import { cp, mkdir, readdir as fsReaddir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import type { NextAdapter } from "next";
import * as esbuild from "esbuild";

const ADAPTER_NAME = "cloudflare-workers";
const DEFAULT_OUT_DIR = ".cloudflare";
const NEXT_SERVER_PORT = 3000;

type BuildCompleteContext = Parameters<
  NonNullable<NextAdapter["onBuildComplete"]>
>[0];

interface CloudflareAdapterOptions {
  outDir?: string;
  kvNamespace?: string;
  skipWranglerConfig?: boolean;
}

const BUILD_TIME_CACHE_HANDLER_STUB = ".next-cloudflare-cache-handler.cjs";
const RUNTIME_CACHE_HANDLER = "cloudflare-cache-handler.js";
const TURBO_RUNTIME_CACHE_HANDLER_SPECIFIER = "../../../../../../../cloudflare-cache-handler.js";
const TURBO_RUNTIME_INSTRUMENTATION_SPECIFIER = "../../../../../../instrumentation.js";

function resolveOutDir(projectDir: string, configuredOutDir: string): string {
  if (path.isAbsolute(configuredOutDir)) return configuredOutDir;
  return path.join(projectDir, configuredOutDir);
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

/**
 * Copy static files into the assets directory for Workers Static Assets.
 */
async function stageStaticAssets(
  ctx: BuildCompleteContext,
  outDir: string
): Promise<void> {
  const assetsDir = path.join(outDir, "assets");
  await mkdir(assetsDir, { recursive: true });

  for (const staticFile of ctx.outputs.staticFiles) {
    const destPath = path.join(assetsDir, staticFile.pathname);
    await mkdir(path.dirname(destPath), { recursive: true });
    await cp(staticFile.filePath, destPath, { recursive: true });
  }

  // Copy the public/ directory (images, fonts, etc. that Next.js serves
  // via the static file server). The adapter API's staticFiles doesn't
  // include these, so we copy them directly.
  const publicDir = path.join(ctx.projectDir, "public");
  try {
    const publicStat = await stat(publicDir);
    if (publicStat.isDirectory()) {
      await cp(publicDir, assetsDir, { recursive: true, force: true });
      console.log(`[${ADAPTER_NAME}] Copied public/ directory to assets`);
    }
  } catch {
    // No public directory
  }

  for (const prerender of ctx.outputs.prerenders) {
    if (!prerender.fallback?.filePath) continue;
    const ext = path.extname(prerender.fallback.filePath) || ".html";
    const dest = prerender.pathname.endsWith(ext)
      ? prerender.pathname
      : prerender.pathname + ext;
    const destPath = path.join(assetsDir, dest);
    await mkdir(path.dirname(destPath), { recursive: true });
    try {
      await cp(prerender.fallback.filePath, destPath);
    } catch {
      // OK
    }
  }
}

/**
 * Collect all traced dependency files from all outputs.
 */
function collectTracedFiles(ctx: BuildCompleteContext): Map<string, string> {
  const files = new Map<string, string>();

  const allOutputs = [
    ...ctx.outputs.appPages,
    ...ctx.outputs.appRoutes,
    ...ctx.outputs.pages,
    ...ctx.outputs.pagesApi,
  ];

  if (ctx.outputs.middleware) {
    allOutputs.push(ctx.outputs.middleware as any);
  }

  for (const output of allOutputs) {
    const relFilePath = path.relative(ctx.repoRoot, output.filePath);
    files.set(relFilePath, output.filePath);

    if (output.assets) {
      for (const [relativePath, absolutePath] of Object.entries(output.assets)) {
        files.set(relativePath, absolutePath);
      }
    }
  }

  return files;
}

/**
 * Copy traced route handler files (.next/server/app/**, chunks, etc.)
 * These are the individual CJS modules that the Next.js server loads
 * dynamically at request time. They get uploaded via wrangler `rules`.
 */
async function stageTracedFiles(
  ctx: BuildCompleteContext,
  outDir: string
): Promise<void> {
  const tracedFiles = collectTracedFiles(ctx);
  const relativeProjectDir = path.relative(ctx.repoRoot, ctx.projectDir);

  console.log(
    `[${ADAPTER_NAME}] Copying ${tracedFiles.size} traced dependency files...`
  );

  for (const [relativePath, absolutePath] of tracedFiles) {
    // Skip native modules, platform binaries, and ESM-only modules
    if (
      relativePath.endsWith(".node") ||
      relativePath.includes("sharp-darwin") ||
      relativePath.includes("sharp-linux") ||
      relativePath.includes("sharp-win") ||
      relativePath.includes("libvips") ||
      relativePath.includes("@vercel/og")
    ) {
      continue;
    }

    let destRelative: string;
    if (relativePath.startsWith(relativeProjectDir + "/")) {
      destRelative = relativePath.slice(relativeProjectDir.length + 1);
    } else {
      const relToProject = path.relative(relativeProjectDir, relativePath);
      destRelative = relToProject;
    }

    const destPath = path.join(outDir, destRelative);
    await mkdir(path.dirname(destPath), { recursive: true });
    try {
      const fileStat = await stat(absolutePath);
      if (fileStat.isFile()) {
        await cp(absolutePath, destPath, { force: true });
      } else if (fileStat.isDirectory()) {
        await cp(absolutePath, destPath, { recursive: true, force: true });
      }
    } catch {
      // Optional deps might not exist
    }
  }
}

/**
 * Bundle the turbopack page/route runtimes with esbuild.
 *
 * These files (app-page-turbo.runtime.prod.js, app-route-turbo.runtime.prod.js)
 * are loaded by route handlers at request time. They contain hundreds of
 * require() calls without .js extensions, which Workers' CJS module loader
 * can't resolve. Bundling them resolves all internal requires at build time.
 */
async function bundleTurboRuntimes(
  ctx: BuildCompleteContext,
  dotNextDest: string
): Promise<void> {
  const nextCompiledDir = path.join(
    ctx.projectDir, "node_modules", "next", "dist", "compiled", "next-server"
  );
  const runtimes = [
    { file: "app-page-turbo.runtime.prod.js", prefix: "server/chunks/ssr" },
    { file: "app-page-turbo-experimental.runtime.prod.js", prefix: "server/chunks/ssr" },
    { file: "app-route-turbo.runtime.prod.js", prefix: "server/chunks/ssr" },
  ];

  for (const { file, prefix } of runtimes) {
    const src = path.join(nextCompiledDir, file);
    const destDir = path.join(dotNextDest, prefix, "next", "dist", "compiled", "next-server");
    const destFile = path.join(destDir, file);

    try {
      await stat(src);
    } catch {
      continue; // Runtime file doesn't exist
    }

    await mkdir(destDir, { recursive: true });

    // Bundle with esbuild to resolve all internal requires
    const result = await esbuild.build({
      entryPoints: [src],
      bundle: true,
      outfile: destFile,
      format: "cjs",
      target: "esnext",
      platform: "node",
      external: [
        // Node builtins
        "node:*",
        "child_process", "cluster", "dgram", "dns", "tls", "net", "v8",
        // Optional deps
        "critters", "webpack", "webpack/*", "@opentelemetry/api",
        // Source maps
        "*.map",
      ],
      plugins: [createCloudflareNextPlugin()],
      absWorkingDir: ctx.projectDir,
      logLevel: "warning",
      keepNames: true,
    });

    // Post-process: fix __require back to require for dynamic loads
    let code = await readFile(destFile, "utf-8");
    code = code
      .replace(/__require\d*\(/g, "require(")
      .replace(/__require\d*\./g, "require.")
      .replace(
        "return (0, i2.pathToFileURL)(r3).toString();",
        [
          `if (r3.endsWith("/.next/${RUNTIME_CACHE_HANDLER}") || r3.endsWith(a2().sep + ".next" + a2().sep + "${RUNTIME_CACHE_HANDLER}")) {`,
          `  return "${TURBO_RUNTIME_CACHE_HANDLER_SPECIFIER}";`,
          "}",
          "return (0, i2.pathToFileURL)(r3).toString();",
        ].join("\n")
      )
      .replace(
        'await require(_nodepath.default.join(projectDir, distDir, "server", `${_constants.INSTRUMENTATION_HOOK_FILENAME}.js`))',
        `await require("${TURBO_RUNTIME_INSTRUMENTATION_SPECIFIER}")`
      )
      .replace(
        "i10 = rW(await uc(e11(this.distDir, s10)));",
        `i10 = rW(require("${TURBO_RUNTIME_CACHE_HANDLER_SPECIFIER}"));`
      )
      .replace(
        "(0, tw.XJ)(t11, rW(await uc(n11(`${s10}/${this.distDir}`, r11))));",
        `(0, tw.XJ)(t11, rW(require("${TURBO_RUNTIME_CACHE_HANDLER_SPECIFIER}")));`
      )
      .replace(
        /(\w+)\.once\("close",\s*\(\)\s*=>\s*\{\s*\1\.writableFinished\s*\|\|\s*(\w+)\.abort\(new (\w+)\(\)\);?\s*\}\),\s*\2/g,
        '$1.once("close",()=>{if($1.writableFinished)return;if(!$1.destroyed&&!$1.errored)return;$2.abort(new $3())}),$2'
      )
      .replace(
        /(\w+)\s*=\s*\{([^;]*clientReferenceManifest:[^;]*serverActionsManifest:[^;]*)\};/g,
        (match, manifestVar, manifestBody) =>
          `${manifestVar} = {${manifestBody}};\n          globalThis.__cf_setManifestsSingleton && globalThis.__cf_setManifestsSingleton(e10, ${manifestVar}.clientReferenceManifest, ${manifestVar}.serverActionsManifest);`
      );
    await writeFile(destFile, code);

    // Only keep ssr/ version to save space; require wrapper handles redirection
  }
}

/**
 * Discover and bundle all .external.js files from next/dist (non-ESM).
 * These are loaded by the turbopack chunk loader at request time.
 */
async function bundleExternalModules(
  ctx: BuildCompleteContext,
  dotNextDest: string
): Promise<void> {
  const nextDistDir = path.join(ctx.projectDir, "node_modules", "next", "dist");

  // Recursively find all .external.js files (skip esm/ directory)
  const externalFiles: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsReaddir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      try {
        const s = await stat(full);
        if (s.isDirectory()) {
          if (entry !== "esm" && entry !== "node_modules") await walk(full);
        } else if (entry.endsWith(".external.js")) {
          externalFiles.push(full);
        }
      } catch {}
    }
  }
  await walk(nextDistDir);

  console.log(`[${ADAPTER_NAME}] Bundling ${externalFiles.length} external modules...`);

  for (const src of externalFiles) {
    // Compute the module path relative to node_modules
    // e.g. next/dist/server/app-render/work-async-storage.external.js
    const rel = path.relative(path.join(ctx.projectDir, "node_modules"), src);

    // Only output to ssr/ to save space; require wrapper handles path redirection
    const dest = path.join(dotNextDest, "server/chunks/ssr", rel);
    await mkdir(path.dirname(dest), { recursive: true });

    try {
      await esbuild.build({
        entryPoints: [src],
        bundle: true,
        outfile: dest,
        format: "cjs",
        target: "esnext",
        platform: "node",
        external: [
          "node:*", "child_process", "cluster", "v8", "tty",
          "critters", "webpack", "@opentelemetry/api",
          "*.map",
        ],
        plugins: [createCloudflareNextPlugin()],
        absWorkingDir: ctx.projectDir,
        logLevel: "silent",
        keepNames: true,
      });
      // Post-process: replace fs calls with global shim references
      let code = await readFile(dest, "utf-8");
      code = code
        .replace(/__require\d*\(/g, "require(")
        .replace(/__require\d*\./g, "require.")
        .replace(/\w+(?:\.\w+)*\.readFileSync\s*\(/g, "(globalThis.__cf_readFileSync || require('node:fs').readFileSync)(")
        .replace(/\w+(?:\.\w+)*\.existsSync\s*\(/g, "(globalThis.__cf_existsSync || require('node:fs').existsSync)(");
      await writeFile(dest, code);
    } catch {
      try { await cp(src, dest, { force: true }); } catch {}
    }
  }
}

/**
 * Copy essential .next build artifacts (manifests, BUILD_ID, etc.)
 */
async function stageBuildArtifacts(
  ctx: BuildCompleteContext,
  outDir: string
): Promise<void> {
  const dotNextDest = path.join(outDir, ".next");
  await mkdir(dotNextDest, { recursive: true });

  const filesToCopy = [
    "BUILD_ID",
    "required-server-files.json",
    "prerender-manifest.json",
    "routes-manifest.json",
    "build-manifest.json",
    "app-path-routes-manifest.json",
    "images-manifest.json",
    "next-server.js.nft.json",
    "next-minimal-server.js.nft.json",
    "package.json",
  ];

  for (const file of filesToCopy) {
    const src = path.join(ctx.distDir, file);
    const dest = path.join(dotNextDest, file);
    try {
      await cp(src, dest, { force: true });
    } catch {
      // Not all exist
    }
  }

  await writeFile(path.join(dotNextDest, "BUILD_ID"), ctx.buildId);

  // Create empty instrumentation module if it doesn't exist
  const instrumentationPath = path.join(dotNextDest, "server", "instrumentation.js");
  try {
    await stat(instrumentationPath);
  } catch {
    await mkdir(path.dirname(instrumentationPath), { recursive: true });
    await writeFile(instrumentationPath, "module.exports = {};");
  }

  // Bundle turbopack runtime files with esbuild so all their internal
  // require() calls (which omit .js extensions) are resolved at build time.
  await bundleTurboRuntimes(ctx, dotNextDest);

  // Dynamically discover and bundle ALL .external.js files from next/dist.
  // These are modules that the turbopack chunk loader loads at request time.
  // They need to be bundled because their internal requires use extension-less
  // paths that Workers' CJS loader can't resolve.
  await bundleExternalModules(ctx, dotNextDest);
}

/**
 * Read the Next.js config and clean it up for runtime use.
 */
async function getCleanedNextConfig(
  ctx: BuildCompleteContext
): Promise<string> {
  const requiredServerFilesPath = path.join(
    ctx.distDir,
    "required-server-files.json"
  );
  try {
    const raw = await readFile(requiredServerFilesPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.config) {
      const config = { ...parsed.config };
      delete config.adapterPath;
      if (config.experimental) {
        config.experimental = { ...config.experimental };
        delete config.experimental.adapterPath;
      }
      config.outputFileTracingRoot = ".";
      if (config.turbopack) {
        config.turbopack = { ...config.turbopack };
        delete config.turbopack.root;
      }
      config.distDir = ".next";
      config.cacheHandler = RUNTIME_CACHE_HANDLER;
      return JSON.stringify(config);
    }
  } catch {
    // fall through
  }
  return "{}";
}

function writeBuildTimeCacheHandlerStub(projectDir: string): string {
  const stubPath = path.join(projectDir, BUILD_TIME_CACHE_HANDLER_STUB);
  const stubCode = `"use strict";
class CloudflareBuildTimeCacheHandler {
  constructor() {
    this.cache = new Map();
  }
  async get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    return { value: entry.value, lastModified: entry.lastModified };
  }
  async set(key, data, ctx) {
    this.cache.set(key, {
      value: data,
      lastModified: Date.now(),
      tags: (ctx && ctx.tags) || [],
    });
  }
  async revalidateTag(tags) {
    const tagList = Array.isArray(tags) ? tags : [tags];
    const tagSet = new Set(tagList);
    for (const [key, entry] of this.cache.entries()) {
      if (entry.tags.some((tag) => tagSet.has(tag))) {
        this.cache.delete(key);
      }
    }
  }
  resetRequestCache() {}
}
module.exports = CloudflareBuildTimeCacheHandler;
module.exports.default = CloudflareBuildTimeCacheHandler;
`;

  writeFileSync(stubPath, stubCode);
  return stubPath;
}

async function getClientReferenceManifestJson(distDir: string): Promise<string> {
  const appServerDir = path.join(distDir, "server", "app");
  const manifests: Record<string, unknown> = {};

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fsReaddir(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const fileStat = await stat(fullPath).catch(() => null);
      if (!fileStat) {
        continue;
      }

      if (fileStat.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!entry.endsWith("_client-reference-manifest.js")) {
        continue;
      }

      const source = await readFile(fullPath, "utf-8");
      const context: Record<string, any> = {
        process: {
          env: {
            NEXT_DEPLOYMENT_ID: process.env.NEXT_DEPLOYMENT_ID,
          },
        },
      };
      context.globalThis = context;

      try {
        vm.runInNewContext(source, context, { filename: fullPath });
      } catch (err) {
        throw new Error(
          `[${ADAPTER_NAME}] Failed to inline client reference manifest ${toPosixPath(fullPath)}: ${err instanceof Error ? err.stack || err.message : String(err)}`
        );
      }

      if (
        !context.__RSC_MANIFEST ||
        typeof context.__RSC_MANIFEST !== "object"
      ) {
        throw new Error(
          `[${ADAPTER_NAME}] Client reference manifest did not populate __RSC_MANIFEST: ${toPosixPath(fullPath)}`
        );
      }

      Object.assign(manifests, context.__RSC_MANIFEST);
    }
  }

  await walk(appServerDir);
  return JSON.stringify(manifests);
}

/**
 * esbuild plugin that patches Next.js server internals for Workers compatibility.
 */
function createCloudflareNextPlugin(): esbuild.Plugin {
  const requireHookStub = [
    "module.exports.registerHook = function() {};",
    "module.exports.deregisterHook = function() {};",
    "module.exports.requireFromString = function() { return {}; };",
  ].join("\n");

  const serverRequireHookStub = [
    "module.exports.addHookAliases = function() {};",
    "module.exports.baseOverrides = {};",
    "module.exports.experimentalOverrides = {};",
  ].join("\n");

  return {
    name: "cloudflare-next-patches",
    setup(build) {
      // Stub out require-hook that monkey-patches Module._extensions.
      // Not needed in bundled runtime since all requires are resolved.
      build.onLoad(
        { filter: /next[\\/]dist[\\/]build[\\/]next-config-ts[\\/]require-hook\.js$/ },
        () => ({ contents: requireHookStub, loader: "js" as const })
      );

      // Stub out server require-hook that aliases webpack/react packages.
      build.onLoad(
        { filter: /next[\\/]dist[\\/]server[\\/]require-hook\.js$/ },
        () => ({ contents: serverRequireHookStub, loader: "js" as const })
      );

      // Stub out commander (CLI arg parser, not needed at runtime).
      build.onLoad(
        { filter: /next[\\/]dist[\\/]compiled[\\/]commander[\\/]index\.js$/ },
        () => ({
          contents: "module.exports = { Command: function() { return { option: function() { return this; }, parse: function() { return this; }, opts: function() { return {}; } }; } };",
          loader: "js" as const,
        })
      );

      // Stub out debug (logging library that requires node:tty).
      build.onLoad(
        { filter: /next[\\/]dist[\\/]compiled[\\/]debug[\\/]index\.js$/ },
        () => ({
          contents: "function debug() { var d = function(){}; d.enabled = false; d.namespace = ''; d.extend = debug; d.destroy = function(){}; return d; } debug.enable = function(){}; debug.disable = function(){}; debug.enabled = function(){ return false; }; debug.humanize = function(){ return ''; }; debug.formatters = {}; module.exports = debug; module.exports.default = debug;",
          loader: "js" as const,
        })
      );

      // Stub out send (static file serving, uses new Function() which is
      // disallowed in Workers). Static files are served by the ASSETS binding.
      build.onLoad(
        { filter: /next[\\/]dist[\\/]compiled[\\/]send[\\/]index\.js$/ },
        () => ({
          contents: "module.exports = function send() { return { on: function() { return this; }, pipe: function() { return this; } }; }; module.exports.mime = { lookup: function() { return 'application/octet-stream'; }, define: function() {} };",
          loader: "js" as const,
        })
      );

      // Stub out serve-static (depends on send, not needed in Workers).
      build.onLoad(
        { filter: /next[\\/]dist[\\/]server[\\/]serve-static\.js$/ },
        () => ({
          contents: "module.exports.getContentType = function() { return 'application/octet-stream'; }; module.exports.getExtension = function() { return ''; };",
          loader: "js" as const,
        })
      );

      // Prefer build-time inlined client reference manifests so app-router
      // SSR never depends on fs + vm evaluation inside Workers.
      build.onLoad(
        { filter: /next[\\/]dist[\\/](?:esm[\\/])?server[\\/]load-components\.js$/ },
        async (args) => {
          let contents = await readFile(args.path, "utf-8");
          const pattern = /async function tryLoadClientReferenceManifest\(manifestPath, entryName, attempts\) \{\s*try \{\s*const context = await evalManifestWithRetries\(manifestPath, attempts\);\s*return context\.__RSC_MANIFEST\[entryName\];\s*\} catch \(err\) \{\s*return undefined;\s*\}\s*\}/;

          if (!pattern.test(contents)) {
            throw new Error(
              `[${ADAPTER_NAME}] Failed to patch ${toPosixPath(args.path)}`
            );
          }

          contents = contents.replace(
            pattern,
            `async function tryLoadClientReferenceManifest(manifestPath, entryName, attempts) {
    const inlinedManifest = globalThis.__CLIENT_REFERENCE_MANIFESTS?.[entryName];
    if (inlinedManifest) {
        return inlinedManifest;
    }
    try {
        const context = await evalManifestWithRetries(manifestPath, attempts);
        return context.__RSC_MANIFEST[entryName];
    } catch (err) {
        return undefined;
    }
}`
          );

          return { contents, loader: "js" as const };
        }
      );

      build.onLoad(
        { filter: /next[\\/]dist[\\/](?:esm[\\/])?server[\\/]load-manifest\.external\.js$/ },
        async (args) => {
          let contents = await readFile(args.path, "utf-8");
          const evalManifestPattern = /function evalManifest\(path, shouldCache = true, cache = sharedCache, handleMissing\) \{/;

          if (!evalManifestPattern.test(contents)) {
            throw new Error(
              `[${ADAPTER_NAME}] Failed to patch ${toPosixPath(args.path)}`
            );
          }

          if (!contents.includes("function getInlinedClientReferenceContext")) {
            contents = contents.replace(
              "const sharedCache = new Map();",
              `const sharedCache = new Map();
function getInlinedClientReferenceContext(manifestPath) {
    const manifests = globalThis.__CLIENT_REFERENCE_MANIFESTS;
    if (!manifests) {
        return undefined;
    }
    const normalizedPath = String(manifestPath).replace(/\\\\/g, "/");
    const nextAppMarker = ".next/server/app/";
    const appMarker = "server/app/";
    let markerIndex = normalizedPath.lastIndexOf(nextAppMarker);
    let markerLength = nextAppMarker.length;
    if (markerIndex === -1) {
        markerIndex = normalizedPath.lastIndexOf(appMarker);
        markerLength = appMarker.length;
    }
    if (markerIndex === -1) {
        return undefined;
    }
    const relativePath = normalizedPath.slice(markerIndex + markerLength);
    const suffix = "_client-reference-manifest.js";
    if (!relativePath.endsWith(suffix)) {
        return undefined;
    }
    const entryName = "/" + relativePath.slice(0, -suffix.length);
    const manifest = manifests[entryName];
    if (!manifest) {
        return undefined;
    }
    return {
        __RSC_MANIFEST: {
            [entryName]: manifest
        }
    };
}`
            );
          }

          contents = contents.replace(
            evalManifestPattern,
            `function evalManifest(path, shouldCache = true, cache = sharedCache, handleMissing) {
    let inlinedContext = getInlinedClientReferenceContext(path);
    if (inlinedContext) {
        if (shouldCache) {
            inlinedContext = (0, _deepfreeze.deepFreeze)(inlinedContext);
            cache.set(path, inlinedContext);
        }
        return inlinedContext;
    }`
          );

          return { contents, loader: "js" as const };
        }
      );

      // Next 16 loads the cache handler via dynamic import(formatDynamicImportPath(...)).
      // Wrangler's module registry can resolve the emitted CommonJS module by a
      // relative specifier like "./.next/cloudflare-cache-handler.js", but not by
      // an absolute file:// URL into the sandboxed bundle output path.
      build.onLoad(
        { filter: /next[\\/]dist[\\/]lib[\\/]format-dynamic-import-path\.js$/ },
        () => ({
          contents: [
            '"use strict";',
            'Object.defineProperty(exports, "__esModule", { value: true });',
            'Object.defineProperty(exports, "formatDynamicImportPath", { enumerable: true, get: function() { return formatDynamicImportPath; } });',
            'const path = require("path");',
            'const { pathToFileURL } = require("url");',
            'function toPosixPath(value) { return value.split(path.sep).join("/"); }',
            'const formatDynamicImportPath = (dir, filePath) => {',
            '  const resolvedFilePath = path.resolve(path.isAbsolute(filePath) ? filePath : path.join(dir, filePath));',
            '  const normalizedResolvedFilePath = toPosixPath(resolvedFilePath);',
            `  if (normalizedResolvedFilePath.endsWith("/.next/${RUNTIME_CACHE_HANDLER}")) {`,
            `    return "./.next/${RUNTIME_CACHE_HANDLER}";`,
            '  }',
            '  return pathToFileURL(resolvedFilePath).toString();',
            '};',
          ].join("\n"),
          loader: "js" as const,
        })
      );

      // Stub unsupported Node.js builtins that Workers doesn't provide
      const unsupportedBuiltins = ["v8", "child_process", "cluster", "dgram", "tls", "tty"];
      for (const mod of unsupportedBuiltins) {
        build.onResolve({ filter: new RegExp(`^(node:)?${mod}$`) }, () => ({
          path: mod,
          namespace: "stub-builtin",
        }));
      }
      build.onLoad({ filter: /.*/, namespace: "stub-builtin" }, (args: any) => ({
        contents: `module.exports = new Proxy({}, { get: () => () => {} });`,
        loader: "js" as const,
      }));

      // We handle fs patching entirely in the bootstrap banner code.
      // Mark node:fs and node:fs/promises as external so they resolve
      // at runtime where our monkey-patches apply.

      // Replace AsyncLocalStorage instance modules with globalThis-backed singletons.
      // This ensures the bootstrap bundle and the turbo runtime bundle share the
      // same AsyncLocalStorage instances (so .run() in one is visible via .getStore()
      // in the other).
      const alsInstances = [
        { filter: /work-async-storage-instance\.js$/, key: "next.als.workAsyncStorage", exportName: "workAsyncStorageInstance" },
        { filter: /work-unit-async-storage-instance\.js$/, key: "next.als.workUnitAsyncStorage", exportName: "workUnitAsyncStorageInstance" },
        { filter: /action-async-storage-instance\.js$/, key: "next.als.actionAsyncStorage", exportName: "actionAsyncStorageInstance" },
        { filter: /after-task-async-storage-instance\.js$/, key: "next.als.afterTaskAsyncStorage", exportName: "afterTaskAsyncStorageInstance" },
        { filter: /console-async-storage-instance\.js$/, key: "next.als.consoleAsyncStorage", exportName: "consoleAsyncStorageInstance" },
        { filter: /dynamic-access-async-storage-instance\.js$/, key: "next.als.dynamicAccessAsyncStorage", exportName: "dynamicAccessAsyncStorageInstance" },
      ];
      for (const { filter, key, exportName } of alsInstances) {
        build.onLoad({ filter }, () => ({
          contents: [
            'const { AsyncLocalStorage } = require("node:async_hooks");',
            `var _key = Symbol.for("${key}");`,
            `if (!globalThis[_key]) globalThis[_key] = new AsyncLocalStorage();`,
            `exports.${exportName} = globalThis[_key];`,
          ].join("\n"),
          loader: "js" as const,
        }));
      }

      // Non-JS files that esbuild tries to load as JS
      build.onLoad(
        { filter: /\/(LICENSE|LICENCE|NOTICE|CHANGELOG|README|\.md$|\.txt$)/ },
        () => ({ contents: "", loader: "empty" as const })
      );
    },
  };
}

/**
 * Bundle the Next.js server bootstrap with esbuild.
 *
 * This is a narrow, focused bundle that resolves the bare-specifier chain:
 *   require("next") -> next/dist/server/next.js -> next/dist/server/next-server.js -> ...
 *
 * Route handlers (.next/server/app/**) are NOT included. They stay as
 * individual CJS modules uploaded via wrangler rules, and are loaded
 * dynamically by the server at request time.
 */
async function bundleServerBootstrap(
  ctx: BuildCompleteContext,
  outDir: string
): Promise<void> {
  const nextConfigJson = await getCleanedNextConfig(ctx);
  const clientReferenceManifestJson = await getClientReferenceManifestJson(ctx.distDir);

  // Read all manifests at build time to inline them into the bundle.
  // This avoids fs.readFile calls at runtime which don't work in Workers.
  const manifestFiles = [
    "BUILD_ID",
    "routes-manifest.json",
    "prerender-manifest.json",
    "build-manifest.json",
    "app-path-routes-manifest.json",
    "images-manifest.json",
    "required-server-files.json",
    "server/middleware-manifest.json",
    "server/functions-config-manifest.json",
    "server/pages-manifest.json",
    "server/app-paths-manifest.json",
    "server/server-reference-manifest.json",
    "server/next-font-manifest.json",
    "server/prefetch-hints.json",
  ];

  const manifestEntries: string[] = [];
  for (const file of manifestFiles) {
    const filePath = path.join(ctx.distDir, file);
    try {
      const content = await readFile(filePath, "utf-8");
      // Escape backticks and backslashes for template literal
      const escaped = content.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
      manifestEntries.push(`  ".next/${file}": \`${escaped}\``);
    } catch {
      // Not all manifests exist
    }
  }

  const manifestMap = `{\n${manifestEntries.join(",\n")}\n}`;

  // Write a small CJS entry that boots the Next.js server
  const bootstrapEntry = path.join(outDir, "__server-bootstrap-entry.cjs");
  const bootstrapCode = `
"use strict";
const http = require("node:http");
const nodePath = require("node:path");
const serverResponseProto = http.ServerResponse && http.ServerResponse.prototype;

if (serverResponseProto) {
  // Cloudflare's node:http bridge can emit "close" during flushHeaders(),
  // which makes Next.js treat streamed responses as aborted before the first
  // body chunk is written. Let the first write flush headers implicitly.
  serverResponseProto.flushHeaders = function() {};
  serverResponseProto.writeEarlyHints = function() {};
  serverResponseProto.writeContinue = function() {};
}

// Pre-loaded manifests (inlined at build time to avoid fs reads in Workers)
const MANIFESTS = ${manifestMap};
const CLIENT_REFERENCE_MANIFESTS = ${clientReferenceManifestJson};
const MANIFESTS_KEY = Symbol.for("next.server.manifests");
// Expose to the patched fs/promises module
globalThis.__MANIFESTS = MANIFESTS;
globalThis.__CLIENT_REFERENCE_MANIFESTS = CLIENT_REFERENCE_MANIFESTS;

function matchManifest(filePath) {
  const p = String(filePath);
  for (const [key, content] of Object.entries(MANIFESTS)) {
    if (p.endsWith(key) || p.endsWith(key.replace(/\\//g, nodePath.sep))) {
      return content;
    }
  }
  return null;
}

function __cf_getWorkStore() {
  const workAsyncStorage = globalThis[Symbol.for("next.als.workAsyncStorage")];
  return workAsyncStorage && typeof workAsyncStorage.getStore === "function"
    ? workAsyncStorage.getStore()
    : undefined;
}

function __cf_normalizeAppPath(page) {
  const segments = String(page)
    .split("/")
    .filter(Boolean)
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
    .filter((segment) => !segment.startsWith("@"));
  const lastSegment = segments[segments.length - 1];
  if (lastSegment === "page" || lastSegment === "route") {
    segments.pop();
  }
  return "/" + segments.join("/");
}

function __cf_normalizeWorkerPageName(pageName) {
  const normalizedPageName = String(pageName);
  return normalizedPageName.startsWith("app")
    ? normalizedPageName
    : "app" + normalizedPageName;
}

function __cf_createProxiedClientReferenceManifest(clientReferenceManifestsPerRoute) {
  const mappingProxies = new Map();

  function createMappingProxy(prop) {
    return new Proxy({}, {
      get(_, id) {
        const workStore = __cf_getWorkStore();
        if (workStore) {
          const currentManifest = clientReferenceManifestsPerRoute.get(workStore.route);
          const currentEntry = currentManifest && currentManifest[prop] && currentManifest[prop][id];
          if (typeof currentEntry !== "undefined") {
            return currentEntry;
          }
        }

        for (const manifest of clientReferenceManifestsPerRoute.values()) {
          const entry = manifest && manifest[prop] && manifest[prop][id];
          if (typeof entry !== "undefined") {
            return entry;
          }
        }

        return undefined;
      },
    });
  }

  return new Proxy({}, {
    get(_, prop) {
      switch (prop) {
        case "moduleLoading":
        case "entryCSSFiles":
        case "entryJSFiles": {
          const workStore = __cf_getWorkStore();
          if (workStore) {
            const currentManifest = clientReferenceManifestsPerRoute.get(workStore.route);
            if (currentManifest && typeof currentManifest[prop] !== "undefined") {
              return currentManifest[prop];
            }
          }

          for (const manifest of clientReferenceManifestsPerRoute.values()) {
            if (manifest && typeof manifest[prop] !== "undefined") {
              return manifest[prop];
            }
          }

          return undefined;
        }
        case "clientModules":
        case "rscModuleMapping":
        case "edgeRscModuleMapping":
        case "ssrModuleMapping":
        case "edgeSSRModuleMapping": {
          let proxy = mappingProxies.get(prop);
          if (!proxy) {
            proxy = createMappingProxy(prop);
            mappingProxies.set(prop, proxy);
          }
          return proxy;
        }
        default:
          return undefined;
      }
    },
  });
}

function __cf_createServerModuleMap() {
  return new Proxy({}, {
    get(_, id) {
      const singleton = globalThis[MANIFESTS_KEY];
      const serverActionsManifest = singleton && singleton.serverActionsManifest;
      const runtimeKey = process.env.NEXT_RUNTIME === "edge" ? "edge" : "node";
      const actionEntry = serverActionsManifest && serverActionsManifest[runtimeKey] && serverActionsManifest[runtimeKey][id];
      const workers = actionEntry && actionEntry.workers;
      if (!workers) {
        return undefined;
      }

      const workStore = __cf_getWorkStore();
      let workerEntry = workStore && workStore.page
        ? workers[__cf_normalizeWorkerPageName(workStore.page)]
        : undefined;

      if (!workerEntry) {
        const workerKeys = Object.keys(workers);
        workerEntry = workerKeys.length > 0 ? workers[workerKeys[0]] : undefined;
      }

      if (!workerEntry) {
        return undefined;
      }

      return {
        id: workerEntry.moduleId,
        name: id,
        chunks: [],
        async: workerEntry.async,
      };
    },
  });
}

function __cf_setManifestsSingleton(page, clientReferenceManifest, rawServerActionsManifest) {
  if (!clientReferenceManifest || !rawServerActionsManifest) {
    return;
  }

  const existingSingleton = globalThis[MANIFESTS_KEY];
  const clientReferenceManifestsPerRoute =
    existingSingleton && existingSingleton.clientReferenceManifestsPerRoute instanceof Map
      ? existingSingleton.clientReferenceManifestsPerRoute
      : new Map();

  clientReferenceManifestsPerRoute.set(
    __cf_normalizeAppPath(page),
    clientReferenceManifest
  );

  const serverActionsManifest = {
    encryptionKey: rawServerActionsManifest.encryptionKey || "",
    node: Object.assign(Object.create(null), rawServerActionsManifest.node || {}),
    edge: Object.assign(Object.create(null), rawServerActionsManifest.edge || {}),
  };

  globalThis[MANIFESTS_KEY] = {
    clientReferenceManifestsPerRoute,
    proxiedClientReferenceManifest: __cf_createProxiedClientReferenceManifest(clientReferenceManifestsPerRoute),
    serverActionsManifest,
    serverModuleMap: __cf_createServerModuleMap(),
  };
}

globalThis.__cf_setManifestsSingleton = __cf_setManifestsSingleton;

// Create a patched fs module via esbuild's onResolve mechanism.
// Since we can't monkey-patch the frozen fs.promises module directly,
// we'll use a different approach: wrap the fs module's readFileSync
// (which IS writable) and use an esbuild plugin to intercept
// require("node:fs/promises") with a patched version.
const fs = require("node:fs");
const zlib = require("node:zlib");

// readFileSync IS writable on the fs object
const origReadFileSync = fs.readFileSync;
fs.readFileSync = function(filePath, options) {
  const content = matchManifest(filePath);
  if (content !== null) {
    if (typeof options === 'string' || (options && options.encoding)) return content;
    return Buffer.from(content);
  }
  return origReadFileSync.apply(this, arguments);
};

const origExistsSync = fs.existsSync;
fs.existsSync = function(filePath) {
  if (matchManifest(filePath) !== null) return true;
  const p = String(filePath);
  if (p.endsWith('.next') || p.endsWith('.next/server') || p.endsWith('.next/server/app') || p.endsWith('.next/server/pages')) return true;
  try { return origExistsSync.apply(this, arguments); } catch(e) { return false; }
};

const origReaddirSync = fs.readdirSync;
fs.readdirSync = function(dirPath, options) {
  try { return origReaddirSync.apply(this, arguments); } catch(e) { return []; }
};

const MAX_ZLIB_OUTPUT_LENGTH = 128 * 1024 * 1024;

function __cf_clampZlibOptions(options) {
  if (!options || typeof options !== "object") {
    return options;
  }

  if (
    typeof options.maxOutputLength === "number" &&
    Number.isFinite(options.maxOutputLength) &&
    options.maxOutputLength > MAX_ZLIB_OUTPUT_LENGTH
  ) {
    return {
      ...options,
      maxOutputLength: MAX_ZLIB_OUTPUT_LENGTH,
    };
  }

  return options;
}

function __cf_patchZlibSync(methodName) {
  const original = zlib[methodName];
  if (typeof original !== "function") {
    return;
  }

  zlib[methodName] = function(buffer, options) {
    return original.call(this, buffer, __cf_clampZlibOptions(options));
  };
}

for (const methodName of [
  "inflateSync",
  "inflateRawSync",
  "gunzipSync",
  "unzipSync",
  "brotliDecompressSync",
]) {
  __cf_patchZlibSync(methodName);
}

const nextConfig = ${nextConfigJson};
nextConfig.compress = false;
nextConfig.experimental = {
  ...(nextConfig.experimental || {}),
  isrFlushToDisk: false,
};

async function boot() {
  process.env.NODE_ENV = "production";
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig);
  delete process.env.NEXT_ADAPTER_PATH;

  // Pre-initialize the manifests singleton on globalThis so the turbo runtime
  // doesn't throw "manifests singleton was not initialized" before the server
  // has a chance to call setManifestsSingleton during rendering.
  if (!globalThis[MANIFESTS_KEY]) {
    var emptyMap = new Map();
    globalThis[MANIFESTS_KEY] = {
      clientReferenceManifestsPerRoute: emptyMap,
      proxiedClientReferenceManifest: __cf_createProxiedClientReferenceManifest(emptyMap),
      serverActionsManifest: { encryptionKey: "", node: Object.create(null), edge: Object.create(null) },
      serverModuleMap: __cf_createServerModuleMap()
    };
  }

  const createNext = require("next").default || require("next");
  const app = createNext({
    dir: __projectDir,
    dev: false,
    quiet: true,
    hostname: "127.0.0.1",
    port: ${NEXT_SERVER_PORT},
    conf: nextConfig,
  });
  await app.prepare();
  const handle = app.getRequestHandler();

  // Catch unhandled errors that Next.js may log to stderr
  process.on("uncaughtException", (err) => {
    console.error("[nextjs-cloudflare] uncaughtException:", err);
  });
  process.on("unhandledRejection", (err) => {
    console.error("[nextjs-cloudflare] unhandledRejection:", err);
  });

  const server = http.createServer((req, res) => {
    Promise.resolve()
      .then(() => handle(req, res))
      .catch((err) => {
      console.error("[nextjs-cloudflare] handler error:", err.stack || err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
      }
      res.end("Internal Server Error");
    });
  });

  await new Promise((resolve, reject) => {
    server.listen(${NEXT_SERVER_PORT}, "127.0.0.1", () => {
      console.log("[nextjs-cloudflare] Server listening on port ${NEXT_SERVER_PORT}");
      resolve();
    });
    server.on("error", reject);
  });

  return server;
}

module.exports = { boot };
`;

  await writeFile(bootstrapEntry, bootstrapCode);

  // Run esbuild to resolve the require("next") chain
  const result = await esbuild.build({
    entryPoints: [bootstrapEntry],
    bundle: true,
    outfile: path.join(outDir, "server-bootstrap.mjs"),
    format: "esm",
    target: "esnext",
    platform: "node",
    minify: true,
    minifySyntax: true,
    minifyWhitespace: true,
    // Don't minify identifiers to keep error messages readable
    minifyIdentifiers: false,
    // Only the server bootstrap chain gets bundled. Everything else is external.
    external: [
      // Optional deps that Next.js requires in try/catch blocks
      "critters",
      "@opentelemetry/api",
      // Webpack and build tooling (not needed at runtime)
      "webpack",
      "webpack/*",
      "next/dist/build/*",
      "next/dist/client/dev/*",
      "@vercel/turbopack-ecmascript-runtime/*",
      // React server DOM packages (resolved dynamically at runtime)
      "react-server-dom-webpack/*",
      "react-server-dom-turbopack/*",
      // Workers handles node: builtins natively via nodejs_compat
      "node:*",
      // Cloudflare Workers runtime modules
      "cloudflare:*",
      // Also without the node: prefix (some compiled deps use bare names)
      "child_process",
      "cluster",
      "dgram",
      "dns",
      "tls",
      "net",
      "v8",
      // Source map files
      "*.map",
    ],
    plugins: [createCloudflareNextPlugin()],
    // Add ESM banner with CJS compatibility shims for Workers
    banner: {
      js: [
        'import { createRequire as __createRequire } from "node:module";',
        'import { fileURLToPath as __fileURLToPath } from "node:url";',
        'import { dirname as __dirname_fn } from "node:path";',
        'const __moduleUrl = import.meta.url === "file:///server-bootstrap.mjs" ? "file:///.cloudflare/server-bootstrap.mjs" : (import.meta.url || "file:///server-bootstrap.mjs");',
        'const __rawRequire = __createRequire(__moduleUrl);',
        'function __maybeParseJson(id, result) {',
        '  if (id.endsWith(".json") && result != null && typeof result !== "function") {',
        '    try {',
        '      var str = typeof result === "string" ? result : result instanceof ArrayBuffer ? new TextDecoder().decode(result) : Buffer.isBuffer(result) ? result.toString() : typeof result === "object" ? null : String(result);',
        '      if (str !== null) return JSON.parse(str);',
        '      if (typeof result === "object" && !Array.isArray(result)) return result;',
        '    } catch(e) {}',
        '  }',
        '  return result;',
        '}',
        'const require = function(id) {',
        '  try { return __maybeParseJson(id, __rawRequire(id)); } catch(e) {',
        '    var filePath = id.startsWith("file://") ? __fileURLToPath(id) : id;',
        '    var stripped = filePath.startsWith("/") ? filePath.slice(1) : filePath;',
        '    if (filePath !== id) try { return __maybeParseJson(id, __rawRequire(filePath)); } catch(e7) {}',
        '    if (filePath !== stripped) try { return __maybeParseJson(id, __rawRequire(stripped)); } catch(e2) {}',
        '    if (stripped.startsWith("server/")) try { return __maybeParseJson(id, __rawRequire(".next/" + stripped)); } catch(e3) {}',
        '    if (stripped.includes("chunks/next/")) try { return __maybeParseJson(id, __rawRequire(stripped.replace("chunks/next/", "chunks/ssr/next/"))); } catch(e5) {}',
        '    if (stripped.includes("chunks/next/")) try { return __maybeParseJson(id, __rawRequire(".next/" + stripped.replace("chunks/next/", "chunks/ssr/next/"))); } catch(e6) {}',
        '    if (filePath.includes(".next/")) try { return __maybeParseJson(id, __rawRequire(filePath.replace(/.*(\\.next\\/)/, ".next/"))); } catch(e4) {}',
        '    throw e;',
        '  }',
        '};',
        'require.resolve = __rawRequire.resolve;',
        'require.cache = __rawRequire.cache || {};',
        'const __filename = __fileURLToPath(__moduleUrl);',
        'const __dirname = __dirname_fn(__filename);',
        'const __projectDir = __dirname === "/" ? "/.cloudflare" : __dirname;',
        'if (typeof process === "object" && process && typeof process.cwd === "function" && process.cwd() === "/" && __projectDir !== "/") {',
        '  process.cwd = function() { return __projectDir; };',
        '}',
      ].join("\n"),
    },
    // Resolve from the project directory where node_modules lives
    absWorkingDir: ctx.projectDir,
    // Don't fail on optional dependencies
    logLevel: "warning",
    // Keep names for better error messages
    keepNames: true,
  });

  // Post-process the bundle
  const bundlePath = path.join(outDir, "server-bootstrap.mjs");
  let bundleCode = await readFile(bundlePath, "utf-8");

  // 1. Fix __require -> require for dynamic route loading.
  // IMPORTANT: esbuild generates "var __require = createRequire(...);" at the top.
  // We must REMOVE that declaration (not rename it to "var require = ...") because
  // our banner already defines `const require` as a wrapper with JSON parsing
  // and path resolution. If we just rename __require -> require everywhere,
  // the "var require = createRequire()" declaration SHADOWS our banner's wrapper.
  bundleCode = bundleCode
    // Remove esbuild's __require declaration (it would shadow our wrapper)
    .replace(/var __require\d*\s*=\s*__createRequire\d*\([^)]*\);?/g, "/* __require removed, using banner wrapper */")
    // Now safely rename __require calls/properties to use our wrapper
    .replace(/__require\d*\(/g, "require(")
    .replace(/__require\d*\./g, "require.");

  // 2. Inject the manifest-aware fs wrapper function at the top (after the banner)
  // This wraps readFileSync, existsSync, and promises.readFile to serve
  // inlined manifests from globalThis.__MANIFESTS.
  const fsShim = `
// --- Cloudflare adapter: fs shim for inlined manifests ---
var __cf_origReadFileSync = require("node:fs").readFileSync;
var __cf_origExistsSync = require("node:fs").existsSync;
function __cf_readFileSync(p, opts) {
  var s = String(p);
  if (typeof globalThis.__MANIFESTS !== 'undefined') {
    for (var k in globalThis.__MANIFESTS) {
      if (s.endsWith(k) || s.indexOf(k) !== -1) {
        var c = globalThis.__MANIFESTS[k];
        return (typeof opts === 'string' || (opts && opts.encoding)) ? c : Buffer.from(c);
      }
    }
  }
  try {
    return __cf_origReadFileSync(p, opts);
  } catch(e) {
    var s = String(p);
    // Try .next/ prefix for paths resolved relative to project root
    if (s.startsWith("/")) {
      try { return __cf_origReadFileSync(s.slice(1), opts); } catch(e2) {}
      if (s.startsWith("/.next/")) try { return __cf_origReadFileSync("." + s, opts); } catch(e3) {}
    }
    if (s.includes(".next/")) {
      try { return __cf_origReadFileSync(s.replace(/.*(\\.next\\/)/, ".next/"), opts); } catch(e4) {}
    }
    // For .js files, try loading via require() which can access Text-type modules.
    if (s.endsWith(".js") || s.endsWith(".json")) {
      var paths = [s];
      if (s.startsWith("/")) paths.push(s.slice(1));
      if (s.includes(".next/")) paths.push(s.replace(/.*(\\.next\\/)/, ".next/"));
      for (var i = 0; i < paths.length; i++) {
        try {
          var mod = __rawRequire(paths[i]);
          if (typeof mod === 'string') return (typeof opts === 'string' || (opts && opts.encoding)) ? mod : Buffer.from(mod);
          if (mod instanceof ArrayBuffer) { var txt = new TextDecoder().decode(mod); return (typeof opts === 'string' || (opts && opts.encoding)) ? txt : Buffer.from(txt); }
        } catch(e5) {}
      }
    }
    throw e;
  }
}
function __cf_existsSync(p) {
  if (typeof globalThis.__MANIFESTS !== 'undefined') {
    var s = String(p);
    for (var k in globalThis.__MANIFESTS) {
      if (s.endsWith(k) || s.indexOf(k) !== -1) return true;
    }
  }
  var s2 = String(p);
  if (s2.endsWith('.next') || s2.endsWith('.next/server') || s2.endsWith('.next/server/app') || s2.endsWith('.next/server/pages')) return true;
  try { return __cf_origExistsSync(p); } catch(e) { return false; }
}
async function __cf_readFile(p, opts) {
  if (typeof globalThis.__MANIFESTS !== 'undefined') {
    var s = String(p);
    for (var k in globalThis.__MANIFESTS) {
      if (s.endsWith(k) || s.indexOf(k) !== -1) {
        var c = globalThis.__MANIFESTS[k];
        return (typeof opts === 'string' || (opts && opts.encoding)) ? c : Buffer.from(c);
      }
    }
  }
  var _fsp = require("node:fs").promises;
  return _fsp["readFile"](p, opts);
}
// Patched readdir that returns [] for missing dirs instead of throwing ENOENT
var __cf_origReaddir = require("node:fs").promises.readdir;
async function __cf_readdir(p, opts) {
  try { return await __cf_origReaddir.call(require("node:fs").promises, p, opts); } catch(e) { return []; }
}
// Patched stat/lstat that won't crash on missing files
var __cf_origStat = require("node:fs").promises.stat;
async function __cf_stat(p, opts) { return __cf_origStat.call(require("node:fs").promises, p, opts); }
var __cf_origLstat = require("node:fs").promises.lstat;
async function __cf_lstat(p, opts) {
  try { return await __cf_origLstat.call(require("node:fs").promises, p, opts); } catch(e) {
    // Return a fake stat for directories that exist in our manifests
    return { isDirectory: function(){ return false; }, isFile: function(){ return false; }, isSymbolicLink: function(){ return false; } };
  }
}
// Expose fs shims globally so external module bundles can use them
globalThis.__cf_readFileSync = __cf_readFileSync;
globalThis.__cf_existsSync = __cf_existsSync;
globalThis.__cf_readFile = __cf_readFile;
globalThis.__cf_readdir = __cf_readdir;
globalThis.__cf_lstat = __cf_lstat;
// --- End fs shim ---
`;

  // Insert the shim after the banner (after the last line of the banner which defines __dirname)
  let bannerEnd = bundleCode.indexOf("const __dirname = ");
  if (bannerEnd === -1) bannerEnd = bundleCode.indexOf("var __dirname = ");
  if (bannerEnd !== -1) {
    const insertPos = bundleCode.indexOf("\n", bannerEnd) + 1;
    bundleCode = bundleCode.slice(0, insertPos) + fsShim + bundleCode.slice(insertPos);
  }

  // 3. Replace fs function calls in the bundle with our shim versions
  // Pattern: (0, _fs.readFileSync)( -> __cf_readFileSync(
  // Pattern: _fs.readFileSync( -> __cf_readFileSync(
  // Pattern: _fs.existsSync( -> __cf_existsSync(
  bundleCode = bundleCode
    .replace(/\(0,\s*\w+\.readFileSync\)\s*\(/g, "__cf_readFileSync(")
    .replace(/\w+(?:\.\w+)*\.readFileSync\s*\(/g, "__cf_readFileSync(")
    .replace(/\(0,\s*\w+\.existsSync\)\s*\(/g, "__cf_existsSync(")
    .replace(/\w+(?:\.\w+)*\.existsSync\s*\(/g, "__cf_existsSync(")
    // Also handle: _promises.readFile( and (0, _promises.readFile)(
    .replace(/\(0,\s*\w+\.readFile\)\s*\(/g, "__cf_readFile(")
    // Pattern: _promises.default.readFile( -> __cf_readFile(
    // Pattern: _promises.readFile( -> __cf_readFile(
    // Must not match readFileSync or require(...).readFile
    .replace(/(?<!\))\w+(?:\.\w+)*\.readFile\((?!Sync)/g, "__cf_readFile(")
    // Replace async readdir calls (for recursiveReadDir)
    .replace(/\(0,\s*\w+(?:\.\w+)*\.readdir\)\s*\(/g, "__cf_readdir(")
    .replace(/\w+(?:\.\w+)*\.readdir\((?!Sync)/g, "__cf_readdir(")
    // Replace lstat calls (used by recursiveReadDir)
    .replace(/\(0,\s*\w+(?:\.\w+)*\.lstat\)\s*\(/g, "__cf_lstat(")
    .replace(/\w+(?:\.\w+)*\.lstat\((?!Sync)/g, "__cf_lstat(");

  await writeFile(bundlePath, bundleCode);

  // Clean up the temp entry
  await rm(bootstrapEntry, { force: true });

  if (result.errors.length > 0) {
    console.error(`[${ADAPTER_NAME}] esbuild errors:`, result.errors);
  }
}

/**
 * Write the KV cache handler as a standalone CJS module.
 * Uploaded via wrangler rules and loaded by Next.js at runtime.
 */
async function writeCacheHandler(outDir: string): Promise<void> {
  const handlerCode = `"use strict";
function getKV() {
  var e = globalThis.__cfEnv;
  return e && e.NEXT_CACHE;
}
function isDebugEnabled(options) {
  var env = globalThis.__cfEnv;
  var proc = typeof process === "object" && process ? process.env : undefined;
  return !!(
    (options && options.debug) ||
    (env && (env.NEXT_CACHE_DEBUG === "true" || env.NEXT_PRIVATE_DEBUG_CACHE === "true")) ||
    (proc && (proc.NEXT_CACHE_DEBUG === "true" || proc.NEXT_PRIVATE_DEBUG_CACHE === "true"))
  );
}
class CloudflareKVCacheHandler {
  constructor(options) { this.debug = isDebugEnabled(options); }
  async get(key) {
    try {
      var kv = getKV(); if (!kv) { if (this.debug) console.error("[cf-cache] get no-kv:", key); return null; }
      var raw = await kv.get(key, "text"); if (!raw) { if (this.debug) console.error("[cf-cache] get miss:", key); return null; }
      var entry = JSON.parse(raw);
      if (this.debug) console.error("[cf-cache] get hit:", key, "kind=", entry && entry.value && entry.value.kind);
      return { value: entry.value, lastModified: entry.lastModified };
    } catch(e) { console.error("[cf-cache] get error:", key, e); return null; }
  }
  async set(key, data, ctx) {
    try {
      var kv = getKV(); if (!kv) return;
      var entry = { value: data, lastModified: Date.now(), tags: ctx && ctx.tags || [] };
      var ttl = typeof (ctx && ctx.revalidate) === "number" ? ctx.revalidate : 31536000;
      await kv.put(key, JSON.stringify(entry), { expirationTtl: Math.max(ttl, 60) });
      if (this.debug) console.error("[cf-cache] set:", key, "kind=", data && data.kind, "ttl=", Math.max(ttl, 60));
      for (var i = 0; i < entry.tags.length; i++) {
        var tagKey = "tag:" + entry.tags[i];
        var existing = await kv.get(tagKey, "json") || [];
        existing.push(key);
        await kv.put(tagKey, JSON.stringify(existing));
      }
    } catch(e) { console.error("[cf-cache] set error:", key, e); }
  }
  async revalidateTag(tags) {
    try {
      var kv = getKV(); if (!kv) return;
      var tagList = Array.isArray(tags) ? tags : [tags];
      if (this.debug) console.error("[cf-cache] revalidateTag:", tagList);
      for (var i = 0; i < tagList.length; i++) {
        var tagKey = "tag:" + tagList[i];
        var keys = await kv.get(tagKey, "json") || [];
        await Promise.all(keys.map(function(k) { return kv.delete(k); }));
        await kv.delete(tagKey);
      }
    } catch(e) { console.error("[cf-cache] revalidateTag error:", tags, e); }
  }
  resetRequestCache() {}
}
module.exports = CloudflareKVCacheHandler;
module.exports.default = CloudflareKVCacheHandler;
`;
  // Write to .next/ so the wrangler ".next/**/*.js" CommonJS rule picks it up
  const destPath = path.join(outDir, ".next", "cloudflare-cache-handler.js");
  await mkdir(path.dirname(destPath), { recursive: true });
  await writeFile(destPath, handlerCode);
}

/**
 * Write the thin worker entry point that imports the bundled bootstrap.
 */
async function writeWorkerEntry(outDir: string): Promise<void> {
  const workerCode = `
import { httpServerHandler } from "cloudflare:node";
import serverBootstrap from "./server-bootstrap.mjs";
const { boot } = serverBootstrap;

const NEXT_SERVER_PORT = ${NEXT_SERVER_PORT};

let serverReady = false;
let initPromise = null;
let initError = null;
let nodeServerHandler = null;

async function bootNextServer(env) {
  if (serverReady) return;
  if (initError) throw initError;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      for (const [key, value] of Object.entries(env)) {
        if (typeof value === "string") {
          process.env[key] = value;
        }
      }
      process.env.PORT = String(NEXT_SERVER_PORT);
      process.env.HOSTNAME = "127.0.0.1";

      // Expose env to the cache handler (which runs inside the bundled server)
      globalThis.__cfEnv = env;

      const server = await boot();
      nodeServerHandler = httpServerHandler(server);
      serverReady = true;
    } catch (err) {
      initError = err;
      throw err;
    }
  })();

  return initPromise;
}

function isStaticAsset(pathname) {
  if (pathname.startsWith("/_next/static/")) return true;
  if (pathname === "/favicon.ico") return true;

  const staticExts = new Set([
    ".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
    ".woff", ".woff2", ".ttf", ".eot", ".webp", ".avif", ".map",
    ".txt", ".xml", ".webmanifest",
  ]);

  const lastDot = pathname.lastIndexOf(".");
  if (lastDot > 0) {
    return staticExts.has(pathname.substring(lastDot));
  }
  return false;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (isStaticAsset(url.pathname)) {
      try {
        const assetResponse = await env.ASSETS.fetch(request);
        if (assetResponse.status !== 404) {
          return assetResponse;
        }
      } catch {
        // Fall through
      }
    }

    // Handle /_next/image requests using Cloudflare Images binding
    if (url.pathname === "/_next/image" && env.IMAGES) {
      try {
        const imageUrl = url.searchParams.get("url");
        const width = parseInt(url.searchParams.get("w") || "0", 10);
        const quality = parseInt(url.searchParams.get("q") || "75", 10);

        if (imageUrl) {
          // Fetch the source image from assets
          const sourceUrl = new URL(imageUrl, request.url);
          const sourceResponse = await env.ASSETS.fetch(
            new Request(sourceUrl.toString())
          );

          if (sourceResponse.ok && sourceResponse.body) {
            // Determine output format from Accept header
            const accept = request.headers.get("Accept") || "";
            let format = "image/webp";
            if (accept.includes("image/avif")) format = "image/avif";
            else if (accept.includes("image/webp")) format = "image/webp";
            else if (accept.includes("image/jpeg") || imageUrl.endsWith(".jpg") || imageUrl.endsWith(".jpeg")) format = "image/jpeg";
            else if (imageUrl.endsWith(".png")) format = "image/png";

            const transforms = {};
            if (width > 0) transforms.width = width;

            const output = await env.IMAGES
              .input(sourceResponse.body)
              .transform(transforms)
              .output({ format, quality });

            const resp = output.response();
            return new Response(resp.body, {
              status: 200,
              headers: {
                "content-type": format,
                "cache-control": "public, max-age=31536000, immutable",
                "vary": "Accept",
              },
            });
          }
        }
      } catch (err) {
        console.error("[nextjs-cloudflare] Image transform error:", err);
        // Fall through to Next.js server
      }
    }

    try {
      await bootNextServer(env);
    } catch (err) {
      console.error("[nextjs-cloudflare] Failed to boot:", err);
      return new Response(
        "Internal Server Error: Next.js failed to start\\n\\n" + String(err),
        { status: 500, headers: { "content-type": "text/plain" } }
      );
    }

    if (!nodeServerHandler) {
      return new Response("Internal Server Error: Node handler not initialized", {
        status: 500,
        headers: { "content-type": "text/plain" },
      });
    }

    try {
      return await nodeServerHandler.fetch(request, env, ctx);
    } catch (err) {
      console.error("[nextjs-cloudflare] nodeServerHandler.fetch error:", err);
      return new Response("Internal Server Error", {
        status: 500,
        headers: { "content-type": "text/plain" },
      });
    }
  },
};
`;

  await writeFile(path.join(outDir, "worker.mjs"), workerCode.trim());
}

/**
 * Generate package.json.
 */
async function writePackageJson(outDir: string): Promise<void> {
  const pkg = {
    name: "nextjs-cloudflare-worker",
    version: "1.0.0",
    private: true,
    type: "commonjs",
  };
  await writeFile(
    path.join(outDir, "package.json"),
    JSON.stringify(pkg, null, 2)
  );
}

/**
 * Generate wrangler.jsonc.
 */
async function writeWranglerConfig(
  outDir: string,
  kvNamespace: string,
  buildId: string
): Promise<void> {
  const config = `{
  // Generated by nextjs-cloudflare-adapter
  "name": "nextjs-app",
  "main": "worker.mjs",
  "compatibility_date": "2026-03-26",
  "compatibility_flags": ["nodejs_compat"],
  "no_bundle": true,
  "find_additional_modules": true,
  "rules": [
    { "type": "ESModule", "globs": ["**/*.mjs"], "fallthrough": true },
    { "type": "Text", "globs": [".next/server/app/**/*-manifest.js", ".next/server/*-manifest.js", ".next/server/interception-route-rewrite-manifest.js"], "fallthrough": true },
    { "type": "CommonJS", "globs": [".next/**/*.js"], "fallthrough": true },
    { "type": "Text", "globs": ["**/*.html"], "fallthrough": true },
    { "type": "Data", "globs": ["**/*.json"], "fallthrough": true }
  ],
  "kv_namespaces": [
    { "binding": "NEXT_CACHE" }
  ],
  "images": {
    "binding": "IMAGES"
  },
  "assets": {
    "binding": "ASSETS",
    "directory": "./assets"
  },
  "vars": {
    "NEXT_BUILD_ID": "${buildId}"
  }
}
`;
  await writeFile(path.join(outDir, "wrangler.jsonc"), config);
}

export function createCloudflareAdapter(
  options: CloudflareAdapterOptions = {}
): NextAdapter {
  const configuredOutDir = options.outDir ?? DEFAULT_OUT_DIR;
  const kvNamespace = options.kvNamespace ?? "NEXT_CACHE";
  const skipWranglerConfig = options.skipWranglerConfig ?? false;

  return {
    name: ADAPTER_NAME,

    modifyConfig(config, ctx) {
      if (
        ctx.phase !== "phase-production-build" &&
        ctx.phase !== "phase-production-server" &&
        ctx.phase !== "phase-export"
      ) {
        return config;
      }

      const projectDir = process.cwd();
      const cacheHandlerStubPath = writeBuildTimeCacheHandlerStub(projectDir);

      return {
        ...config,
        cacheHandler: cacheHandlerStubPath,
      };
    },

    async onBuildComplete(ctx) {
      const outDir = resolveOutDir(ctx.projectDir, configuredOutDir);

      console.log(`\n[${ADAPTER_NAME}] Building for Cloudflare Workers...`);

      await rm(outDir, { recursive: true, force: true });
      await mkdir(outDir, { recursive: true });

      console.log(`[${ADAPTER_NAME}] Staging static assets...`);
      await stageStaticAssets(ctx, outDir);

      console.log(`[${ADAPTER_NAME}] Staging traced server files...`);
      await stageTracedFiles(ctx, outDir);

      console.log(`[${ADAPTER_NAME}] Staging build artifacts...`);
      await stageBuildArtifacts(ctx, outDir);

      console.log(`[${ADAPTER_NAME}] Bundling server bootstrap...`);
      await bundleServerBootstrap(ctx, outDir);

      // Write the cache handler as a standalone CJS module in the output.
      // It gets uploaded via wrangler rules as CommonJS and loaded by
      // Next.js at runtime via require(config.cacheHandler).
      // Uses globalThis.__cfEnv (set by worker entry) for KV access.
      console.log(`[${ADAPTER_NAME}] Writing cache handler...`);
      await writeCacheHandler(outDir);

      console.log(`[${ADAPTER_NAME}] Writing worker entry...`);
      await writeWorkerEntry(outDir);

      await writePackageJson(outDir);

      if (!skipWranglerConfig) {
        await writeWranglerConfig(outDir, kvNamespace, ctx.buildId);
      }

      console.log(`[${ADAPTER_NAME}] Build complete!`);
      console.log(`[${ADAPTER_NAME}] Output: ${outDir}`);
      console.log(`[${ADAPTER_NAME}]`);
      console.log(`[${ADAPTER_NAME}] Preview: cd ${configuredOutDir} && npx wrangler dev`);
      console.log(`[${ADAPTER_NAME}] Deploy:  cd ${configuredOutDir} && npx wrangler deploy`);
    },
  };
}

export default createCloudflareAdapter();
