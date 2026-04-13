#!/usr/bin/env node

import { AsyncLocalStorage } from 'node:async_hooks'
import http, { createServer } from 'node:http'
import https from 'node:https'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { parse as parseNodeUrl, pathToFileURL } from 'node:url'

const ADAPTER_REVALIDATED_TAG_STATE_HEADER = 'x-adapter-revalidated-tags-state'
const requestTagStateStorage = new AsyncLocalStorage()

function parseArgs(argv) {
  const args = {}

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (!arg.startsWith('--')) {
      continue
    }

    args[arg.slice(2)] = argv[index + 1]
    index += 1
  }

  return args
}

function setProcessCwd(nextCwd) {
  try {
    process.chdir(nextCwd)
  } catch {}

  try {
    process.cwd = () => nextCwd
  } catch {}
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

function isLoopbackUrl(url) {
  return (
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1')
  )
}

function isRedirectStatusCode(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
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

function applyTagStateUpdate(tagStateByTag, tags, durations) {
  const normalizedTags = normalizeCacheTags(
    typeof tags === 'string' ? [tags] : tags
  )

  if (normalizedTags.length === 0) {
    return
  }

  const now = Date.now()

  for (const tag of normalizedTags) {
    const previousState = tagStateByTag.get(tag) || {}
    const nextState = { ...previousState }

    if (durations) {
      nextState.stale = now

      if (durations.expire !== undefined) {
        nextState.expired = now + durations.expire * 1000
      }
    } else {
      nextState.expired = now
    }

    tagStateByTag.set(tag, nextState)
    const requestTagState = requestTagStateStorage.getStore()

    if (requestTagState instanceof Map) {
      requestTagState.set(tag, { ...nextState })
    }
  }
}

function serializeTagState(tagStateByTag) {
  return Object.fromEntries(tagStateByTag.entries())
}

function encodeSerializedTagState(serializedTagState) {
  if (!serializedTagState || typeof serializedTagState !== 'object') {
    return null
  }

  if (Object.keys(serializedTagState).length === 0) {
    return null
  }

  try {
    return Buffer.from(JSON.stringify(serializedTagState), 'utf8').toString('base64')
  } catch {
    return null
  }
}

function decodeSerializedTagState(encodedSerializedTagState) {
  if (
    typeof encodedSerializedTagState !== 'string' ||
    encodedSerializedTagState.length === 0
  ) {
    return null
  }

  try {
    return JSON.parse(
      Buffer.from(encodedSerializedTagState, 'base64').toString('utf8')
    )
  } catch {
    return null
  }
}

function recordRequestTagState(tag, value) {
  const requestTagState = requestTagStateStorage.getStore()

  if (
    !(requestTagState instanceof Map) ||
    typeof tag !== 'string' ||
    !value ||
    typeof value !== 'object'
  ) {
    return
  }

  requestTagState.set(tag, { ...value })
}

function mergeSerializedTagState(tagStateByTag, serializedTagState, tagsManifest) {
  if (!serializedTagState || typeof serializedTagState !== 'object') {
    return
  }

  for (const [tag, value] of Object.entries(serializedTagState)) {
    if (typeof tag !== 'string' || !value || typeof value !== 'object') {
      continue
    }

    const nextState = { ...value }

    if (tagsManifest instanceof Map) {
      tagsManifest.set(tag, nextState)
      continue
    }

    tagStateByTag.set(tag, nextState)
    recordRequestTagState(tag, nextState)
  }
}

function getCurrentRequestTagStateHeaderValue() {
  const requestTagState = requestTagStateStorage.getStore()

  if (!(requestTagState instanceof Map)) {
    return null
  }

  return encodeSerializedTagState(serializeTagState(requestTagState))
}

function installRequestTagStateResponseHeader(res) {
  if (res.__cloudflareAdapterRequestTagStateHeaderInstalled) {
    return
  }

  const ensureResponseHeader = () => {
    if (res.headersSent) {
      return
    }

    const encodedSerializedTagState = getCurrentRequestTagStateHeaderValue()

    if (encodedSerializedTagState) {
      res.setHeader(
        ADAPTER_REVALIDATED_TAG_STATE_HEADER,
        encodedSerializedTagState
      )
    }
  }

  const originalWriteHead = res.writeHead.bind(res)
  const originalEnd = res.end.bind(res)

  res.writeHead = (...args) => {
    ensureResponseHeader()
    return originalWriteHead(...args)
  }

  res.end = (...args) => {
    ensureResponseHeader()
    return originalEnd(...args)
  }

  Object.defineProperty(res, '__cloudflareAdapterRequestTagStateHeaderInstalled', {
    value: true,
    configurable: true,
  })
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

function decodeRequestMetaHeader(encodedMeta) {
  if (!encodedMeta) {
    return {}
  }

  try {
    return JSON.parse(Buffer.from(encodedMeta, 'base64').toString('utf8'))
  } catch {
    return {}
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

function createOutputRequestMeta(
  projectRoot,
  manifest,
  outputPathname,
  outputType,
  requestHeaders,
  requestMeta = {},
  requestUrl,
  forwardedHost,
  forwardedProto
) {
  const runtimeRepoRoot = path.join(projectRoot, manifest.nodeRuntime.runtimeRepoRootRelative)
  const runtimeProjectDir = path.join(
    runtimeRepoRoot,
    ...String(manifest.nodeRuntime.projectDirRelative || '')
      .split('/')
      .filter(Boolean)
  )
  const absoluteDistDir = path.join(runtimeProjectDir, manifest.nodeRuntime.distDir)
  let initUrl = requestMeta.initURL || null
  let initQuery = requestMeta.initQuery || null
  let initProtocol = requestMeta.initProtocol || null

  if (!initUrl && requestUrl) {
    const protocol = forwardedProto || 'http'
    const host = forwardedHost || 'localhost'
    initUrl = `${protocol}://${host}${requestUrl}`
  }

  if (!initQuery) {
    initQuery = parseRequestQuery(initUrl || requestUrl)
  }

  if (!initProtocol && initUrl) {
    try {
      initProtocol = new URL(initUrl).protocol.replace(/:+$/, '')
    } catch {}
  }

  const headers = requestHeaders instanceof Headers ? requestHeaders : new Headers(requestHeaders)
  const requestIsRsc = headers.get('rsc') === '1'
  const isPrefetchRscRequest = headers.get('next-router-prefetch') === '1'
  const segmentPrefetchRscRequest = headers.get('next-router-segment-prefetch')
  let requestPathname = null

  try {
    requestPathname = new URL(initUrl || requestUrl || '/', 'http://localhost').pathname
  } catch {}

  const requestNodeDataPath = requestPathname
    ? getMatchedPathFromNodeDataOutput(requestPathname, manifest.buildId, manifest.basePath)
    : null
  const outputNodeDataPath =
    typeof outputPathname === 'string'
      ? getMatchedPathFromNodeDataOutput(outputPathname, manifest.buildId, manifest.basePath)
      : null
  const matchedNodeDataPath = requestNodeDataPath || outputNodeDataPath
  const shouldPreserveDynamicPagesOutputPath =
    !!requestNodeDataPath &&
    outputType === 'PAGES' &&
    typeof outputPathname === 'string' &&
    outputPathname.includes('[')

  let invokeOutput =
    shouldPreserveDynamicPagesOutputPath ? outputPathname : matchedNodeDataPath || outputPathname

  if (
    outputType === 'APP_PAGE' &&
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

function getNextTagsManifestImportSpecifier(manifest, runtimeRepoRoot) {
  const nextServerEntryRelative = manifest?.nodeRuntime?.nextServerEntryRelative

  if (typeof nextServerEntryRelative !== 'string' || nextServerEntryRelative.length === 0) {
    return null
  }

  const tagsManifestRelative = nextServerEntryRelative.replace(
    /next-server\.js$/,
    'lib/incremental-cache/tags-manifest.external.js'
  )

  return pathToFileURL(path.join(runtimeRepoRoot, tagsManifestRelative)).href
}

const loadCreateNextServer = new Function('specifier', 'return import(specifier)')

async function installSharedTagStateBridge(manifest, runtimeRepoRoot, sharedTagState) {
  const specifier = getNextTagsManifestImportSpecifier(manifest, runtimeRepoRoot)

  if (!specifier) {
    return null
  }

  const tagsManifestModule = await loadCreateNextServer(specifier)
  const tagsManifest = tagsManifestModule?.tagsManifest

  if (!(tagsManifest instanceof Map)) {
    return null
  }

  if (!tagsManifest.__cloudflareAdapterSharedSyncInstalled) {
    const originalSet = tagsManifest.set.bind(tagsManifest)

    tagsManifest.set = (tag, value) => {
      if (typeof tag === 'string' && value && typeof value === 'object') {
        sharedTagState.set(tag, { ...value })
        recordRequestTagState(tag, value)
      }

      return originalSet(tag, value)
    }

    Object.defineProperty(tagsManifest, '__cloudflareAdapterSharedSyncInstalled', {
      value: true,
      configurable: true,
    })
  }

  for (const [tag, value] of tagsManifest.entries()) {
    if (typeof tag === 'string' && value && typeof value === 'object') {
      sharedTagState.set(tag, { ...value })
    }
  }

  return {
    tagsManifest,
  }
}

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

async function renderPagesErrorResponse({
  req,
  res,
  projectRoot,
  manifest,
  moduleCache,
  encodedRequestMeta,
  forwardedHost,
  forwardedProto,
}) {
  const errorOutputPathname = getErrorOutputPathname(manifest)

  if (!errorOutputPathname) {
    return false
  }

  const runtimeRepoRoot = path.join(projectRoot, manifest.nodeRuntime.runtimeRepoRootRelative)
  const outputModule = await loadNodeEntry(
    errorOutputPathname,
    moduleCache,
    manifest,
    runtimeRepoRoot
  )
  const handler = outputModule?.handler

  if (typeof handler !== 'function') {
    return false
  }

  if (forwardedHost) {
    req.headers.host = forwardedHost
    req.headers['x-forwarded-host'] = forwardedHost
  }
  if (forwardedProto) {
    req.headers['x-forwarded-proto'] = forwardedProto
  }

  req.headers['x-adapter-node-output-pathname'] = errorOutputPathname
  req.headers['x-adapter-node-output-type'] = 'PAGES'

  const requestMeta = createOutputRequestMeta(
    projectRoot,
    manifest,
    errorOutputPathname,
    'PAGES',
    toNodeRequestHeaders(req.headers),
    decodeRequestMetaHeader(encodedRequestMeta),
    req.url,
    forwardedHost,
    forwardedProto
  )

  res.statusCode = 500

  if (isMiddlewareStyleHandler('PAGES', handler)) {
    const response = await handler(
      await createWebRequestFromNodeRequest(req, {
        forwardedHost,
        forwardedProto,
      }),
      {
        waitUntil: () => {},
        requestMeta,
      }
    )

    await writeWebResponseToNodeResponse(res, response, req.method)
    return true
  }

  await handler(req, res, {
    waitUntil: () => {},
    requestMeta,
  })

  return true
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
  res.shouldKeepAlive = false
  res.setHeader('connection', 'close')
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

    if (key.toLowerCase() === 'vary') {
      res.setHeader(key, mergeDelimitedHeaderValue(res.getHeader(key), value))
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

const NEXT_VARY_HEADER_FIELDS = [
  'rsc',
  'next-router-state-tree',
  'next-router-prefetch',
  'next-router-segment-prefetch',
]

function mergeDelimitedHeaderValue(existingValue, nextValue) {
  const tokens = new Map()
  const rawValues = [
    ...(Array.isArray(existingValue) ? existingValue : [existingValue]),
    ...(Array.isArray(nextValue) ? nextValue : [nextValue]),
  ]

  for (const rawValue of rawValues) {
    if (typeof rawValue !== 'string') {
      continue
    }

    for (const part of rawValue.split(',')) {
      const token = part.trim()

      if (!token) {
        continue
      }

      tokens.set(token.toLowerCase(), token)
    }
  }

  return Array.from(tokens.values()).join(', ')
}

function shouldApplyNextVaryHeader(outputType, requestHeaders) {
  return outputType === 'APP_PAGE' || requestHeaders?.rsc === '1'
}

function applyNextVaryHeader(res, outputType, requestHeaders) {
  if (!shouldApplyNextVaryHeader(outputType, requestHeaders)) {
    return
  }

  res.setHeader(
    'vary',
    mergeDelimitedHeaderValue(res.getHeader('vary'), NEXT_VARY_HEADER_FIELDS.join(', '))
  )
}

function isMiddlewareStyleHandler(outputType, handler) {
  return outputType === 'MIDDLEWARE' || handler?.length === 2
}

function logRscDebugSnapshot(req, outputPathname, outputType, requestMeta) {
  if (process.env.CLOUDFLARE_ADAPTER_DEBUG_RSC !== '1') {
    return
  }

  if (outputType !== 'APP_PAGE' || !String(outputPathname).endsWith('.rsc')) {
    return
  }

  const interestingHeaders = [
    'rsc',
    'next-router-state-tree',
    'next-router-prefetch',
    'next-router-segment-prefetch',
    'next-url',
    'x-now-route-matches',
    'x-middleware-prefetch',
    'x-matched-path',
    'x-nextjs-data',
    'host',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-forwarded-port',
  ]

  const headers = Object.fromEntries(
    interestingHeaders.flatMap((key) =>
      req.headers[key] === undefined ? [] : [[key, req.headers[key]]]
    )
  )

  console.error(
    'Cloudflare adapter RSC debug',
    JSON.stringify(
      {
        url: req.url,
        method: req.method,
        outputPathname,
        outputType,
        headers,
        requestMeta,
      },
      null,
      2
    )
  )
}

function logMiddlewareCookieDebugSnapshot(req, outputPathname, outputType) {
  if (process.env.CLOUDFLARE_ADAPTER_DEBUG_MIDDLEWARE_COOKIES !== '1') {
    return
  }

  if (req.method !== 'POST' || req.url !== '/rsc-cookies') {
    return
  }

  console.error(
    'Cloudflare adapter middleware cookie debug',
    JSON.stringify(
      {
        outputPathname,
        outputType,
        nextAction: req.headers['next-action'],
        cookie: req.headers.cookie,
        setCookie: req.headers['set-cookie'],
        middlewareSetCookie: req.headers['x-middleware-set-cookie'],
      },
      null,
      2
    )
  )
}

function logI18nDebugSnapshot(req, outputPathname, outputType, requestMeta) {
  if (process.env.CLOUDFLARE_ADAPTER_DEBUG_I18N !== '1') {
    return
  }

  console.error(
    'Cloudflare adapter sidecar i18n debug',
    JSON.stringify(
      {
        url: req.url,
        method: req.method,
        outputPathname,
        outputType,
        requestMeta,
      },
      null,
      2
    )
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const projectRoot = path.resolve(args['project-dir'] || process.cwd())
  const port = Number(args.port || 0)

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('Missing or invalid --port')
  }

  const { manifest } = await import(path.join(projectRoot, '.adapter/generated/manifest.mjs'))
  const runtimeRepoRoot = path.join(projectRoot, manifest.nodeRuntime.runtimeRepoRootRelative)
  const moduleCache = new Map()

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

  await import(path.join(projectRoot, '.adapter/generated/node-bootstrap.mjs'))

  const sharedTagState = new Map()
  const sharedTagBridge = await installSharedTagStateBridge(
    manifest,
    runtimeRepoRoot,
    sharedTagState
  )

  const server = createServer((req, res) => {
    void requestTagStateStorage.run(new Map(), async () => {
      installRequestTagStateResponseHeader(res)
      req.headers.connection = 'close'
      res.shouldKeepAlive = false
      res.setHeader('connection', 'close')

      const outputPathname = Array.isArray(req.headers['x-adapter-node-output-pathname'])
        ? req.headers['x-adapter-node-output-pathname'][0]
        : req.headers['x-adapter-node-output-pathname']
      const outputType = Array.isArray(req.headers['x-adapter-node-output-type'])
        ? req.headers['x-adapter-node-output-type'][0]
        : req.headers['x-adapter-node-output-type']
      const invocationId = Array.isArray(req.headers['x-invocation-id'])
        ? req.headers['x-invocation-id'][0]
        : req.headers['x-invocation-id']
      const encodedRequestMeta = Array.isArray(req.headers['x-adapter-node-request-meta'])
        ? req.headers['x-adapter-node-request-meta'][0]
        : req.headers['x-adapter-node-request-meta']
      const forwardedHost = Array.isArray(req.headers['x-adapter-forwarded-host'])
        ? req.headers['x-adapter-forwarded-host'][0]
        : req.headers['x-adapter-forwarded-host']
      const forwardedPort = Array.isArray(req.headers['x-forwarded-port'])
        ? req.headers['x-forwarded-port'][0]
        : req.headers['x-forwarded-port']
      const forwardedProto = Array.isArray(req.headers['x-forwarded-proto'])
        ? req.headers['x-forwarded-proto'][0]
        : req.headers['x-forwarded-proto']
      const encodedSerializedTagState = Array.isArray(
        req.headers[ADAPTER_REVALIDATED_TAG_STATE_HEADER]
      )
        ? req.headers[ADAPTER_REVALIDATED_TAG_STATE_HEADER][0]
        : req.headers[ADAPTER_REVALIDATED_TAG_STATE_HEADER]

      try {
        if (outputPathname || req.url === '/_adapter/revalidated-tags') {
          console.log(
            '[adapter node sidecar] request',
            req.method,
            req.url,
            outputPathname || null,
            invocationId || null
          )
        }

        mergeSerializedTagState(
          sharedTagState,
          decodeSerializedTagState(encodedSerializedTagState),
          sharedTagBridge?.tagsManifest
        )

        if (req.url === '/_adapter/status') {
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ status: 'ready' }))
          return
        }

        if (req.url === '/_adapter/revalidated-tags' && req.method === 'GET') {
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ tags: serializeTagState(sharedTagState) }))
          return
        }

        if (req.url === '/_adapter/revalidated-tags' && req.method === 'POST') {
          const body = await new Response(Readable.toWeb(req)).json().catch(() => ({}))
          const tags = body?.tags
          const durations = body?.durations

          console.log('[adapter node sidecar] received revalidated tags', tags, durations || null)
          applyTagStateUpdate(sharedTagState, tags, durations)

          if (sharedTagBridge?.tagsManifest instanceof Map) {
            for (const tag of normalizeCacheTags(tags)) {
              const nextState = sharedTagState.get(tag)

              if (nextState) {
                sharedTagBridge.tagsManifest.set(tag, nextState)
              }
            }
          }

          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true }))
          return
        }

        if (!outputPathname) {
          throw new Error('Missing x-adapter-node-output-pathname header')
        }

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

        if (forwardedHost) {
          req.headers.host = forwardedHost
        }
        if (forwardedHost) {
          req.headers['x-forwarded-host'] = forwardedHost
        }
        if (forwardedPort) {
          req.headers['x-forwarded-port'] = forwardedPort
        }
        if (forwardedProto) {
          req.headers['x-forwarded-proto'] = forwardedProto
        }

        const requestMeta = createOutputRequestMeta(
          projectRoot,
          manifest,
          outputPathname,
          outputType,
          toNodeRequestHeaders(req.headers),
          decodeRequestMetaHeader(encodedRequestMeta),
          req.url,
          forwardedHost,
          forwardedProto
        )

        logRscDebugSnapshot(req, outputPathname, outputType, requestMeta)
        logMiddlewareCookieDebugSnapshot(req, outputPathname, outputType)
        logI18nDebugSnapshot(req, outputPathname, outputType, requestMeta)
        applyNextVaryHeader(res, outputType, req.headers)
        applyPagesFallbackStatusCode(res, outputPathname, requestMeta)

        if (isMiddlewareStyleHandler(outputType, handler)) {
          const response = await handler(
            await createWebRequestFromNodeRequest(req, {
              forwardedHost,
              forwardedProto,
            }),
            {
              waitUntil: () => {},
              requestMeta,
            }
          )

          await writeWebResponseToNodeResponse(res, response, req.method)
        } else {
          await handler(req, res, {
            waitUntil: () => {},
            requestMeta,
          })
        }
      } catch (error) {
        console.error('Cloudflare adapter sidecar failed')
        console.error(error?.stack || error)

        const canRenderPagesError =
          !res.headersSent &&
          outputType === 'PAGES' &&
          typeof outputPathname === 'string' &&
          !outputPathname.includes('/_next/data/') &&
          !outputPathname.endsWith('/_error') &&
          !outputPathname.endsWith('/500')

        if (canRenderPagesError) {
          try {
            const renderedErrorPage = await renderPagesErrorResponse({
              req,
              res,
              projectRoot,
              manifest,
              moduleCache,
              encodedRequestMeta,
              forwardedHost,
              forwardedProto,
            })

            if (renderedErrorPage) {
              return
            }
          } catch (renderError) {
            console.error('Cloudflare adapter sidecar failed to render pages error')
            console.error(renderError?.stack || renderError)
          }
        }

        if (!res.headersSent) {
          res.statusCode = 500
          res.end('Internal Server Error')
        } else {
          res.destroy(error)
        }
      }
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })

  console.log(`Cloudflare adapter node sidecar ready on http://127.0.0.1:${port}`)

  const shutdown = () => {
    server.close(() => process.exit(0))
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exit(1)
})
