# nextjs-cloudflare-adapter

> **This is not an official Cloudflare project.** This was a ~24 hour experiment to see how far the new Next.js 16.2 adapter API could get toward deploying a full App Router application on Cloudflare Workers. It is not production-ready. If you are looking for something with better build times and production performance, use [vinext](https://github.com/nicholascelestin/vinext).

## What is this?

A Next.js deployment adapter for Cloudflare Workers, built on the [Next.js adapter API](https://nextjs.org/docs/app/api-reference/config/next-config-js/adapterPath) (`adapterPath` in `next.config.ts`). It was tested against the [next-app-router-playground](https://github.com/vercel/next-app-router-playground), which exercises the full suite of App Router features.

Live demo: https://nextjs-app.southpolesteve.workers.dev

## What Works

- **Static/prerendered pages** - Served from Cloudflare's CDN edge via Workers Static Assets
- **Dynamic SSR** - Server-rendered pages with full streaming
- **Partial Prerendering (PPR)** - Static shells served instantly, dynamic content streams in
- **Client-side navigation** - RSC flight transitions between pages (no full page reloads)
- **React hydration and interactivity** - Event handlers, state, client components all work
- **Nested layouts** - Layout state preserved across navigation
- **Image optimization** - `/_next/image` requests are handled by the [Cloudflare Images binding](https://developers.cloudflare.com/images/transform-images/bindings/), serving optimized WebP/AVIF at the requested size and quality. No `sharp` needed.
- **View transitions** - Working
- **Error boundaries** - Working
- **Route groups, parallel routes** - Working
- **CSS/JS assets** - Served from CDN edge
- **Code syntax highlighting** - Working (CodeHike)
- **ISR / Incremental Static Regeneration** - KV-backed cache handler with automatic namespace provisioning. Pages with `revalidate` are cached in [Workers KV](https://developers.cloudflare.com/kv/) and revalidated on schedule. Tag-based revalidation (`revalidateTag`) is supported. Enable debug logging with `NEXT_CACHE_DEBUG=true`.

## What Doesn't Work / Known Gaps

### Blockers for production use

- **Cold start time** - The 22MB minified bootstrap needs to initialize on every cold start, likely 3-5 seconds per colo. This is the biggest gap vs vinext, which avoids booting the full Next.js server. Mitigations: [Smart Placement](https://developers.cloudflare.com/workers/configuration/placement/) to pin to fewer colos, or architecturally splitting the server.
- **Brittle minified code patches** - The adapter matches specific minified variable names (e.g. `i2`, `r3`, `rW`, `uc`) in Next.js compiled output for string replacements. Any Next.js patch release that changes minification output can silently break the adapter. Needs either more robust structural matching or upstream Next.js changes.
- **10MB compressed size limit** - The Worker is at ~9.8MB compressed with zero headroom. One more dependency or Next.js version bump and deploys will fail. Needs bundle audit, aggressive tree-shaking, or splitting into multiple workers via service bindings.
- **No automated tests** - Zero tests. Any change can silently break things.

### Untested features

- **Server Actions** - POST requests, form submissions, revalidation on mutation. Untested and likely needs fixes.
- **Middleware** - Untested (playground doesn't use it). Many production apps use middleware for auth, redirects, A/B testing.
- **`use cache` directives** - `use cache: remote` and `use cache: private` need the `cacheHandlers` config (plural), which is a different interface from the `cacheHandler` (singular) used for ISR. Not implemented.

### Known broken

- **API routes** - `/api/og` (OG image generation) broken (`@vercel/og` excluded from build).
- **404 page** - Returns 500 instead of a styled 404. The `pages/404.html` and `pages/500.html` static files aren't included in the output.

## How It Works

1. `next build` runs the adapter's `modifyConfig` (sets up KV cache handler) and `onBuildComplete` hooks
2. Static assets (CSS, JS, images, prerendered HTML) are staged for Workers Static Assets
3. The Next.js server is bundled with esbuild into a single `server-bootstrap.mjs` file (~22MB minified)
4. Turbopack runtimes and external modules are bundled separately with esbuild
5. A thin `worker.mjs` entry point uses `httpServerHandler` from `cloudflare:node` to bridge Worker `fetch()` to the Node.js HTTP server
6. `/_next/image` requests are intercepted and handled by the Cloudflare Images binding
7. Manifests are inlined at build time to avoid `fs.readFileSync` calls at runtime
8. A KV-backed cache handler is deployed as a standalone CJS module for ISR
9. `wrangler deploy` uploads everything and auto-provisions the KV namespace

## Usage

```bash
# In your Next.js 16.2+ project
npm install nextjs-cloudflare-adapter

# next.config.ts
export default {
  adapterPath: require.resolve('nextjs-cloudflare-adapter'),
  // ... your config
}

# Build
npx next build

# Preview locally
cd .cloudflare && npx wrangler dev

# Deploy
cd .cloudflare && npx wrangler deploy
```

## What the Next.js Adapter API Needs to Improve

The adapter API handles the build-time side well (traced files, manifests, routing info). The gap is entirely on the runtime side. Here is everything we had to patch around, and what the adapter API could do to make non-Node deployments work without these hacks.

### 1. No portable request handler

The adapter API doesn't provide a way to create a web-standard request handler. We had to boot a full `http.createServer`, bind it to a port, and use `httpServerHandler` from `cloudflare:node` to bridge `fetch()` to it. The API should provide a `createRequestHandler()` that takes a `Request` and returns a `Response`, with no Node.js HTTP server involved.

### 2. Manifest loading assumes filesystem access

The server reads ~15 JSON manifests and several JS manifests via `fs.readFileSync`. We had to inline all of them at build time into `globalThis.__MANIFESTS` and string-replace every `readFileSync`/`existsSync`/`readFile`/`readdir`/`lstat` call in the bundle with shim functions. The adapter API should provide manifest data as structured objects in the build context, or provide a pluggable manifest loader.

### 3. No runtime portability layer

The Next.js server pulls in Node.js-specific modules at runtime that have nothing to do with rendering:

- `Module._extensions` monkey-patching (`require-hook.js`)
- `child_process` via `commander` (CLI arg parser)
- `node:v8` for heap statistics
- `node:tty` via `debug` logging library
- `new Function()` in `send` (static file server)
- `vm.runInNewContext` for client reference manifests

Each of these had to be stubbed via esbuild plugins. The adapter API should either provide a "minimal server" mode that strips these, or document which modules need to be stubbed for non-Node runtimes.

### 4. Turbopack chunk loading assumes Node.js module resolution

The turbopack runtime loads chunks via CJS `require()` with absolute paths and without file extensions. Workers' `createRequire` does exact name matching. We had to write a `require` wrapper with 6 fallback resolution strategies, bundle all turbo runtimes and external modules with esbuild, and post-process the bundles to fix `__require` references. The chunk loader should use web-standard `import()` or provide a pluggable resolution function.

### 5. Singletons break across bundles

The server uses module-level singletons (6 AsyncLocalStorage instances, manifests singleton) that must be shared between the server bootstrap and the turbopack route renderers. When split across esbuild bundles, each gets its own copy. We had to replace all singleton modules with `globalThis[Symbol.for()]`-backed versions via esbuild plugins. These should use `globalThis` with `Symbol.for()` out of the box.

### 6. `public/` directory missing from adapter outputs

`ctx.outputs.staticFiles` includes `_next/static/` files but NOT `public/` directory files. We had to manually copy `public/` to the assets directory. These should be included in the adapter outputs.

### 7. `ServerResponse` assumptions

The Node.js HTTP server's `ServerResponse` has methods (`flushHeaders`, `writeEarlyHints`, `writeContinue`) that trigger spurious "close" events in Workers' `node:http` bridge. We had to stub these on the prototype. If the adapter API provided a web-standard request handler (point 1), this wouldn't be an issue.

## Performance Comparison

Median warm TTFB (3 runs, all caches warm, from a single location, not a rigorous benchmark):

| Route | This Adapter | [vinext](https://github.com/nicholascelestin/vinext) | Vercel |
|---|---|---|---|
| `/` (homepage) | 157ms | 156ms | 184ms |
| `/layouts` | 179ms | 150ms | 185ms |
| `/loading/clothing` (dynamic SSR) | 180ms | 193ms | 283ms |
| `/context` | 154ms | 181ms | 224ms |
| `/view-transitions` | 166ms | 149ms | 205ms |

When warm, all three Workers-based deployments (this adapter and vinext) are in the same ballpark (~150-190ms). Vercel is consistently slower (~185-280ms) because it serves from us-east-1 while Workers run at the nearest edge colo.

The real performance difference is cold starts. This adapter boots the entire Next.js server (~22MB) on first request per isolate, which adds several seconds. vinext avoids this by not running the full Next.js server at all.

## License

MIT
