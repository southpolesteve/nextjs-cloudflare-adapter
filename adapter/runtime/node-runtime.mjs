import http, { createServer } from 'node:http'
import https from 'node:https'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { parse as parseNodeUrl, pathToFileURL } from 'node:url'

const BOOT_TIMEOUT_MS = 15000

function toBundlePath(relativePath = '') {
  const segments = String(relativePath)
    .split('/')
    .filter(Boolean)

  return path.join('/bundle', ...segments)
}

function toPosixPath(filePath = '') {
  return String(filePath).split(path.sep).join('/')
}

function setProcessCwd(nextCwd) {
  try {
    if (typeof process.chdir === 'function') {
      process.chdir(nextCwd)
    }
  } catch {}

  try {
    process.cwd = () => nextCwd
  } catch {}
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    const handleListening = () => {
      server.off('error', handleError)
      resolve()
    }

    const handleError = (error) => {
      server.off('listening', handleListening)
      reject(error)
    }

    server.once('listening', handleListening)
    server.once('error', handleError)
    server.listen(port)
  })
}

function createBootstrapState() {
  return {
    phase: 'idle',
    startedAt: null,
    completedAt: null,
    error: null,
    lastOutputPathname: null,
  }
}

function getNodeSidecarPort() {
  const rawPort = process.env.CLOUDFLARE_ADAPTER_NODE_SIDECAR_PORT
  const parsedPort = Number(rawPort)

  return Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : null
}

function shouldCreateHotFetchResponse(response) {
  if (!response?.body) {
    return false
  }

  const contentType = response.headers.get('content-type') || ''
  const transferEncoding = response.headers.get('transfer-encoding') || ''

  return (
    contentType.startsWith('text/plain') ||
    contentType.startsWith('text/event-stream') ||
    transferEncoding.toLowerCase().includes('chunked')
  )
}

function applyResponseMetadata(response, metadata = {}) {
  if (!response || typeof response !== 'object' || !metadata || typeof metadata !== 'object') {
    return response
  }

  const propertyDescriptors = {}

  if (typeof metadata.url === 'string' && metadata.url.length > 0) {
    propertyDescriptors.url = {
      configurable: true,
      value: metadata.url,
    }
  }

  if (typeof metadata.redirected === 'boolean') {
    propertyDescriptors.redirected = {
      configurable: true,
      value: metadata.redirected,
    }
  }

  if (Object.keys(propertyDescriptors).length > 0) {
    try {
      Object.defineProperties(response, propertyDescriptors)
    } catch {}
  }

  return response
}

function createResponseWithMetadata(sourceResponse, body, init) {
  const response = new Response(body, init)

  return applyResponseMetadata(response, {
    url: sourceResponse?.url,
    redirected: sourceResponse?.redirected,
  })
}

function stripAppPageDocumentValidators(response) {
  const headers = new Headers(response.headers)
  headers.delete('etag')
  headers.delete('last-modified')

  return createResponseWithMetadata(response, response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function createHotFetchResponse(response) {
  if (!shouldCreateHotFetchResponse(response)) {
    return response
  }

  const transform = new TransformStream()
  const reader = response.body.getReader()
  const writer = transform.writable.getWriter()

  void (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read()

        if (done) {
          break
        }

        await writer.write(value)
      }

      await writer.close()
    } catch (error) {
      const message = String(error?.message || error || '')

      if (
        /connection closed|premature close|aborted|socket hang up/i.test(message)
      ) {
        try {
          await writer.close()
        } catch {}
        return
      }

      try {
        await writer.abort(error)
      } catch {}
    }
  })()

  return createResponseWithMetadata(response, transform.readable, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  })
}

