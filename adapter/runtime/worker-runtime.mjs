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
  return headers.get('rsc') === '1' || url.searchParams.has('_rsc')
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

function normalizeNextQueryParam(key) {
  for (const prefix of ['nxtP', 'nxtI']) {
    if (key !== prefix && key.startsWith(prefix)) {
      return key.slice(prefix.length)
    }
  }

  return null
}

function toRouteParams(routeMatches) {
  if (!routeMatches) {
    return undefined
  }

  const params = {}

  for (const [key, value] of Object.entries(routeMatches)) {
    if (/^\d+$/.test(key) || value === undefined) {
      continue
    }

    const normalizedKey = normalizeNextQueryParam(key) || key
    params[normalizedKey] = value
  }

  return Object.keys(params).length > 0 ? params : undefined
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

function createRouteRequestMeta(routeResult) {
  if (!routeResult) {
    return undefined
  }

  const params = toRouteParams(routeResult.routeMatches)
  const query = routeResult.resolvedQuery
  const invokePath = routeResult.invocationTarget?.pathname

  if (
    params === undefined &&
    query === undefined &&
    routeResult.resolvedPathname === undefined &&
    invokePath === undefined
  ) {
    return undefined
  }

  return {
    params,
    query,
    resolvedPathname: routeResult.resolvedPathname,
    invokePath,
    invokeQuery: query,
  }
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

function finalizeResponse(response, { headers, status } = {}) {
  const nextStatus = status ?? response.status
  const init = {
    status: nextStatus,
    headers: mergeHeaders(response.headers, headers),
  }

  if (status === undefined || status === response.status) {
    init.statusText = response.statusText
  }

  return new Response(response.body, {
    ...init,
  })
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

  return handler(attachEdgeRequestContext(request, { nextConfig, requestMeta }), {
    waitUntil: executionCtx?.waitUntil?.bind(executionCtx),
    signal: request.signal,
    requestMeta,
  })
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
  applyQuery(invocationUrl, invocationTarget.query)

  return invocationUrl
}

function isRedirectResponse(response) {
  return response.status >= 300 && response.status < 400
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
  const routeOutputs = new Map(
    manifest.routeOutputs.map((output) => [output.pathname, output])
  )
  const assetPathnames = new Set(manifest.assetPathnames)
  const prerenderAssetPathnames = new Set(manifest.prerenderAssetPathnames ?? [])
  const prerenderDataRouteMap = new Map(Object.entries(manifest.prerenderDataRouteMap ?? {}))
  const assetPathMap = new Map(Object.entries(manifest.assetPathMap ?? {}))
  const assetMetadata = new Map(Object.entries(manifest.assetMetadata ?? {}))
  const notFoundOutput = manifest.notFoundPathname
    ? routeOutputs.get(manifest.notFoundPathname)
    : undefined
  const nodeRuntime = manifest.nodeRuntime?.enabled ? createNodeRuntime(manifest) : null

  return {
    async fetch(request, env, executionCtx) {
      if (request.url) {
        const directUrl = new URL(request.url)

        if (directUrl.pathname === '/_adapter/status' && nodeRuntime) {
          return nodeRuntime.fetch(request)
        }
      }

      const requestUrl = new URL(request.url)
      const requestHeaders = new Headers(request.headers)
      const { middlewareBody, handlerBody } = teeRequestBody(request.body)
      let downstreamRequestHeaders = new Headers(requestHeaders)
      let middlewareResponse

      const routeResult = await resolveRoutes({
        url: requestUrl,
        buildId: manifest.buildId,
        basePath: manifest.basePath,
        i18n: manifest.i18n,
        headers: requestHeaders,
        requestBody: middlewareBody,
        pathnames: manifest.pathnames,
        routes: manifest.routing,
        invokeMiddleware: async (ctx) => {
          if (!manifest.middleware) {
            return {}
          }

          const middlewareRequest = createDerivedRequest(request, {
            url: ctx.url.toString(),
            headers: ctx.headers,
            body: ctx.requestBody,
          })

          middlewareResponse = await invokeOutput(
            manifest.middleware,
            middlewareRequest,
            executionCtx,
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
        const redirectHeaders = mergeHeaders(routeResult.resolvedHeaders)

        if (!redirectHeaders.has('location')) {
          redirectHeaders.set('location', routeResult.redirect.url.toString())
        }

        return new Response(null, {
          status: routeResult.redirect.status,
          headers: redirectHeaders,
        })
      }

      if (routeResult.externalRewrite) {
        const rewrittenRequest = createDerivedRequest(request, {
          url: routeResult.externalRewrite.toString(),
          headers: downstreamRequestHeaders,
          body: handlerBody,
        })
        const rewrittenResponse = await fetch(rewrittenRequest)

        return finalizeResponse(rewrittenResponse, {
          headers: routeResult.resolvedHeaders,
          status: routeResult.status,
        })
      }

      if (routeResult.resolvedPathname) {
        const isPrerenderDataRequest =
          isRscRequest(requestUrl, requestHeaders) &&
          prerenderDataRouteMap.has(routeResult.resolvedPathname)
        const assetPathname = isPrerenderDataRequest
          ? prerenderDataRouteMap.get(routeResult.resolvedPathname)
          : routeResult.resolvedPathname

        if (
          assetPathname &&
          assetPathnames.has(assetPathname) &&
          canServeStaticAsset(request.method)
        ) {
          const assetUrl = new URL(requestUrl.toString())
          assetUrl.pathname = assetPathMap.get(assetPathname) || assetPathname

          if (routeResult.invocationTarget?.query) {
            applyQuery(assetUrl, routeResult.invocationTarget.query)
          }

          const assetRequest = createDerivedRequest(request, {
            url: assetUrl.toString(),
            headers: downstreamRequestHeaders,
            body: handlerBody,
          })
          const assetResponse = await fetchAssetResponse(env, assetRequest)
          const assetMeta = assetMetadata.get(assetPathname)
          const assetHeaders = mergeHeaders(assetMeta?.headers, routeResult.resolvedHeaders)
          const staticDataContentType = getStaticDataContentType(assetPathname)

          if (staticDataContentType) {
            assetHeaders.set('content-type', staticDataContentType)
          }

          if (
            prerenderAssetPathnames.has(routeResult.resolvedPathname) &&
            !assetHeaders.has('x-nextjs-cache')
          ) {
            assetHeaders.set('x-nextjs-cache', 'PRERENDER')
          }

          if (
            prerenderAssetPathnames.has(routeResult.resolvedPathname) &&
            !assetHeaders.has('x-nextjs-prerender')
          ) {
            assetHeaders.set('x-nextjs-prerender', '1')
          }

          return finalizeResponse(assetResponse, {
            headers: assetHeaders,
            status: routeResult.status ?? assetMeta?.status,
          })
        }

        const output = routeOutputs.get(routeResult.resolvedPathname)

        if (output) {
          const invocationUrl = buildInvocationUrl(requestUrl, routeResult.invocationTarget)
          const invocationRequest = createDerivedRequest(request, {
            url: invocationUrl.toString(),
            headers: downstreamRequestHeaders,
            body: handlerBody,
          })
          const routeRequestMeta = createRouteRequestMeta(routeResult)
          const routeMatchesHeader = toRouteMatchesHeader(routeResult.routeMatches)

          if (routeMatchesHeader && !invocationRequest.headers.has('x-now-route-matches')) {
            invocationRequest.headers.set('x-now-route-matches', routeMatchesHeader)
          }

          const response = await invokeRouteOutput(
            output,
            invocationRequest,
            executionCtx,
            nodeRuntime,
            manifest.nextConfig,
            routeRequestMeta
          )

          return finalizeResponse(response, {
            headers: routeResult.resolvedHeaders,
            status: routeResult.status,
          })
        }
      }

      const directAssetResponse = await env.ASSETS.fetch(request)

      if (directAssetResponse.status !== 404) {
        return directAssetResponse
      }

      if (notFoundOutput) {
        const notFoundResponse = await invokeRouteOutput(
          notFoundOutput,
          request,
          executionCtx,
          nodeRuntime,
          manifest.nextConfig
        )
        const notFoundStatus = notFoundResponse.status === 200 ? 404 : notFoundResponse.status

        return finalizeResponse(notFoundResponse, { status: notFoundStatus })
      }

      return new Response('Not Found', { status: 404 })
    },
  }
}
