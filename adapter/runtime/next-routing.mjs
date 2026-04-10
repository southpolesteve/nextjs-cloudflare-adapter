function matchesCondition(actual, expected) {
  if (actual === undefined) {
    return { matched: false }
  }

  if (expected === undefined) {
    return { matched: true, capturedValue: actual }
  }

  try {
    const regex = new RegExp(expected)
    const match = actual.match(regex)

    if (match) {
      return { matched: true, capturedValue: match[0] }
    }
  } catch {}

  if (actual === expected) {
    return { matched: true, capturedValue: actual }
  }

  return { matched: false }
}

function getConditionValue(condition, url, headers) {
  switch (condition.type) {
    case 'header':
      return headers.get(condition.key) || undefined
    case 'cookie': {
      const cookieHeader = headers.get('cookie')

      if (!cookieHeader) {
        return undefined
      }

      const cookies = cookieHeader.split(';').reduce((accumulator, cookie) => {
        const [key, ...value] = cookie.trim().split('=')

        if (key) {
          accumulator[key] = value.join('=')
        }

        return accumulator
      }, {})

      return cookies[condition.key]
    }
    case 'query':
      return url.searchParams.get(condition.key) || undefined
    case 'host':
      return url.hostname
    default:
      return ''
  }
}

function normalizeCaptureKey(key) {
  return key.replace(/[^a-zA-Z]/g, '')
}

function checkHasConditions(conditions, url, headers) {
  if (!conditions || conditions.length === 0) {
    return { matched: true, captures: {} }
  }

  const captures = {}

  for (const condition of conditions) {
    const actual = getConditionValue(condition, url, headers)
    const result = matchesCondition(actual, condition.value)

    if (!result.matched) {
      return { matched: false, captures: {} }
    }

    if (result.capturedValue !== undefined && condition.type !== 'host') {
      captures[normalizeCaptureKey(condition.key)] = result.capturedValue
    }
  }

  return { matched: true, captures }
}

function checkMissingConditions(conditions, url, headers) {
  if (!conditions || conditions.length === 0) {
    return true
  }

  for (const condition of conditions) {
    const actual = getConditionValue(condition, url, headers)
    const result = matchesCondition(actual, condition.value)

    if (result.matched) {
      return false
    }
  }

  return true
}

function replaceDestination(destination, regexMatches, captures) {
  let resolved = destination

  if (regexMatches) {
    for (let index = 1; index < regexMatches.length; index += 1) {
      const value = regexMatches[index]

      if (value !== undefined) {
        resolved = resolved.replace(new RegExp(`\\$${index}`, 'g'), value)
      }
    }

    if (regexMatches.groups) {
      for (const [key, value] of Object.entries(regexMatches.groups)) {
        if (value !== undefined) {
          resolved = resolved.replace(new RegExp(`\\$${key}`, 'g'), value)
        }
      }
    }
  }

  for (const [key, value] of Object.entries(captures)) {
    resolved = resolved.replace(new RegExp(`\\$${key}`, 'g'), value)
  }

  return resolved
}

function isExternalDestination(destination) {
  return destination.startsWith('http://') || destination.startsWith('https://')
}

function applyDestination(url, destination) {
  if (isExternalDestination(destination)) {
    return new URL(destination)
  }

  const nextUrl = new URL(url.toString())
  const [pathname, search] = destination.split('?')
  nextUrl.pathname = pathname

  if (search) {
    const params = new URLSearchParams(search)

    for (const [key, value] of params.entries()) {
      nextUrl.searchParams.set(key, value)
    }
  }

  return nextUrl
}

function isRedirectStatus(status) {
  return Boolean(status && status >= 300 && status < 400)
}

function hasRedirectHeaders(headers) {
  const lowerCaseKeys = Object.keys(headers).map((key) => key.toLowerCase())
  return lowerCaseKeys.includes('location') || lowerCaseKeys.includes('refresh')
}

function normalizeNextDataUrl(url, basePath, buildId) {
  const nextUrl = new URL(url.toString())
  let pathname = nextUrl.pathname
  const prefix = `${basePath}/_next/data/${buildId}/`

  if (pathname.startsWith(prefix)) {
    let normalized = pathname.slice(prefix.length)

    if (normalized.endsWith('.json')) {
      normalized = normalized.slice(0, -5)
    }

    pathname = basePath ? `${basePath}/${normalized}` : `/${normalized}`
    nextUrl.pathname = pathname
  }

  return nextUrl
}