function createLineChunkedTextResponse(response) {
  if (!response?.body) {
    return response
  }

  const contentType = response.headers.get('content-type') || ''

  if (!contentType.startsWith('text/plain')) {
    return response
  }

  const sourceReader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let done = false
  const pendingChunks = []

  const stream = new ReadableStream({
    async pull(controller) {
      while (pendingChunks.length === 0 && !done) {
        const { value, done: sourceDone } = await sourceReader.read()

        if (sourceDone) {
          buffer += decoder.decode()
          if (buffer) {
            pendingChunks.push(buffer)
            buffer = ''
          }
          done = true
          break
        }

        buffer += decoder.decode(value, { stream: true })

        while (true) {
          const newlineIndex = buffer.indexOf('\n')

          if (newlineIndex === -1) {
            break
          }

          pendingChunks.push(buffer.slice(0, newlineIndex + 1))
          buffer = buffer.slice(newlineIndex + 1)
        }
      }

      if (pendingChunks.length > 0) {
        controller.enqueue(encoder.encode(pendingChunks.shift()))
        return
      }

      controller.close()
    },
    cancel(reason) {
      return sourceReader.cancel(reason)
    },
  })

  const headers = new Headers(response.headers)
  headers.delete('content-length')

  return createResponseWithMetadata(response, stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function createUncompressedStreamingResponse(response) {
  const headers = new Headers(response.headers)
  headers.set('content-encoding', 'identity')
  headers.delete('content-length')

  return createResponseWithMetadata(response, response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function isLoopbackUrl(url) {
  return (
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1')
  )
}

function isRedirectStatusCode(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function shouldNormalizeAppPageRscRedirectStatus(output, requestHeaders, response) {
  return (
    output?.type === 'APP_PAGE' &&
    requestHeaders instanceof Headers &&
    requestHeaders.get('rsc') === '1' &&
    isRedirectStatusCode(response?.status)
  )
}

async function fetchViaNodeHttp(request, redirectCount = 0) {
  const url = new URL(request.url)
  const transport = url.protocol === 'https:' ? https : http
  const hopByHopHeaders = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ])

  const response = await new Promise((resolve, reject) => {
    let settled = false
    let requestBodyStream = null

    const resolveOnce = (value) => {
      if (settled) {
        return
      }

      settled = true
      resolve(value)
    }

    const rejectOnce = (error) => {
      if (settled) {
        return
      }

      settled = true
      reject(error)
    }

    const stopRequestBodyStream = () => {
      if (!requestBodyStream) {
        return
      }

      requestBodyStream.unpipe(nodeRequest)
      requestBodyStream.destroy()
      requestBodyStream = null
    }

    const nodeRequest = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers: {
          ...Object.fromEntries(request.headers.entries()),
          'accept-encoding': 'identity',
        },
      },
      (nodeResponse) => {
        const headers = new Headers()

        for (const [key, value] of Object.entries(nodeResponse.headers)) {
          if (value === undefined) {
            continue
          }
          if (hopByHopHeaders.has(key.toLowerCase())) {
            continue
          }

          if (Array.isArray(value)) {
            for (const item of value) {
              headers.append(key, item)
            }
            continue
          }

          headers.set(key, value)
        }

        stopRequestBodyStream()

        resolveOnce(
          applyResponseMetadata(
            new Response(Readable.toWeb(nodeResponse), {
              status: nodeResponse.statusCode || 500,
              statusText: nodeResponse.statusMessage,
              headers,
            }),
            {
              url: url.toString(),
            }
          )
        )
      }
    )

    nodeRequest.once('error', rejectOnce)

    if (request.signal) {
      if (request.signal.aborted) {
        nodeRequest.destroy(request.signal.reason)
        rejectOnce(request.signal.reason)
        return
      }

      request.signal.addEventListener(
        'abort',
        () => {
          nodeRequest.destroy(request.signal.reason)
          rejectOnce(request.signal.reason)
        },
        { once: true }
      )
    }

    if (request.body) {
      requestBodyStream = Readable.fromWeb(request.body)
      requestBodyStream.once('error', rejectOnce)
      requestBodyStream.pipe(nodeRequest)
      return
    }

    nodeRequest.end()
  })

  if (
    request.redirect === 'follow' &&
    isRedirectStatusCode(response.status) &&
    response.headers.has('location')
  ) {
    if (redirectCount >= 20) {
      throw new TypeError('fetch failed')
    }

    const redirectUrl = new URL(response.headers.get('location'), request.url)
    let nextMethod = request.method
    let nextBody = request.body
    const nextHeaders = new Headers(request.headers)

    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && request.method === 'POST')
    ) {
      nextMethod = 'GET'
      nextBody = null
      nextHeaders.delete('content-length')
      nextHeaders.delete('content-type')
      nextHeaders.delete('transfer-encoding')
    }

    return fetchViaNodeHttp(
      new Request(redirectUrl, {
        method: nextMethod,
        headers: nextHeaders,
        body: nextBody,
        duplex: nextBody ? 'half' : undefined,
        redirect: request.redirect,
        signal: request.signal,
      }),
      redirectCount + 1
    )
  }

  if (request.redirect === 'error' && isRedirectStatusCode(response.status)) {
    throw new TypeError('fetch failed')
  }

  return createLineChunkedTextResponse(response)
}

function installFetchResponseWrapper() {
  if (globalThis.__CLOUDFLARE_ADAPTER_FETCH_WRAPPED) {
    return
  }

  const originalFetch = globalThis.fetch?.bind(globalThis)

  if (typeof originalFetch !== 'function') {
    return
  }

  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init)
    const response = isLoopbackUrl(new URL(request.url))
      ? await fetchViaNodeHttp(request)
      : await originalFetch(request)

    return createHotFetchResponse(response)
  }
  globalThis.__CLOUDFLARE_ADAPTER_FETCH_WRAPPED = true
}

function updateBootstrapState(state, phase, extra = {}) {
  Object.assign(state, { phase }, extra)
}

async function withTimeout(label, callback, timeoutMs = BOOT_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await Promise.race([
      callback(controller.signal),
      new Promise((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          { once: true }
        )
      }),
    ])
  } finally {
    clearTimeout(timeoutId)
  }
}

function getMatchedPathFromNodeDataOutput(pathname, buildId, basePath = '') {
  const prefix = `${basePath}/_next/data/${buildId}/`

  if (!pathname?.startsWith(prefix) || !pathname.endsWith('.json')) {
    return null
  }

  const normalized = pathname.slice(prefix.length, -'.json'.length)

  if (!normalized || normalized === 'index') {
    return `${basePath || ''}/`
  }

  return `${basePath}/${normalized}`
}

function parseRequestQuery(requestUrl) {
  if (!requestUrl) {
    return null
  }

  let url

  try {
    url = new URL(requestUrl, 'http://localhost')
  } catch {
    return null
  }

  const query = {}

  for (const [key, value] of url.searchParams.entries()) {
    const existing = query[key]

    if (existing === undefined) {
      query[key] = value
      continue
    }

    query[key] = Array.isArray(existing) ? [...existing, value] : [existing, value]
  }

  return query
}

function createRevalidateHandler(requestUrl) {
  let originUrl

  try {
    originUrl = new URL(requestUrl || '/', 'http://localhost')
  } catch {
    return undefined
  }

  return async ({ urlPath, headers, opts } = {}) => {
    if (typeof urlPath !== 'string' || !urlPath.startsWith('/')) {
      throw new Error(`Invalid urlPath provided to revalidate(): ${urlPath}`)
    }

    const revalidateUrl = new URL(urlPath, originUrl)
    const revalidateHeaders = new Headers()

    for (const [key, value] of Object.entries(headers ?? {})) {
      if (value === undefined) {
        continue
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          revalidateHeaders.append(key, item)
        }
        continue
      }

      revalidateHeaders.set(key, String(value))
    }

    const response = await fetch(revalidateUrl, {
      method: 'HEAD',
      headers: revalidateHeaders,
    })
    const cacheHeader =
      response.headers.get('x-vercel-cache') || response.headers.get('x-nextjs-cache')

    if (
      cacheHeader?.toUpperCase() !== 'REVALIDATED' &&
      response.status !== 200 &&
      !(response.status === 404 && opts?.unstable_onlyGenerated)
    ) {
      throw new Error(`Invalid response ${response.status}`)
    }
  }
}

