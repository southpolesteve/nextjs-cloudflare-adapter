import { resolveRoutes, responseToMiddlewareResult } from './next-routing.mjs'
import { createNodeRuntime } from './node-runtime.mjs'

function emptyBodyStream() {
  return new ReadableStream({
    start(controller) {
      controller.close()
    },
  })
}

function canHaveBody(method) {
  return method !== 'GET' && method !== 'HEAD'
}

function canServeStaticAsset(method) {
  return method === 'GET' || method === 'HEAD'
}

function isRscRequest(url, headers) {
  return headers.get('rsc') === '1'
}

function isPrefetchRscRequest(headers) {
  return headers.get('next-router-prefetch') === '1'
}

function isRedirectStatusCode(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function isNextDataRequest(headers) {
  return headers.get('x-nextjs-data') === '1'
}

function getEmbeddedBlobContentType(url) {
  if (!url.startsWith('blob:server/edge/assets/')) {
    return 'application/octet-stream'
  }

  if (url.endsWith('.txt')) {
    return 'text/plain; charset=utf-8'
  }

  if (url.endsWith('.json')) {
    return 'application/json; charset=utf-8'
  }

  if (url.endsWith('.svg')) {
    return 'image/svg+xml'
  }

  if (url.endsWith('.png')) {
    return 'image/png'
  }

  if (url.endsWith('.jpg') || url.endsWith('.jpeg')) {
    return 'image/jpeg'
  }

  if (url.endsWith('.webp')) {
    return 'image/webp'
  }

  if (url.endsWith('.wasm')) {
    return 'application/wasm'
  }

  if (url.endsWith('.ttf')) {
    return 'font/ttf'
  }

  if (url.endsWith('.otf')) {
    return 'font/otf'
  }

  if (url.endsWith('.woff')) {
    return 'font/woff'
  }

  if (url.endsWith('.woff2')) {
    return 'font/woff2'
  }

  return 'application/octet-stream'
}

function decodeBase64ToBytes(value) {
  const decoded = atob(value)
  const bytes = new Uint8Array(decoded.length)

  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index)
  }

  return bytes
}

function getEmbeddedBlobBytes(url) {
  globalThis._WORKER_RAW_FILE_CACHE ??= new Map()

  if (globalThis._WORKER_RAW_FILE_CACHE.has(url)) {
    return globalThis._WORKER_RAW_FILE_CACHE.get(url)
  }

  const base64Value = globalThis._WORKER_RAW_FILES?.[url]

  if (typeof base64Value !== 'string') {
    return null
  }

  const bytes = decodeBase64ToBytes(base64Value)
  globalThis._WORKER_RAW_FILE_CACHE.set(url, bytes)
  return bytes
}

function installEmbeddedBlobFetchBridge() {
  if (globalThis.__CLOUDFLARE_ADAPTER_BLOB_FETCH_BRIDGE_INSTALLED) {
    return
  }

  const originalFetch = globalThis.fetch?.bind(globalThis)

  if (typeof originalFetch !== 'function') {
    return
  }

  globalThis.fetch = async (input, init) => {
    const requestUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input?.url

    if (typeof requestUrl === 'string' && requestUrl.startsWith('blob:server/edge/assets/')) {
      const requestMethod =
        init?.method ||
        (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET') ||
        'GET'

      if (requestMethod !== 'GET' && requestMethod !== 'HEAD') {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: new Headers({
            allow: 'GET, HEAD',
          }),
        })
      }

      const bytes = getEmbeddedBlobBytes(requestUrl)

      if (!bytes) {
        return new Response('Not Found', {
          status: 404,
        })
      }

      return new Response(requestMethod === 'HEAD' ? null : bytes.slice(), {
        status: 200,
        headers: new Headers({
          'content-type': getEmbeddedBlobContentType(requestUrl),
          'content-length': String(bytes.byteLength),
          'cache-control': 'public, immutable, max-age=31536000',
        }),
      })
    }

    return originalFetch(input, init)
  }

  globalThis.__CLOUDFLARE_ADAPTER_BLOB_FETCH_BRIDGE_INSTALLED = true
}

installEmbeddedBlobFetchBridge()

const NEXT_CACHE_HANDLERS_SYMBOL = Symbol.for('@next/cache-handlers')
const NEXT_CACHE_TAGS_HEADER = 'x-next-cache-tags'
const ADAPTER_REVALIDATED_TAG_STATE_HEADER = 'x-adapter-revalidated-tags-state'

function normalizeCacheTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) {
    return []
  }

  const normalizedTags = new Map()

  for (const tag of tags) {
    if (typeof tag !== 'string' || tag.length === 0) {
      continue
    }

    normalizedTags.set(tag, tag)
  }

  return Array.from(normalizedTags.values())
}

function getCachedResponseTagHeader(value) {
  const headers = value?.headers

  if (!headers) {
    return undefined
  }

  if (headers instanceof Headers) {
    return headers.get(NEXT_CACHE_TAGS_HEADER) || undefined
  }

  for (const [key, headerValue] of Object.entries(headers)) {
    if (String(key).toLowerCase() !== NEXT_CACHE_TAGS_HEADER) {
      continue
    }

    if (Array.isArray(headerValue)) {
      return headerValue.join(',')
    }

    return typeof headerValue === 'string' ? headerValue : String(headerValue)
  }

  return undefined
}

function getCachedEntryTags(entry, ctx) {
  if (entry?.value?.kind === 'FETCH') {
    const storedTags = normalizeCacheTags(entry.tags)
    const requestedTags = normalizeCacheTags(ctx?.tags)

    if (requestedTags.length === 0) {
      return storedTags
    }

    const mergedTags = new Map(storedTags.map((tag) => [tag, tag]))

    for (const tag of requestedTags) {
      mergedTags.set(tag, tag)
    }

    const nextTags = Array.from(mergedTags.values())

    if (nextTags.length !== storedTags.length) {
      entry.tags = nextTags
    }

    return nextTags
  }

  const responseTagHeader = getCachedResponseTagHeader(entry?.value)

  if (typeof responseTagHeader !== 'string' || responseTagHeader.length === 0) {
    return []
  }

  return normalizeCacheTags(responseTagHeader.split(',').map((tag) => tag.trim()))
}

function hasExpiredCacheTag(tags, tagStateByTag, timestamp) {
  const now = Date.now()

  for (const tag of tags) {
    const expiredAt = tagStateByTag.get(tag)?.expired

    if (
      typeof expiredAt === 'number' &&
      expiredAt <= now &&
      expiredAt > timestamp
    ) {
      return true
    }
  }

  return false
}

function hasStaleCacheTag(tags, tagStateByTag, timestamp) {
  for (const tag of tags) {
    const staleAt = tagStateByTag.get(tag)?.stale ?? 0

    if (typeof staleAt === 'number' && staleAt > timestamp) {
      return true
    }
  }

  return false
}

let localDevConfigPromise

async function getConfiguredNodeSidecarPort() {
  localDevConfigPromise ??= import('../generated/local-dev-config.mjs').catch(() => ({
    nodeSidecarPort: null,
  }))

  const localDevConfig = await localDevConfigPromise
  const rawPort = globalThis.process?.env?.CLOUDFLARE_ADAPTER_NODE_SIDECAR_PORT
  const parsedPort = Number(rawPort ?? localDevConfig?.nodeSidecarPort)

  return Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : null
}

async function getNodeSidecarRevalidatedTagsUrl() {
  const sidecarPort = await getConfiguredNodeSidecarPort()

  if (!sidecarPort) {
    return null
  }

  return `http://127.0.0.1:${sidecarPort}/_adapter/revalidated-tags`
}

function mergeSharedTagState(tagStateByTag, serializedTagState) {
  if (!serializedTagState || typeof serializedTagState !== 'object') {
    return
  }

  for (const [tag, value] of Object.entries(serializedTagState)) {
    if (typeof tag !== 'string' || !value || typeof value !== 'object') {
      continue
    }

    const previousState = tagStateByTag.get(tag) || {}
    tagStateByTag.set(tag, {
      ...previousState,
      ...value,
    })
  }
}

function serializeTagState(tagStateByTag) {
  if (!(tagStateByTag instanceof Map) || tagStateByTag.size === 0) {
    return null
  }

  const serializedTagState = Object.fromEntries(tagStateByTag.entries())
  return Object.keys(serializedTagState).length > 0 ? serializedTagState : null
}

function encodeSerializedTagState(serializedTagState) {
  if (!serializedTagState || typeof serializedTagState !== 'object') {
    return null
  }

  try {
    return btoa(JSON.stringify(serializedTagState))
  } catch {
    return null
  }
}

function decodeSerializedTagState(encodedSerializedTagState) {
  if (typeof encodedSerializedTagState !== 'string' || encodedSerializedTagState.length === 0) {
    return null
  }

  try {
    return JSON.parse(atob(encodedSerializedTagState))
  } catch {
    return null
  }
}

function createSerializedTagStateHeader(tagStateByTag) {
  return encodeSerializedTagState(serializeTagState(tagStateByTag))
}

function mergeSharedTagStateFromResponse(response, edgeIncrementalCache) {
  if (!response?.headers || !edgeIncrementalCache?.tagStateByTag) {
    return
  }

  const encodedSerializedTagState = response.headers.get(
    ADAPTER_REVALIDATED_TAG_STATE_HEADER
  )
  const serializedTagState = decodeSerializedTagState(encodedSerializedTagState)

  mergeSharedTagState(edgeIncrementalCache.tagStateByTag, serializedTagState)
}

async function syncEdgeTagStateFromNodeSidecar(edgeIncrementalCache) {
  const requestUrl = await getNodeSidecarRevalidatedTagsUrl()

  if (!requestUrl) {
    return
  }

  try {
    const response = await fetch(requestUrl)

    if (!response.ok) {
      console.log('[adapter edge tag sync] non-ok response', response.status, requestUrl)
      return
    }

    const payload = await response.json().catch(() => null)
    console.log(
      '[adapter edge tag sync] fetched tags',
      Object.keys(payload?.tags || {}),
      requestUrl
    )
    mergeSharedTagState(edgeIncrementalCache.tagStateByTag, payload?.tags)
  } catch (error) {
    console.log('[adapter edge tag sync] fetch failed', requestUrl, error?.message || error)
  }
}

