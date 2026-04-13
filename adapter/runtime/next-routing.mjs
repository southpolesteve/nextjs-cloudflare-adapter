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

function matchesMiddlewareMatcherPath(matcher, pathname, url, headers) {
  if (!matcher) {
    return false
  }

  if (!checkMissingConditions(matcher.missing, url, headers)) {
    return false
  }

  if (!checkHasConditions(matcher.has, url, headers).matched) {
    return false
  }

  try {
    return new RegExp(matcher.sourceRegex).test(pathname)
  } catch {
    return false
  }
}

function getMiddlewareMatcherCandidates({
  url,
  matcher,
  i18n,
  basePath,
  pendingLocale,
}) {
  const pathname = url.pathname || '/'
  const candidates = new Set([pathname])

  let decodedPathname = pathname

  try {
    decodedPathname = decodeURIComponent(pathname)
    candidates.add(decodedPathname)
  } catch {}

  if (!i18n || matcher?.locale === false) {
    return Array.from(candidates)
  }

  const pathnameWithoutBase =
    basePath && pathname.startsWith(basePath)
      ? pathname.slice(basePath.length) || '/'
      : pathname
  const normalizedPath = normalizeLocalePath(pathnameWithoutBase, i18n.locales)

  if (normalizedPath.detectedLocale) {
    return Array.from(candidates)
  }

  const localeToApply = pendingLocale || i18n.defaultLocale
  const localizedPath =
    pathnameWithoutBase === '/'
      ? `${basePath}/${localeToApply}`
      : `${basePath}/${localeToApply}${pathnameWithoutBase}`

  candidates.add(localizedPath)

  const sourcePath = matcher.source || ''
  const pathSegments = pathnameWithoutBase.split('/').filter(Boolean)
  const sourceSegments = sourcePath.split('?')[0].split('/').filter(Boolean)
  const looksLikeInvalidLocalePrefixedMatch =
    sourcePath &&
    sourcePath !== '/' &&
    pathSegments.length === sourceSegments.length + 1 &&
    pathnameWithoutBase.endsWith(sourcePath)

  if (looksLikeInvalidLocalePrefixedMatch) {
    candidates.delete(pathname)
    candidates.delete(decodedPathname)
  }

  return Array.from(candidates)
}

function shouldInvokeMiddleware({
  url,
  headers,
  matchers,
  i18n,
  basePath,
  pendingLocale,
}) {
  if (!Array.isArray(matchers) || matchers.length === 0) {
    return true
  }

  return matchers.some((matcher) => {
    const candidatePathnames = getMiddlewareMatcherCandidates({
      url,
      matcher,
      i18n,
      basePath,
      pendingLocale,
    })

    for (const candidatePathname of candidatePathnames) {
      if (matchesMiddlewareMatcherPath(matcher, candidatePathname, url, headers)) {
        return true
      }
    }

    return false
  })
}

function replaceDestination(destination, regexMatches, captures) {
  let resolved = destination
  const replacements = []

  if (regexMatches) {
    for (let index = 1; index < regexMatches.length; index += 1) {
      const value = regexMatches[index]

      if (value !== undefined) {
        replacements.push([String(index), value])
      }
    }

    if (regexMatches.groups) {
      for (const [key, value] of Object.entries(regexMatches.groups)) {
        if (value !== undefined) {
          replacements.push([key, value])
        }
      }
    }
  }

  for (const [key, value] of Object.entries(captures)) {
    replacements.push([key, value])
  }

  replacements.sort((left, right) => right[0].length - left[0].length)

  for (const [key, value] of replacements) {
    resolved = resolved.replace(new RegExp(`\\$${key}`, 'g'), value)
  }

  return resolved
}

function extractSourceParamNames(source) {
  if (!source) {
    return []
  }

  const parameterNames = []
  const matcher = /:([A-Za-z0-9_]+)(?:\([^)]*\))?[?*+]?/g
  let match

  while ((match = matcher.exec(source)) !== null) {
    parameterNames.push(match[1])
  }

  return parameterNames
}