function createOutputRequestMeta(manifest, output, request, requestMeta = {}, requestUrl) {
  const runtimeRepoRoot = toBundlePath(manifest.nodeRuntime.runtimeRepoRootRelative)
  const runtimeProjectDir = path.join(
    runtimeRepoRoot,
    ...String(manifest.nodeRuntime.projectDirRelative || '')
      .split('/')
      .filter(Boolean)
  )
  const absoluteDistDir = path.join(runtimeProjectDir, manifest.nodeRuntime.distDir)
  const initUrl = requestMeta.initURL || requestUrl || null
  const initQuery = requestMeta.initQuery || parseRequestQuery(initUrl)
  let initProtocol = requestMeta.initProtocol || null

  if (!initProtocol && initUrl) {
    try {
      initProtocol = new URL(initUrl).protocol.replace(/:+$/, '')
    } catch {}
  }

  const requestHeaders = request?.headers instanceof Headers ? request.headers : new Headers()
  const requestIsRsc = requestHeaders.get('rsc') === '1'
  const isPrefetchRscRequest = requestHeaders.get('next-router-prefetch') === '1'
  const segmentPrefetchRscRequest = requestHeaders.get('next-router-segment-prefetch')
  let requestPathname = null

  try {
    requestPathname = new URL(initUrl || requestUrl || '/', 'http://localhost').pathname
  } catch {}

  const requestNodeDataPath = requestPathname
    ? getMatchedPathFromNodeDataOutput(requestPathname, manifest.buildId, manifest.basePath)
    : null
  const outputNodeDataPath =
    typeof output?.pathname === 'string'
      ? getMatchedPathFromNodeDataOutput(output.pathname, manifest.buildId, manifest.basePath)
      : null
  const matchedNodeDataPath = requestNodeDataPath || outputNodeDataPath
  const shouldPreserveDynamicPagesOutputPath =
    !!requestNodeDataPath &&
    output?.type === 'PAGES' &&
    typeof output?.pathname === 'string' &&
    output.pathname.includes('[')

  let invokeOutput =
    shouldPreserveDynamicPagesOutputPath ? output.pathname : matchedNodeDataPath || output?.pathname

  if (
    output?.type === 'APP_PAGE' &&
    typeof invokeOutput === 'string' &&
    invokeOutput.endsWith('.rsc') &&
    !invokeOutput.includes('.segment.rsc') &&
    !invokeOutput.includes('.segments/')
  ) {
    invokeOutput = invokeOutput.slice(0, -'.rsc'.length) || '/'

    if (invokeOutput === '/index') {
      invokeOutput = '/'
    }
  }

  return {
    ...requestMeta,
    relativeProjectDir: manifest.nodeRuntime.projectDirRelative || '',
    distDir: absoluteDistDir,
    invokeOutput,
    revalidate: createRevalidateHandler(initUrl || requestUrl),
    ...(matchedNodeDataPath ? { isNextDataReq: true } : {}),
    ...(requestIsRsc ? { isRSCRequest: true } : {}),
    ...(isPrefetchRscRequest ? { isPrefetchRSCRequest: true } : {}),
    ...(typeof segmentPrefetchRscRequest === 'string'
      ? { segmentPrefetchRSCRequest: segmentPrefetchRscRequest }
      : {}),
    ...(initQuery ? { initQuery } : {}),
    ...(initUrl ? { initURL: initUrl } : {}),
    ...(initProtocol ? { initProtocol } : {}),
  }
}

function encodeRequestMetaHeader(requestMeta = {}) {
  return Buffer.from(JSON.stringify(requestMeta)).toString('base64')
}

function decodeRequestMetaHeader(headerValue) {
  const encodedValue = Array.isArray(headerValue) ? headerValue[0] : headerValue

  if (typeof encodedValue !== 'string' || encodedValue.length === 0) {
    return undefined
  }

  try {
    return JSON.parse(Buffer.from(encodedValue, 'base64').toString('utf8'))
  } catch {
    return undefined
  }
}

async function unwrapNodeModule(moduleNamespace) {
  let current = moduleNamespace
  const seen = new Set()

  while (
    current &&
    (typeof current === 'object' || typeof current === 'function') &&
    !seen.has(current)
  ) {
    seen.add(current)

    if (typeof current.then === 'function') {
      current = await current
      continue
    }

    if (typeof current.handler === 'function' || current.routeModule) {
      return current
    }

    const turbopackExportsSymbol = Object.getOwnPropertySymbols(current).find(
      (symbol) => symbol.description === 'turbopack exports'
    )

    if (
      turbopackExportsSymbol &&
      current[turbopackExportsSymbol] !== undefined &&
      current[turbopackExportsSymbol] !== current
    ) {
      current = current[turbopackExportsSymbol]
      continue
    }

    if (current.default !== undefined && current.default !== current) {
      current = current.default
      continue
    }

    if (current['module.exports'] !== undefined && current['module.exports'] !== current) {
      current = current['module.exports']
      continue
    }

    break
  }

  return current
}

function hasRequestBody(method) {
  return method !== 'GET' && method !== 'HEAD'
}

function toNodeRequestHeaders(headersLike = {}) {
  const headers = new Headers()

  for (const [key, value] of Object.entries(headersLike)) {
    if (value === undefined) {
      continue
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item)
      }
      continue
    }

    headers.set(key, value)
  }

  return headers
}