async function propagateTagStateToNodeSidecar(tags, durations) {
  const requestUrl = await getNodeSidecarRevalidatedTagsUrl()

  if (!requestUrl) {
    return
  }

  try {
    const normalizedTags = normalizeCacheTags(typeof tags === 'string' ? [tags] : tags)
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: new Headers({
        'content-type': 'application/json; charset=utf-8',
      }),
      body: JSON.stringify({
        tags: normalizedTags,
        durations,
      }),
    })
    console.log(
      '[adapter edge tag sync] propagated tags',
      normalizedTags,
      durations || null,
      response.status,
      requestUrl
    )
  } catch (error) {
    console.log(
      '[adapter edge tag sync] propagate failed',
      requestUrl,
      error?.message || error
    )
  }
}

function hasRevalidatedAssetTags(assetMeta, edgeIncrementalCache) {
  const assetTagHeader = getCachedResponseTagHeader(assetMeta)

  if (typeof assetTagHeader !== 'string' || assetTagHeader.length === 0) {
    return false
  }

  const assetTags = normalizeCacheTags(assetTagHeader.split(',').map((tag) => tag.trim()))
  return assetTags.some((tag) => edgeIncrementalCache.tagStateByTag.has(tag))
}

function getRevalidatedAssetTags(assetMeta, edgeIncrementalCache, fulfilledTagStateByTag) {
  const assetTagHeader = getCachedResponseTagHeader(assetMeta)

  if (typeof assetTagHeader !== 'string' || assetTagHeader.length === 0) {
    return []
  }

  const assetTags = normalizeCacheTags(assetTagHeader.split(',').map((tag) => tag.trim()))

  return assetTags.filter((tag) => {
    const tagState = edgeIncrementalCache.tagStateByTag.get(tag)

    if (!tagState) {
      return false
    }

    const fulfilledState = fulfilledTagStateByTag?.get(tag)

    if (!fulfilledState) {
      return true
    }

    return (
      ((typeof tagState.expired === 'number' ? tagState.expired : 0) >
        (typeof fulfilledState.expired === 'number' ? fulfilledState.expired : 0)) ||
      ((typeof tagState.stale === 'number' ? tagState.stale : 0) >
        (typeof fulfilledState.stale === 'number' ? fulfilledState.stale : 0))
    )
  })
}

function getPreviewModeId(manifest) {
  if (typeof manifest?.middleware?.config?.env?.__NEXT_PREVIEW_MODE_ID === 'string') {
    return manifest.middleware.config.env.__NEXT_PREVIEW_MODE_ID
  }

  for (const output of manifest?.routeOutputs || []) {
    if (typeof output?.config?.env?.__NEXT_PREVIEW_MODE_ID === 'string') {
      return output.config.env.__NEXT_PREVIEW_MODE_ID
    }
  }

  return null
}

function installEdgeIncrementalFetchCache(edgeIncrementalCache) {
  class CloudflareAdapterEdgeFetchCache {
    constructor(ctx = {}) {
      this.revalidatedTags = new Set(normalizeCacheTags(ctx.revalidatedTags))
    }

    async get(cacheKey, ctx = {}) {
      const cacheEntry = edgeIncrementalCache.entries.get(cacheKey)

      if (!cacheEntry) {
        return null
      }

      const entryTags = getCachedEntryTags(cacheEntry, ctx)
      const softTags = normalizeCacheTags(ctx.softTags)
      const relevantTags = normalizeCacheTags([...entryTags, ...softTags])

      if (
        relevantTags.some((tag) => this.revalidatedTags.has(tag)) ||
        hasExpiredCacheTag(relevantTags, edgeIncrementalCache.tagStateByTag, cacheEntry.lastModified)
      ) {
        return null
      }

      const hasStaleTags = hasStaleCacheTag(
        relevantTags,
        edgeIncrementalCache.tagStateByTag,
        cacheEntry.lastModified
      )

      return {
        lastModified: hasStaleTags ? 0 : cacheEntry.lastModified,
        value: cacheEntry.value,
      }
    }

    async set(cacheKey, data, ctx = {}) {
      if (data == null) {
        edgeIncrementalCache.entries.delete(cacheKey)
        return
      }

      edgeIncrementalCache.entries.set(cacheKey, {
        lastModified: Date.now(),
        value: data,
        tags: ctx.fetchCache ? normalizeCacheTags(ctx.tags) : undefined,
      })
    }

    async revalidateTag(tags, durations) {
      const normalizedTags = normalizeCacheTags(
        typeof tags === 'string' ? [tags] : tags
      )

      if (normalizedTags.length === 0) {
        return
      }

      const now = Date.now()

      for (const tag of normalizedTags) {
        const previousState = edgeIncrementalCache.tagStateByTag.get(tag) || {}
        const nextState = { ...previousState }

        if (durations) {
          nextState.stale = now

          if (durations.expire !== undefined) {
            nextState.expired = now + durations.expire * 1000
          }
        } else {
          nextState.expired = now
        }

        edgeIncrementalCache.tagStateByTag.set(tag, nextState)
      }

      await propagateTagStateToNodeSidecar(normalizedTags, durations)
    }

    resetRequestCache() {}
  }

  globalThis[NEXT_CACHE_HANDLERS_SYMBOL] = {
    ...(globalThis[NEXT_CACHE_HANDLERS_SYMBOL] || {}),
    FetchCache: CloudflareAdapterEdgeFetchCache,
  }
}

function getNormalizedNextDataPathname(url, headers, buildId, basePath = '') {
  if (!isNextDataRequest(headers)) {
    return null
  }

  const prefix = `${basePath}/_next/data/${buildId}/`

  if (!url.pathname.startsWith(prefix) || !url.pathname.endsWith('.json')) {
    return null
  }

  const normalized = url.pathname.slice(prefix.length, -'.json'.length)
  return normalized ? `${basePath}/${normalized}` : `${basePath || ''}/`
}

function getStaticDataContentType(pathname) {
  if (pathname.endsWith('.rsc')) {
    return 'text/x-component'
  }

  if (pathname.endsWith('.json')) {
    return 'application/json; charset=utf-8'
  }

  return null
}

function getConfiguredPathPrefix(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return ''
  }

  try {
    if (value.startsWith('http://') || value.startsWith('https://')) {
      const parsed = new URL(value)
      return parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '')
    }
  } catch {}

  return value === '/' ? '' : value.replace(/\/+$/, '')
}

function isStaticAssetRequestPath(pathname, manifest) {
  if (typeof pathname !== 'string') {
    return false
  }

  const prefixes = new Set([
    `${getConfiguredPathPrefix(manifest?.basePath || '')}/_next/static/`,
    `${getConfiguredPathPrefix(manifest?.nextConfig?.assetPrefix || '')}/_next/static/`,
  ])

  for (const prefix of prefixes) {
    if (pathname.startsWith(prefix)) {
      return true
    }
  }

  return false
}

function createNextDataNotFoundResponse(headers = new Headers()) {
  const responseHeaders = mergeHeaders(
    headers,
    new Headers({
      'content-type': 'application/json; charset=utf-8',
    })
  )

  return new Response(JSON.stringify({ notFound: true }), {
    status: 404,
    headers: responseHeaders,
  })
}

async function shouldUsePagesNotFoundFallback(response, output, notFoundOutput) {
  if (!response || response.status !== 404 || output?.type !== 'PAGES') {
    return false
  }

  if (notFoundOutput?.pathname && output?.pathname === notFoundOutput.pathname) {
    return false
  }

  const renderedOutputPathname = response.headers.get('x-adapter-node-output') || ''

  if (notFoundOutput?.pathname && renderedOutputPathname === notFoundOutput.pathname) {
    return true
  }

  const contentType = response.headers.get('content-type') || ''

  if (contentType.length === 0 || contentType.startsWith('text/plain')) {
    return true
  }

  if (
    contentType.startsWith('text/html') &&
    typeof notFoundOutput?.pathname === 'string' &&
    notFoundOutput.pathname.endsWith('/_error')
  ) {
    try {
      const body = await response.clone().text()

      if (
        body.includes('"page":"/_error"') &&
        body.includes('"statusCode":200') &&
        body.includes('An unexpected error has occurred')
      ) {
        return true
      }
    } catch {}
  }

  return false
}

async function shouldUsePagesErrorFallback(response, output, errorOutput, errorAssetPathname) {
  if (!response || response.status < 500 || output?.type !== 'PAGES') {
    return false
  }

  if (
    (errorOutput?.pathname && output.pathname === errorOutput.pathname) ||
    (typeof errorAssetPathname === 'string' && output.pathname === errorAssetPathname)
  ) {
    return false
  }

  const renderedOutputPathname = response.headers.get('x-adapter-node-output') || ''

  if (
    (errorOutput?.pathname && renderedOutputPathname === errorOutput.pathname) ||
    (typeof errorAssetPathname === 'string' && renderedOutputPathname === errorAssetPathname)
  ) {
    return false
  }

  const contentType = response.headers.get('content-type') || ''

  if (contentType.length === 0 || contentType.startsWith('text/plain')) {
    return true
  }

  if (contentType.startsWith('text/html')) {
    try {
      const body = await response.clone().text()

      if (
        body.includes('"page":"/_error"') &&
        body.includes('"statusCode":500') &&
        body.includes('Internal Server Error')
      ) {
        return true
      }
    } catch {}
  }

  return false
}

function getNotFoundRequestMeta(requestMeta = {}) {
  return {
    ...requestMeta,
    adapterRenderNotFound: true,
    adapterRenderStatusCode: 404,
  }
}

async function shouldBypassStaticHtmlShell(assetResponse, output) {
  if (
    assetResponse.status !== 200 ||
    output?.type !== 'APP_PAGE' ||
    output?.runtime !== 'nodejs'
  ) {
    return false
  }

  const contentType = assetResponse.headers.get('content-type') || ''

  if (!contentType.startsWith('text/html')) {
    return false
  }

  try {
    const body = await assetResponse.clone().text()
    const hasSuspenseBoundary = body.includes('template id="B:')
    const hasInlineResumeScript = body.includes('self.__next_f')
    const hasPendingResumePlaceholder = body.includes('template id="P:')
    const isTruncatedShell = !body.includes('</body>') || !body.includes('</html>')
    return (
      (hasSuspenseBoundary && !hasInlineResumeScript) ||
      (hasPendingResumePlaceholder && isTruncatedShell) ||
      (hasSuspenseBoundary && isTruncatedShell && !body.includes('self.__next_f'))
    )
  } catch {
    return false
  }
}