function denormalizeNextDataUrl(url, basePath, buildId) {
  const nextUrl = new URL(url.toString())
  let pathname = nextUrl.pathname
  const prefix = `${basePath}/_next/data/${buildId}/`

  if (!pathname.startsWith(prefix)) {
    let normalized = pathname

    if (basePath && pathname.startsWith(basePath)) {
      normalized = pathname.slice(basePath.length)
    }

    pathname = `${basePath}/_next/data/${buildId}${normalized}.json`
    nextUrl.pathname = pathname
  }

  return nextUrl
}

function detectDomainLocale(domains, hostname, detectedLocale) {
  if (!domains) {
    return undefined
  }

  const normalizedHostname = hostname?.toLowerCase()
  const normalizedLocale = detectedLocale?.toLowerCase()

  for (const domain of domains) {
    const currentDomain = domain.domain.split(':', 1)[0].toLowerCase()

    if (
      normalizedHostname === currentDomain ||
      normalizedLocale === domain.defaultLocale.toLowerCase() ||
      domain.locales?.some((locale) => locale.toLowerCase() === normalizedLocale)
    ) {
      return domain
    }
  }

  return undefined
}

function normalizeLocalePath(pathname, locales) {
  if (!locales || locales.length === 0) {
    return { pathname }
  }

  const parts = pathname.split('/', 2)

  if (!parts[1]) {
    return { pathname }
  }

  const firstSegment = parts[1].toLowerCase()
  const loweredLocales = locales.map((locale) => locale.toLowerCase())
  const index = loweredLocales.indexOf(firstSegment)

  if (index < 0) {
    return { pathname }
  }

  const detectedLocale = locales[index]
  const pathnameWithoutLocale = pathname.slice(detectedLocale.length + 1) || '/'

  return {
    pathname: pathnameWithoutLocale,
    detectedLocale,
  }
}

function getAcceptLanguageLocale(header, locales) {
  if (!header || locales.length === 0) {
    return undefined
  }

  try {
    const parsed = header
      .split(',')
      .map((part) => {
        const pieces = part.trim().split(';')
        const locale = pieces[0]
        let quality = 1

        if (pieces[1]) {
          const match = pieces[1].match(/q=([0-9.]+)/)
          if (match?.[1]) {
            quality = Number.parseFloat(match[1])
          }
        }

        return { locale, quality }
      })
      .filter((entry) => entry.quality > 0)
      .sort((left, right) => right.quality - left.quality)

    const localeMap = new Map(locales.map((locale) => [locale.toLowerCase(), locale]))

    for (const { locale } of parsed) {
      const exact = locale.toLowerCase()
      if (localeMap.has(exact)) {
        return localeMap.get(exact)
      }
    }

    for (const { locale } of parsed) {
      const base = locale.toLowerCase().split('-')[0]

      if (localeMap.has(base)) {
        return localeMap.get(base)
      }

      for (const [candidate, resolved] of localeMap) {
        if (candidate.startsWith(`${base}-`)) {
          return resolved
        }
      }
    }

    return undefined
  } catch {
    return undefined
  }
}

function getCookieLocale(cookieHeader, locales) {
  if (!cookieHeader || locales.length === 0) {
    return undefined
  }

  try {
    const cookies = cookieHeader.split(';').reduce((accumulator, cookie) => {
      const [key, ...value] = cookie.trim().split('=')

      if (key && value.length > 0) {
        accumulator[key] = decodeURIComponent(value.join('='))
      }

      return accumulator
    }, {})

    const nextLocale = cookies.NEXT_LOCALE?.toLowerCase()

    if (!nextLocale) {
      return undefined
    }

    return locales.find((locale) => locale.toLowerCase() === nextLocale)
  } catch {
    return undefined
  }
}

