const fs = require('node:fs/promises')
const path = require('node:path')
const vm = require('node:vm')

const ROUTE_OUTPUT_GROUPS = ['pages', 'pagesApi', 'appPages', 'appRoutes']
const NEXT_DIST_EXCLUDE_NAMES = new Set(['cache', 'diagnostics', 'trace', 'trace-build', 'types'])
const NATIVE_BINARY_EXTENSIONS = new Set(['.node', '.dylib', '.so'])
const DEFAULT_NODE_PORT = 8080

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/')
}

function toPosixRelativePath(fromPath, toPath) {
  const relativePath = path.posix.relative(toPosixPath(fromPath), toPosixPath(toPath))
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

function hasExtension(pathname) {
  return path.extname(pathname) !== ''
}

function toAssetRelativePath(pathname, filePath) {
  const cleanPathname = pathname.replace(/^\/+/, '')

  if (!cleanPathname) {
    return 'index.html'
  }

  if (hasExtension(cleanPathname)) {
    return cleanPathname
  }

  if (filePath.endsWith('.html')) {
    return path.join(cleanPathname, 'index.html')
  }

  return cleanPathname
}

async function copyAssetFile(sourcePath, assetRoot, pathname) {
  const destinationPath = path.join(assetRoot, toAssetRelativePath(normalizeOutputPathname(pathname), sourcePath))

  await fs.mkdir(path.dirname(destinationPath), { recursive: true })
  await fs.copyFile(sourcePath, destinationPath)
}

async function copyRuntimeFile(sourcePath, destinationPath) {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true })
  await fs.copyFile(sourcePath, destinationPath)
}

async function copyRuntimeSymlink(sourcePath, destinationPath) {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true })

  try {
    await fs.rm(destinationPath, { force: true, recursive: true })
  } catch {}

  await fs.symlink(await fs.readlink(sourcePath), destinationPath)
}

async function patchTurbopackRuntimeForWorkers(filePath) {
  const originalSource = await fs.readFile(filePath, 'utf8')
  const marker = 'const RUNTIME_ROOT = path.resolve(__filename, relativePathToRuntimeRoot);'

  if (!originalSource.includes(marker)) {
    return
  }

  const patchedSource = originalSource.replace(
    marker,
    [
      `const CURRENT_RUNTIME_FILENAME =`,
      `    typeof __filename !== 'undefined'`,
      `        ? __filename`,
      `        : path.join(process.cwd(), process.env.__NEXT_RELATIVE_DIST_DIR || '.next', RUNTIME_PUBLIC_PATH);`,
      `const CURRENT_RUNTIME_DIRNAME = path.dirname(CURRENT_RUNTIME_FILENAME);`,
      `function requireFromCurrentRuntime(resolvedPath, chunkPath) {`,
      `    const chunkLoader = globalThis._NODE_TURBOPACK_CHUNK_REQUIRE?.[chunkPath];`,
      `    if (typeof chunkLoader === 'function') {`,
      `        return chunkLoader();`,
      `    }`,
      `    const relativePath = path.relative(CURRENT_RUNTIME_DIRNAME, resolvedPath).split(path.sep).join('/');`,
      `    const requestPath = relativePath.startsWith('.') ? relativePath : \`./\${relativePath}\`;`,
      `    try {`,
      `        return require(requestPath);`,
      `    } catch (relativeRequireError) {`,
      `        try {`,
      `            return require(resolvedPath);`,
      `        } catch {`,
      `            throw relativeRequireError;`,
      `        }`,
      `    }`,
      `}`,
      `const RUNTIME_ROOT = path.resolve(CURRENT_RUNTIME_FILENAME, relativePathToRuntimeRoot);`,
    ].join('\n')
  ).replace(
    'const ABSOLUTE_ROOT = path.resolve(__filename, relativePathToDistRoot);',
    'const ABSOLUTE_ROOT = path.resolve(CURRENT_RUNTIME_FILENAME, relativePathToDistRoot);'
  ).replaceAll(
    'const chunkModules = require(resolved);',
    'const chunkModules = requireFromCurrentRuntime(resolved, chunkPath);'
  )

  if (patchedSource !== originalSource) {
    await fs.writeFile(filePath, patchedSource)
  }
}

async function patchCommonJsGlobalsForWorkers(filePath, relativePath) {
  const originalSource = await fs.readFile(filePath, 'utf8')

  if (!originalSource.includes('__dirname+"/"')) {
    return
  }

  const relativeDir = toPosixPath(path.dirname(relativePath))
  const dirnameExpression =
    relativeDir === '.'
      ? 'process.cwd()'
      : `require("path").join(process.cwd(), ${JSON.stringify(relativeDir)})`

  const patchedSource = originalSource.replaceAll('__dirname+"/"', `${dirnameExpression}+"/"`)

  if (patchedSource !== originalSource) {
    await fs.writeFile(filePath, patchedSource)
  }
}