async function createBufferedNodeRequestBody(req, method) {
  if (!hasRequestBody(method)) {
    return null
  }

  const body = await new Response(Readable.toWeb(req)).arrayBuffer()
  return body.byteLength > 0 ? body : null
}

async function createWebRequestFromNodeRequest(
  req,
  {
    forwardedHost,
    forwardedProto,
  } = {}
) {
  const headers = toNodeRequestHeaders(req.headers)
  headers.delete('x-adapter-node-request-id')
  headers.delete('x-adapter-node-output-pathname')
  headers.delete('x-adapter-node-output-type')
  headers.delete('x-adapter-node-request-meta')
  headers.delete('x-adapter-forwarded-host')

  const protocol = forwardedProto || headers.get('x-forwarded-proto') || 'http'
  const host =
    forwardedHost ||
    headers.get('x-forwarded-host') ||
    headers.get('host') ||
    'localhost'
  const requestUrl = new URL(req.url || '/', `${protocol}://${host}`)
  const method = req.method || 'GET'
  const init = {
    method,
    headers,
  }

  const body = await createBufferedNodeRequestBody(req, method)

  if (body) {
    init.body = body
  }

  return new Request(requestUrl, init)
}

async function writeWebResponseToNodeResponse(res, response, method = 'GET') {
  res.statusCode = response.status
  if (response.statusText) {
    res.statusMessage = response.statusText
  }

  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      const setCookies =
        typeof response.headers.getSetCookie === 'function'
          ? response.headers.getSetCookie()
          : [value]
      res.setHeader(key, setCookies)
      return
    }

    res.setHeader(key, value)
  })

  if (!response.body || method === 'HEAD') {
    res.end()
    return
  }

  await new Promise((resolve, reject) => {
    const bodyStream = Readable.fromWeb(response.body)
    bodyStream.once('error', reject)
    res.once('error', reject)
    res.once('finish', resolve)
    bodyStream.pipe(res)
  })
}

function isMiddlewareStyleHandler(output, handler) {
  return output?.type === 'MIDDLEWARE' || handler?.length === 2
}