function detectLocale({
  pathname,
  hostname,
  cookieHeader,
  acceptLanguageHeader,
  i18n,
}) {
  const normalizedPath = normalizeLocalePath(pathname, i18n.locales)

  if (normalizedPath.detectedLocale) {
    return {
      locale: normalizedPath.detectedLocale,
      pathnameWithoutLocale: normalizedPath.pathname,
      localeInPath: true,
    }
  }

  if (i18n.localeDetection === false) {
    const domainLocale = detectDomainLocale(i18n.domains, hostname)

    return {
      locale: domainLocale?.defaultLocale || i18n.defaultLocale,
      pathnameWithoutLocale: pathname,
      localeInPath: false,
    }
  }

  const cookieLocale = getCookieLocale(cookieHeader, i18n.locales)

  if (cookieLocale) {
    return {
      locale: cookieLocale,
      pathnameWithoutLocale: pathname,
      localeInPath: false,
    }
  }

  const acceptLanguageLocale = getAcceptLanguageLocale(
    acceptLanguageHeader || '',
    i18n.locales
  )

  if (acceptLanguageLocale) {
    return {
      locale: acceptLanguageLocale,
      pathnameWithoutLocale: pathname,
      localeInPath: false,
    }
  }

  const domainLocale = detectDomainLocale(i18n.domains, hostname)

  if (domainLocale) {
    return {
      locale: domainLocale.defaultLocale,
      pathnameWithoutLocale: pathname,
      localeInPath: false,
    }
  }

  return {
    locale: i18n.defaultLocale,
    pathnameWithoutLocale: pathname,
    localeInPath: false,
  }
}

function matchRoute(route, url, headers) {
  const regex = new RegExp(route.sourceRegex)
  const regexMatches = url.pathname.match(regex)

  if (!regexMatches) {
    return { matched: false }
  }

  const hasConditions = checkHasConditions(route.has, url, headers)
  if (!hasConditions.matched) {
    return { matched: false }
  }

  if (!checkMissingConditions(route.missing, url, headers)) {
    return { matched: false }
  }

  const destination = route.destination
    ? replaceDestination(route.destination, regexMatches, hasConditions.captures)
    : undefined
  const responseHeaders = route.headers
    ? Object.fromEntries(
        Object.entries(route.headers).map(([key, value]) => [
          replaceDestination(key, regexMatches, hasConditions.captures),
          replaceDestination(value, regexMatches, hasConditions.captures),
        ])
      )
    : undefined

  return {
    matched: true,
    destination,
    headers: responseHeaders,
    regexMatches,
    hasCaptures: hasConditions.captures,
  }
}

function processRoutes(routes, url, headers, resolvedHeaders, origin) {
  let nextUrl = url
  let status

  for (const route of routes) {
    const result = matchRoute(route, nextUrl, headers)

    if (!result.matched) {
      continue
    }

    if (result.headers) {
      for (const [key, value] of Object.entries(result.headers)) {
        resolvedHeaders.set(key, value)
      }
    }

    if (route.status) {
      status = route.status
    }

    if (isRedirectStatus(route.status) && result.headers && hasRedirectHeaders(result.headers)) {
      const locationHeader = result.headers.Location || result.headers.location
      const redirectTarget = result.destination || locationHeader

      if (!redirectTarget) {
        return {
          url: nextUrl,
          stopped: true,
          status,
        }
      }

      const redirectUrl = isExternalDestination(redirectTarget)
        ? new URL(redirectTarget)
        : applyDestination(nextUrl, redirectTarget)

      return {
        url: nextUrl,
        redirect: {
          url: redirectUrl,
          status: route.status,
        },
        stopped: true,
        status,
      }
    }

    if (!result.destination) {
      continue
    }

    if (isExternalDestination(result.destination)) {
      return {
        url: nextUrl,
        externalRewrite: new URL(result.destination),
        stopped: true,
        status,
      }
    }

    nextUrl = applyDestination(nextUrl, result.destination)

    if (nextUrl.origin !== origin) {
      return {
        url: nextUrl,
        externalRewrite: nextUrl,
        stopped: true,
        status,
      }
    }
  }

  return {
    url: nextUrl,
    stopped: false,
    status,
  }
}

function matchesPathname(pathname, pathnames) {
  for (const candidate of pathnames) {
    if (pathname === candidate) {
      return candidate
    }
  }

  return undefined
}

function toResolvedQuery(url) {
  const query = {}

  for (const [key, value] of url.searchParams.entries()) {
    if (isUnresolvedRoutePlaceholder(value)) {
      continue
    }

    const current = query[key]

    if (current === undefined) {
      query[key] = value
      continue
    }

    query[key] = Array.isArray(current) ? [...current, value] : [current, value]
  }

  return query
}

function isUnresolvedRoutePlaceholder(value) {
  return /^\$[A-Za-z0-9]+$/.test(value)
}