function toSourceCaptures(route, regexMatches) {
  if (!regexMatches) {
    return {}
  }

  const parameterNames = extractSourceParamNames(route.source)

  if (parameterNames.length === 0) {
    return {}
  }

  const captures = {}

  for (let index = 0; index < parameterNames.length; index += 1) {
    const value = regexMatches[index + 1]

    if (value !== undefined) {
      captures[parameterNames[index]] = value
    }
  }

  return captures
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

function applyRewriteUrl(url, rewriteUrl) {
  const nextUrl = new URL(url.toString())
  nextUrl.pathname = rewriteUrl.pathname
  nextUrl.hash = rewriteUrl.hash

  for (const [key, value] of rewriteUrl.searchParams.entries()) {
    nextUrl.searchParams.set(key, value)
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

function normalizeNextDataUrl(url, basePath, buildId, trailingSlash = false) {
  const nextUrl = new URL(url.toString())
  let pathname = nextUrl.pathname
  const prefix = `${basePath}/_next/data/${buildId}/`

  if (pathname.startsWith(prefix)) {
    let normalized = pathname.slice(prefix.length)

    if (normalized.endsWith('.json')) {
      normalized = normalized.slice(0, -5)
    }

    pathname = basePath ? `${basePath}/${normalized}` : `/${normalized}`

    if (
      trailingSlash &&
      pathname !== '/' &&
      !pathname.endsWith('/') &&
      !pathname.split('/').pop()?.includes('.')
    ) {
      pathname = `${pathname}/`
    }

    nextUrl.pathname = pathname
  }

  return nextUrl
}

function denormalizeNextDataUrl(url, basePath, buildId, trailingSlash = false) {
  const nextUrl = new URL(url.toString())
  let pathname = nextUrl.pathname
  const prefix = `${basePath}/_next/data/${buildId}/`

  if (!pathname.startsWith(prefix)) {
    let normalized = pathname

    if (basePath && pathname.startsWith(basePath)) {
      normalized = pathname.slice(basePath.length)
    }

    if (trailingSlash && normalized !== '/' && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1)
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

function normalizeRepeatedSlashes(pathname) {
  if (typeof pathname !== 'string' || !pathname.includes('//')) {
    return pathname
  }

  const normalizedPathname = pathname.replace(/\/{2,}/g, '/')
  return normalizedPathname || '/'
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

function createRouteRegExp(sourceRegex, caseSensitive = false) {
  return new RegExp(sourceRegex, caseSensitive ? '' : 'i')
}

function matchesResolvedPathname(left, right, caseSensitive = false) {
  if (caseSensitive) {
    return left === right
  }

  return left.toLowerCase() === right.toLowerCase()
}

function matchRoute(route, url, headers, caseSensitive = false) {
  const regex = createRouteRegExp(route.sourceRegex, caseSensitive)
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

  const sourceCaptures = toSourceCaptures(route, regexMatches)
  const destinationCaptures = {
    ...sourceCaptures,
    ...hasConditions.captures,
  }

  const destination = route.destination
    ? replaceDestination(route.destination, regexMatches, destinationCaptures)
    : undefined
  const responseHeaders = route.headers
    ? Object.fromEntries(
        Object.entries(route.headers).map(([key, value]) => [
          replaceDestination(key, regexMatches, destinationCaptures),
          replaceDestination(value, regexMatches, destinationCaptures),
        ])
      )
    : undefined

  return {
    matched: true,
    destination,
    headers: responseHeaders,
    regexMatches,
    hasCaptures: destinationCaptures,
  }
}

function processRoutes(routes, url, headers, resolvedHeaders, origin, caseSensitive = false) {
  let nextUrl = url
  let status

  for (const route of routes) {
    const result = matchRoute(route, nextUrl, headers, caseSensitive)

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

function matchesPathname(pathname, pathnames, trailingSlash = false, caseSensitive = false) {
  const normalizedPathname =
    pathname !== '/' && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname

  for (const candidate of pathnames) {
    if (
      matchesResolvedPathname(pathname, candidate, caseSensitive) ||
      matchesResolvedPathname(normalizedPathname, candidate, caseSensitive)
    ) {
      return candidate
    }

    if (
      trailingSlash &&
      pathname !== '/' &&
      pathname.endsWith('/') &&
      matchesResolvedPathname(pathname.slice(0, -1), candidate, caseSensitive)
    ) {
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
    resolvedRequestUrl: url,
    invocationTarget: {
      pathname: invocationPathname,
      query: resolvedQuery,
      rawQuery: url.search,
    },
  }
}

function matchDynamicRoute(pathname, route, trailingSlash = false, caseSensitive = false) {
  const nextPathname =
    trailingSlash && pathname !== '/' && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  const regex = createRouteRegExp(route.sourceRegex, caseSensitive)
  const regexMatches = nextPathname.match(regex)

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

const dynamicPathnameMatcherCache = new Map()

function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}

function createDynamicPathnameMatcher(pathname, caseSensitive = false) {
  const cacheKey = `${caseSensitive ? '1' : '0'}:${pathname}`

  if (dynamicPathnameMatcherCache.has(cacheKey)) {
    return dynamicPathnameMatcherCache.get(cacheKey)
  }

  if (typeof pathname !== 'string' || !pathname.includes('[')) {
    dynamicPathnameMatcherCache.set(cacheKey, null)
    return null
  }

  const paramNames = []
  let pattern = '^'

  if (pathname === '/') {
    pattern += '/'
  } else {
    for (const segment of pathname.split('/').slice(1)) {
      const optionalCatchAllMatch = segment.match(/^\[\[\.\.\.([^\]/]+)\]\]$/)

      if (optionalCatchAllMatch) {
        paramNames.push(optionalCatchAllMatch[1])
        pattern += '(?:/(.+?))?'
        continue
      }

      const catchAllMatch = segment.match(/^\[\.\.\.([^\]/]+)\]$/)

      if (catchAllMatch) {
        paramNames.push(catchAllMatch[1])
        pattern += '/(.+?)'
        continue
      }

      const dynamicMatch = segment.match(/^\[([^\]/]+)\]$/)

      if (dynamicMatch) {
        paramNames.push(dynamicMatch[1])
        pattern += '/([^/]+?)'
        continue
      }

      pattern += `/${escapeRegExp(segment)}`
    }
  }

  pattern += '(?:/)?$'

  const matcher = {
    regex: new RegExp(pattern, caseSensitive ? '' : 'i'),
    paramNames,
  }

  dynamicPathnameMatcherCache.set(cacheKey, matcher)
  return matcher
}

function matchDynamicPathname(pathname, candidatePathname, trailingSlash = false, caseSensitive = false) {
  const matcher = createDynamicPathnameMatcher(candidatePathname, caseSensitive)

  if (!matcher) {
    return { matched: false }
  }

  const nextPathname =
    trailingSlash && pathname !== '/' && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  const regexMatches = nextPathname.match(matcher.regex)

  if (!regexMatches) {
    return { matched: false }
  }

  const params = {}

  for (let index = 0; index < matcher.paramNames.length; index += 1) {
    const value = regexMatches[index + 1]

    if (value !== undefined) {
      params[matcher.paramNames[index]] = value
    }
  }

  return {
    matched: true,
    params,
    regexMatches,
  }
}

function applyOnMatchHeaders(routes, url, headers, baseHeaders, caseSensitive = false) {
  const resolvedHeaders = new Headers(baseHeaders)

  for (const route of routes) {
    const result = matchRoute(route, url, headers, caseSensitive)

    if (!result.matched || !result.headers) {
      continue
    }

    for (const [key, value] of Object.entries(result.headers)) {
      resolvedHeaders.set(key, value)
    }
  }

  return resolvedHeaders
}

function normalizeComparablePathname(pathname) {
  return pathname !== '/' && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

function canMatchDynamicPrerenderPath(
  dynamicPrerenderRoutes,
  resolvedPathname,
  concretePathname,
  caseSensitive = false
) {
  const routeConfig = dynamicPrerenderRoutes?.[resolvedPathname]

  if (!routeConfig || routeConfig.fallback !== false) {
    return true
  }

  const allowedPathnames = resolvedPathname.endsWith('.rsc')
    ? routeConfig.dataRoutePathnames
    : routeConfig.pathnames

  if (!Array.isArray(allowedPathnames) || allowedPathnames.length === 0) {
    return false
  }

  const normalizedConcretePathname = normalizeComparablePathname(concretePathname)

  return allowedPathnames.some((pathname) =>
    matchesResolvedPathname(
      normalizeComparablePathname(pathname),
      normalizedConcretePathname,
      caseSensitive
    )
  )
}

function checkDynamicRoutes(
  dynamicRoutes,
  url,
  pathnames,
  requestHeaders,
  resolvedHeaders,
  onMatchRoutes,
  trailingSlash,
  caseSensitive,
  basePath,
  buildId,
  shouldNormalizeNextData,
  isNextDataRequest,
  dynamicPrerenderRoutes = {}
) {
  let nextUrl = url

  if (isNextDataRequest && shouldNormalizeNextData) {
    nextUrl = denormalizeNextDataUrl(url, basePath, buildId)
  }

  for (const route of dynamicRoutes) {
    const dynamicMatch = matchDynamicRoute(nextUrl.pathname, route, trailingSlash, caseSensitive)

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
    let matchedConcretePathname = pathname
    let matchedPathname = matchesPathname(pathname, pathnames, trailingSlash, caseSensitive)
    let invocationPathname = nextUrl.pathname

    if (!matchedPathname && buildId) {
      const normalizedNextDataPathname = normalizeNextDataUrl(
        new URL(`http://localhost${pathname}`),
        basePath,
        buildId,
        trailingSlash
      ).pathname

      if (normalizedNextDataPathname !== pathname) {
        matchedPathname = matchesPathname(
          normalizedNextDataPathname,
          pathnames,
          trailingSlash,
          caseSensitive
        )

        if (matchedPathname) {
          matchedConcretePathname = normalizedNextDataPathname
        }
      }
    }

    if (buildId) {
      const normalizedInvocationPathname = normalizeNextDataUrl(
        nextUrl,
        basePath,
        buildId,
        trailingSlash
      ).pathname

      if (normalizedInvocationPathname !== nextUrl.pathname) {
        invocationPathname = normalizedInvocationPathname
      }
    }

    if (!matchedPathname) {
      continue
    }

    if (
      !canMatchDynamicPrerenderPath(
        dynamicPrerenderRoutes,
        matchedPathname,
        matchedConcretePathname,
        caseSensitive
      )
    ) {
      continue
    }

    const destinationUrl = destination ? mergeDestinationQueryIntoUrl(nextUrl, destination) : nextUrl
    const responseHeaders = applyOnMatchHeaders(
      onMatchRoutes,
      destinationUrl,
      requestHeaders,
      resolvedHeaders,
      caseSensitive
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
        invocationPathname,
      }),
      resetUrl: nextUrl,
    }
  }

  return { matched: false }
}

function checkDynamicPathnameMatches(
  pathnames,
  url,
  requestHeaders,
  resolvedHeaders,
  onMatchRoutes,
  trailingSlash,
  caseSensitive,
  dynamicPrerenderRoutes = {}
) {
  for (const pathname of pathnames) {
    const dynamicMatch = matchDynamicPathname(
      url.pathname,
      pathname,
      trailingSlash,
      caseSensitive
    )

    if (!dynamicMatch.matched) {
      continue
    }

    if (
      !canMatchDynamicPrerenderPath(
        dynamicPrerenderRoutes,
        pathname,
        url.pathname,
        caseSensitive
      )
    ) {
      continue
    }

    const responseHeaders = applyOnMatchHeaders(
      onMatchRoutes,
      url,
      requestHeaders,
      resolvedHeaders,
      caseSensitive
    )

    return {
      matched: true,
      result: withResolvedInvocationTarget({
        result: {
          routeMatches: dynamicMatch.params,
          resolvedHeaders: responseHeaders,
        },
        url,
        resolvedPathname: pathname,
        invocationPathname: url.pathname,
      }),
    }
  }

  return { matched: false }
}

function hasDirectRouteMatch(
  url,
  pathnames,
  dynamicRoutes,
  requestHeaders,
  trailingSlash,
  caseSensitive,
  basePath,
  buildId,
  shouldNormalizeNextData,
  isNextDataRequest,
  dynamicPrerenderRoutes = {}
) {
  if (matchesPathname(url.pathname, pathnames, trailingSlash, caseSensitive)) {
    return true
  }

  if (!Array.isArray(dynamicRoutes) || dynamicRoutes.length === 0) {
    return checkDynamicPathnameMatches(
      pathnames,
      url,
      requestHeaders,
      new Headers(),
      [],
      trailingSlash,
      caseSensitive,
      dynamicPrerenderRoutes
    ).matched
  }

  return checkDynamicRoutes(
    dynamicRoutes,
    url,
    pathnames,
    requestHeaders,
    new Headers(),
    [],
    trailingSlash,
    caseSensitive,
    basePath,
    buildId,
    shouldNormalizeNextData,
    isNextDataRequest,
    dynamicPrerenderRoutes
  ).matched || checkDynamicPathnameMatches(
    pathnames,
    url,
    requestHeaders,
    new Headers(),
    [],
    trailingSlash,
    caseSensitive,
    dynamicPrerenderRoutes
  ).matched
}

export async function resolveRoutes({
  url,
  buildId,
  basePath,
  nextConfig,
  trailingSlash,
  preferDynamicRoutes = false,
  requestBody,
  headers,
  pathnames,
  dynamicPrerenderRoutes = {},
  i18n,
  routes,
  middlewareMatchers,
  invokeMiddleware,
}) {
  const { shouldNormalizeNextData } = routes
  let requestUrl = new URL(url.toString())
  let requestHeaders = new Headers(headers)
  requestHeaders.delete('x-middleware-set-cookie')
  const resolvedHeaders = new Headers()
  let status
  const origin = url.origin
  let isNextDataRequest = false
  let pendingLocale = null
  let appliedPendingLocale = false
  const caseSensitive = !!nextConfig?.experimental?.caseSensitiveRoutes
  requestUrl.pathname = normalizeRepeatedSlashes(requestUrl.pathname)

  if (shouldNormalizeNextData) {
    const nextDataPrefix = `${basePath}/_next/data/${buildId}/`
    isNextDataRequest = url.pathname.startsWith(nextDataPrefix)

    if (isNextDataRequest) {
      requestUrl = normalizeNextDataUrl(requestUrl, basePath, buildId, trailingSlash)
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
      const directRouteMatch = hasDirectRouteMatch(
        requestUrl,
        pathnames,
        routes.dynamicRoutes,
        requestHeaders,
        trailingSlash,
        caseSensitive,
        basePath,
        buildId,
        shouldNormalizeNextData,
        isNextDataRequest,
        dynamicPrerenderRoutes
      )
      let locale = normalizedPath.detectedLocale || defaultLocale

      const shouldApplyPreferredLocaleDetection = pathname === '/'

      if (
        shouldApplyPreferredLocaleDetection &&
        i18n.localeDetection !== false &&
        !localeInPath
      ) {
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
        const shouldInjectLocalePrefix = !(locale === defaultLocale && directRouteMatch)

        if (shouldInjectLocalePrefix) {
          const localeToApply = locale || domainLocale?.defaultLocale || i18n.defaultLocale

          if (invokeMiddleware) {
            pendingLocale = localeToApply
          } else {
            requestUrl.pathname = `${basePath}/${localeToApply}${pathname}`
          }
        }
      }
    }
  }

  const beforeMiddlewareResult = processRoutes(
    routes.beforeMiddleware,
    requestUrl,
    requestHeaders,
    resolvedHeaders,
    origin,
    caseSensitive
  )

  if (beforeMiddlewareResult.status) {
    status = beforeMiddlewareResult.status
  }

  if (beforeMiddlewareResult.redirect) {
    const normalizedPathname =
      requestUrl.pathname !== '/' && requestUrl.pathname.endsWith('/')
        ? requestUrl.pathname.slice(0, -1)
        : null
    const canCollapseTrailingSlashRedirect =
      Boolean(normalizedPathname) &&
      requestUrl.search.length > 0 &&
      beforeMiddlewareResult.redirect.url.origin === requestUrl.origin &&
      beforeMiddlewareResult.redirect.url.pathname === normalizedPathname &&
      beforeMiddlewareResult.redirect.url.search === requestUrl.search &&
      matchesPathname(normalizedPathname, pathnames, trailingSlash, caseSensitive)

    if (canCollapseTrailingSlashRedirect) {
      requestUrl = new URL(beforeMiddlewareResult.redirect.url.toString())
      status = undefined
    } else {
      return {
        redirect: beforeMiddlewareResult.redirect,
        resolvedHeaders,
        status,
      }
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

  if (
    shouldInvokeMiddleware({
      url: requestUrl,
      headers: requestHeaders,
      matchers: middlewareMatchers,
      i18n,
      basePath,
      pendingLocale,
    })
  ) {
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
      const rewriteUrl = middlewareResult.rewrite
      pendingLocale = null

      if (rewriteUrl.origin !== origin) {
        return {
          externalRewrite: rewriteUrl,
          resolvedHeaders,
          status,
        }
      }

      requestUrl = applyRewriteUrl(requestUrl, rewriteUrl)
    }
  }

  if (isNextDataRequest && shouldNormalizeNextData) {
    requestUrl = normalizeNextDataUrl(requestUrl, basePath, buildId, trailingSlash)
  }

  const matchedPathHeader = requestHeaders.get('x-matched-path')

  if (matchedPathHeader && !requestHeaders.get('x-middleware-rewrite')) {
    try {
      const matchedUrl = new URL(getRelativeURL(matchedPathHeader, requestUrl.toString()), requestUrl)
      let matchedPathname = matchedUrl.pathname

      if (
        !isNextDataRequest &&
        i18n?.defaultLocale &&
        matchedPathname === `${basePath}/404` &&
        matchesPathname(
          `${basePath}/${i18n.defaultLocale}/404`,
          pathnames,
          trailingSlash,
          caseSensitive
        )
      ) {
        matchedPathname = `${basePath}/${i18n.defaultLocale}/404`
      }

      requestUrl.pathname = matchedPathname
      requestUrl.search = matchedUrl.search || requestUrl.search
      pendingLocale = null
    } catch {}
  }

  if (pendingLocale && i18n && !isNextDataRequest) {
    const pathname = requestUrl.pathname.startsWith(basePath)
      ? requestUrl.pathname.slice(basePath.length) || '/'
      : requestUrl.pathname
    const normalizedPath = normalizeLocalePath(pathname, i18n.locales)

    if (!normalizedPath.detectedLocale) {
      requestUrl.pathname = `${basePath}/${pendingLocale}${pathname}`
      appliedPendingLocale = true
    }
  }

  if (appliedPendingLocale) {
    const localizedBeforeMiddlewareResult = processRoutes(
      routes.beforeMiddleware,
      requestUrl,
      requestHeaders,
      resolvedHeaders,
      origin,
      caseSensitive
    )

    if (localizedBeforeMiddlewareResult.status) {
      status = localizedBeforeMiddlewareResult.status
    }

    if (localizedBeforeMiddlewareResult.redirect) {
      return {
        redirect: localizedBeforeMiddlewareResult.redirect,
        resolvedHeaders,
        status,
      }
    }

    if (localizedBeforeMiddlewareResult.externalRewrite) {
      return {
        externalRewrite: localizedBeforeMiddlewareResult.externalRewrite,
        resolvedHeaders,
        status,
      }
    }

    requestUrl = localizedBeforeMiddlewareResult.url
  }

  const beforeFilesResult = processRoutes(
    routes.beforeFiles,
    requestUrl,
    requestHeaders,
    resolvedHeaders,
    origin,
    caseSensitive
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
    requestUrl = denormalizeNextDataUrl(requestUrl, basePath, buildId, trailingSlash)
  }

  let resolvedPathname = matchesPathname(requestUrl.pathname, pathnames, trailingSlash, caseSensitive)

  if (resolvedPathname) {
    if (preferDynamicRoutes) {
      const dynamicCheck = checkDynamicRoutes(
        routes.dynamicRoutes,
        requestUrl,
        pathnames,
        requestHeaders,
        resolvedHeaders,
        routes.onMatch,
        trailingSlash,
        caseSensitive,
        basePath,
        buildId,
        shouldNormalizeNextData,
        isNextDataRequest,
        dynamicPrerenderRoutes
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

      const dynamicPathnameCheck = checkDynamicPathnameMatches(
        pathnames,
        requestUrl,
        requestHeaders,
        resolvedHeaders,
        routes.onMatch,
        trailingSlash,
        caseSensitive,
        dynamicPrerenderRoutes
      )

      if (dynamicPathnameCheck.matched && dynamicPathnameCheck.result) {
        return {
          ...dynamicPathnameCheck.result,
          status,
        }
      }
    }

    const responseHeaders = applyOnMatchHeaders(
      routes.onMatch,
      requestUrl,
      requestHeaders,
      resolvedHeaders,
      caseSensitive
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
    requestUrl = normalizeNextDataUrl(requestUrl, basePath, buildId, trailingSlash)
  }

  for (const route of routes.afterFiles) {
    const result = matchRoute(route, requestUrl, requestHeaders, caseSensitive)

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

    let filesystemUrl = requestUrl

    if (isNextDataRequest && shouldNormalizeNextData) {
      filesystemUrl = denormalizeNextDataUrl(requestUrl, basePath, buildId, trailingSlash)
    }

    resolvedPathname = matchesPathname(
      filesystemUrl.pathname,
      pathnames,
      trailingSlash,
      caseSensitive
    )

    if (resolvedPathname) {
      const responseHeaders = applyOnMatchHeaders(
        routes.onMatch,
        filesystemUrl,
        requestHeaders,
        resolvedHeaders,
        caseSensitive
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

    const dynamicCheck = checkDynamicRoutes(
      routes.dynamicRoutes,
      requestUrl,
      pathnames,
      requestHeaders,
      resolvedHeaders,
      routes.onMatch,
      trailingSlash,
      caseSensitive,
      basePath,
      buildId,
      shouldNormalizeNextData,
      isNextDataRequest,
      dynamicPrerenderRoutes
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

    const dynamicPathnameCheck = checkDynamicPathnameMatches(
      pathnames,
      requestUrl,
      requestHeaders,
      resolvedHeaders,
      routes.onMatch,
      trailingSlash,
      caseSensitive,
      dynamicPrerenderRoutes
    )

    if (dynamicPathnameCheck.matched && dynamicPathnameCheck.result) {
      return {
        ...dynamicPathnameCheck.result,
        status,
      }
    }
  }

  for (const route of routes.dynamicRoutes) {
    const dynamicMatch = matchDynamicRoute(
      requestUrl.pathname,
      route,
      trailingSlash,
      caseSensitive
    )

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
    let matchedConcretePathname = pathname
    let invocationPathname = requestUrl.pathname

    resolvedPathname = matchesPathname(pathname, pathnames, trailingSlash, caseSensitive)

    if (!resolvedPathname && buildId) {
      const normalizedNextDataPathname = normalizeNextDataUrl(
        new URL(`http://localhost${pathname}`),
        basePath,
        buildId,
        trailingSlash
      ).pathname

      if (normalizedNextDataPathname !== pathname) {
        resolvedPathname = matchesPathname(
          normalizedNextDataPathname,
          pathnames,
          trailingSlash,
          caseSensitive
        )

        if (resolvedPathname) {
          matchedConcretePathname = normalizedNextDataPathname
        }
      }
    }

    if (buildId) {
      const normalizedInvocationPathname = normalizeNextDataUrl(
        requestUrl,
        basePath,
        buildId,
        trailingSlash
      ).pathname

      if (normalizedInvocationPathname !== requestUrl.pathname) {
        invocationPathname = normalizedInvocationPathname
      }
    }

    if (!resolvedPathname) {
      continue
    }

    if (
      !canMatchDynamicPrerenderPath(
        dynamicPrerenderRoutes,
        resolvedPathname,
        matchedConcretePathname,
        caseSensitive
      )
    ) {
      continue
    }

    const destinationUrl = destination
      ? mergeDestinationQueryIntoUrl(requestUrl, destination)
      : requestUrl
    const responseHeaders = applyOnMatchHeaders(
      routes.onMatch,
      destinationUrl,
      requestHeaders,
      resolvedHeaders,
      caseSensitive
    )

    return withResolvedInvocationTarget({
      result: {
        routeMatches: dynamicMatch.params,
        resolvedHeaders: responseHeaders,
        status,
      },
      url: destinationUrl,
      resolvedPathname,
      invocationPathname,
    })
  }

  const dynamicPathnameCheck = checkDynamicPathnameMatches(
    pathnames,
    requestUrl,
    requestHeaders,
    resolvedHeaders,
    routes.onMatch,
    trailingSlash,
    caseSensitive,
    dynamicPrerenderRoutes
  )

  if (dynamicPathnameCheck.matched && dynamicPathnameCheck.result) {
    return {
      ...dynamicPathnameCheck.result,
      status,
    }
  }

  for (const route of routes.fallback) {
    const result = matchRoute(route, requestUrl, requestHeaders, caseSensitive)

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

    let filesystemUrl = requestUrl

    if (isNextDataRequest && shouldNormalizeNextData) {
      filesystemUrl = denormalizeNextDataUrl(requestUrl, basePath, buildId, trailingSlash)
    }

    resolvedPathname = matchesPathname(
      filesystemUrl.pathname,
      pathnames,
      trailingSlash,
      caseSensitive
    )

    if (resolvedPathname) {
      const responseHeaders = applyOnMatchHeaders(
        routes.onMatch,
        filesystemUrl,
        requestHeaders,
        resolvedHeaders,
        caseSensitive
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

    const dynamicCheck = checkDynamicRoutes(
      routes.dynamicRoutes,
      requestUrl,
      pathnames,
      requestHeaders,
      resolvedHeaders,
      routes.onMatch,
      trailingSlash,
      caseSensitive,
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

    const rewrittenDynamicPathnameCheck = checkDynamicPathnameMatches(
      pathnames,
      requestUrl,
      requestHeaders,
      resolvedHeaders,
      routes.onMatch,
      trailingSlash,
      caseSensitive,
      dynamicPrerenderRoutes
    )

    if (rewrittenDynamicPathnameCheck.matched && rewrittenDynamicPathnameCheck.result) {
      return {
        ...rewrittenDynamicPathnameCheck.result,
        status,
      }
    }
  }

  return {
    resolvedHeaders,
    resolvedRequestUrl: requestUrl,
    status,
  }
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function getRelativeURL(value, base) {
  try {
    const resolved = new URL(value, base)
    const baseUrl = new URL(base)
    const sameLoopbackOrigin =
      resolved.protocol === baseUrl.protocol &&
      resolved.port === baseUrl.port &&
      isLoopbackHostname(resolved.hostname) &&
      isLoopbackHostname(baseUrl.hostname)

    if (resolved.origin === baseUrl.origin || sameLoopbackOrigin) {
      return `${resolved.pathname}${resolved.search}${resolved.hash}`
    }

    return resolved.toString()
  } catch {
    return value
  }
}

function isRscRequest(url, headers) {
  return headers.get('rsc') === '1'
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
    !collectedHeaders.location &&
    !collectedHeaders['x-matched-path']
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
          if (key === 'set-cookie') {
            requestHeaders.append('x-middleware-set-cookie', item)
          }
        }
      } else {
        responseHeaders.set(key, value)
        requestHeaders.set(key, value)
        if (key === 'set-cookie') {
          requestHeaders.append('x-middleware-set-cookie', value)
        }
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

      if (isRscRequest(requestUrl, requestHeaders)) {
        if (requestUrl.pathname !== rewriteUrl.pathname) {
          responseHeaders.set('x-nextjs-rewritten-path', rewriteUrl.pathname)
        }

        if (requestUrl.search !== rewriteUrl.search) {
          responseHeaders.set('x-nextjs-rewritten-query', rewriteUrl.search.slice(1))
        }
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
