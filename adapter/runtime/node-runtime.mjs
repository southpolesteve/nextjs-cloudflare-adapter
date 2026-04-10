import http, { createServer } from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { Readable } from 'node:stream'

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

function createHotFetchResponse(response) {
  if (!shouldCreateHotFetchResponse(response)) {
    return response
  }

  const transform = new TransformStream()
  void response.body.pipeTo(transform.writable).catch(() => {})

  return new Response(transform.readable, {
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

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function createUncompressedStreamingResponse(response) {
  const headers = new Headers(response.headers)
  headers.set('content-encoding', 'identity')
  headers.delete('content-length')

  return new Response(response.body, {
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

        resolve(
          new Response(Readable.toWeb(nodeResponse), {
            status: nodeResponse.statusCode || 500,
            statusText: nodeResponse.statusMessage,
            headers,
          })
        )
      }
    )

    nodeRequest.once('error', reject)

    if (request.signal) {
      if (request.signal.aborted) {
        nodeRequest.destroy(request.signal.reason)
        reject(request.signal.reason)
        return
      }

      request.signal.addEventListener(
        'abort',
        () => {
          nodeRequest.destroy(request.signal.reason)
          reject(request.signal.reason)
        },
        { once: true }
      )
    }

    if (request.body) {
      Readable.fromWeb(request.body).on('error', reject).pipe(nodeRequest)
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

function createOutputRequestMeta(manifest, output, requestMeta = {}, requestUrl) {
  const runtimeRepoRoot = toBundlePath(manifest.nodeRuntime.runtimeRepoRootRelative)
  const runtimeProjectDir = path.join(
    runtimeRepoRoot,
    ...String(manifest.nodeRuntime.projectDirRelative || '')
      .split('/')
      .filter(Boolean)
  )
  const absoluteDistDir = path.join(runtimeProjectDir, manifest.nodeRuntime.distDir)
  const initUrl = requestMeta.initURL || requestUrl || null
  let initProtocol = requestMeta.initProtocol || null

  if (!initProtocol && initUrl) {
    try {
      initProtocol = new URL(initUrl).protocol.replace(/:+$/, '')
    } catch {}
  }

  return {
    ...requestMeta,
    relativeProjectDir: manifest.nodeRuntime.projectDirRelative || '',
    distDir: absoluteDistDir,
    invokeOutput: output?.pathname,
    ...(initUrl ? { initURL: initUrl } : {}),
    ...(initProtocol ? { initProtocol } : {}),
  }
}

function encodeRequestMetaHeader(requestMeta = {}) {
  return Buffer.from(JSON.stringify(requestMeta)).toString('base64')
}

function unwrapNodeModule(moduleNamespace) {
  if (moduleNamespace?.default) {
    return moduleNamespace.default
  }

  if (moduleNamespace?.['module.exports']) {
    return moduleNamespace['module.exports']
  }

  return moduleNamespace
}

async function loadNodeEntry(outputPathname, moduleCache) {
  if (moduleCache.has(outputPathname)) {
    return moduleCache.get(outputPathname)
  }

  const loader = globalThis._NODE_ENTRY_LOADERS?.[outputPathname]

  if (typeof loader !== 'function') {
    throw new Error(`Node entry loader was not registered for ${outputPathname}`)
  }

  const loadedModule = unwrapNodeModule(await loader())
  moduleCache.set(outputPathname, loadedModule)

  return loadedModule
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
      const requestId = Array.isArray(req.headers['x-adapter-node-request-id'])
        ? req.headers['x-adapter-node-request-id'][0]
        : req.headers['x-adapter-node-request-id']
      const outputPathname = Array.isArray(req.headers['x-adapter-node-output-pathname'])
        ? req.headers['x-adapter-node-output-pathname'][0]
        : req.headers['x-adapter-node-output-pathname']
      const requestContext = requestId ? requestContexts.get(requestId) : undefined

      try {
        if (!outputPathname) {
          throw new Error('Missing x-adapter-node-output-pathname header')
        }

        updateBootstrapState(bootstrapState, 'loading-output', {
          error: null,
          lastOutputPathname: outputPathname,
        })

        const outputModule = await loadNodeEntry(outputPathname, moduleCache)
        const handler = outputModule?.handler

        if (typeof handler !== 'function') {
          throw new Error(`Node output handler was not found for ${outputPathname}`)
        }

        updateBootstrapState(bootstrapState, 'handling-request', {
          error: null,
          lastOutputPathname: outputPathname,
        })

        await handler(req, res, {
          waitUntil: requestContext?.waitUntil,
          requestMeta: requestContext?.requestMeta,
        })

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

function createRequestWithNodeHeaders(request, headers, requestUrl = request.url) {
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  headers.set('accept-encoding', 'identity')
  const init = {
    method: request.method,
    headers,
    redirect: request.redirect,
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

  headers.set('x-adapter-node-request-meta', encodeRequestMetaHeader(requestMeta))

  return createRequestWithNodeHeaders(request, headers, sidecarUrl.toString())
}

async function finalizeNodeResponse(request, response) {
  const url = new URL(request.url)
  const contentType = response.headers.get('content-type') || ''
  const transferEncoding = response.headers.get('transfer-encoding') || ''
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

  if (
    isPlainTextStream ||
    isChunked ||
    (!url.pathname.includes('/_next/data/') && !shouldBufferByContentType)
  ) {
    return createHotFetchResponse(createUncompressedStreamingResponse(response))
  }

  const headers = new Headers(response.headers)
  const body = request.method === 'HEAD' ? null : await response.arrayBuffer()

  return new Response(body, {
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
      headers.set('x-adapter-node-output-pathname', output.pathname)

      let response
      let responsePhase = bootstrapState.phase
      const outputRequestMeta = createOutputRequestMeta(
        manifest,
        output,
        requestMeta,
        request.url
      )

      if (sidecarPort) {
        responsePhase = 'sidecar'
        response = await fetch(createSidecarNodeRequest(request, headers, sidecarPort, outputRequestMeta))
      } else {
        await ensureServerStarted()

        const requestId = String(++nextRequestId)

        requestContexts.set(requestId, {
          waitUntil: executionCtx?.waitUntil?.bind(executionCtx),
          requestMeta: outputRequestMeta,
        })

        headers.set('x-adapter-node-request-id', requestId)
        response = await (await getHandleAsNodeRequest())(
          manifest.nodeRuntime.port,
          createRequestWithNodeHeaders(request, headers)
        )
        responsePhase = bootstrapState.phase
      }

      const finalizedResponse = await finalizeNodeResponse(request, response)
      const responseWithMutableHeaders = new Response(finalizedResponse.body, {
        status: finalizedResponse.status,
        statusText: finalizedResponse.statusText,
        headers: new Headers(finalizedResponse.headers),
      })

      responseWithMutableHeaders.headers.set('x-adapter-node-phase', responsePhase)
      responseWithMutableHeaders.headers.set('x-adapter-node-output', output.pathname)
      return responseWithMutableHeaders
    },
  }
}