function mergeDestinationQueryIntoUrl(url, destination) {
  const nextUrl = new URL(url.toString())
  const search = destination.split('?')[1]

  if (!search) {
    return nextUrl
  }

  const params = new URLSearchParams(search)

  for (const [key, value] of params.entries()) {
    if (isUnresolvedRoutePlaceholder(value)) {
      continue
    }

    nextUrl.searchParams.set(key, value)
  }

  return nextUrl
}

function withResolvedInvocationTarget({
  result,
  url,
  resolvedPathname,
  invocationPathname,
}) {
  const resolvedQuery = toResolvedQuery(url)

  return {
    ...result,
    resolvedPathname,
    resolvedQuery,
    invocationTarget: {
      pathname: invocationPathname,
      query: resolvedQuery,
    },
  }
}

function matchDynamicRoute(pathname, route) {
  const regex = new RegExp(route.sourceRegex)
  const regexMatches = pathname.match(regex)

  if (!regexMatches) {
    return { matched: false }
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
    matched: true,
    params,
    regexMatches,
  }
}

function applyOnMatchHeaders(routes, url, headers, baseHeaders) {
  const resolvedHeaders = new Headers(baseHeaders)

  for (const route of routes) {
    const result = matchRoute(route, url, headers)

    if (!result.matched || !result.headers) {
      continue
    }

    for (const [key, value] of Object.entries(result.headers)) {
      resolvedHeaders.set(key, value)
    }
  }

  return resolvedHeaders
}

function checkDynamicRoutes(
  dynamicRoutes,
  url,
  pathnames,
  requestHeaders,
  resolvedHeaders,
  onMatchRoutes,
  basePath,
  buildId,
  shouldNormalizeNextData,
  isNextDataRequest
) {
  let nextUrl = url

  if (isNextDataRequest && shouldNormalizeNextData) {
    nextUrl = denormalizeNextDataUrl(url, basePath, buildId)
  }

  for (const route of dynamicRoutes) {
    const dynamicMatch = matchDynamicRoute(nextUrl.pathname, route)

    if (!dynamicMatch.matched) {
      continue
    }

    const hasConditions = checkHasConditions(route.has, nextUrl, requestHeaders)
    const missingConditions = checkMissingConditions(route.missing, nextUrl, requestHeaders)

    if (!hasConditions.matched || !missingConditions) {
      continue
    }

    const destination = route.destination
      ? replaceDestination(route.destination, dynamicMatch.regexMatches || null, hasConditions.captures)
      : undefined
    const pathname = destination ? destination.split('?')[0] : nextUrl.pathname
    const matchedPathname = matchesPathname(pathname, pathnames)

    if (!matchedPathname) {
      continue
    }

    const destinationUrl = destination ? mergeDestinationQueryIntoUrl(nextUrl, destination) : nextUrl
    const responseHeaders = applyOnMatchHeaders(
      onMatchRoutes,
      destinationUrl,
      requestHeaders,
      resolvedHeaders
    )

    return {
      matched: true,
      result: withResolvedInvocationTarget({
        result: {
          routeMatches: dynamicMatch.params,
          resolvedHeaders: responseHeaders,
        },
        url: destinationUrl,
        resolvedPathname: matchedPathname,
        invocationPathname: nextUrl.pathname,
      }),
      resetUrl: nextUrl,
    }
  }

  return { matched: false }
}

