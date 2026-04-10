#!/usr/bin/env node

import http, { createServer } from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { Readable } from 'node:stream'

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

function createOutputRequestMeta(
  projectRoot,
  manifest,
  outputPathname,
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
  let initProtocol = requestMeta.initProtocol || null

  if (!initUrl && requestUrl) {
    const protocol = forwardedProto || 'http'
    const host = forwardedHost || 'localhost'
    initUrl = `${protocol}://${host}${requestUrl}`
  }

  if (!initProtocol && initUrl) {
    try {
      initProtocol = new URL(initUrl).protocol.replace(/:+$/, '')
    } catch {}
  }

  return {
    ...requestMeta,
    relativeProjectDir: manifest.nodeRuntime.projectDirRelative || '',
    distDir: absoluteDistDir,
    invokeOutput: outputPathname,
    ...(initUrl ? { initURL: initUrl } : {}),
    ...(initProtocol ? { initProtocol } : {}),
  }
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

  const server = createServer((req, res) => {
    void (async () => {
      const outputPathname = Array.isArray(req.headers['x-adapter-node-output-pathname'])
        ? req.headers['x-adapter-node-output-pathname'][0]
        : req.headers['x-adapter-node-output-pathname']
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

      try {
        if (req.url === '/_adapter/status') {
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ status: 'ready' }))
          return
        }

        if (!outputPathname) {
          throw new Error('Missing x-adapter-node-output-pathname header')
        }

        const loader = globalThis._NODE_ENTRY_LOADERS?.[outputPathname]

        if (typeof loader !== 'function') {
          throw new Error(`Node entry loader was not registered for ${outputPathname}`)
        }

        let outputModule = moduleCache.get(outputPathname)

        if (!outputModule) {
          outputModule = unwrapNodeModule(await loader())
          moduleCache.set(outputPathname, outputModule)
        }

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
          decodeRequestMetaHeader(encodedRequestMeta),
          req.url,
          forwardedHost,
          forwardedProto
        )

        await handler(req, res, {
          waitUntil: () => {},
          requestMeta,
        })
      } catch (error) {
        console.error('Cloudflare adapter sidecar failed')
        console.error(error?.stack || error)

        if (!res.headersSent) {
          res.statusCode = 500
          res.end('Internal Server Error')
        } else {
          res.destroy(error)
        }
      }
    })()
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