async function patchBareNextRequiresForWorkers(filePath, relativePath, nextPackageRootRelative) {
  if (!nextPackageRootRelative) {
    return
  }

  const originalSource = await fs.readFile(filePath, 'utf8')

  if (!originalSource.includes('next/dist/')) {
    return
  }

  const currentDir = toPosixPath(path.posix.dirname(toPosixPath(relativePath)))
  const rewriteSpecifier = (specifier) => {
    const normalizedSpecifier = specifier.replace(/^.*node_modules\/next\/dist\//, 'next/dist/')

    if (!normalizedSpecifier.startsWith('next/dist/')) {
      return specifier
    }

    const subpath = normalizedSpecifier.slice('next/dist/'.length)
    const targetRelativePath = path.posix.join(nextPackageRootRelative, 'dist', subpath)
    return toPosixRelativePath(currentDir, targetRelativePath)
  }

  let patchedSource = originalSource.replaceAll(
    /((?:require|import)\(\s*)(["'])([^"'`]+)\2/g,
    (match, prefix, quote, specifier) => {
      if (!specifier.includes('next/dist/')) {
        return match
      }

      return `${prefix}${quote}${rewriteSpecifier(specifier)}${quote}`
    }
  )

  patchedSource = patchedSource.replaceAll(
    /((?:from|export\s+\*\s+from|export\s+\{[^}]+\}\s+from)\s+)(["'])([^"'`]+)\2/g,
    (match, prefix, quote, specifier) => {
      if (!specifier.includes('next/dist/')) {
        return match
      }

      return `${prefix}${quote}${rewriteSpecifier(specifier)}${quote}`
    }
  )

  if (patchedSource !== originalSource) {
    await fs.writeFile(filePath, patchedSource)
  }
}

async function patchOpenTelemetryRequiresForWorkers(filePath, relativePath, nextPackageRootRelative) {
  const normalizedRelativePath = toPosixPath(relativePath)
  const nextPackageMarker = '/node_modules/next/'
  const nextPackageMarkerIndex = normalizedRelativePath.lastIndexOf(nextPackageMarker)
  const nextPackageRoot =
    nextPackageMarkerIndex >= 0
      ? normalizedRelativePath.slice(0, nextPackageMarkerIndex + '/node_modules/next'.length)
      : nextPackageRootRelative && normalizedRelativePath.startsWith(`${nextPackageRootRelative}/`)
        ? nextPackageRootRelative
        : null

  if (!nextPackageRoot) {
    return
  }

  const originalSource = await fs.readFile(filePath, 'utf8')

  if (!originalSource.includes('@opentelemetry/api')) {
    return
  }

  const currentDir = toPosixPath(path.posix.dirname(normalizedRelativePath))
  const compiledApiPath = path.posix.join(nextPackageRoot, 'dist', 'compiled', '@opentelemetry', 'api')
  const rewrittenPath = toPosixRelativePath(currentDir, compiledApiPath)
  const patchedSource = originalSource.replaceAll(
    /require\((["'])@opentelemetry\/api\1\)/g,
    `require(${JSON.stringify(rewrittenPath)})`
  )

  if (patchedSource !== originalSource) {
    await fs.writeFile(filePath, patchedSource)
  }
}

async function patchOptionalCrittersRequiresForWorkers(filePath) {
  const originalSource = await fs.readFile(filePath, 'utf8')

  if (!originalSource.includes('critters')) {
    return
  }

  const helperName = '__next_cloudflare_optional_require__'
  let patchedSource = originalSource.replaceAll(
    /require\((["'])critters\1\)/g,
    `${helperName}("critters")`
  )

  if (patchedSource === originalSource) {
    return
  }

  if (!patchedSource.includes(`const ${helperName} =`)) {
    patchedSource = `const ${helperName} = (specifier) => (0, eval)('require')(specifier);\n${patchedSource}`
  }

  await fs.writeFile(filePath, patchedSource)
}

async function collectRuntimePackageSpecifiers(runtimeFiles) {
  const packageSpecifiers = new Set()

  for (const [relativePath, sourcePath] of runtimeFiles) {
    const normalizedPath = toPosixPath(relativePath)

    if (!normalizedPath.endsWith('/package.json')) {
      continue
    }

    if (
      normalizedPath !== 'package.json' &&
      !normalizedPath.startsWith('node_modules/') &&
      !normalizedPath.includes('/node_modules/')
    ) {
      continue
    }

    try {
      const packageJson = JSON.parse(await fs.readFile(sourcePath, 'utf8'))

      if (typeof packageJson.name === 'string' && packageJson.name) {
        packageSpecifiers.add(packageJson.name)
      }
    } catch {}
  }

  return packageSpecifiers
}

async function patchHashedPackageRequiresForWorkers(filePath, runtimePackageSpecifiers) {
  const originalSource = await fs.readFile(filePath, 'utf8')

  if (!/-[0-9a-f]{8,}/.test(originalSource)) {
    return
  }

  const rewriteSpecifier = (specifier) => {
    if (
      !specifier ||
      specifier.startsWith('.') ||
      specifier.startsWith('/') ||
      !/-[0-9a-f]{8,}$/.test(specifier)
    ) {
      return specifier
    }

    const unhashedSpecifier = specifier.replace(/-[0-9a-f]{8,}$/, '')
    return unhashedSpecifier
  }

  let patchedSource = originalSource.replaceAll(
    /(["'])([@a-zA-Z0-9_.\/-]+-[0-9a-f]{8,})\1/g,
    (match, quote, specifier) => `${quote}${rewriteSpecifier(specifier)}${quote}`
  )

  patchedSource = patchedSource.replaceAll(
    /((?:require|import)\(\s*)(["'])([^"'`]+)\2/g,
    (match, prefix, quote, specifier) => `${prefix}${quote}${rewriteSpecifier(specifier)}${quote}`
  )

  patchedSource = patchedSource.replaceAll(
    /((?:from|export\s+\*\s+from|export\s+\{[^}]+\}\s+from)\s+)(["'])([^"'`]+)\2/g,
    (match, prefix, quote, specifier) => `${prefix}${quote}${rewriteSpecifier(specifier)}${quote}`
  )

  if (patchedSource !== originalSource) {
    await fs.writeFile(filePath, patchedSource)
  }
}

async function patchInstrumentationGlobalsForWorkers(filePath) {
  const originalSource = await fs.readFile(filePath, 'utf8')
  const marker =
    "cachedInstrumentationModule = (0, _interopdefault.interopDefault)(await require(_nodepath.default.join(projectDir, distDir, 'server', `${_constants.INSTRUMENTATION_HOOK_FILENAME}.js`)));"

  if (!originalSource.includes(marker)) {
    return
  }

  const patchedSource = originalSource.replace(
    marker,
    [
      "const instrumentationPath = _nodepath.default.join(projectDir, distDir, 'server', `${_constants.INSTRUMENTATION_HOOK_FILENAME}.js`);",
      "        if (!require('fs').existsSync(instrumentationPath)) {",
      '            return undefined;',
      '        }',
      "        cachedInstrumentationModule = (0, _interopdefault.interopDefault)(await require(instrumentationPath));",
    ].join('\n')
  )

  if (patchedSource !== originalSource) {
    await fs.writeFile(filePath, patchedSource)
  }
}

async function patchLoadManifestForWorkers(filePath) {
  const originalSource = await fs.readFile(filePath, 'utf8')

  let patchedSource = originalSource

  if (patchedSource.includes("let manifest;\n    if (handleMissing) {")) {
    patchedSource = patchedSource
      .replace(
        "let manifest;\n    if (handleMissing) {",
        [
          'let manifest;',
          "    const runtimeFileKey = typeof process.cwd === 'function' ? (0, _path.relative)(process.cwd(), path).split(_path.sep).join('/') : path;",
          '    const embeddedRawManifest = globalThis._NODE_RAW_FILES?.[runtimeFileKey];',
          '    const embeddedManifest = globalThis._NODE_JSON_FILES?.[runtimeFileKey];',
          '    if (embeddedRawManifest !== undefined) {',
          '        manifest = embeddedRawManifest;',
          '    } else if (embeddedManifest !== undefined) {',
          "        manifest = skipParse ? JSON.stringify(embeddedManifest) : embeddedManifest;",
          '    } else if (handleMissing) {',
        ].join('\n')
      )
      .replace(
        '        manifest = JSON.parse(manifest);',
        [
          "        if (typeof manifest === 'string') {",
          '            manifest = JSON.parse(manifest);',
          '        }',
        ].join('\n')
      )
  }

  if (patchedSource.includes("let content;\n    if (handleMissing) {")) {
    patchedSource = patchedSource.replace(
      "let content;\n    if (handleMissing) {",
      [
        'let content;',
        "    const runtimeFileKey = typeof process.cwd === 'function' ? (0, _path.relative)(process.cwd(), path).split(_path.sep).join('/') : path;",
        '    const embeddedEvalManifest = globalThis._NODE_EVAL_MANIFESTS?.[runtimeFileKey];',
        '    if (embeddedEvalManifest !== undefined) {',
        '        let contextObject = embeddedEvalManifest;',
        '        if (shouldCache) {',
        '            contextObject = (0, _deepfreeze.deepFreeze)(contextObject);',
        '            cache.set(path, contextObject);',
        '        }',
        '        return contextObject;',
        '    } else if (handleMissing) {',
      ].join('\n')
    )
  }

  if (patchedSource !== originalSource) {
    await fs.writeFile(filePath, patchedSource)
  }
}

async function copyDirectory(sourceDir, destinationDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true })

  await fs.mkdir(destinationDir, { recursive: true })

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const destinationPath = path.join(destinationDir, entry.name)

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath)
      continue
    }

    if (entry.isFile()) {
      await fs.copyFile(sourcePath, destinationPath)
    }
  }
}

async function copyRuntimeImportFiles({ orderedRuntimeImports, projectDir, runtimeRoot }) {
  const copiedRuntimeImports = []

  for (const sourcePath of orderedRuntimeImports) {
    const relativePath = path.relative(projectDir, sourcePath)
    const destinationPath = path.join(runtimeRoot, relativePath)

    await fs.mkdir(path.dirname(destinationPath), { recursive: true })
    await fs.copyFile(sourcePath, destinationPath)

    copiedRuntimeImports.push(destinationPath)
  }

  return copiedRuntimeImports
}

async function copyRuntimeSupportFiles({ supportFiles, projectDir, runtimeRoot }) {
  for (const sourcePath of supportFiles) {
    const relativePath = path.relative(projectDir, sourcePath)
    const destinationPath = path.join(runtimeRoot, relativePath)

    await fs.mkdir(path.dirname(destinationPath), { recursive: true })
    await fs.copyFile(sourcePath, destinationPath)
  }
}

function collectRouteOutputs(outputs) {
  const routeOutputs = []

  if (outputs.middleware) {
    routeOutputs.push(outputs.middleware)
  }

  for (const group of ROUTE_OUTPUT_GROUPS) {
    routeOutputs.push(...(outputs[group] ?? []))
  }

  return routeOutputs
}

function collectRouteRuntimeOutputs(outputs) {
  const edgeRouteOutputs = []
  const nodeRouteOutputs = []

  for (const output of collectRouteOutputs(outputs)) {
    if (output.runtime === 'edge') {
      edgeRouteOutputs.push(output)
      continue
    }

    nodeRouteOutputs.push(output)
  }

  return {
    edgeRouteOutputs,
    nodeRouteOutputs,
  }
}

function validateUnsupportedFeatures({ outputs, edgeRouteOutputs, nodeRouteOutputs }) {
  const edgeOutputsMissingMetadata = edgeRouteOutputs.filter((output) => !output.edgeRuntime)

  if (edgeOutputsMissingMetadata.length > 0) {
    const details = edgeOutputsMissingMetadata.map((output) => output.pathname).join(', ')
    throw new Error(`Missing edgeRuntime metadata for edge outputs: ${details}`)
  }

  if (nodeRouteOutputs.length === 0) {
    const unsupportedPrerenders = (outputs.prerenders ?? []).filter((prerender) => {
      if (!prerender.fallback?.filePath) {
        return false
      }

      if (prerender.fallback.postponedState) {
        return true
      }

      return prerender.fallback.initialRevalidate !== false
    })

    if (unsupportedPrerenders.length > 0) {
      const details = unsupportedPrerenders.map((prerender) => prerender.pathname).join(', ')

      throw new Error(
        `The Cloudflare Workers adapter currently supports only fully static prerenders. Unsupported prerenders: ${details}`
      )
    }
  }
}

function collectOrderedRuntimeImports({ outputs, edgeRouteOutputs }) {
  const importPaths = []
  const seen = new Set()
  const orderedOutputs = [
    ...(outputs.middleware ? [outputs.middleware] : []),
    ...edgeRouteOutputs,
  ]

  for (const output of orderedOutputs) {
    const orderedFiles = [
      ...Object.values(output.assets ?? {}),
      output.edgeRuntime?.modulePath,
    ].filter((filePath) => filePath && filePath.endsWith('.js'))

    for (const filePath of orderedFiles) {
      if (seen.has(filePath)) {
        continue
      }

      seen.add(filePath)
      importPaths.push(filePath)
    }
  }

  return importPaths
}

function collectRuntimeSupportFiles({ outputs, edgeRouteOutputs }) {
  const supportFiles = []
  const seen = new Set()
  const orderedOutputs = [
    ...(outputs.middleware ? [outputs.middleware] : []),
    ...edgeRouteOutputs,
  ]

  for (const output of orderedOutputs) {
    const files = [
      ...Object.values(output.assets ?? {}),
      ...Object.values(output.wasmAssets ?? {}),
    ].filter(Boolean)

    for (const filePath of files) {
      if (seen.has(filePath)) {
        continue
      }

      seen.add(filePath)
      supportFiles.push(filePath)
    }
  }

  return supportFiles
}

function addRuntimeEnv(runtimeEnv, key, value) {
  const existing = runtimeEnv.get(key)

  if (existing !== undefined && existing !== value) {
    throw new Error(`Conflicting runtime env value for ${key}. Values: ${existing} and ${value}`)
  }

  runtimeEnv.set(key, value)
}

function collectRuntimeEnv({ outputs, edgeRouteOutputs, config }) {
  const runtimeEnv = new Map()
  const envOutputs = [
    ...(outputs.middleware ? [outputs.middleware] : []),
    ...edgeRouteOutputs,
  ]

  addRuntimeEnv(runtimeEnv, 'NODE_ENV', 'production')
  addRuntimeEnv(runtimeEnv, '__NEXT_BASE_PATH', config.basePath || '')
  addRuntimeEnv(runtimeEnv, '__NEXT_TRAILING_SLASH', Boolean(config.trailingSlash))
  addRuntimeEnv(
    runtimeEnv,
    '__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS',
    Boolean(config.experimental?.authInterrupts)
  )

  for (const [key, value] of Object.entries(config.env ?? {})) {
    addRuntimeEnv(runtimeEnv, key, value)
  }

  if (config.i18n !== undefined && config.i18n !== null) {
    addRuntimeEnv(runtimeEnv, '__NEXT_I18N_CONFIG', config.i18n)
  }

  if (config.cacheLife !== undefined) {
    addRuntimeEnv(runtimeEnv, '__NEXT_CACHE_LIFE', config.cacheLife)
  }

  if (config.experimental?.clientParamParsingOrigins !== undefined) {
    addRuntimeEnv(
      runtimeEnv,
      '__NEXT_CLIENT_PARAM_PARSING_ORIGINS',
      config.experimental.clientParamParsingOrigins
    )
  }

  for (const output of envOutputs) {
    for (const [key, value] of Object.entries(output.config?.env ?? {})) {
      addRuntimeEnv(runtimeEnv, key, value)
    }
  }

  return Object.fromEntries(runtimeEnv)
}

function normalizeOutputPathname(pathname) {
  if (!pathname || pathname === '/') {
    return '/'
  }

  if (pathname === '/index') {
    return '/'
  }

  if (pathname.endsWith('/index')) {
    return pathname.slice(0, -'/index'.length) || '/'
  }

  return pathname
}

function serializeRouteOutput(output) {
  return {
    type: output.type,
    pathname: normalizeOutputPathname(output.pathname),
    runtime: output.runtime,
    edgeRuntime: output.edgeRuntime,
  }
}

async function resolvePrerenderDataFilePath(distDir, dataRoutePathname) {
  const cleanPathname = dataRoutePathname.replace(/^\/+/, '')
  const candidatePaths = [
    path.join(distDir, 'server', 'app', cleanPathname),
    path.join(distDir, 'server', 'pages', cleanPathname),
    path.join(distDir, 'server', cleanPathname),
  ]

  if (cleanPathname.startsWith('_next/data/')) {
    const strippedPathname = cleanPathname.replace(/^_next\/data\/[^/]+\//, '')
    candidatePaths.push(
      path.join(distDir, 'server', 'pages', strippedPathname),
      path.join(distDir, 'server', strippedPathname)
    )
  }

  for (const candidatePath of candidatePaths) {
    if (await pathExists(candidatePath)) {
      return candidatePath
    }
  }

  return null
}

async function resolvePrerenderDataRoutes({ outputs, distDir }) {
  const prerenderManifestPath = path.join(distDir, 'prerender-manifest.json')

  if (!(await pathExists(prerenderManifestPath))) {
    return []
  }

  const prerenderManifest = JSON.parse(await fs.readFile(prerenderManifestPath, 'utf8'))
  const prerenderDataRoutes = []

  for (const prerender of outputs.prerenders ?? []) {
    if (!prerender.fallback?.filePath || prerender.fallback.initialRevalidate !== false) {
      continue
    }

    const pathname = normalizeOutputPathname(prerender.pathname)
    const dataRoutePathname = prerenderManifest.routes?.[pathname]?.dataRoute

    if (!dataRoutePathname) {
      continue
    }

    const normalizedDataRoutePathname = normalizeOutputPathname(dataRoutePathname)
    const filePath = await resolvePrerenderDataFilePath(distDir, normalizedDataRoutePathname)

    if (!filePath) {
      continue
    }

    prerenderDataRoutes.push({
      pathname,
      dataRoutePathname: normalizedDataRoutePathname,
      filePath,
    })
  }

  return prerenderDataRoutes
}

function toOutputImportPath({ generatedDir, runtimeRepoRoot, repoRoot, filePath }) {
  const runtimeFilePath = path.join(runtimeRepoRoot, path.relative(repoRoot, filePath))
  const relativePath = path.relative(generatedDir, runtimeFilePath).split(path.sep).join('/')

  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`
}

function toRuntimeRequirePath({ generatedDir, runtimeRepoRoot, repoRoot, filePath }) {
  return toOutputImportPath({
    generatedDir,
    runtimeRepoRoot,
    repoRoot,
    filePath,
  })
}

function isNativeBinary(filePath) {
  return NATIVE_BINARY_EXTENSIONS.has(path.extname(filePath)) || filePath.includes('sharp-libvips')
}

function addRuntimeFile(runtimeFiles, relativePath, sourcePath) {
  if (!relativePath) {
    return
  }

  const normalizedPath = toPosixPath(relativePath)

  if (normalizedPath.startsWith('../') || path.isAbsolute(normalizedPath)) {
    throw new Error(`Runtime file ${sourcePath} resolved outside the repo root: ${relativePath}`)
  }

  runtimeFiles.set(normalizedPath, sourcePath)
}

function addRepoRelativeRuntimeFile(runtimeFiles, repoRoot, sourcePath) {
  addRuntimeFile(runtimeFiles, path.relative(repoRoot, sourcePath), sourcePath)
}

function toTraceRuntimeRelativePath(sourcePath, repoRoot) {
  const relativePath = path.relative(repoRoot, sourcePath)

  if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    return relativePath
  }

  const normalizedSourcePath = toPosixPath(sourcePath)
  const nodeModulesMarker = '/node_modules/'
  const nodeModulesIndex = normalizedSourcePath.lastIndexOf(nodeModulesMarker)

  if (nodeModulesIndex === -1) {
    return null
  }

  return normalizedSourcePath.slice(nodeModulesIndex + 1)
}

async function collectDirectoryFiles(runtimeFiles, sourceDir, repoRoot) {
  if (!(await pathExists(sourceDir))) {
    return
  }

  const entries = await fs.readdir(sourceDir, { withFileTypes: true })

  for (const entry of entries) {
    if (NEXT_DIST_EXCLUDE_NAMES.has(entry.name)) {
      continue
    }

    const sourcePath = path.join(sourceDir, entry.name)

    if (entry.isDirectory()) {
      await collectDirectoryFiles(runtimeFiles, sourcePath, repoRoot)
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    addRepoRelativeRuntimeFile(runtimeFiles, repoRoot, sourcePath)
  }
}

async function collectLocalNodeModules(runtimeFiles, projectDir, repoRoot) {
  const nodeModulesDir = path.join(projectDir, 'node_modules')

  if (!(await pathExists(nodeModulesDir))) {
    return
  }

  const entries = await fs.readdir(nodeModulesDir, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    await collectDirectoryFiles(runtimeFiles, path.join(nodeModulesDir, entry.name), repoRoot)
  }
}

async function collectTraceFiles(runtimeFiles, tracePath, distDir, repoRoot) {
  if (!(await pathExists(tracePath))) {
    return
  }

  const trace = JSON.parse(await fs.readFile(tracePath, 'utf8'))

  for (const relativeTracePath of trace.files ?? []) {
    const sourcePath = path.resolve(distDir, relativeTracePath)
    const runtimeRelativePath = toTraceRuntimeRelativePath(sourcePath, repoRoot)

    if (!runtimeRelativePath) {
      continue
    }

    addRuntimeFile(runtimeFiles, runtimeRelativePath, sourcePath)
  }
}

function toRouteTracePath(filePath) {
  return `${filePath}.nft.json`
}

async function collectNestedTraceFiles(runtimeFiles, sourceDir, distDir, repoRoot) {
  if (!(await pathExists(sourceDir))) {
    return
  }

  const entries = await fs.readdir(sourceDir, { withFileTypes: true })

  for (const entry of entries) {
    const entryPath = path.join(sourceDir, entry.name)

    if (entry.isDirectory()) {
      await collectNestedTraceFiles(runtimeFiles, entryPath, distDir, repoRoot)
      continue
    }

    if (!entry.isFile() || !entry.name.endsWith('.nft.json')) {
      continue
    }

    await collectTraceFiles(runtimeFiles, entryPath, distDir, repoRoot)
  }
}

function resolveHashedPackageAlias(relativePath, runtimePackageSpecifiers) {
  const normalizedPath = toPosixPath(relativePath)
  const nodeModulesIndex = normalizedPath.lastIndexOf('/node_modules/')
  const packagePath =
    nodeModulesIndex >= 0
      ? normalizedPath.slice(nodeModulesIndex + '/node_modules/'.length)
      : normalizedPath.startsWith('node_modules/')
        ? normalizedPath.slice('node_modules/'.length)
        : null

  if (!packagePath || packagePath.includes('/') === false) {
    const unhashedSpecifier = packagePath?.replace(/-[0-9a-f]{8,}$/, '')
    return runtimePackageSpecifiers.has(unhashedSpecifier) ? unhashedSpecifier : null
  }

  const packageSegments = packagePath.startsWith('@')
    ? packagePath.split('/').slice(0, 2)
    : packagePath.split('/').slice(0, 1)
  const lastSegmentIndex = packageSegments.length - 1
  const unhashedLastSegment = packageSegments[lastSegmentIndex]?.replace(/-[0-9a-f]{8,}$/, '')

  if (!unhashedLastSegment || unhashedLastSegment === packageSegments[lastSegmentIndex]) {
    return null
  }

  packageSegments[lastSegmentIndex] = unhashedLastSegment
  const unhashedSpecifier = packageSegments.join('/')
  return runtimePackageSpecifiers.has(unhashedSpecifier) ? unhashedSpecifier : null
}

async function writeRuntimePackageAlias(runtimeRepoRoot, relativePath, aliasSpecifier) {
  const aliasDir = path.join(runtimeRepoRoot, relativePath)
  const aliasName = path.posix.basename(toPosixPath(relativePath))

  await fs.mkdir(aliasDir, { recursive: true })
  await fs.writeFile(
    path.join(aliasDir, 'package.json'),
    JSON.stringify({ name: aliasName, main: 'index.js' }, null, 2) + '\n'
  )
  await fs.writeFile(
    path.join(aliasDir, 'index.js'),
    `module.exports = require(${JSON.stringify(aliasSpecifier)});\n`
  )
}

async function collectNodeRuntimeFiles({ outputs, distDir, projectDir, repoRoot }) {
  const runtimeFiles = new Map()

  await collectDirectoryFiles(runtimeFiles, distDir, repoRoot)
  await collectLocalNodeModules(runtimeFiles, projectDir, repoRoot)
  await collectNestedTraceFiles(runtimeFiles, path.join(distDir, 'server'), distDir, repoRoot)

  for (const output of collectRouteOutputs(outputs)) {
    addRepoRelativeRuntimeFile(runtimeFiles, repoRoot, output.filePath)
    await collectTraceFiles(runtimeFiles, toRouteTracePath(output.filePath), distDir, repoRoot)

    for (const [relativePath, sourcePath] of Object.entries(output.assets ?? {})) {
      addRuntimeFile(runtimeFiles, relativePath, sourcePath)
    }
  }

  for (const prerender of outputs.prerenders ?? []) {
    if (!prerender.fallback?.filePath) {
      continue
    }

    addRepoRelativeRuntimeFile(runtimeFiles, repoRoot, prerender.fallback.filePath)
  }

  await collectTraceFiles(runtimeFiles, path.join(distDir, 'next-server.js.nft.json'), distDir, repoRoot)

  const packageJsonPath = path.join(projectDir, 'package.json')

  if (await pathExists(packageJsonPath)) {
    addRepoRelativeRuntimeFile(runtimeFiles, repoRoot, packageJsonPath)
  }

  await collectDirectoryFiles(
    runtimeFiles,
    path.join(projectDir, 'node_modules', 'next', 'dist', 'compiled', 'next-server'),
    repoRoot
  )

  return runtimeFiles
}

async function copyNodeRuntimeFiles({ runtimeFiles, runtimeRepoRoot }) {
  const nextPackageRootRelative = findNextPackageRootRelative(runtimeFiles)
  const runtimePackageSpecifiers = await collectRuntimePackageSpecifiers(runtimeFiles)

  for (const [relativePath, sourcePath] of runtimeFiles) {
    if (isNativeBinary(sourcePath)) {
      continue
    }

    let stats

    try {
      stats = await fs.lstat(sourcePath)
    } catch {
      const aliasSpecifier = resolveHashedPackageAlias(relativePath, runtimePackageSpecifiers)

      if (aliasSpecifier) {
        await writeRuntimePackageAlias(runtimeRepoRoot, relativePath, aliasSpecifier)
      }

      continue
    }

    const destinationPath = path.join(runtimeRepoRoot, relativePath)

    if (stats.isSymbolicLink()) {
      await copyRuntimeSymlink(sourcePath, destinationPath)
      continue
    }

    if (!stats.isFile()) {
      continue
    }

    await copyRuntimeFile(sourcePath, destinationPath)

    if (destinationPath.endsWith('.js')) {
      await patchBareNextRequiresForWorkers(destinationPath, relativePath, nextPackageRootRelative)
      await patchOpenTelemetryRequiresForWorkers(
        destinationPath,
        relativePath,
        nextPackageRootRelative
      )
      await patchHashedPackageRequiresForWorkers(destinationPath, runtimePackageSpecifiers)
      await patchOptionalCrittersRequiresForWorkers(destinationPath)
      await patchCommonJsGlobalsForWorkers(destinationPath, relativePath)

      if (relativePath.endsWith('next/dist/server/lib/router-utils/instrumentation-globals.external.js')) {
        await patchInstrumentationGlobalsForWorkers(destinationPath)
      }

      if (relativePath.endsWith('next/dist/server/load-manifest.external.js')) {
        await patchLoadManifestForWorkers(destinationPath)
      }
    }

    if (path.basename(destinationPath) === '[turbopack]_runtime.js') {
      await patchTurbopackRuntimeForWorkers(destinationPath)
    }
  }

  await patchNodeRuntimeTree({
    rootDir: runtimeRepoRoot,
    baseDir: runtimeRepoRoot,
    nextPackageRootRelative,
    runtimePackageSpecifiers,
  })
}

async function copyLocalProjectNodeModules({ projectDir, runtimeRepoRoot }) {
  const projectNodeModulesDir = path.join(projectDir, 'node_modules')
  const runtimeNodeModulesDir = path.join(runtimeRepoRoot, 'node_modules')

  if (!(await pathExists(projectNodeModulesDir))) {
    return
  }

  const entries = await fs.readdir(projectNodeModulesDir, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.name === '.pnpm' || entry.isSymbolicLink()) {
      continue
    }

    const sourcePath = path.join(projectNodeModulesDir, entry.name)
    const destinationPath = path.join(runtimeNodeModulesDir, entry.name)

    if (entry.isDirectory()) {
      await fs.rm(destinationPath, { force: true, recursive: true }).catch(() => {})
      await copyDirectory(sourcePath, destinationPath)
      continue
    }

    if (entry.isFile()) {
      await fs.mkdir(path.dirname(destinationPath), { recursive: true })
      await fs.copyFile(sourcePath, destinationPath)
    }
  }
}

async function patchNodeRuntimeTree({
  rootDir,
  baseDir,
  nextPackageRootRelative,
  runtimePackageSpecifiers,
}) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true })

  for (const entry of entries) {
    const destinationPath = path.join(rootDir, entry.name)

    if (entry.isDirectory()) {
      await patchNodeRuntimeTree({
        rootDir: destinationPath,
        baseDir,
        nextPackageRootRelative,
        runtimePackageSpecifiers,
      })
      continue
    }

    if (!entry.isFile() || !destinationPath.endsWith('.js')) {
      continue
    }

    const relativePath = toPosixPath(path.relative(baseDir, destinationPath))

    await patchBareNextRequiresForWorkers(destinationPath, relativePath, nextPackageRootRelative)
    await patchOpenTelemetryRequiresForWorkers(
      destinationPath,
      relativePath,
      nextPackageRootRelative
    )
    await patchHashedPackageRequiresForWorkers(destinationPath, runtimePackageSpecifiers)
    await patchOptionalCrittersRequiresForWorkers(destinationPath)
    await patchCommonJsGlobalsForWorkers(destinationPath, relativePath)

    if (relativePath.endsWith('next/dist/server/lib/router-utils/instrumentation-globals.external.js')) {
      await patchInstrumentationGlobalsForWorkers(destinationPath)
    }

    if (relativePath.endsWith('next/dist/server/load-manifest.external.js')) {
      await patchLoadManifestForWorkers(destinationPath)
    }

    if (path.basename(destinationPath) === '[turbopack]_runtime.js') {
      await patchTurbopackRuntimeForWorkers(destinationPath)
    }
  }
}

function buildNodeChunkRequireEntries({
  runtimeFiles,
  generatedDir,
  runtimeRepoRoot,
  repoRoot,
  projectDirRelative,
  distDir,
}) {
  const chunkEntries = []
  const distPrefix = toPosixPath(path.posix.join(projectDirRelative || '', distDir).replace(/^\/+/, ''))

  for (const relativePath of runtimeFiles.keys()) {
    const normalizedPath = toPosixPath(relativePath)

    if (!normalizedPath.endsWith('.js')) {
      continue
    }

    if (!normalizedPath.startsWith(`${distPrefix}/`)) {
      continue
    }

    const runtimeChunkPath = normalizedPath.slice(`${distPrefix}/`.length)

    if (!runtimeChunkPath.startsWith('server/chunks/')) {
      continue
    }

    chunkEntries.push({
      chunkPath: runtimeChunkPath,
      requirePath: toRuntimeRequirePath({
        generatedDir,
        runtimeRepoRoot,
        repoRoot,
        filePath: path.join(repoRoot, relativePath),
      }),
    })
  }

  return chunkEntries
}

async function buildNodeJsonEntries({
  runtimeFiles,
  projectDirRelative,
  distDir,
}) {
  const jsonEntries = []
  const distPrefix = toPosixPath(path.posix.join(projectDirRelative || '', distDir).replace(/^\/+/, ''))

  for (const [relativePath, sourcePath] of runtimeFiles) {
    const normalizedPath = toPosixPath(relativePath)

    if (!normalizedPath.endsWith('.json')) {
      continue
    }

    if (!normalizedPath.startsWith(`${distPrefix}/`)) {
      continue
    }

    const distRelativePath = normalizedPath.slice(`${distPrefix}/`.length)

    if (distRelativePath.startsWith('diagnostics/') || distRelativePath.endsWith('.nft.json')) {
      continue
    }

    if (!(await pathExists(sourcePath))) {
      continue
    }

    jsonEntries.push({
      filePath: normalizedPath,
      value: JSON.parse(await fs.readFile(sourcePath, 'utf8')),
    })
  }

  return jsonEntries
}

async function buildNodeRawEntries({
  runtimeFiles,
  projectDirRelative,
  distDir,
}) {
  const rawEntries = []
  const distPrefix = toPosixPath(path.posix.join(projectDirRelative || '', distDir).replace(/^\/+/, ''))
  const embeddedRawManifestPaths = new Set([
    'BUILD_ID',
    'dynamic-css-manifest',
  ])

  for (const [relativePath, sourcePath] of runtimeFiles) {
    const normalizedPath = toPosixPath(relativePath)

    if (!normalizedPath.startsWith(`${distPrefix}/`)) {
      continue
    }

    const distRelativePath = normalizedPath.slice(`${distPrefix}/`.length)

    if (!embeddedRawManifestPaths.has(distRelativePath)) {
      continue
    }

    if (!(await pathExists(sourcePath))) {
      continue
    }

    rawEntries.push({
      filePath: normalizedPath,
      value: await fs.readFile(sourcePath, 'utf8'),
    })
  }

  return rawEntries
}

async function buildNodeEvalManifestEntries({
  runtimeFiles,
  projectDirRelative,
  distDir,
}) {
  const evalManifestEntries = []
  const distPrefix = toPosixPath(path.posix.join(projectDirRelative || '', distDir).replace(/^\/+/, ''))

  for (const [relativePath, sourcePath] of runtimeFiles) {
    const normalizedPath = toPosixPath(relativePath)

    if (!normalizedPath.endsWith('_client-reference-manifest.js')) {
      continue
    }

    if (!normalizedPath.startsWith(`${distPrefix}/`)) {
      continue
    }

    if (!(await pathExists(sourcePath))) {
      continue
    }

    const content = await fs.readFile(sourcePath, 'utf8')
    const contextObject = {
      process: {
        env: {
          NEXT_DEPLOYMENT_ID: process.env.NEXT_DEPLOYMENT_ID,
        },
      },
    }

    vm.runInNewContext(content, contextObject)

    evalManifestEntries.push({
      filePath: normalizedPath,
      value: {
        __RSC_MANIFEST: contextObject.__RSC_MANIFEST ?? {},
      },
    })
  }

  return evalManifestEntries
}

async function readJsonIfExists(filePath) {
  if (!(await pathExists(filePath))) {
    return null
  }

  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

function serializeConfig(config, requiredServerFilesManifest) {
  if (requiredServerFilesManifest?.config) {
    return requiredServerFilesManifest.config
  }

  return JSON.parse(JSON.stringify(config))
}

function findNextServerEntryRelative(runtimeFiles) {
  for (const relativePath of runtimeFiles.keys()) {
    if (
      relativePath.endsWith('node_modules/next/dist/server/next-server.js') ||
      relativePath.endsWith('packages/next/dist/server/next-server.js')
    ) {
      return relativePath
    }
  }

  return null
}

function findNextPackageRootRelative(runtimeFiles) {
  for (const relativePath of runtimeFiles.keys()) {
    const normalizedPath = toPosixPath(relativePath)

    if (normalizedPath === 'node_modules/next/package.json') {
      return 'node_modules/next'
    }
  }

  for (const relativePath of runtimeFiles.keys()) {
    const normalizedPath = toPosixPath(relativePath)

    if (normalizedPath.endsWith('/node_modules/next/package.json')) {
      return toPosixPath(path.posix.dirname(normalizedPath))
    }
  }

  return null
}

function buildWorkerManifest({
  buildId,
  assetMetadata,
  config,
  nextConfig,
  outputs,
  prerenderDataRoutes = [],
  routing,
  edgeRouteOutputs,
  nodeRouteOutputs,
  nodeRuntime,
}) {
  const routeOutputs = [...edgeRouteOutputs, ...nodeRouteOutputs].map(serializeRouteOutput)
  const middleware =
    outputs.middleware && outputs.middleware.runtime === 'edge'
      ? serializeRouteOutput(outputs.middleware)
      : null

  const assetPathnames = [
    ...(outputs.staticFiles ?? []).map((output) => normalizeOutputPathname(output.pathname)),
    ...(outputs.prerenders ?? [])
      .filter((prerender) => prerender.fallback?.filePath && prerender.fallback.initialRevalidate === false)
      .map((prerender) => normalizeOutputPathname(prerender.pathname)),
    ...prerenderDataRoutes.map((route) => route.dataRoutePathname),
  ]
  const prerenderAssetPathnames = (outputs.prerenders ?? [])
    .filter((prerender) => prerender.fallback?.filePath && prerender.fallback.initialRevalidate === false)
    .map((prerender) => normalizeOutputPathname(prerender.pathname))
  const assetPathMap = Object.fromEntries([
    ...(outputs.staticFiles ?? []).map((output) => [
      normalizeOutputPathname(output.pathname),
      `/${toPosixPath(toAssetRelativePath(normalizeOutputPathname(output.pathname), output.filePath))}`,
    ]),
    ...(outputs.prerenders ?? [])
      .filter((prerender) => prerender.fallback?.filePath && prerender.fallback.initialRevalidate === false)
      .map((prerender) => [
        normalizeOutputPathname(prerender.pathname),
        `/${toPosixPath(
          toAssetRelativePath(normalizeOutputPathname(prerender.pathname), prerender.fallback.filePath)
        )}`,
      ]),
    ...prerenderDataRoutes.map((route) => [
      route.dataRoutePathname,
      `/${toPosixPath(toAssetRelativePath(route.dataRoutePathname, route.filePath))}`,
    ]),
  ])
  const prerenderDataRouteMap = Object.fromEntries(
    prerenderDataRoutes.map((route) => [route.pathname, route.dataRoutePathname])
  )

  const pathnames = [
    ...routeOutputs.map((output) => output.pathname),
    ...assetPathnames,
  ]

  return {
    buildId,
    basePath: config.basePath || '',
    i18n: config.i18n,
    nextConfig,
    routing,
    middleware,
    routeOutputs,
    assetPathnames,
    prerenderAssetPathnames,
    prerenderDataRouteMap,
    assetPathMap,
    assetMetadata,
    pathnames,
    notFoundPathname: routeOutputs.find((output) => output.pathname === '/_not-found')?.pathname || null,
    nodeRuntime,
  }
}

async function buildAssetMetadata(outputs, prerenderDataRoutes = []) {
  const metadataEntries = []
  const assetOutputs = [
    ...(outputs.staticFiles ?? []).map((output) => ({
      pathname: normalizeOutputPathname(output.pathname),
      filePath: output.filePath,
    })),
    ...(outputs.prerenders ?? [])
      .filter((prerender) => prerender.fallback?.filePath && prerender.fallback.initialRevalidate === false)
      .map((prerender) => ({
        pathname: normalizeOutputPathname(prerender.pathname),
        filePath: prerender.fallback.filePath,
      })),
    ...prerenderDataRoutes.map((route) => ({
      pathname: route.dataRoutePathname,
      filePath: route.filePath,
    })),
  ]

  for (const assetOutput of assetOutputs) {
    if (!assetOutput.filePath.endsWith('.body')) {
      continue
    }

    const metadataPath = assetOutput.filePath.slice(0, -'.body'.length) + '.meta'

    if (!(await pathExists(metadataPath))) {
      continue
    }

    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'))
    metadataEntries.push([assetOutput.pathname, metadata])
  }

  return Object.fromEntries(metadataEntries)
}

async function writeGeneratedFiles({
  outputDir,
  runtimeEnv,
  copiedRuntimeImports,
  workerManifest,
  nodeRouteOutputImports,
  nodeChunkRequireEntries = [],
  nodeRawEntries = [],
  nodeJsonEntries = [],
  nodeEvalManifestEntries = [],
}) {
  const generatedDir = path.join(outputDir, 'generated')
  const runtimeSupportDir = path.join(outputDir, 'runtime-support')
  const runtimeEnvPath = path.join(generatedDir, 'runtime-env.mjs')
  const chunkLoaderPath = path.join(generatedDir, 'chunks.mjs')
  const nodeBootstrapPath = path.join(generatedDir, 'node-bootstrap.mjs')
  const chunkRequirePath = path.join(generatedDir, 'chunk-requires.cjs')
  const rawFilePath = path.join(generatedDir, 'raw-files.cjs')
  const jsonFilePath = path.join(generatedDir, 'json-files.cjs')
  const evalManifestPath = path.join(generatedDir, 'eval-manifests.cjs')
  const manifestPath = path.join(generatedDir, 'manifest.mjs')
  const workerEntryPath = path.join(outputDir, 'worker.mjs')

  await fs.mkdir(generatedDir, { recursive: true })
  await copyDirectory(path.join(__dirname, 'runtime'), runtimeSupportDir)

  const runtimeEnvSource = [
    `import { AsyncLocalStorage } from 'node:async_hooks'`,
    ``,
    `globalThis.self ??= globalThis`,
    `globalThis.AsyncLocalStorage ??= AsyncLocalStorage`,
    `globalThis.process ??= { env: {} }`,
    `globalThis.process.env ??= {}`,
    ...Object.entries(runtimeEnv).map(
      ([key, value]) => `globalThis.process.env[${JSON.stringify(key)}] ??= ${JSON.stringify(value)}`
    ),
    '',
  ].join('\n')

  const chunkRequireSource = [
    `globalThis._NODE_TURBOPACK_CHUNK_REQUIRE ??= {}`,
    ...nodeChunkRequireEntries.map(
      ({ chunkPath, requirePath }) =>
        `globalThis._NODE_TURBOPACK_CHUNK_REQUIRE[${JSON.stringify(chunkPath)}] = () => require(${JSON.stringify(
          requirePath
        )})`
    ),
    '',
  ].join('\n')

  const rawFileSource = [
    `globalThis._NODE_RAW_FILES ??= {}`,
    ...nodeRawEntries.map(
      ({ filePath, value }) =>
        `globalThis._NODE_RAW_FILES[${JSON.stringify(filePath)}] = ${JSON.stringify(value)}`
    ),
    '',
  ].join('\n')

  const jsonFileSource = [
    `globalThis._NODE_JSON_FILES ??= {}`,
    ...nodeJsonEntries.map(
      ({ filePath, value }) =>
        `globalThis._NODE_JSON_FILES[${JSON.stringify(filePath)}] = ${JSON.stringify(value)}`
    ),
    '',
  ].join('\n')

  const evalManifestSource = [
    `globalThis._NODE_EVAL_MANIFESTS ??= {}`,
    ...nodeEvalManifestEntries.map(
      ({ filePath, value }) =>
        `globalThis._NODE_EVAL_MANIFESTS[${JSON.stringify(filePath)}] = ${JSON.stringify(value)}`
    ),
    '',
  ].join('\n')

  const chunkLoaderSource = [
    `await import('./runtime-env.mjs')`,
    ...copiedRuntimeImports.map((filePath) => {
      const relativePath = path.relative(generatedDir, filePath).split(path.sep).join('/')
      const normalizedPath = relativePath.startsWith('.') ? relativePath : `./${relativePath}`

      return `await import(${JSON.stringify(normalizedPath)})`
    }),
    '',
  ].join('\n')

  const nodeBootstrapSource = [
    `await import('./runtime-env.mjs')`,
    `await import('./raw-files.cjs')`,
    `await import('./json-files.cjs')`,
    `await import('./eval-manifests.cjs')`,
    `await import('./chunk-requires.cjs')`,
    '',
    `globalThis._NODE_ENTRY_LOADERS ??= {}`,
    ...nodeRouteOutputImports.map(
      ({ pathname, importPath }) =>
        `globalThis._NODE_ENTRY_LOADERS[${JSON.stringify(pathname)}] = () => import(${JSON.stringify(importPath)})`
    ),
    '',
  ].join('\n')

  const manifestSource = `export const manifest = ${JSON.stringify(workerManifest, null, 2)}\n`

  const workerEntrySource = [
    `import './generated/chunks.mjs'`,
    `import { manifest } from './generated/manifest.mjs'`,
    `import { createWorker } from './runtime-support/worker-runtime.mjs'`,
    ``,
    `export default createWorker(manifest)`,
    '',
  ].join('\n')

  await Promise.all([
    fs.writeFile(runtimeEnvPath, runtimeEnvSource),
    fs.writeFile(rawFilePath, rawFileSource),
    fs.writeFile(jsonFilePath, jsonFileSource),
    fs.writeFile(evalManifestPath, evalManifestSource),
    fs.writeFile(chunkRequirePath, chunkRequireSource),
    fs.writeFile(chunkLoaderPath, chunkLoaderSource),
    fs.writeFile(nodeBootstrapPath, nodeBootstrapSource),
    fs.writeFile(manifestPath, manifestSource),
    fs.writeFile(workerEntryPath, workerEntrySource),
    fs.writeFile(
      path.join(outputDir, 'build-manifest.json'),
      JSON.stringify(
        {
          runtimeEnv,
          copiedRuntimeImports,
          manifest: workerManifest,
          embeddedRawFiles: nodeRawEntries.map(({ filePath }) => filePath),
          embeddedJsonFiles: nodeJsonEntries.map(({ filePath }) => filePath),
          embeddedEvalManifests: nodeEvalManifestEntries.map(({ filePath }) => filePath),
        },
        null,
        2
      )
    ),
  ])
}

/** @type {import('next').NextAdapter} */
const adapter = {
  name: 'cloudflare-workers-minimal',

  async modifyConfig(config) {
    return {
      ...config,
      turbopack: {
        ...(config.turbopack ?? {}),
        root: config.turbopack?.root ?? process.cwd(),
      },
    }
  },

  async onBuildComplete({ outputs, routing, projectDir, repoRoot, distDir, buildId, config }) {
    const outputDir = path.join(path.dirname(distDir), '.adapter')
    const assetRoot = path.join(outputDir, 'assets')
    const runtimeRoot = path.join(outputDir, 'runtime')
    const runtimeRepoRoot = path.join(runtimeRoot, 'repo')
    const { edgeRouteOutputs, nodeRouteOutputs } = collectRouteRuntimeOutputs(outputs)
    const hasNodeRuntime = nodeRouteOutputs.length > 0

    validateUnsupportedFeatures({ outputs, edgeRouteOutputs, nodeRouteOutputs })

    await fs.rm(outputDir, { recursive: true, force: true })
    await fs.mkdir(assetRoot, { recursive: true })
    const prerenderDataRoutes = await resolvePrerenderDataRoutes({ outputs, distDir })

    for (const staticFile of outputs.staticFiles ?? []) {
      await copyAssetFile(staticFile.filePath, assetRoot, staticFile.pathname)
    }

    for (const prerender of outputs.prerenders ?? []) {
      if (!prerender.fallback?.filePath || prerender.fallback.initialRevalidate !== false) {
        continue
      }

      await copyAssetFile(prerender.fallback.filePath, assetRoot, prerender.pathname)
    }

    for (const prerenderDataRoute of prerenderDataRoutes) {
      await copyAssetFile(prerenderDataRoute.filePath, assetRoot, prerenderDataRoute.dataRoutePathname)
    }

    const orderedRuntimeImports = collectOrderedRuntimeImports({
      outputs,
      edgeRouteOutputs,
    })
    const runtimeSupportFiles = collectRuntimeSupportFiles({
      outputs,
      edgeRouteOutputs,
    })
    const runtimeEnv = collectRuntimeEnv({ outputs, edgeRouteOutputs, config })
    const copiedRuntimeImports = await copyRuntimeImportFiles({
      orderedRuntimeImports,
      projectDir,
      runtimeRoot,
    })
    await copyRuntimeSupportFiles({
      supportFiles: runtimeSupportFiles,
      projectDir,
      runtimeRoot,
    })
    const requiredServerFilesManifest = hasNodeRuntime
      ? await readJsonIfExists(path.join(distDir, 'required-server-files.json'))
      : null
    const serializedConfig = serializeConfig(config, requiredServerFilesManifest)
    let nextServerEntryRelative = null
    let nodeRouteOutputImports = []
    let nodeChunkRequireEntries = []
    let nodeRawEntries = []
    let nodeJsonEntries = []
    let nodeEvalManifestEntries = []

    if (hasNodeRuntime) {
      const runtimeFiles = await collectNodeRuntimeFiles({
        outputs,
        distDir,
        projectDir,
        repoRoot,
      })

      await copyNodeRuntimeFiles({
        runtimeFiles,
        runtimeRepoRoot,
      })
      await copyLocalProjectNodeModules({
        projectDir,
        runtimeRepoRoot,
      })

      nextServerEntryRelative = findNextServerEntryRelative(runtimeFiles)

      if (!nextServerEntryRelative) {
        throw new Error(
          'Could not find next/dist/server/next-server.js in the copied node runtime files'
        )
      }

      nodeRouteOutputImports = nodeRouteOutputs.map((output) => ({
        pathname: normalizeOutputPathname(output.pathname),
        importPath: toOutputImportPath({
          generatedDir: path.join(outputDir, 'generated'),
          runtimeRepoRoot,
          repoRoot,
          filePath: output.filePath,
        }),
      }))
      nodeChunkRequireEntries = buildNodeChunkRequireEntries({
        runtimeFiles,
        generatedDir: path.join(outputDir, 'generated'),
        runtimeRepoRoot,
        repoRoot,
        projectDirRelative: toPosixPath(path.relative(repoRoot, projectDir)),
        distDir: config.distDir || '.next',
      })
      nodeRawEntries = await buildNodeRawEntries({
        runtimeFiles,
        projectDirRelative: toPosixPath(path.relative(repoRoot, projectDir)),
        distDir: config.distDir || '.next',
      })
      nodeJsonEntries = await buildNodeJsonEntries({
        runtimeFiles,
        projectDirRelative: toPosixPath(path.relative(repoRoot, projectDir)),
        distDir: config.distDir || '.next',
      })
      nodeEvalManifestEntries = await buildNodeEvalManifestEntries({
        runtimeFiles,
        projectDirRelative: toPosixPath(path.relative(repoRoot, projectDir)),
        distDir: config.distDir || '.next',
      })
    }

    const assetMetadata = await buildAssetMetadata(outputs, prerenderDataRoutes)
    const workerManifest = buildWorkerManifest({
      buildId,
      assetMetadata,
      config,
      nextConfig: serializedConfig,
      outputs,
      prerenderDataRoutes,
      routing,
      edgeRouteOutputs,
      nodeRouteOutputs,
      nodeRuntime: hasNodeRuntime
        ? {
            enabled: true,
            runtimeRepoRootRelative: '.adapter/runtime/repo',
            projectDirRelative: toPosixPath(path.relative(repoRoot, projectDir)),
            distDir: config.distDir || '.next',
            nextConfig: serializedConfig,
            serverFilesManifest: requiredServerFilesManifest,
            nextServerEntryRelative,
            isTurbopackBuild: await pathExists(path.join(distDir, 'turbopack')),
            port: DEFAULT_NODE_PORT,
          }
        : null,
    })

    await writeGeneratedFiles({
      outputDir,
      runtimeEnv,
      copiedRuntimeImports,
      workerManifest,
      nodeRouteOutputImports,
      nodeChunkRequireEntries,
      nodeRawEntries,
      nodeJsonEntries,
      nodeEvalManifestEntries,
    })
  },
}

module.exports = adapter