export async function resolveRoutes({
  url,
  buildId,
  basePath,
  requestBody,
  headers,
  pathnames,
  i18n,
  routes,
  invokeMiddleware,
}) {
  const { shouldNormalizeNextData } = routes
  let requestUrl = new URL(url.toString())
  let requestHeaders = new Headers(headers)
  const resolvedHeaders = new Headers()
  let status
  const origin = url.origin
  let isNextDataRequest = false

  if (shouldNormalizeNextData) {
    const nextDataPrefix = `${basePath}/_next/data/${buildId}/`
    isNextDataRequest = url.pathname.startsWith(nextDataPrefix)

    if (isNextDataRequest) {
      requestUrl = normalizeNextDataUrl(requestUrl, basePath, buildId)
    }
  }

  if (i18n && !isNextDataRequest) {
    const pathname = requestUrl.pathname.startsWith(basePath)
      ? requestUrl.pathname.slice(basePath.length) || '/'
      : requestUrl.pathname

    if (!pathname.startsWith('/_next/') && !pathname.startsWith('/api/')) {
      const hostname = requestUrl.hostname
      const cookieHeader = requestHeaders.get('cookie') || undefined
      const acceptLanguageHeader = requestHeaders.get('accept-language') || undefined
      const normalizedPath = normalizeLocalePath(pathname, i18n.locales)
      const localeInPath = Boolean(normalizedPath.detectedLocale)
      const domainLocale = detectDomainLocale(i18n.domains, hostname)
      const defaultLocale = domainLocale?.defaultLocale || i18n.defaultLocale
      let locale = normalizedPath.detectedLocale || defaultLocale

      if (i18n.localeDetection !== false && !localeInPath) {
        const detected = detectLocale({
          pathname,
          hostname,
          cookieHeader,
          acceptLanguageHeader,
          i18n,
        })
        locale = detected.locale

        if (locale !== defaultLocale) {
          const localeDomain = detectDomainLocale(i18n.domains, undefined, locale)

          if (localeDomain && localeDomain.domain !== hostname) {
            const protocol = localeDomain.http ? 'http' : 'https'
            const localePath = locale === localeDomain.defaultLocale ? '' : `/${locale}`
            const redirectUrl = new URL(
              `${protocol}://${localeDomain.domain}${basePath}${localePath}${pathname}${requestUrl.search}`
            )

            return {
              redirect: {
                url: redirectUrl,
                status: 307,
              },
              resolvedHeaders,
            }
          }

          if (!cookieHeader || (localeDomain && localeDomain.domain === hostname)) {
            const redirectUrl = new URL(requestUrl.toString())
            redirectUrl.pathname = `${basePath}/${locale}${pathname}`

            return {
              redirect: {
                url: redirectUrl,
                status: 307,
              },
              resolvedHeaders,
            }
          }
        }
      }

      if (!localeInPath) {
        requestUrl.pathname = `${basePath}/${locale || domainLocale?.defaultLocale || i18n.defaultLocale}${pathname}`
      }
    }
  }

  const beforeMiddlewareResult = processRoutes(
    routes.beforeMiddleware,
    requestUrl,
    requestHeaders,
    resolvedHeaders,
    origin
  )

  if (beforeMiddlewareResult.status) {
    status = beforeMiddlewareResult.status
  }

  if (beforeMiddlewareResult.redirect) {
    return {
      redirect: beforeMiddlewareResult.redirect,
      resolvedHeaders,
      status,
    }
  }

  if (beforeMiddlewareResult.externalRewrite) {
    return {
      externalRewrite: beforeMiddlewareResult.externalRewrite,
      resolvedHeaders,
      status,
    }
  }

  requestUrl = beforeMiddlewareResult.url

  if (isNextDataRequest && shouldNormalizeNextData) {
    requestUrl = denormalizeNextDataUrl(requestUrl, basePath, buildId)
  }

  const middlewareResult = await invokeMiddleware({
    url: requestUrl,
    headers: requestHeaders,
    requestBody,
  })

  if (middlewareResult.bodySent) {
    return { middlewareResponded: true }
  }

  if (middlewareResult.requestHeaders) {
    requestHeaders = new Headers(middlewareResult.requestHeaders)
  }

  if (middlewareResult.responseHeaders) {
    middlewareResult.responseHeaders.forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') {
        resolvedHeaders.append(key, value)
      } else {
        resolvedHeaders.set(key, value)
      }
    })
  }

  if (middlewareResult.redirect) {
    if (!resolvedHeaders.has('location')) {
      resolvedHeaders.set('Location', middlewareResult.redirect.url.toString())
    }

    return {
      redirect: middlewareResult.redirect,
      resolvedHeaders,
      status: middlewareResult.redirect.status,
    }
  }

  if (middlewareResult.rewrite) {
    requestUrl = middlewareResult.rewrite

    if (requestUrl.origin !== origin) {
      return {
        externalRewrite: requestUrl,
        resolvedHeaders,
        status,
      }
    }
  }

  if (isNextDataRequest && shouldNormalizeNextData) {
    requestUrl = normalizeNextDataUrl(requestUrl, basePath, buildId)
  }

  const beforeFilesResult = processRoutes(
    routes.beforeFiles,
    requestUrl,
    requestHeaders,
    resolvedHeaders,
    origin
  )

  if (beforeFilesResult.status) {
    status = beforeFilesResult.status
  }

  if (beforeFilesResult.redirect) {
    return {
      redirect: beforeFilesResult.redirect,
      resolvedHeaders,
      status,
    }
  }

  if (beforeFilesResult.externalRewrite) {
    return {
      externalRewrite: beforeFilesResult.externalRewrite,
      resolvedHeaders,
      status,
    }
  }

  requestUrl = beforeFilesResult.url

  if (isNextDataRequest && shouldNormalizeNextData) {
    requestUrl = denormalizeNextDataUrl(requestUrl, basePath, buildId)
  }

  let resolvedPathname = matchesPathname(requestUrl.pathname, pathnames)

  if (resolvedPathname) {
    for (const route of routes.dynamicRoutes) {
      const dynamicMatch = matchDynamicRoute(requestUrl.pathname, route)

      if (!dynamicMatch.matched) {
        continue
      }

      const hasConditions = checkHasConditions(route.has, requestUrl, requestHeaders)
      const missingConditions = checkMissingConditions(route.missing, requestUrl, requestHeaders)

      if (!hasConditions.matched || !missingConditions) {
        continue
      }

      const destination = route.destination
        ? replaceDestination(route.destination, dynamicMatch.regexMatches || null, hasConditions.captures)
        : undefined
      const destinationUrl = destination
        ? mergeDestinationQueryIntoUrl(requestUrl, destination)
        : requestUrl
      const responseHeaders = applyOnMatchHeaders(
        routes.onMatch,
        destinationUrl,
        requestHeaders,
        resolvedHeaders
      )

      return withResolvedInvocationTarget({
        result: {
          routeMatches: dynamicMatch.params,
          resolvedHeaders: responseHeaders,
          status,
        },
        url: destinationUrl,
        resolvedPathname,
        invocationPathname: requestUrl.pathname,
      })
    }

    const responseHeaders = applyOnMatchHeaders(
      routes.onMatch,
      requestUrl,
      requestHeaders,
      resolvedHeaders
    )

    return withResolvedInvocationTarget({
      result: {
        resolvedHeaders: responseHeaders,
        status,
      },
      url: requestUrl,
      resolvedPathname,
      invocationPathname: requestUrl.pathname,
    })
  }

  if (isNextDataRequest && shouldNormalizeNextData) {
    requestUrl = normalizeNextDataUrl(requestUrl, basePath, buildId)
  }

  for (const route of routes.afterFiles) {
    const result = matchRoute(route, requestUrl, requestHeaders)

    if (!result.matched) {
      continue
    }

    if (result.headers) {
      for (const [key, value] of Object.entries(result.headers)) {
        resolvedHeaders.set(key, value)
      }
    }

    if (route.status) {
      status = route.status
    }

    if (!result.destination) {
      continue
    }

    if (isRedirectStatus(route.status) && result.headers && hasRedirectHeaders(result.headers)) {
      const redirectUrl = isExternalDestination(result.destination)
        ? new URL(result.destination)
        : applyDestination(requestUrl, result.destination)

      return {
        redirect: {
          url: redirectUrl,
          status: route.status,
        },
        resolvedHeaders,
        status,
      }
    }

    if (isExternalDestination(result.destination)) {
      return {
        externalRewrite: new URL(result.destination),
        resolvedHeaders,
        status,
      }
    }

    requestUrl = applyDestination(requestUrl, result.destination)

    if (requestUrl.origin !== origin) {
      return {
        externalRewrite: requestUrl,
        resolvedHeaders,
        status,
      }
    }

    const dynamicCheck = checkDynamicRoutes(
      routes.dynamicRoutes,
      requestUrl,
      pathnames,
      requestHeaders,
      resolvedHeaders,
      routes.onMatch,
      basePath,
      buildId,
      shouldNormalizeNextData,
      isNextDataRequest
    )

    if (dynamicCheck.matched && dynamicCheck.result) {
      if (dynamicCheck.resetUrl) {
        requestUrl = dynamicCheck.resetUrl
      }

      return {
        ...dynamicCheck.result,
        status,
      }
    }

    let filesystemUrl = requestUrl

    if (isNextDataRequest && shouldNormalizeNextData) {
      filesystemUrl = denormalizeNextDataUrl(requestUrl, basePath, buildId)
    }

    resolvedPathname = matchesPathname(filesystemUrl.pathname, pathnames)

    if (resolvedPathname) {
      const responseHeaders = applyOnMatchHeaders(
        routes.onMatch,
        filesystemUrl,
        requestHeaders,
        resolvedHeaders
      )

      return withResolvedInvocationTarget({
        result: {
          resolvedHeaders: responseHeaders,
          status,
        },
        url: filesystemUrl,
        resolvedPathname,
        invocationPathname: filesystemUrl.pathname,
      })
    }
  }

  for (const route of routes.dynamicRoutes) {
    const dynamicMatch = matchDynamicRoute(requestUrl.pathname, route)

    if (!dynamicMatch.matched) {
      continue
    }

    const hasConditions = checkHasConditions(route.has, requestUrl, requestHeaders)
    const missingConditions = checkMissingConditions(route.missing, requestUrl, requestHeaders)

    if (!hasConditions.matched || !missingConditions) {
      continue
    }

    const destination = route.destination
      ? replaceDestination(route.destination, dynamicMatch.regexMatches || null, hasConditions.captures)
      : undefined
    const pathname = destination ? destination.split('?')[0] : requestUrl.pathname

    resolvedPathname = matchesPathname(pathname, pathnames)

    if (!resolvedPathname) {
      continue
    }

    const destinationUrl = destination
      ? mergeDestinationQueryIntoUrl(requestUrl, destination)
      : requestUrl
    const responseHeaders = applyOnMatchHeaders(
      routes.onMatch,
      destinationUrl,
      requestHeaders,
      resolvedHeaders
    )

    return withResolvedInvocationTarget({
      result: {
        routeMatches: dynamicMatch.params,
        resolvedHeaders: responseHeaders,
        status,
      },
      url: destinationUrl,
      resolvedPathname,
      invocationPathname: requestUrl.pathname,
    })
  }

  for (const route of routes.fallback) {
    const result = matchRoute(route, requestUrl, requestHeaders)

    if (!result.matched) {
      continue
    }

    if (result.headers) {
      for (const [key, value] of Object.entries(result.headers)) {
        resolvedHeaders.set(key, value)
      }
    }

    if (route.status) {
      status = route.status
    }

    if (!result.destination) {
      continue
    }

    if (isRedirectStatus(route.status) && result.headers && hasRedirectHeaders(result.headers)) {
      const redirectUrl = isExternalDestination(result.destination)
        ? new URL(result.destination)
        : applyDestination(requestUrl, result.destination)

      return {
        redirect: {
          url: redirectUrl,
          status: route.status,
        },
        resolvedHeaders,
        status,
      }
    }

    if (isExternalDestination(result.destination)) {
      return {
        externalRewrite: new URL(result.destination),
        resolvedHeaders,
        status,
      }
    }

    requestUrl = applyDestination(requestUrl, result.destination)

    if (requestUrl.origin !== origin) {
      return {
        externalRewrite: requestUrl,
        resolvedHeaders,
        status,
      }
    }

    const dynamicCheck = checkDynamicRoutes(
      routes.dynamicRoutes,
      requestUrl,
      pathnames,
      requestHeaders,
      resolvedHeaders,
      routes.onMatch,
      basePath,
      buildId,
      shouldNormalizeNextData,
      isNextDataRequest
    )

    if (dynamicCheck.matched && dynamicCheck.result) {
      if (dynamicCheck.resetUrl) {
        requestUrl = dynamicCheck.resetUrl
      }

      return {
        ...dynamicCheck.result,
        status,
      }
    }

    let filesystemUrl = requestUrl

    if (isNextDataRequest && shouldNormalizeNextData) {
      filesystemUrl = denormalizeNextDataUrl(requestUrl, basePath, buildId)
    }

    resolvedPathname = matchesPathname(filesystemUrl.pathname, pathnames)

    if (resolvedPathname) {
      const responseHeaders = applyOnMatchHeaders(
        routes.onMatch,
        filesystemUrl,
        requestHeaders,
        resolvedHeaders
      )

      return withResolvedInvocationTarget({
        result: {
          resolvedHeaders: responseHeaders,
          status,
        },
        url: filesystemUrl,
        resolvedPathname,
        invocationPathname: filesystemUrl.pathname,
      })
    }
  }

  return {
    resolvedHeaders,
    status,
  }
}