function getSegmentPrefetchAssetPathname(assetPathname, requestHeaders, assetPathnames) {
  const segmentPrefetchPath = requestHeaders.get('next-router-segment-prefetch')

  if (
    typeof segmentPrefetchPath !== 'string' ||
    typeof assetPathname !== 'string' ||
    !segmentPrefetchPath.startsWith('/')
  ) {
    return null
  }

  const segmentAssetBase = assetPathname.endsWith('.rsc')
    ? assetPathname.slice(0, -'.rsc'.length)
    : assetPathname
  const candidatePathname = `${segmentAssetBase}.segments${segmentPrefetchPath}.segment.rsc`
  return assetPathnames.has(candidatePathname) ? candidatePathname : null
}

function getConcretePrerenderAssetPathname(routeResult, requestUrl, requestIsRsc, assetPathnames) {
  if (
    typeof routeResult?.resolvedPathname !== 'string' ||
    !routeResult.resolvedPathname.includes('[')
  ) {
    return null
  }

  const candidatePathnames = new Set()
  const concretePathnames = [
    routeResult.invocationTarget?.pathname,
    routeResult.resolvedRequestUrl?.pathname,
    requestUrl.pathname,
    interpolateRoutePathname(routeResult.resolvedPathname, routeResult.routeMatches),
  ]

  for (const pathname of concretePathnames) {
    if (typeof pathname !== 'string' || pathname.length === 0) {
      continue
    }

    candidatePathnames.add(pathname)

    try {
      candidatePathnames.add(decodeURIComponent(pathname))
    } catch {}
  }

  for (const pathname of candidatePathnames) {
    const assetPathname = requestIsRsc && !pathname.endsWith('.rsc') ? `${pathname}.rsc` : pathname

    if (assetPathnames.has(assetPathname)) {
      return assetPathname
    }
  }

  return null
}

function hasDraftModeCookie(headers) {
  const cookieHeader = headers.get('cookie')
  return typeof cookieHeader === 'string' && cookieHeader.includes('__prerender_bypass=')
}

function hasOnDemandRevalidateHeader(headers) {
  const revalidateHeader = headers.get('x-prerender-revalidate')
  return typeof revalidateHeader === 'string' && revalidateHeader.length > 0
}

function hasInvalidUrlEncoding(url) {
  try {
    decodeURIComponent(url.pathname)
    return false
  } catch {
    return true
  }
}

function teeRequestBody(body) {
  if (!body) {
    return {
      middlewareBody: emptyBodyStream(),
      handlerBody: undefined,
    }
  }

  const [middlewareBody, handlerBody] = body.tee()

  return {
    middlewareBody,
    handlerBody,
  }
}

async function bufferRequestBody(body) {
  if (!body) {
    return undefined
  }

  const payload = await new Response(body).arrayBuffer()
  return payload.byteLength > 0 ? payload : undefined
}

function applyQuery(url, query) {
  url.search = ''

  for (const [key, value] of Object.entries(query ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, item)
      }
      continue
    }

    url.searchParams.set(key, value)
  }
}

function mergeHeaders(baseHeaders, extraHeaders) {
  const merged = new Headers(baseHeaders)

  if (!extraHeaders) {
    return merged
  }

  extraHeaders.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      merged.append(key, value)
      return
    }

    merged.set(key, value)
  })

  return merged
}

const NEXT_VARY_HEADER_FIELDS = [
  'rsc',
  'next-router-state-tree',
  'next-router-prefetch',
  'next-router-segment-prefetch',
]

const ASSET_FETCH_VARY_HEADER_FIELDS = [
  ...NEXT_VARY_HEADER_FIELDS,
  'next-url',
  'x-now-route-matches',
]

function appendDelimitedHeaderValue(headers, key, value) {
  if (!(headers instanceof Headers) || typeof value !== 'string' || value.length === 0) {
    return
  }

  const existing = headers.get(key)
  const tokens = new Map()

  for (const item of `${existing || ''},${value}`.split(',')) {
    const token = item.trim()

    if (!token) {
      continue
    }

    tokens.set(token.toLowerCase(), token)
  }

  if (tokens.size > 0) {
    headers.set(key, Array.from(tokens.values()).join(', '))
  }
}

function shouldApplyNextVaryHeader(output, requestHeaders) {
  return output?.type === 'APP_PAGE' || requestHeaders?.get('rsc') === '1'
}

function hashHeaderKey(value) {
  let hash = 5381

  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index)
  }

  return (hash >>> 0).toString(36)
}

function getAssetFetchVaryKey(requestHeaders, output) {
  if (
    !(requestHeaders instanceof Headers) ||
    !(output?.type === 'APP_PAGE' && requestHeaders.get('rsc') === '1')
  ) {
    return ''
  }

  const headerEntries = ASSET_FETCH_VARY_HEADER_FIELDS.flatMap((key) => {
    const value = requestHeaders.get(key)
    return value === null ? [] : [[key, value]]
  })

  if (headerEntries.length === 0) {
    return ''
  }

  return hashHeaderKey(
    headerEntries.map(([key, value]) => `${key}:${value}`).join('\n')
  )
}

function applyNextVaryHeader(headers, requestHeaders, output) {
  if (!shouldApplyNextVaryHeader(output, requestHeaders)) {
    return
  }

  appendDelimitedHeaderValue(headers, 'vary', NEXT_VARY_HEADER_FIELDS.join(', '))
}

function toRelativeRedirectTarget(target, requestUrl) {
  try {
    const redirectUrl = new URL(target, requestUrl)
    return redirectUrl.origin === requestUrl.origin
      ? `${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`
      : redirectUrl.toString()
  } catch {
    return target
  }
}

function applyNextDataRedirectHeaders(headers, requestHeaders, requestUrl) {
  if (!isNextDataRequest(requestHeaders)) {
    return headers
  }

  const location = headers.get('location')

  if (!location) {
    return headers
  }

  headers.delete('location')
  headers.set('x-nextjs-redirect', toRelativeRedirectTarget(location, requestUrl))

  return headers
}

function normalizeRedirectLocation(location, requestUrl, nextConfig) {
  if (!location || nextConfig?.trailingSlash) {
    return location
  }

  try {
    const redirectUrl = new URL(location, requestUrl)

    if (redirectUrl.origin !== requestUrl.origin) {
      return location
    }

    if (redirectUrl.pathname !== '/' && redirectUrl.pathname.endsWith('/')) {
      redirectUrl.pathname = redirectUrl.pathname.slice(0, -1)
    }

    return `${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`
  } catch {
    return location
  }
}

function getMiddlewareAddedResponseHeaders(originalHeaders, downstreamHeaders) {
  const addedHeaders = new Headers()
  const blockedResponseHeaders = new Set([
    'accept',
    'accept-encoding',
    'accept-language',
    'connection',
    'content-length',
    'cookie',
    'host',
    'set-cookie',
    'user-agent',
    'x-now-route-matches',
  ])

  downstreamHeaders.forEach((value, key) => {
    const lowerKey = key.toLowerCase()

    if (blockedResponseHeaders.has(lowerKey) || lowerKey.startsWith('x-middleware-')) {
      return
    }

    if (originalHeaders.get(key) === value) {
      return
    }

    addedHeaders.set(key, value)
  })

  return addedHeaders
}

function normalizeNextQueryParam(key) {
  for (const prefix of ['nxtP', 'nxtI']) {
    if (key !== prefix && key.startsWith(prefix)) {
      return key.slice(prefix.length)
    }
  }

  return null
}

function normalizeRouteParamKey(key) {
  return String(key).replace(/[^a-zA-Z0-9]/g, '')
}

function normalizeLocalePathname(pathname, locales) {
  if (!Array.isArray(locales) || locales.length === 0) {
    return { pathname, detectedLocale: undefined }
  }

  const segments = pathname.split('/')
  const firstSegment = segments[1]?.toLowerCase()

  if (!firstSegment) {
    return { pathname, detectedLocale: undefined }
  }

  const detectedLocale = locales.find((locale) => locale.toLowerCase() === firstSegment)

  if (!detectedLocale) {
    return { pathname, detectedLocale: undefined }
  }

  return {
    pathname: pathname.slice(detectedLocale.length + 1) || '/',
    detectedLocale,
  }
}

function getNotFoundAssetPathname(requestUrl, manifest, assetPathnames) {
  const basePath = manifest.basePath || ''
  const i18n = manifest.nextConfig?.i18n || manifest.i18n
  const pathname = requestUrl.pathname.startsWith(basePath)
    ? requestUrl.pathname.slice(basePath.length) || '/'
    : requestUrl.pathname
  const candidates = []

  if (i18n?.defaultLocale && Array.isArray(i18n.locales) && i18n.locales.length > 0) {
    const normalized = normalizeLocalePathname(pathname, i18n.locales)
    const locale = normalized.detectedLocale || i18n.defaultLocale

    if (locale) {
      candidates.push(`${basePath}/${locale}/404`)
    }
  }

  candidates.push(`${basePath}/404`)

  for (const candidate of candidates) {
    if (assetPathnames.has(candidate)) {
      return candidate
    }
  }

  return null
}

function getPagesErrorOutput(routeOutputs, basePath = '') {
  const candidates = [`${basePath}/500`, `${basePath}/_error`]

  for (const candidate of candidates) {
    const output = routeOutputs.get(candidate)

    if (output?.type === 'PAGES') {
      return output
    }
  }

  return undefined
}

function getErrorAssetPathname(manifest, assetPathnames) {
  const basePath = manifest.basePath || ''

  for (const candidate of [`${basePath}/500`, `${basePath}/_error`]) {
    if (assetPathnames.has(candidate)) {
      return candidate
    }
  }

  return null
}