function normalizeOutputPathname(pathname) {
  if (typeof pathname !== 'string' || pathname.length === 0) {
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

function getImageOptimizerPathname(manifest) {
  const imagePath = manifest?.nodeRuntime?.nextConfig?.images?.path

  if (typeof imagePath !== 'string' || !imagePath.startsWith('/')) {
    return null
  }

  return normalizeOutputPathname(imagePath)
}

function getRuntimeProjectDir(manifest, runtimeRepoRoot) {
  const projectDirRelative = String(manifest?.nodeRuntime?.projectDirRelative || '')
    .split('/')
    .filter(Boolean)

  return projectDirRelative.length > 0
    ? path.join(runtimeRepoRoot, ...projectDirRelative)
    : runtimeRepoRoot
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

function isPathWithinRoot(filePath, rootDir) {
  const relativePath = path.relative(rootDir, filePath)
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

function getInternalStaticAssetContentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.avif':
      return 'image/avif'
    case '.bmp':
      return 'image/bmp'
    case '.gif':
      return 'image/gif'
    case '.ico':
      return 'image/x-icon'
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.svg':
      return 'image/svg+xml'
    case '.tif':
    case '.tiff':
      return 'image/tiff'
    case '.webp':
      return 'image/webp'
    default:
      return null
  }
}

async function tryServeInternalStaticAsset(req, res, manifest, runtimeRepoRoot) {
  const requestUrl = typeof req?.url === 'string' ? req.url : ''

  if (!requestUrl) {
    return false
  }

  let pathname

  try {
    pathname = new URL(requestUrl, 'http://localhost').pathname
  } catch {
    pathname = parseNodeUrl(requestUrl).pathname || '/'
  }

  const basePath = manifest?.basePath || ''
  const normalizedPathname =
    basePath && pathname.startsWith(`${basePath}/`)
      ? pathname.slice(basePath.length) || '/'
      : pathname
  const runtimeProjectDir = getRuntimeProjectDir(manifest, runtimeRepoRoot)
  const distDir = path.join(runtimeProjectDir, manifest?.nodeRuntime?.distDir || '.next')
  const publicDir = path.join(runtimeProjectDir, 'public')
  let assetRoot = null
  let assetRelativePath = null

  if (normalizedPathname.startsWith('/_next/static/')) {
    assetRoot = path.join(distDir, 'static')
    assetRelativePath = normalizedPathname.slice('/_next/static/'.length)
  } else if (!normalizedPathname.startsWith('/_next/')) {
    assetRoot = publicDir
    assetRelativePath = normalizedPathname.replace(/^\/+/, '')
  }

  if (!assetRoot || !assetRelativePath) {
    return false
  }

  let decodedRelativePath

  try {
    decodedRelativePath = decodeURIComponent(assetRelativePath)
  } catch {
    return false
  }

  const assetPath = path.resolve(assetRoot, decodedRelativePath)

  if (!isPathWithinRoot(assetPath, assetRoot)) {
    return false
  }

  if (!(await pathExists(assetPath))) {
    return false
  }

  const assetStats = await fs.stat(assetPath).catch(() => null)

  if (!assetStats?.isFile()) {
    return false
  }

  const contentType = getInternalStaticAssetContentType(assetPath)

  res.statusCode = 200

  if (contentType) {
    res.setHeader('Content-Type', contentType)
  }

  res.setHeader('Content-Length', String(assetStats.size))
  res.setHeader(
    'Cache-Control',
    normalizedPathname.startsWith('/_next/static/')
      ? 'public, immutable, max-age=31536000'
      : 'public, max-age=0, must-revalidate'
  )

  if ((req.method || 'GET').toUpperCase() === 'HEAD') {
    res.end()
    return true
  }

  res.end(await fs.readFile(assetPath))
  return true
}

function getNextServerImportSpecifier(manifest, runtimeRepoRoot) {
  const nextServerEntryRelative = manifest?.nodeRuntime?.nextServerEntryRelative

  if (typeof nextServerEntryRelative !== 'string' || nextServerEntryRelative.length === 0) {
    return null
  }

  const nextServerWrapperRelative = nextServerEntryRelative.replace(/next-server\.js$/, 'next.js')
  return pathToFileURL(path.join(runtimeRepoRoot, nextServerWrapperRelative)).href
}

function getNextRequestMetaImportSpecifier(manifest, runtimeRepoRoot) {
  const nextServerEntryRelative = manifest?.nodeRuntime?.nextServerEntryRelative

  if (typeof nextServerEntryRelative !== 'string' || nextServerEntryRelative.length === 0) {
    return null
  }

  const requestMetaRelative = nextServerEntryRelative.replace(/next-server\.js$/, 'request-meta.js')
  return pathToFileURL(path.join(runtimeRepoRoot, requestMetaRelative)).href
}

function getNextNodeHttpImportSpecifier(manifest, runtimeRepoRoot) {
  const nextServerEntryRelative = manifest?.nodeRuntime?.nextServerEntryRelative

  if (typeof nextServerEntryRelative !== 'string' || nextServerEntryRelative.length === 0) {
    return null
  }

  const nodeHttpRelative = nextServerEntryRelative.replace(/next-server\.js$/, 'base-http/node.js')
  return pathToFileURL(path.join(runtimeRepoRoot, nodeHttpRelative)).href
}

const loadCreateNextServer = new Function('specifier', 'return import(specifier)')

function createSyntheticImageOptimizerModule(manifest, runtimeRepoRoot) {
  let serverPromise
  let internalServerPromise
  let requestHandlerPromise
  let setRequestMetaPromise
  let nodeHttpClassesPromise

  return {
    async handler(req, res, ctx) {
      ctx ||= {}
      serverPromise ??= (async () => {
        const specifier = getNextServerImportSpecifier(manifest, runtimeRepoRoot)

        if (!specifier) {
          throw new Error('Missing nextServerEntryRelative for image optimizer route')
        }

        const nextServerModule = await loadCreateNextServer(specifier)
        const createNextServer = nextServerModule.default

        if (typeof createNextServer !== 'function') {
          throw new Error('Next server factory was not found for image optimizer route')
        }

        return createNextServer({
          dir: getRuntimeProjectDir(manifest, runtimeRepoRoot),
          dev: false,
          customServer: false,
          quiet: true,
          hostname: '127.0.0.1',
          port: Number(process.env.PORT || 0),
          conf: JSON.parse(process.env.__NEXT_PRIVATE_STANDALONE_CONFIG || '{}'),
        })
      })().catch((error) => {
        serverPromise = undefined
        throw error
      })

      internalServerPromise ??= serverPromise.then(async (server) =>
        typeof server?.getServer === 'function' ? server.getServer() : server
      )
      requestHandlerPromise ??= serverPromise.then((server) => {
        const requestHandler = server?.getRequestHandler?.()

        if (typeof requestHandler !== 'function') {
          throw new Error('Next request handler was not found for image optimizer route')
        }

        return requestHandler
      })
      setRequestMetaPromise ??= (async () => {
        const specifier = getNextRequestMetaImportSpecifier(manifest, runtimeRepoRoot)

        if (!specifier) {
          throw new Error('Missing request-meta entry for image optimizer route')
        }

        const requestMetaModule = await loadCreateNextServer(specifier)
        const setRequestMeta = requestMetaModule?.setRequestMeta

        if (typeof setRequestMeta !== 'function') {
          throw new Error('Next request metadata helper was not found for image optimizer route')
        }

        return setRequestMeta
      })()
      nodeHttpClassesPromise ??= (async () => {
        const specifier = getNextNodeHttpImportSpecifier(manifest, runtimeRepoRoot)

        if (!specifier) {
          throw new Error('Missing base-http entry for image optimizer route')
        }

        const nodeHttpModule = await loadCreateNextServer(specifier)
        const { NodeNextRequest, NodeNextResponse } = nodeHttpModule ?? {}

        if (typeof NodeNextRequest !== 'function' || typeof NodeNextResponse !== 'function') {
          throw new Error('Next node request/response helpers were not found for image optimizer route')
        }

        return {
          NodeNextRequest,
          NodeNextResponse,
        }
      })()

      const [requestHandler, setRequestMeta] = await Promise.all([
        requestHandlerPromise,
        setRequestMetaPromise,
      ])
      const internalServer = await internalServerPromise
      if (internalServer && typeof internalServer === 'object' && !internalServer.routerServerHandler) {
        internalServer.routerServerHandler = async (nodeReq, nodeRes) => {
          if (await tryServeInternalStaticAsset(nodeReq, nodeRes, manifest, runtimeRepoRoot)) {
            return
          }

          return requestHandler(nodeReq, nodeRes)
        }
      }
      const { NodeNextRequest, NodeNextResponse } = await nodeHttpClassesPromise
      const normalizedReq =
        req instanceof NodeNextRequest ? req : new NodeNextRequest(req)
      const normalizedRes =
        res instanceof NodeNextResponse ? res : new NodeNextResponse(res)

      if (ctx?.requestMeta) {
        setRequestMeta(normalizedReq, ctx.requestMeta)
      }

      if (typeof internalServer?.handleNextImageRequest === 'function') {
        const parsedUrl = parseNodeUrl(normalizedReq.url || req.url || '/', true)
        const handled = await internalServer.handleNextImageRequest(
          normalizedReq,
          normalizedRes,
          parsedUrl
        )

        if (handled) {
          return
        }
      }

      return requestHandler(req, res)
    },
  }
}

async function loadNodeEntry(outputPathname, moduleCache, manifest, runtimeRepoRoot) {
  if (moduleCache.has(outputPathname)) {
    return moduleCache.get(outputPathname)
  }

  const imageOptimizerPathname = getImageOptimizerPathname(manifest)

  if (imageOptimizerPathname && outputPathname === imageOptimizerPathname) {
    const syntheticModule = createSyntheticImageOptimizerModule(manifest, runtimeRepoRoot)
    moduleCache.set(outputPathname, syntheticModule)
    return syntheticModule
  }

  const loader = globalThis._NODE_ENTRY_LOADERS?.[outputPathname]

  if (typeof loader !== 'function') {
    throw new Error(`Node entry loader was not registered for ${outputPathname}`)
  }

  const loadedModule = await unwrapNodeModule(await loader())
  moduleCache.set(outputPathname, loadedModule)

  return loadedModule
}

function getErrorOutputPathname(manifest) {
  const basePath = manifest.basePath || ''
  const candidates = [`${basePath}/500`, `${basePath}/_error`]

  for (const candidate of candidates) {
    if (typeof globalThis._NODE_ENTRY_LOADERS?.[candidate] === 'function') {
      return candidate
    }
  }

  return null
}

function applyPagesFallbackStatusCode(res, outputPathname, requestMeta = {}) {
  if (!outputPathname || res.headersSent) {
    return
  }

  if (
    requestMeta?.adapterRenderNotFound &&
    (outputPathname.endsWith('/_error') || outputPathname.endsWith('/404'))
  ) {
    res.statusCode =
      Number.isInteger(requestMeta.adapterRenderStatusCode) &&
      requestMeta.adapterRenderStatusCode > 0
        ? requestMeta.adapterRenderStatusCode
        : 404
  }
}

function getNodeRequestUrl(req) {
  const headers = toNodeRequestHeaders(req?.headers)
  const protocol = headers.get('x-forwarded-proto') || 'http'
  const host = headers.get('x-forwarded-host') || headers.get('host') || 'localhost'

  return new URL(req?.url || '/', `${protocol}://${host}`).toString()
}

async function renderPagesErrorResponse({
  req,
  res,
  manifest,
  moduleCache,
  requestMeta,
  waitUntil,
}) {
  const errorOutputPathname = getErrorOutputPathname(manifest)

  if (!errorOutputPathname) {
    return null
  }

  const runtimeRepoRoot = toBundlePath(manifest.nodeRuntime.runtimeRepoRootRelative)
  const outputModule = await loadNodeEntry(
    errorOutputPathname,
    moduleCache,
    manifest,
    runtimeRepoRoot
  )
  const handler = outputModule?.handler

  if (typeof handler !== 'function') {
    return null
  }

  const errorOutput = {
    pathname: errorOutputPathname,
    type: 'PAGES',
  }
  const requestHeaders = toNodeRequestHeaders(req.headers)
  const requestUrl = getNodeRequestUrl(req)

  req.headers['x-adapter-node-output-pathname'] = errorOutputPathname
  req.headers['x-adapter-node-output-type'] = 'PAGES'

  const errorRequestMeta = createOutputRequestMeta(
    manifest,
    errorOutput,
    {
      headers: requestHeaders,
      url: requestUrl,
    },
    requestMeta,
    requestUrl
  )

  res.statusCode = 500

  if (isMiddlewareStyleHandler(errorOutput, handler)) {
    const response = await handler(
      await createWebRequestFromNodeRequest(req),
      {
        waitUntil,
        requestMeta: errorRequestMeta,
      }
    )

    await writeWebResponseToNodeResponse(res, response, req.method)
    return errorOutputPathname
  }

  await handler(req, res, {
    waitUntil,
    requestMeta: errorRequestMeta,
  })

  return errorOutputPathname
}

let cloudflareNodeModulePromise
let nodeBootstrapPromise
let localDevConfigPromise

async function getConfiguredNodeSidecarPort() {
  localDevConfigPromise ??= import('../generated/local-dev-config.mjs').catch(() => ({
    nodeSidecarPort: null,
  }))

  const localDevConfig = await localDevConfigPromise
  const configuredPort = Number(localDevConfig?.nodeSidecarPort ?? getNodeSidecarPort())

  return Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : null
}

async function getHandleAsNodeRequest() {
  cloudflareNodeModulePromise ??= import('cloudflare:node')
  const cloudflareNodeModule = await cloudflareNodeModulePromise
  return cloudflareNodeModule.handleAsNodeRequest
}

async function ensureNodeBootstrapLoaded() {
  nodeBootstrapPromise ??= import('../generated/node-bootstrap.mjs')
  return nodeBootstrapPromise
}

async function startNodeServer(manifest, requestContexts, moduleCache, bootstrapState) {
  const runtimeRepoRoot = toBundlePath(manifest.nodeRuntime.runtimeRepoRootRelative)

  globalThis.self ??= globalThis
  setProcessCwd(runtimeRepoRoot)
  installFetchResponseWrapper()

  process.env.NODE_ENV ??= 'production'
  process.env.__NEXT_RELATIVE_DIST_DIR = manifest.nodeRuntime.distDir
  process.env.__NEXT_RELATIVE_PROJECT_DIR = manifest.nodeRuntime.projectDirRelative || ''

  if (manifest.buildId) {
    process.env.__NEXT_BUILD_ID = manifest.buildId
  }

  if (manifest.nodeRuntime.isTurbopackBuild) {
    process.env.TURBOPACK ??= '1'
  }

  if (manifest.nodeRuntime.nextConfig) {
    process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(manifest.nodeRuntime.nextConfig)
  }

  if (manifest.nodeRuntime.serverFilesManifest) {
    globalThis.__SERVER_FILES_MANIFEST = manifest.nodeRuntime.serverFilesManifest
    globalThis.self.__SERVER_FILES_MANIFEST = manifest.nodeRuntime.serverFilesManifest
  }

  updateBootstrapState(bootstrapState, 'creating-http-server')

  const server = createServer((req, res) => {
    void (async () => {
      req.headers.connection = 'close'
      res.shouldKeepAlive = false
      res.setHeader('connection', 'close')

      const requestId = Array.isArray(req.headers['x-adapter-node-request-id'])
        ? req.headers['x-adapter-node-request-id'][0]
        : req.headers['x-adapter-node-request-id']
      const outputPathname = Array.isArray(req.headers['x-adapter-node-output-pathname'])
        ? req.headers['x-adapter-node-output-pathname'][0]
        : req.headers['x-adapter-node-output-pathname']
      const outputType = Array.isArray(req.headers['x-adapter-node-output-type'])
        ? req.headers['x-adapter-node-output-type'][0]
        : req.headers['x-adapter-node-output-type']
      const requestContext = requestId ? requestContexts.get(requestId) : undefined
      const headerRequestMeta = decodeRequestMetaHeader(req.headers['x-adapter-node-request-meta'])
      const resolvedRequestMeta = requestContext?.requestMeta ?? headerRequestMeta
      const resolvedWaitUntil = requestContext?.waitUntil

      try {
        if (!outputPathname) {
          throw new Error('Missing x-adapter-node-output-pathname header')
        }

        updateBootstrapState(bootstrapState, 'loading-output', {
          error: null,
          lastOutputPathname: outputPathname,
        })

        const outputModule = await loadNodeEntry(
          outputPathname,
          moduleCache,
          manifest,
          runtimeRepoRoot
        )
        const handler = outputModule?.handler

        if (typeof handler !== 'function') {
          throw new Error(`Node output handler was not found for ${outputPathname}`)
        }

        updateBootstrapState(bootstrapState, 'handling-request', {
          error: null,
          lastOutputPathname: outputPathname,
        })
        applyPagesFallbackStatusCode(res, outputPathname, resolvedRequestMeta)

        if (isMiddlewareStyleHandler(requestContext?.output, handler)) {
          const response = await handler(
            await createWebRequestFromNodeRequest(req, {
              forwardedHost: req.headers['x-forwarded-host'],
              forwardedProto: req.headers['x-forwarded-proto'],
            }),
            {
              waitUntil: resolvedWaitUntil,
              requestMeta: resolvedRequestMeta,
            }
          )

          await writeWebResponseToNodeResponse(res, response, req.method)
        } else {
          await handler(req, res, {
            waitUntil: resolvedWaitUntil,
            requestMeta: resolvedRequestMeta,
          })
        }

        updateBootstrapState(bootstrapState, 'ready', {
          completedAt: new Date().toISOString(),
          error: null,
          lastOutputPathname: outputPathname,
        })
      } catch (error) {
        updateBootstrapState(bootstrapState, 'request-failed', {
          completedAt: new Date().toISOString(),
          error: error?.stack || String(error),
          lastOutputPathname: outputPathname || null,
        })
        console.error('Cloudflare adapter node output failed')
        console.error(error?.stack || error)

        const canRenderPagesError =
          !res.headersSent &&
          (requestContext?.output?.type === 'PAGES' || outputType === 'PAGES') &&
          typeof outputPathname === 'string' &&
          !outputPathname.includes('/_next/data/') &&
          !outputPathname.endsWith('/_error') &&
          !outputPathname.endsWith('/500')

        if (canRenderPagesError) {
          try {
            const renderedErrorOutputPathname = await renderPagesErrorResponse({
              req,
              res,
              manifest,
              moduleCache,
              requestMeta: resolvedRequestMeta,
              waitUntil: resolvedWaitUntil,
            })

            if (renderedErrorOutputPathname) {
              updateBootstrapState(bootstrapState, 'ready', {
                completedAt: new Date().toISOString(),
                error: null,
                lastOutputPathname: renderedErrorOutputPathname,
              })
              return
            }
          } catch (renderError) {
            console.error('Cloudflare adapter node runtime failed to render pages error')
            console.error(renderError?.stack || renderError)
          }
        }

        if (!res.headersSent) {
          res.statusCode = 500
          res.end('Internal Server Error')
        } else {
          res.destroy(error)
        }
      } finally {
        if (requestId) {
          requestContexts.delete(requestId)
        }
      }
    })()
  })

  updateBootstrapState(bootstrapState, 'listening')
  await withTimeout('server.listen()', () => listen(server, manifest.nodeRuntime.port))
  updateBootstrapState(bootstrapState, 'ready', {
    completedAt: new Date().toISOString(),
  })
}

function createRequestWithNodeHeaders(
  request,
  headers,
  requestUrl = request.url,
  redirect = request.redirect
) {
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  headers.set('accept-encoding', 'identity')
  const init = {
    method: request.method,
    headers,
    redirect,
  }

  if (hasBody) {
    init.body = request.body
    init.duplex = request.body ? 'half' : undefined
  } else if (!headers.has('content-length') && !headers.has('transfer-encoding')) {
    headers.set('content-length', '0')
  }

  return new Request(requestUrl, init)
}

function createSidecarNodeRequest(request, headers, sidecarPort, requestMeta = {}) {
  const sidecarUrl = new URL(request.url)
  sidecarUrl.protocol = 'http:'
  sidecarUrl.hostname = '127.0.0.1'
  sidecarUrl.port = String(sidecarPort)

  const originalUrl = new URL(request.url)
  const originalHost = request.headers.get('host')
  if (originalHost) {
    headers.set('x-adapter-forwarded-host', originalHost)
    headers.set('x-forwarded-host', originalHost)
  }
  headers.set('x-forwarded-proto', originalUrl.protocol.slice(0, -1))
  headers.set(
    'x-forwarded-port',
    originalUrl.port || (originalUrl.protocol === 'https:' ? '443' : '80')
  )

  headers.delete('keep-alive')
  headers.set('connection', 'close')
  headers.set('x-adapter-node-request-meta', encodeRequestMetaHeader(requestMeta))

  return createRequestWithNodeHeaders(request, headers, sidecarUrl.toString(), 'manual')
}

async function finalizeNodeResponse(request, response, output) {
  const url = new URL(request.url)
  const requestHeaders = request.headers instanceof Headers ? request.headers : new Headers(request.headers)
  const contentType = response.headers.get('content-type') || ''
  const transferEncoding = response.headers.get('transfer-encoding') || ''
  const isAppPageDocumentResponse =
    output?.type === 'APP_PAGE' &&
    requestHeaders.get('rsc') !== '1' &&
    contentType.startsWith('text/html')
  const isPlainTextStream =
    contentType.startsWith('text/plain') || contentType.startsWith('text/event-stream')
  const isFlightResponse = contentType.startsWith('text/x-component')
  const isChunked = transferEncoding.toLowerCase().includes('chunked')
  const shouldBufferByContentType =
    contentType.startsWith('text/') ||
    contentType.startsWith('application/json') ||
    contentType.startsWith('application/xhtml+xml') ||
    contentType.startsWith('application/xml')

  if (isFlightResponse) {
    return createHotFetchResponse(createUncompressedStreamingResponse(response))
  }

  if (isAppPageDocumentResponse) {
    return createHotFetchResponse(
      createUncompressedStreamingResponse(stripAppPageDocumentValidators(response))
    )
  }

  if (
    isPlainTextStream ||
    isChunked ||
    (!url.pathname.includes('/_next/data/') && !shouldBufferByContentType)
  ) {
    return createHotFetchResponse(createUncompressedStreamingResponse(response))
  }

  const headers = new Headers(response.headers)
  const body = request.method === 'HEAD' ? null : await response.arrayBuffer()

  return createResponseWithMetadata(response, body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export function createNodeRuntime(manifest) {
  const bootstrapState = createBootstrapState()
  const requestContexts = new Map()
  const moduleCache = new Map()
  let nextRequestId = 0
  let serverPromise

  function ensureServerStarted() {
    if (serverPromise) {
      return serverPromise
    }

    serverPromise = (async () => {
      updateBootstrapState(bootstrapState, 'loading-node-bootstrap', {
        startedAt: new Date().toISOString(),
        completedAt: null,
        error: null,
      })

      await ensureNodeBootstrapLoaded()

      updateBootstrapState(bootstrapState, 'starting', {
        error: null,
      })

      await startNodeServer(manifest, requestContexts, moduleCache, bootstrapState)
    })().catch((error) => {
      serverPromise = undefined
      updateBootstrapState(bootstrapState, 'failed', {
        completedAt: new Date().toISOString(),
        error: error?.stack || String(error),
      })
      console.error('Cloudflare adapter node runtime bootstrap failed')
      console.error(error?.stack || error)
      throw error
    })

    return serverPromise
  }

  return {
    async fetch(request, { output, executionCtx, requestMeta } = {}) {
      const url = new URL(request.url)
      const sidecarPort = await getConfiguredNodeSidecarPort()

      if (url.pathname === '/_adapter/status') {
        return Response.json(bootstrapState)
      }

      if (!output?.pathname) {
        throw new Error('Missing output metadata for node runtime fetch')
      }

      const headers = new Headers(request.headers)
      const invocationId =
        headers.get('x-invocation-id') || `adapter-${Date.now()}-${++nextRequestId}`

      headers.set('x-invocation-id', invocationId)
      headers.set('x-adapter-node-output-pathname', output.pathname)
      headers.set('x-adapter-node-output-type', output.type || '')

      let response
      let responsePhase = bootstrapState.phase
      const outputRequestMeta = createOutputRequestMeta(
        manifest,
        output,
        request,
        requestMeta,
        request.url
      )

      if (sidecarPort) {
        responsePhase = 'sidecar'
        if (output?.type === 'APP_PAGE' && request.headers.get('rsc') !== '1') {
          headers.delete('if-none-match')
          headers.delete('if-modified-since')
        }

        response = await fetch(createSidecarNodeRequest(request, headers, sidecarPort, outputRequestMeta))
      } else {
        await ensureServerStarted()

        const requestId = invocationId

        requestContexts.set(requestId, {
          waitUntil: executionCtx?.waitUntil?.bind(executionCtx),
          requestMeta: outputRequestMeta,
          output,
        })

        headers.set('x-adapter-node-request-id', requestId)
        response = await (await getHandleAsNodeRequest())(
          manifest.nodeRuntime.port,
          createRequestWithNodeHeaders(request, headers)
        )
        responsePhase = bootstrapState.phase
      }

      const finalizedResponse = await finalizeNodeResponse(request, response, output)
      const normalizedStatus = shouldNormalizeAppPageRscRedirectStatus(
        output,
        request.headers,
        finalizedResponse
      )
        ? 200
        : finalizedResponse.status
      const responseWithMutableHeaders = new Response(finalizedResponse.body, {
        status: normalizedStatus,
        statusText: finalizedResponse.statusText,
        headers: new Headers(finalizedResponse.headers),
      })

      responseWithMutableHeaders.headers.set('x-adapter-node-phase', responsePhase)
      responseWithMutableHeaders.headers.set('x-adapter-node-output', output.pathname)
      return responseWithMutableHeaders
    },
  }
}