function getRelativeURL(value, base) {
  try {
    const resolved = new URL(value, base)
    const baseUrl = new URL(base)

    if (resolved.origin === baseUrl.origin) {
      return `${resolved.pathname}${resolved.search}${resolved.hash}`
    }

    return resolved.toString()
  } catch {
    return value
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export function responseToMiddlewareResult(response, requestHeaders, requestUrl) {
  const result = {}
  const collectedHeaders = {}

  response.headers.forEach((value, key) => {
    if (collectedHeaders[key]) {
      const current = collectedHeaders[key]

      if (Array.isArray(current)) {
        current.push(value)
      } else {
        collectedHeaders[key] = [current, value]
      }
    } else {
      collectedHeaders[key] = value
    }
  })

  if (collectedHeaders['x-middleware-override-headers']) {
    const allowedHeaders = new Set()
    let overridden = collectedHeaders['x-middleware-override-headers']

    if (typeof overridden === 'string') {
      overridden = overridden.split(',')
    }

    for (const key of overridden) {
      allowedHeaders.add(key.trim())
    }

    delete collectedHeaders['x-middleware-override-headers']

    const toDelete = []
    requestHeaders.forEach((_, key) => {
      if (!allowedHeaders.has(key)) {
        toDelete.push(key)
      }
    })

    for (const key of toDelete) {
      requestHeaders.delete(key)
    }

    for (const key of allowedHeaders.keys()) {
      const overrideKey = `x-middleware-request-${key}`
      const overrideValue = collectedHeaders[overrideKey]

      if (overrideValue === undefined || overrideValue === null) {
        requestHeaders.delete(key)
      } else if (Array.isArray(overrideValue)) {
        requestHeaders.set(key, overrideValue[0])

        for (let index = 1; index < overrideValue.length; index += 1) {
          requestHeaders.append(key, overrideValue[index])
        }
      } else {
        requestHeaders.set(key, overrideValue)
      }

      delete collectedHeaders[overrideKey]
    }
  }

  if (
    !collectedHeaders['x-middleware-rewrite'] &&
    !collectedHeaders['x-middleware-next'] &&
    !collectedHeaders.location
  ) {
    collectedHeaders['x-middleware-refresh'] = '1'
  }

  delete collectedHeaders['x-middleware-next']

  const responseHeaders = new Headers()

  for (const [key, value] of Object.entries(collectedHeaders)) {
    if (
      ['content-length', 'x-middleware-rewrite', 'x-middleware-redirect', 'x-middleware-refresh'].includes(
        key
      )
    ) {
      continue
    }

    if (key === 'x-middleware-set-cookie') {
      if (value !== undefined) {
        if (Array.isArray(value)) {
          for (const item of value) {
            requestHeaders.append(key, item)
          }
        } else {
          requestHeaders.set(key, value)
        }
      }

      continue
    }

    if (value !== undefined) {
      if (Array.isArray(value)) {
        for (const item of value) {
          responseHeaders.append(key, item)
          requestHeaders.append(key, item)
        }
      } else {
        responseHeaders.set(key, value)
        requestHeaders.set(key, value)
      }
    }
  }

  result.responseHeaders = responseHeaders
  result.requestHeaders = requestHeaders

  if (collectedHeaders['x-middleware-rewrite']) {
    const rewriteValue = collectedHeaders['x-middleware-rewrite']
    const relativeUrl = getRelativeURL(rewriteValue, requestUrl.toString())
    responseHeaders.set('x-middleware-rewrite', relativeUrl)

    try {
      const rewriteUrl = new URL(relativeUrl, requestUrl)

      if (rewriteUrl.origin !== requestUrl.origin) {
        result.rewrite = rewriteUrl
        return result
      }

      result.rewrite = rewriteUrl
    } catch {
      result.rewrite = new URL(relativeUrl, requestUrl)
    }
  }

  if (collectedHeaders.location) {
    const location = collectedHeaders.location
    const isRedirect = REDIRECT_STATUSES.has(response.status)

    if (isRedirect) {
      const relativeUrl = getRelativeURL(location, requestUrl.toString())
      responseHeaders.set('location', relativeUrl)

      try {
        result.redirect = {
          url: new URL(relativeUrl, requestUrl),
          status: response.status,
        }
      } catch {
        result.redirect = {
          url: new URL(relativeUrl, requestUrl),
          status: response.status,
        }
      }

      return result
    }

    responseHeaders.set('location', location)
    return result
  }

  if (collectedHeaders['x-middleware-refresh']) {
    result.bodySent = true
    return result
  }

  return result
}