function getRouteParamDefinitions(routePathname) {
  if (!routePathname) {
    return []
  }

  const matches = routePathname.matchAll(
    /\[\[\.\.\.([^\]/]+)\]\]|\[\.\.\.([^\]/]+)\]|\[([^\]/]+)\]/g
  )

  return Array.from(matches, (match) => {
    const name = match[1] || match[2] || match[3]
    const repeat = Boolean(match[1] || match[2])

    return {
      name,
      repeat,
      normalized: normalizeRouteParamKey(name),
    }
  })
}

function toRouteParams(routeMatches, routePathname) {
  if (!routeMatches) {
    return undefined
  }

  const params = {}
  const paramDefinitions = getRouteParamDefinitions(routePathname)
  const paramsByNormalizedName = new Map(
    paramDefinitions.map((definition) => [definition.normalized, definition])
  )

  for (const [key, value] of Object.entries(routeMatches)) {
    if (/^\d+$/.test(key) || value === undefined) {
      continue
    }

    const normalizedKey = normalizeNextQueryParam(key) || key
    const definition =
      paramsByNormalizedName.get(normalizeRouteParamKey(normalizedKey)) || null
    const routeParamName = definition?.name || normalizedKey

    if (definition?.repeat && typeof value === 'string') {
      params[routeParamName] = value.split('/')
      continue
    }

    params[routeParamName] = value
  }

  return Object.keys(params).length > 0 ? params : undefined
}

function getOutputRoutePathname(output, buildId, basePath = '') {
  if (typeof output?.pathname !== 'string') {
    return null
  }

  const matchedNodeDataPath = getMatchedPathFromNodeDataOutput(output.pathname, buildId, basePath)

  if (matchedNodeDataPath) {
    return matchedNodeDataPath
  }

  if (
    output?.type === 'APP_PAGE' &&
    output.pathname.endsWith('.rsc') &&
    !output.pathname.includes('.segment.rsc') &&
    !output.pathname.includes('.segments/')
  ) {
    const routePathname = output.pathname.slice(0, -'.rsc'.length) || '/'
    return routePathname === '/index' ? '/' : routePathname
  }

  return output.pathname
}

function interpolateRoutePathname(routePathname, routeMatches) {
  if (typeof routePathname !== 'string' || !routePathname.includes('[')) {
    return routePathname
  }

  const params = toRouteParams(routeMatches, routePathname)

  if (!params) {
    return routePathname
  }

  return routePathname.replace(
    /\[\[\.\.\.([^\]/]+)\]\]|\[\.\.\.([^\]/]+)\]|\[([^\]/]+)\]/g,
    (match, optionalCatchallName, catchallName, dynamicName) => {
      const paramName = optionalCatchallName || catchallName || dynamicName
      const value = params[paramName]

      if (value === undefined) {
        return match
      }

      if (Array.isArray(value)) {
        return value.map((item) => encodeURIComponent(String(item))).join('/')
      }

      return encodeURIComponent(String(value))
    }
  )
}

function toRouteMatchesHeader(routeMatches) {
  if (!routeMatches) {
    return undefined
  }

  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(routeMatches)) {
    if (/^\d+$/.test(key) || value === undefined) {
      continue
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, item)
      }
      continue
    }

    params.set(key, value)
  }

  const encoded = params.toString()
  return encoded || undefined
}

function createRouteRequestMeta(routeResult, manifest, requestUrl, output) {
  if (!routeResult) {
    return undefined
  }

  const requestNodeDataPath =
    typeof requestUrl?.pathname === 'string'
      ? getMatchedPathFromNodeDataOutput(requestUrl.pathname, manifest?.buildId, manifest?.basePath)
      : null
  const outputNodeDataPath =
    output?.type === 'PAGES' && typeof output?.pathname === 'string'
      ? getMatchedPathFromNodeDataOutput(output.pathname, manifest?.buildId, manifest?.basePath)
      : null
  const matchedNodeDataPath = requestNodeDataPath || outputNodeDataPath
  const routePathname =
    getOutputRoutePathname(output, manifest?.buildId, manifest?.basePath) || routeResult.resolvedPathname
  const resolvedPathname = interpolateRoutePathname(routePathname, routeResult.routeMatches)
  const invokePath = routeResult.invocationTarget?.pathname || resolvedPathname
  const params = toRouteParams(routeResult.routeMatches, routePathname)
  const requestQuery = parseRequestQuery(requestUrl)
  const query =
    requestQuery || routeResult.resolvedQuery
      ? {
          ...(requestQuery || {}),
          ...(routeResult.resolvedQuery || {}),
        }
      : undefined

  if (
    params === undefined &&
    query === undefined &&
    resolvedPathname === undefined &&
    invokePath === undefined
  ) {
    return undefined
  }

  const requestMeta = {
    params,
    query,
    resolvedPathname,
    invokePath,
    invokeQuery: query,
  }

  if (matchedNodeDataPath) {
    requestMeta.isNextDataReq = true
  }

  const i18n = manifest?.nextConfig?.i18n

  if (i18n?.defaultLocale && Array.isArray(i18n.locales) && i18n.locales.length > 0) {
    const basePath = manifest?.basePath || ''
    const localeSourcePathname =
      matchedNodeDataPath ||
      invokePath ||
      resolvedPathname ||
      requestUrl?.pathname ||
      routeResult.invocationTarget?.pathname ||
      null

    if (typeof localeSourcePathname === 'string') {
      const localePathname = basePath && localeSourcePathname.startsWith(basePath)
        ? localeSourcePathname.slice(basePath.length) || '/'
        : localeSourcePathname
      const normalizedLocalePath = normalizeLocalePathname(localePathname, i18n.locales)

      if (normalizedLocalePath.detectedLocale) {
        requestMeta.locale = normalizedLocalePath.detectedLocale
        requestMeta.defaultLocale = i18n.defaultLocale
        requestMeta.didStripLocale = true
      } else {
        requestMeta.locale = i18n.defaultLocale
        requestMeta.defaultLocale = i18n.defaultLocale
        requestMeta.localeInferredFromDefault = true
      }
    }
  }

  return requestMeta
}

function createDerivedRequest(request, { url, headers, body }) {
  const requestInit = {
    method: request.method,
    headers,
    body: canHaveBody(request.method) ? body : undefined,
    redirect: request.redirect,
  }

  if (requestInit.body) {
    requestInit.duplex = 'half'
  }

  return new Request(url, requestInit)
}

function attachEdgeRequestContext(request, { nextConfig, requestMeta } = {}) {
  if (nextConfig !== undefined && !('nextConfig' in request)) {
    Object.defineProperty(request, 'nextConfig', {
      value: nextConfig,
      configurable: true,
    })
  }

  if (requestMeta !== undefined && !('requestMeta' in request)) {
    Object.defineProperty(request, 'requestMeta', {
      value: requestMeta,
      configurable: true,
    })
  }

  return request
}

function getPublicRscSearch(requestUrl) {
  if (!(requestUrl instanceof URL) || typeof requestUrl.search !== 'string') {
    return ''
  }

  const rawSearch = requestUrl.search.startsWith('?') ? requestUrl.search.slice(1) : requestUrl.search

  if (!rawSearch) {
    return ''
  }

  const segments = rawSearch
    .split('&')
    .filter(Boolean)
    .filter((segment) => {
      const separatorIndex = segment.indexOf('=')
      const rawKey = separatorIndex === -1 ? segment : segment.slice(0, separatorIndex)
      return rawKey !== '_rsc'
    })

  return segments.length > 0 ? `?${segments.join('&')}` : ''
}

function getRscCanonicalUrlParts(pathname, renderedSearch = '') {
  return `${pathname}${renderedSearch}`.split('/')
}

async function patchAppRscMetadata(response, requestUrl, output) {
  if (
    output?.type !== 'APP_PAGE' ||
    !(requestUrl instanceof URL) ||
    response.status !== 200 ||
    !response.body
  ) {
    return response
  }

  const contentType = response.headers.get('content-type') || ''

  if (!contentType.startsWith('text/x-component')) {
    return response
  }

  const renderedSearch = getPublicRscSearch(requestUrl)

  if (!renderedSearch) {
    return response
  }

  const patchedHeaders = new Headers(response.headers)

  patchedHeaders.set('x-nextjs-rewritten-query', renderedSearch.slice(1))

  patchedHeaders.delete('content-encoding')

  let bodyText

  try {
    bodyText = await response.text()
  } catch {
    return response
  }

  const bodyLines = bodyText.split('\n')
  const rootPayloadIndex = bodyLines.findIndex((line) => line.startsWith('0:{'))

  if (rootPayloadIndex === -1) {
    patchedHeaders.delete('content-length')
    patchedHeaders.delete('etag')

    return new Response(bodyText, {
      status: response.status,
      statusText: response.statusText,
      headers: patchedHeaders,
    })
  }

  let rootPayload

  try {
    rootPayload = JSON.parse(bodyLines[rootPayloadIndex].slice(2))
  } catch {
    patchedHeaders.delete('content-length')
    patchedHeaders.delete('etag')

    return new Response(bodyText, {
      status: response.status,
      statusText: response.statusText,
      headers: patchedHeaders,
    })
  }

  rootPayload.c = getRscCanonicalUrlParts(requestUrl.pathname, renderedSearch)
  rootPayload.q = renderedSearch
  bodyLines[rootPayloadIndex] = `0:${JSON.stringify(rootPayload)}`

  patchedHeaders.delete('content-length')
  patchedHeaders.delete('etag')

  return new Response(bodyLines.join('\n'), {
    status: response.status,
    statusText: response.statusText,
    headers: patchedHeaders,
  })
}

async function stripPassThroughContentEncoding(response) {
  if (!(response instanceof Response)) {
    return response
  }

  const contentEncoding = response.headers.get('content-encoding')

  if (typeof contentEncoding !== 'string' || contentEncoding.length === 0) {
    return response
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  const shouldStripEncoding =
    contentType.startsWith('text/html') || contentType.startsWith('text/x-component')

  if (!shouldStripEncoding) {
    return response
  }

  let bodyText

  try {
    bodyText = await response.text()
  } catch {
    return response
  }

  const strippedHeaders = new Headers(response.headers)
  strippedHeaders.delete('content-encoding')
  strippedHeaders.delete('content-length')
  strippedHeaders.delete('etag')

  return new Response(bodyText, {
    status: response.status,
    statusText: response.statusText,
    headers: strippedHeaders,
  })
}

async function normalizeAppPageHtmlAssetResponse(response, output) {
  if (!(response instanceof Response) || output?.type !== 'APP_PAGE') {
    return stripPassThroughContentEncoding(response)
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase()

  if (!contentType.startsWith('text/html')) {
    return stripPassThroughContentEncoding(response)
  }

  let bodyText

  try {
    bodyText = await response.text()
  } catch {
    return response
  }

  const headers = new Headers(response.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  headers.delete('etag')
  headers.delete('last-modified')

  return new Response(bodyText, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

async function finalizeResponse(
  response,
  { headers, status, requestHeaders, requestUrl, nextConfig, output } = {}
) {
  let nextStatus = status ?? response.status
  const nextRequestUrl = requestUrl ?? new URL(response.url || 'http://localhost')
  const mergedHeaders = mergeHeaders(response.headers, headers)
  const responseWithMergedHeaders = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: mergedHeaders,
  })
  const patchedResponse = await patchAppRscMetadata(
    responseWithMergedHeaders,
    nextRequestUrl,
    output
  )
  const finalHeaders = new Headers(patchedResponse.headers)
  applyNextVaryHeader(finalHeaders, requestHeaders ?? new Headers(), output)

  if (
    requestHeaders instanceof Headers &&
    requestHeaders.get('rsc') === '1' &&
    (patchedResponse.headers.get('content-type') || '')
      .toLowerCase()
      .startsWith('text/x-component')
  ) {
    finalHeaders.set('content-encoding', 'identity')
    finalHeaders.delete('content-length')
    finalHeaders.delete('etag')
    finalHeaders.delete('expires')
    finalHeaders.delete('last-modified')
    finalHeaders.set(
      'cache-control',
      'private, no-cache, no-store, no-transform, max-age=0, must-revalidate'
    )
  }

  const normalizedLocation = normalizeRedirectLocation(
    finalHeaders.get('location'),
    nextRequestUrl,
    nextConfig
  )

  if (
    output?.type === 'APP_PAGE' &&
    requestHeaders instanceof Headers &&
    requestHeaders.get('rsc') === '1' &&
    isRedirectStatusCode(nextStatus)
  ) {
    nextStatus = 200
  }

  if (normalizedLocation) {
    finalHeaders.set('location', normalizedLocation)
  }

  applyNextDataRedirectHeaders(finalHeaders, requestHeaders ?? new Headers(), nextRequestUrl)
  const init = {
    status: nextStatus,
    headers: finalHeaders,
  }

  if (status === undefined || status === response.status) {
    init.statusText = patchedResponse.statusText
  }

  return new Response(patchedResponse.body, {
    ...init,
  })
}

function isPagesPrerenderResponse(response, requestHeaders, output) {
  if (!(response instanceof Response) || output?.type !== 'PAGES') {
    return false
  }

  const cacheMarker = response.headers.get('x-nextjs-cache') || response.headers.get('x-vercel-cache')

  if (!cacheMarker) {
    return false
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  return (
    isNextDataRequest(requestHeaders) ||
    contentType.startsWith('text/html') ||
    contentType.startsWith('application/json')
  )
}

function normalizePagesPrerenderResponse(response, requestHeaders, output) {
  if (!isPagesPrerenderResponse(response, requestHeaders, output)) {
    return response
  }

  const headers = new Headers(response.headers)
  headers.set('cache-control', 'public, max-age=0, must-revalidate')

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

async function invokeMiddlewareOutput(handler, request, context) {
  const buildManifestKey = '__BUILD_MANIFEST'
  const hadBuildManifest = Object.prototype.hasOwnProperty.call(globalThis, buildManifestKey)
  const buildManifestDescriptor = hadBuildManifest
    ? Object.getOwnPropertyDescriptor(globalThis, buildManifestKey)
    : null

  if (hadBuildManifest) {
    Reflect.deleteProperty(globalThis, buildManifestKey)
  }

  try {
    return await handler(request, context)
  } finally {
    if (buildManifestDescriptor) {
      Object.defineProperty(globalThis, buildManifestKey, buildManifestDescriptor)
    } else {
      Reflect.deleteProperty(globalThis, buildManifestKey)
    }
  }
}

async function invokeOutput(output, request, executionCtx, nextConfig, requestMeta = {}) {
  const entry = await globalThis._ENTRIES?.[output.edgeRuntime.entryKey]

  if (!entry) {
    throw new Error(`Edge entry was not registered for ${output.pathname}`)
  }

  const handler = entry[output.edgeRuntime.handlerExport]

  if (typeof handler !== 'function') {
    throw new Error(
      `Edge handler export ${output.edgeRuntime.handlerExport} was not found for ${output.pathname}`
    )
  }

  const invocationRequest = attachEdgeRequestContext(request, { nextConfig, requestMeta })
  const invocationContext = {
    waitUntil: executionCtx?.waitUntil?.bind(executionCtx),
    signal: request.signal,
    requestMeta,
  }

  if (output.type === 'MIDDLEWARE') {
    return invokeMiddlewareOutput(handler, invocationRequest, invocationContext)
  }

  return handler(invocationRequest, invocationContext)
}

async function invokeRouteOutput(
  output,
  request,
  executionCtx,
  nodeRuntime,
  nextConfig,
  requestMeta = {}
) {
  if (output.runtime === 'edge') {
    return invokeOutput(output, request, executionCtx, nextConfig, requestMeta)
  }

  if (!nodeRuntime) {
    throw new Error(`Node runtime was not initialized for ${output.pathname}`)
  }

  return nodeRuntime.fetch(request, {
    output,
    executionCtx,
    requestMeta,
  })
}

function buildInvocationUrl(requestUrl, invocationTarget) {
  const invocationUrl = new URL(requestUrl.toString())

  if (!invocationTarget) {
    return invocationUrl
  }

  invocationUrl.pathname = invocationTarget.pathname
  if (typeof invocationTarget.rawQuery === 'string') {
    invocationUrl.search = invocationTarget.rawQuery
  } else {
    applyQuery(invocationUrl, invocationTarget.query)
  }

  return invocationUrl
}

function parseRequestQuery(requestUrl) {
  if (!requestUrl) {
    return undefined
  }

  let url

  try {
    url =
      requestUrl instanceof URL ? requestUrl : new URL(String(requestUrl), 'http://localhost')
  } catch {
    return undefined
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

  return Object.keys(query).length > 0 ? query : undefined
}

function getMatchedPathFromNodeDataOutput(pathname, buildId, basePath = '') {
  const prefix = `${basePath}/_next/data/${buildId}/`

  if (!pathname.startsWith(prefix) || !pathname.endsWith('.json')) {
    return null
  }

  const normalized = pathname.slice(prefix.length, -'.json'.length)

  if (!normalized || normalized === 'index') {
    return `${basePath || ''}/`
  }

  return `${basePath}/${normalized}`
}

function isRedirectResponse(response) {
  return response.status >= 300 && response.status < 400
}

function matchesDynamicRoutePathname(pathname, route, caseSensitive = false) {
  const nextPathname =
    pathname !== '/' && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname

  try {
    return new RegExp(route.sourceRegex, caseSensitive ? '' : 'i').test(nextPathname)
  } catch {
    return false
  }
}

function getDynamicRouteMatch(pathname, route, caseSensitive = false) {
  if (typeof pathname !== 'string') {
    return null
  }

  const nextPathname =
    pathname !== '/' && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname

  let regexMatches

  try {
    regexMatches = nextPathname.match(new RegExp(route.sourceRegex, caseSensitive ? '' : 'i'))
  } catch {
    return null
  }

  if (!regexMatches) {
    return null
  }

  const params = {}

  for (let index = 1; index < regexMatches.length; index += 1) {
    if (regexMatches[index] !== undefined) {
      params[String(index)] = regexMatches[index]
    }
  }

  if (regexMatches.groups) {
    Object.assign(params, regexMatches.groups)
  }

  return {
    params,
    regexMatches,
  }
}

function getDynamicRscOutput(resolvedPathname, manifest, routeOutputs) {
  if (typeof resolvedPathname !== 'string') {
    return undefined
  }

  const caseSensitive = manifest.nextConfig?.caseSensitiveRoutes === true

  for (const route of manifest.routing?.dynamicRoutes ?? []) {
    if (typeof route?.source !== 'string' || route.source.endsWith('.rsc')) {
      continue
    }

    const dynamicOutputPathname = `${route.source}.rsc`

    if (!routeOutputs.has(dynamicOutputPathname)) {
      continue
    }

    const dynamicMatch = getDynamicRouteMatch(resolvedPathname, route, caseSensitive)

    if (dynamicMatch) {
      return {
        output: routeOutputs.get(dynamicOutputPathname),
        routeMatches: dynamicMatch.params,
      }
    }
  }

  return undefined
}

function getDynamicRouteOutput(resolvedPathname, manifest, routeOutputs) {
  if (typeof resolvedPathname !== 'string') {
    return undefined
  }

  const caseSensitive = manifest.nextConfig?.caseSensitiveRoutes === true

  for (const route of manifest.routing?.dynamicRoutes ?? []) {
    if (typeof route?.source !== 'string' || !routeOutputs.has(route.source)) {
      continue
    }

    const dynamicMatch = getDynamicRouteMatch(resolvedPathname, route, caseSensitive)

    if (dynamicMatch) {
      return {
        output: routeOutputs.get(route.source),
        routeMatches: dynamicMatch.params,
      }
    }
  }

  return undefined
}

function logWorkerRscDebugSnapshot(kind, requestUrl, requestHeaders, details = {}) {
  if (globalThis.process?.env?.CLOUDFLARE_ADAPTER_DEBUG_WORKER_RSC !== '1') {
    return
  }

  const interestingHeaders = [
    'rsc',
    'next-router-prefetch',
    'next-router-segment-prefetch',
    'next-router-state-tree',
    'next-url',
    'x-now-route-matches',
  ]

  const headers = Object.fromEntries(
    interestingHeaders.flatMap((key) =>
      requestHeaders.get(key) === null ? [] : [[key, requestHeaders.get(key)]]
    )
  )

  console.log(
    'Cloudflare adapter worker RSC debug',
    JSON.stringify(
      {
        kind,
        url: `${requestUrl.pathname}${requestUrl.search}`,
        headers,
        ...details,
      }
    )
  )
}

function logWorkerActionDebugSnapshot(request, routeResult, output) {
  if (globalThis.process?.env?.CLOUDFLARE_ADAPTER_DEBUG_ACTION_ROUTE !== '1') {
    return
  }

  if (request.method !== 'POST' || !request.headers.has('next-action')) {
    return
  }

  console.log(
    'Cloudflare adapter action route debug',
    JSON.stringify({
      url: request.url,
      resolvedPathname: routeResult?.resolvedPathname,
      invocationTarget: routeResult?.invocationTarget,
      routeMatches: routeResult?.routeMatches,
      outputPathname: output?.pathname ?? null,
      outputType: output?.type ?? null,
    })
  )
}

function logWorkerI18nDebugSnapshot(requestUrl, routeResult, routeRequestMeta, output) {
  if (globalThis.process?.env?.CLOUDFLARE_ADAPTER_DEBUG_I18N !== '1') {
    return
  }

  console.log(
    'Cloudflare adapter worker i18n debug',
    JSON.stringify({
      url: `${requestUrl.pathname}${requestUrl.search}`,
      resolvedPathname: routeResult?.resolvedPathname,
      invocationTarget: routeResult?.invocationTarget,
      routeMatches: routeResult?.routeMatches,
      outputPathname: output?.pathname ?? null,
      outputType: output?.type ?? null,
      requestMeta: routeRequestMeta ?? null,
    })
  )
}

async function fetchAssetResponse(env, request, maxRedirects = 5) {
  let currentRequest = request

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const response = await env.ASSETS.fetch(currentRequest)

    if (!isRedirectResponse(response)) {
      return response
    }

    const location = response.headers.get('location')

    if (!location || redirects === maxRedirects) {
      return response
    }

    const nextUrl = new URL(location, currentRequest.url)
    currentRequest = createDerivedRequest(currentRequest, {
      url: nextUrl.toString(),
      headers: new Headers(currentRequest.headers),
      body: undefined,
    })
  }

  return env.ASSETS.fetch(currentRequest)
}

export function createWorker(manifest) {
  installEmbeddedBlobFetchBridge()

  const edgeIncrementalCache = {
    entries: new Map(),
    tagStateByTag: new Map(),
  }

  installEdgeIncrementalFetchCache(edgeIncrementalCache)

  const routeOutputs = new Map(
    manifest.routeOutputs.map((output) => [output.pathname, output])
  )
  const assetPathnames = new Set(manifest.assetPathnames)
  const prerenderAssetPathnames = new Set(manifest.prerenderAssetPathnames ?? [])
  const prerenderDataRouteMap = new Map(Object.entries(manifest.prerenderDataRouteMap ?? {}))
  const assetPathMap = new Map(Object.entries(manifest.assetPathMap ?? {}))
  const assetMetadata = new Map(Object.entries(manifest.assetMetadata ?? {}))
  const previewModeId = getPreviewModeId(manifest)
  const fulfilledNodeAppPageTagStateByTag = new Map()
  const notFoundOutput = manifest.notFoundPathname
    ? routeOutputs.get(manifest.notFoundPathname)
    : undefined
  const errorOutput = getPagesErrorOutput(routeOutputs, manifest.basePath)
  const staticNotFoundAssetPathname = getNotFoundAssetPathname(
    new URL(`https://adapter.invalid${manifest.basePath || '/'}`),
    manifest,
    assetPathnames
  )
  const staticErrorAssetPathname = getErrorAssetPathname(manifest, assetPathnames)
  const revalidatedPrerenderPathnames = new Set()
  const nodeRuntime = manifest.nodeRuntime?.enabled ? createNodeRuntime(manifest) : null

  return {
    async fetch(request, env, executionCtx) {
      await syncEdgeTagStateFromNodeSidecar(edgeIncrementalCache)

      if (request.url) {
        const directUrl = new URL(request.url)

        if (directUrl.pathname === '/_adapter/status' && nodeRuntime) {
          return nodeRuntime.fetch(request)
        }
      }

      const requestUrl = new URL(request.url)

      if (hasInvalidUrlEncoding(requestUrl)) {
        return new Response('Bad Request', { status: 400 })
      }

      const requestHeaders = new Headers(request.headers)
      const requestHasDraftModeCookie = hasDraftModeCookie(requestHeaders)
      const { middlewareBody, handlerBody } = teeRequestBody(request.body)
      let downstreamRequestHeaders = new Headers(requestHeaders)
      let middlewareResponse

      const routeResult = await resolveRoutes({
        url: requestUrl,
        buildId: manifest.buildId,
        basePath: manifest.basePath,
        nextConfig: manifest.nextConfig,
        trailingSlash: manifest.nextConfig?.trailingSlash,
        preferDynamicRoutes: canHaveBody(request.method),
        i18n: manifest.i18n,
        headers: requestHeaders,
        requestBody: middlewareBody,
        pathnames: manifest.pathnames,
        dynamicPrerenderRoutes: manifest.dynamicPrerenderRoutes,
        routes: manifest.routing,
        middlewareMatchers: manifest.middleware?.config?.matchers,
        invokeMiddleware: async (ctx) => {
          if (!manifest.middleware) {
            return {}
          }

          const middlewareBody = canHaveBody(request.method)
            ? await bufferRequestBody(ctx.requestBody)
            : undefined
          const middlewareRequest = createDerivedRequest(request, {
            url: ctx.url.toString(),
            headers: ctx.headers,
            body: middlewareBody,
          })

          middlewareResponse = await invokeRouteOutput(
            manifest.middleware,
            middlewareRequest,
            executionCtx,
            nodeRuntime,
            manifest.nextConfig
          )

          const middlewareResult = responseToMiddlewareResult(
            middlewareResponse,
            new Headers(ctx.headers),
            ctx.url
          )

          if (middlewareResult.requestHeaders) {
            downstreamRequestHeaders = new Headers(middlewareResult.requestHeaders)
          }

          return middlewareResult
        },
      })

      if (routeResult.middlewareResponded && middlewareResponse) {
        return middlewareResponse
      }

      if (routeResult.redirect) {
        const redirectHeaders = applyNextDataRedirectHeaders(
          mergeHeaders(routeResult.resolvedHeaders),
          requestHeaders,
          requestUrl
        )
        const resolvedRedirectLocation = toRelativeRedirectTarget(
          routeResult.redirect.url.toString(),
          requestUrl
        )

        redirectHeaders.set('location', resolvedRedirectLocation)

        const normalizedLocation = normalizeRedirectLocation(
          redirectHeaders.get('location'),
          requestUrl,
          manifest.nextConfig
        )

        if (normalizedLocation) {
          redirectHeaders.set('location', normalizedLocation)
        }

        applyNextDataRedirectHeaders(redirectHeaders, requestHeaders, requestUrl)

        return new Response(null, {
          status: routeResult.redirect.status,
          headers: redirectHeaders,
        })
      }

      if (routeResult.externalRewrite) {
        const middlewareAddedHeaders = getMiddlewareAddedResponseHeaders(
          requestHeaders,
          downstreamRequestHeaders
        )
        const rewrittenRequest = createDerivedRequest(request, {
          url: routeResult.externalRewrite.toString(),
          headers: downstreamRequestHeaders,
          body: handlerBody,
        })
        const rewrittenResponse = await fetch(rewrittenRequest)

        return finalizeResponse(rewrittenResponse, {
          headers: mergeHeaders(routeResult.resolvedHeaders, middlewareAddedHeaders),
          status: routeResult.status,
          requestHeaders: rewrittenRequest.headers,
          requestUrl,
          nextConfig: manifest.nextConfig,
        })
      }

      if (routeResult.resolvedPathname) {
        const middlewareAddedHeaders = getMiddlewareAddedResponseHeaders(
          requestHeaders,
          downstreamRequestHeaders
        )
        const requestIsRsc = isRscRequest(requestUrl, requestHeaders)
        const requestIsPrefetchRsc = isPrefetchRscRequest(requestHeaders)
        const concretePrerenderAssetPathname = getConcretePrerenderAssetPathname(
          routeResult,
          requestUrl,
          requestIsRsc,
          assetPathnames
        )
        const shouldPreferConcretePrerenderAsset = Boolean(concretePrerenderAssetPathname)
        const dynamicRscMatchPathname =
          routeResult.invocationTarget?.pathname ||
          interpolateRoutePathname(routeResult.resolvedPathname, routeResult.routeMatches) ||
          routeResult.resolvedPathname
        const dynamicRsc =
          requestIsRsc &&
          !requestIsPrefetchRsc &&
          !shouldPreferConcretePrerenderAsset &&
          !prerenderDataRouteMap.has(routeResult.resolvedPathname)
            ? getDynamicRscOutput(dynamicRscMatchPathname, manifest, routeOutputs)
            : undefined
        const dynamicRouteOutput =
          !requestIsRsc && !shouldPreferConcretePrerenderAsset
            ? getDynamicRouteOutput(dynamicRscMatchPathname, manifest, routeOutputs)
            : undefined
        const routeRscOutput =
          requestIsRsc && !requestIsPrefetchRsc
            ? routeOutputs.get(`${routeResult.resolvedPathname}.rsc`) || dynamicRsc?.output
            : undefined
        const rscOutput =
          requestIsRsc &&
          !requestIsPrefetchRsc &&
          !shouldPreferConcretePrerenderAsset &&
          !prerenderDataRouteMap.has(routeResult.resolvedPathname)
            ? routeRscOutput
            : undefined
        let output =
          routeRscOutput || routeOutputs.get(routeResult.resolvedPathname) || dynamicRouteOutput?.output
        const isPrerenderDataRequest = requestIsRsc && prerenderDataRouteMap.has(routeResult.resolvedPathname)
        const assetPathname =
          concretePrerenderAssetPathname ||
          (isPrerenderDataRequest
            ? prerenderDataRouteMap.get(routeResult.resolvedPathname)
            : routeResult.resolvedPathname)
        const routeResultWithDynamicMatches =
          dynamicRsc?.routeMatches || dynamicRouteOutput?.routeMatches
            ? {
                ...routeResult,
                routeMatches: {
                  ...(routeResult.routeMatches ?? {}),
                  ...(dynamicRsc?.routeMatches ?? {}),
                  ...dynamicRouteOutput?.routeMatches,
                },
              }
            : routeResult

        if (!output && canHaveBody(request.method) && routeResult.invocationTarget?.pathname) {
          output = routeOutputs.get(routeResult.invocationTarget.pathname)
        }

        logWorkerActionDebugSnapshot(request, routeResultWithDynamicMatches, output)

        const segmentPrefetchAssetPathname = getSegmentPrefetchAssetPathname(
          assetPathname,
          requestHeaders,
          assetPathnames
        )
        const isRewrittenSegmentPrefetch =
          requestIsRsc &&
          requestHeaders.has('next-router-segment-prefetch') &&
          (routeResult.resolvedHeaders.has('x-nextjs-rewritten-path') ||
            routeResult.resolvedHeaders.has('x-nextjs-rewritten-query') ||
            routeResult.resolvedHeaders.has('x-middleware-rewrite'))
        const requiresDynamicSegmentPrefetch =
          requestIsRsc &&
          requestHeaders.has('next-router-segment-prefetch') &&
          !segmentPrefetchAssetPathname
        const requestHasOnDemandRevalidate = hasOnDemandRevalidateHeader(requestHeaders)
        const appPagePrerenderAssetMeta =
          output?.type === 'APP_PAGE'
            ? assetMetadata.get(
                prerenderDataRouteMap.get(dynamicRscMatchPathname) ||
                  prerenderDataRouteMap.get(routeResult.resolvedPathname)
              )
            : null
        const assetHasRevalidatedTags = hasRevalidatedAssetTags(
          assetMetadata.get(assetPathname) ||
            assetMetadata.get(dynamicRscMatchPathname) ||
            assetMetadata.get(routeResult.resolvedPathname) ||
            appPagePrerenderAssetMeta,
          edgeIncrementalCache
        )
        const revalidatedNodeAppPageTags =
          output?.runtime === 'nodejs' && output?.type === 'APP_PAGE'
            ? getRevalidatedAssetTags(
                appPagePrerenderAssetMeta,
                edgeIncrementalCache,
                fulfilledNodeAppPageTagStateByTag
              )
            : []
        const requiresDynamicQueryAppRsc =
          requestIsRsc &&
          output?.type === 'APP_PAGE' &&
          getPublicRscSearch(requestUrl) !== ''
        const shouldBypassPrerenderAsset =
          output?.type === 'PAGES' &&
          prerenderAssetPathnames.has(routeResult.resolvedPathname) &&
          (requestHasOnDemandRevalidate ||
            revalidatedPrerenderPathnames.has(routeResult.resolvedPathname))

        if (
          assetPathname &&
          assetPathnames.has(assetPathname) &&
          !rscOutput &&
          !(requestHasDraftModeCookie && output) &&
          canServeStaticAsset(request.method) &&
          !shouldBypassPrerenderAsset &&
          !assetHasRevalidatedTags &&
          !requiresDynamicQueryAppRsc &&
          !requiresDynamicSegmentPrefetch &&
          !isRewrittenSegmentPrefetch
        ) {
          const servedAssetPathname = segmentPrefetchAssetPathname || assetPathname

          if (requestIsRsc) {
            logWorkerRscDebugSnapshot('asset', requestUrl, requestHeaders, {
              resolvedPathname: routeResult.resolvedPathname,
              assetPathname: servedAssetPathname,
            })
          }

          const assetUrl = new URL(requestUrl.toString())
          assetUrl.pathname = assetPathMap.get(servedAssetPathname) || servedAssetPathname

          if (typeof routeResult.invocationTarget?.rawQuery === 'string') {
            assetUrl.search = routeResult.invocationTarget.rawQuery
          } else if (routeResult.invocationTarget?.query) {
            applyQuery(assetUrl, routeResult.invocationTarget.query)
          }

          const assetFetchVaryKey = getAssetFetchVaryKey(requestHeaders, output)

          if (assetFetchVaryKey) {
            assetUrl.searchParams.set('__cf_rscv', assetFetchVaryKey)
          }

          if (requestIsRsc || output?.type === 'APP_PAGE') {
            downstreamRequestHeaders.delete('if-none-match')
            downstreamRequestHeaders.delete('if-modified-since')
          }

          const assetRequest = createDerivedRequest(request, {
            url: assetUrl.toString(),
            headers: downstreamRequestHeaders,
            body: handlerBody,
          })
          const assetResponse = await normalizeAppPageHtmlAssetResponse(
            await fetchAssetResponse(env, assetRequest)
            ,
            output
          )
          const assetMeta =
            assetMetadata.get(servedAssetPathname) || assetMetadata.get(assetPathname)
          const assetHeaders = mergeHeaders(
            mergeHeaders(assetMeta?.headers, routeResult.resolvedHeaders),
            middlewareAddedHeaders
          )
          assetHeaders.delete('content-encoding')
          assetHeaders.delete('content-length')
          const staticDataContentType = getStaticDataContentType(servedAssetPathname)
          const assetContentType =
            staticDataContentType || assetResponse.headers.get('content-type') || ''

          if (staticDataContentType) {
            assetHeaders.set('content-type', staticDataContentType)
          }

          if (
            !requestIsRsc &&
            output?.type === 'APP_PAGE' &&
            assetContentType.toLowerCase().startsWith('text/html')
          ) {
            assetHeaders.set(
              'cache-control',
              'private, no-cache, no-store, max-age=0, must-revalidate'
            )
          }

          if (
            servedAssetPathname.endsWith('.segment.rsc') &&
            requestHeaders.has('next-router-segment-prefetch') &&
            !assetHeaders.has('x-middleware-rewrite') &&
            !assetHeaders.has('x-nextjs-rewritten-path') &&
            !assetHeaders.has('x-nextjs-rewritten-query') &&
            !assetHeaders.has('x-nextjs-postponed')
          ) {
            assetHeaders.set('x-nextjs-postponed', '2')
          }

          if (
            (prerenderAssetPathnames.has(servedAssetPathname) ||
              prerenderAssetPathnames.has(routeResult.resolvedPathname)) &&
            !assetHeaders.has('x-nextjs-cache')
          ) {
            assetHeaders.set('x-nextjs-cache', 'PRERENDER')
          }

          if (
            (prerenderAssetPathnames.has(servedAssetPathname) ||
              prerenderAssetPathnames.has(routeResult.resolvedPathname)) &&
            !assetHeaders.has('x-nextjs-prerender')
          ) {
            assetHeaders.set('x-nextjs-prerender', '1')
          }

          if (await shouldBypassStaticHtmlShell(assetResponse, output)) {
            output = output || routeOutputs.get(routeResult.resolvedPathname)
          } else {
          return finalizeResponse(assetResponse, {
            headers: assetHeaders,
            output,
            status: routeResult.status ?? assetMeta?.status,
            requestHeaders: assetRequest.headers,
            requestUrl,
            nextConfig: manifest.nextConfig,
          })
          }
        }

        if (output) {
          if (requestIsRsc) {
            logWorkerRscDebugSnapshot('output', requestUrl, requestHeaders, {
              resolvedPathname: routeResult.resolvedPathname,
              outputPathname: output.pathname,
            })
          }

          const shouldPreserveOriginalEdgeRequestUrl =
            output.runtime === 'edge' &&
            output.type === 'PAGES' &&
            routeResult.invocationTarget?.pathname &&
            routeResult.invocationTarget.pathname !== requestUrl.pathname
          const invocationHeaders = new Headers(downstreamRequestHeaders)
          const serializedTagStateHeader =
            output.runtime !== 'edge'
              ? createSerializedTagStateHeader(edgeIncrementalCache.tagStateByTag)
              : null

          if (serializedTagStateHeader) {
            invocationHeaders.set(
              ADAPTER_REVALIDATED_TAG_STATE_HEADER,
              serializedTagStateHeader
            )
          }

          const shouldForceNodeAppPageRevalidate =
            output.runtime === 'nodejs' &&
            output.type === 'APP_PAGE' &&
            revalidatedNodeAppPageTags.length > 0 &&
            typeof previewModeId === 'string' &&
            previewModeId.length > 0

          if (shouldForceNodeAppPageRevalidate) {
            invocationHeaders.set('x-prerender-revalidate', previewModeId)
          }

          const invocationUrl =
            output.runtime === 'edge'
              ? shouldPreserveOriginalEdgeRequestUrl
                ? new URL(request.url)
                : buildInvocationUrl(requestUrl, routeResult.invocationTarget)
              : new URL(requestUrl.toString())
          const invocationRequest = createDerivedRequest(request, {
            url: invocationUrl.toString(),
            headers: invocationHeaders,
            body: handlerBody,
          })
          const routeRequestMeta = createRouteRequestMeta(
            routeResultWithDynamicMatches,
            manifest,
            requestUrl,
            output
          )
          const routeMatchesHeader = toRouteMatchesHeader(routeResultWithDynamicMatches.routeMatches)

          logWorkerI18nDebugSnapshot(requestUrl, routeResultWithDynamicMatches, routeRequestMeta, output)

          if (routeMatchesHeader && !invocationRequest.headers.has('x-now-route-matches')) {
            invocationRequest.headers.set('x-now-route-matches', routeMatchesHeader)
          }

          const isMiddlewarePrefetch =
            invocationRequest.headers.get('x-middleware-prefetch') === '1' &&
            output.runtime === 'nodejs' &&
            output.type === 'PAGES'
          const matchedPath = getMatchedPathFromNodeDataOutput(
            output.pathname,
            manifest.buildId,
            manifest.basePath
          )

          if (isMiddlewarePrefetch && matchedPath) {
            const prefetchHeaders = mergeHeaders(
              mergeHeaders(routeResult.resolvedHeaders, middlewareAddedHeaders),
              new Headers({
                'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate',
                'content-type': 'application/json; charset=utf-8',
                'x-matched-path': matchedPath,
                'x-middleware-skip': '1',
              })
            )

            return new Response('{}', {
              status: routeResult.status ?? 200,
              headers: prefetchHeaders,
            })
          }

          let response = await invokeRouteOutput(
            output,
            invocationRequest,
            executionCtx,
            nodeRuntime,
            manifest.nextConfig,
            routeRequestMeta
          )

          response = normalizePagesPrerenderResponse(response, invocationRequest.headers, output)

          if (
            !canServeStaticAsset(request.method) &&
            isPagesPrerenderResponse(response, invocationRequest.headers, output) &&
            response.status < 400
          ) {
            return new Response('Method Not Allowed', {
              status: 405,
              headers: mergeHeaders(
                mergeHeaders(routeResult.resolvedHeaders, middlewareAddedHeaders),
                new Headers({ allow: 'GET, HEAD' })
              ),
            })
          }

          mergeSharedTagStateFromResponse(response, edgeIncrementalCache)

          if (
            shouldForceNodeAppPageRevalidate &&
            (response.headers.get('x-nextjs-cache') || response.headers.get('x-vercel-cache')) ===
              'REVALIDATED'
          ) {
            for (const tag of revalidatedNodeAppPageTags) {
              const tagState = edgeIncrementalCache.tagStateByTag.get(tag)

              if (tagState) {
                fulfilledNodeAppPageTagStateByTag.set(tag, { ...tagState })
              }
            }
          }

          if (
            requestHasOnDemandRevalidate &&
            output.type === 'PAGES' &&
            prerenderAssetPathnames.has(routeResult.resolvedPathname) &&
            response.status < 500
          ) {
            revalidatedPrerenderPathnames.add(routeResult.resolvedPathname)
          }

          if (await shouldUsePagesNotFoundFallback(response, output, notFoundOutput)) {
            if (getNormalizedNextDataPathname(requestUrl, requestHeaders, manifest.buildId, manifest.basePath)) {
              return createNextDataNotFoundResponse(
                mergeHeaders(routeResult.resolvedHeaders, middlewareAddedHeaders)
              )
            }

            const notFoundAssetPathname =
              getNotFoundAssetPathname(requestUrl, manifest, assetPathnames) ||
              staticNotFoundAssetPathname

            if (notFoundAssetPathname && canServeStaticAsset(request.method)) {
              const notFoundAssetUrl = new URL(requestUrl.toString())
              notFoundAssetUrl.pathname =
                assetPathMap.get(notFoundAssetPathname) || notFoundAssetPathname
              notFoundAssetUrl.search = ''
              const notFoundAssetRequest = createDerivedRequest(request, {
                url: notFoundAssetUrl.toString(),
                headers: downstreamRequestHeaders,
                body: handlerBody,
              })
              const notFoundAssetResponse = await fetchAssetResponse(env, notFoundAssetRequest)

              if (notFoundAssetResponse.status !== 404) {
                return finalizeResponse(notFoundAssetResponse, {
                  headers: mergeHeaders(routeResult.resolvedHeaders, middlewareAddedHeaders),
                  output: notFoundOutput,
                  status: 404,
                  requestHeaders: notFoundAssetRequest.headers,
                  requestUrl,
                  nextConfig: manifest.nextConfig,
                })
              }
            }

            if (notFoundOutput) {
              const notFoundRequest = createDerivedRequest(request, {
                url: requestUrl.toString(),
                headers: downstreamRequestHeaders,
                body: handlerBody,
              })
              const notFoundResponse = await invokeRouteOutput(
                notFoundOutput,
                notFoundRequest,
                executionCtx,
                nodeRuntime,
                manifest.nextConfig,
                getNotFoundRequestMeta(routeRequestMeta)
              )
              const notFoundStatus =
                notFoundResponse.status === 200 ? 404 : notFoundResponse.status

              return finalizeResponse(notFoundResponse, {
                headers: mergeHeaders(routeResult.resolvedHeaders, middlewareAddedHeaders),
                output: notFoundOutput,
                status: notFoundStatus,
                requestHeaders: notFoundRequest.headers,
                requestUrl,
                nextConfig: manifest.nextConfig,
              })
            }
          }

          if (await shouldUsePagesErrorFallback(response, output, errorOutput, staticErrorAssetPathname)) {
            if (staticErrorAssetPathname && canServeStaticAsset(request.method)) {
              const errorAssetUrl = new URL(requestUrl.toString())
              errorAssetUrl.pathname =
                assetPathMap.get(staticErrorAssetPathname) || staticErrorAssetPathname
              errorAssetUrl.search = ''
              const errorAssetRequest = createDerivedRequest(request, {
                url: errorAssetUrl.toString(),
                headers: downstreamRequestHeaders,
                body: handlerBody,
              })
              const errorAssetResponse = await fetchAssetResponse(env, errorAssetRequest)

              if (errorAssetResponse.status !== 404) {
                return finalizeResponse(errorAssetResponse, {
                  headers: mergeHeaders(routeResult.resolvedHeaders, middlewareAddedHeaders),
                  output: errorOutput,
                  status: 500,
                  requestHeaders: errorAssetRequest.headers,
                  requestUrl,
                  nextConfig: manifest.nextConfig,
                })
              }
            }

            if (errorOutput) {
              const errorRequest = createDerivedRequest(request, {
                url: requestUrl.toString(),
                headers: downstreamRequestHeaders,
                body: handlerBody,
              })
              const errorResponse = await invokeRouteOutput(
                errorOutput,
                errorRequest,
                executionCtx,
                nodeRuntime,
                manifest.nextConfig,
                routeRequestMeta
              )
              const errorStatus = errorResponse.status >= 500 ? errorResponse.status : 500

              return finalizeResponse(errorResponse, {
                headers: mergeHeaders(routeResult.resolvedHeaders, middlewareAddedHeaders),
                output: errorOutput,
                status: errorStatus,
                requestHeaders: errorRequest.headers,
                requestUrl,
                nextConfig: manifest.nextConfig,
              })
            }
          }

          return finalizeResponse(response, {
            headers: mergeHeaders(routeResult.resolvedHeaders, middlewareAddedHeaders),
            output,
            status: routeResult.status,
            requestHeaders: invocationRequest.headers,
            requestUrl,
            nextConfig: manifest.nextConfig,
          })
        }
      }

      const resolvedRequestUrl = routeResult.resolvedRequestUrl || requestUrl
      const directAssetRequest = createDerivedRequest(request, {
        url: resolvedRequestUrl.toString(),
        headers: downstreamRequestHeaders,
      })
      const fallbackHeaders = mergeHeaders(
        routeResult.resolvedHeaders,
        getMiddlewareAddedResponseHeaders(requestHeaders, downstreamRequestHeaders)
      )
      const nextDataAssetPathname = getNormalizedNextDataPathname(
        requestUrl,
        requestHeaders,
        manifest.buildId,
        manifest.basePath
      )

      if (
        nextDataAssetPathname &&
        assetPathnames.has(nextDataAssetPathname) &&
        canServeStaticAsset(request.method)
      ) {
        const assetUrl = new URL(requestUrl.toString())
        assetUrl.pathname = assetPathMap.get(nextDataAssetPathname) || nextDataAssetPathname

        const nextDataAssetRequest = createDerivedRequest(request, {
          url: assetUrl.toString(),
          headers: downstreamRequestHeaders,
          body: handlerBody,
        })
        const nextDataAssetResponse = await fetchAssetResponse(env, nextDataAssetRequest)
        const nextDataHeaders = mergeHeaders(
          fallbackHeaders,
          new Headers({ 'x-nextjs-matched-path': nextDataAssetPathname })
        )

        return finalizeResponse(nextDataAssetResponse, {
          headers: nextDataHeaders,
          requestHeaders: nextDataAssetRequest.headers,
          requestUrl,
          nextConfig: manifest.nextConfig,
        })
      }

      const directAssetResponse = await env.ASSETS.fetch(directAssetRequest)

      if (directAssetResponse.status !== 404) {
        return finalizeResponse(directAssetResponse, {
          headers: fallbackHeaders,
          requestHeaders: directAssetRequest.headers,
          requestUrl,
          nextConfig: manifest.nextConfig,
        })
      }

      if (isStaticAssetRequestPath(resolvedRequestUrl.pathname, manifest)) {
        const staticAssetNotFoundHeaders = mergeHeaders(
          fallbackHeaders,
          new Headers({ 'content-type': 'text/plain; charset=utf-8' })
        )

        return new Response('Not Found', {
          status: 404,
          headers: staticAssetNotFoundHeaders,
        })
      }

      if (nextDataAssetPathname) {
        return createNextDataNotFoundResponse(fallbackHeaders)
      }

      const notFoundAssetPathname =
        getNotFoundAssetPathname(requestUrl, manifest, assetPathnames) || staticNotFoundAssetPathname

      if (notFoundAssetPathname && canServeStaticAsset(request.method)) {
        const notFoundAssetUrl = new URL(requestUrl.toString())
        notFoundAssetUrl.pathname = assetPathMap.get(notFoundAssetPathname) || notFoundAssetPathname
        notFoundAssetUrl.search = ''
        const notFoundAssetRequest = createDerivedRequest(request, {
          url: notFoundAssetUrl.toString(),
          headers: downstreamRequestHeaders,
          body: handlerBody,
        })
        const notFoundAssetResponse = await fetchAssetResponse(env, notFoundAssetRequest)

        if (notFoundAssetResponse.status !== 404) {
          return finalizeResponse(notFoundAssetResponse, {
            headers: fallbackHeaders,
            output: notFoundOutput,
            status: 404,
            requestHeaders: notFoundAssetRequest.headers,
            requestUrl,
            nextConfig: manifest.nextConfig,
          })
        }
      }

      if (notFoundOutput) {
        const notFoundRequest = createDerivedRequest(request, {
          url: requestUrl.toString(),
          headers: downstreamRequestHeaders,
          body: handlerBody,
        })
        const notFoundResponse = await invokeRouteOutput(
          notFoundOutput,
          notFoundRequest,
          executionCtx,
          nodeRuntime,
          manifest.nextConfig,
          getNotFoundRequestMeta()
        )
        const notFoundStatus = notFoundResponse.status === 200 ? 404 : notFoundResponse.status

        return finalizeResponse(notFoundResponse, {
          headers: fallbackHeaders,
          output: notFoundOutput,
          status: notFoundStatus,
          requestHeaders: notFoundRequest.headers,
          requestUrl,
          nextConfig: manifest.nextConfig,
        })
      }

      return new Response('Not Found', {
        status: 404,
        headers: fallbackHeaders,
      })
    },
  }
}
