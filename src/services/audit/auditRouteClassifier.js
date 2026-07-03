const READ_ONLY_SUFFIXES = [
  '/models',
  '/usage',
  '/key-info',
  '/me',
  '/body-preview-stats',
  '/body-preview-purge'
]

const EXCLUDED_PREFIXES = [
  '/admin',
  '/admin-next',
  '/users',
  '/web',
  '/apiStats',
  '/apiStats/',
  '/health',
  '/metrics'
]

function normalizePath(value) {
  const raw = String(value || '/')
  const withoutQuery = raw.split('?')[0]
  const collapsed = withoutQuery.replace(/\/{2,}/g, '/')
  const normalized = collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed
  return normalized.toLowerCase() || '/'
}

function getRequestPath(req = {}) {
  return normalizePath(req.originalUrl || `${req.baseUrl || ''}${req.path || req.url || ''}`)
}

function hasReadOnlySuffix(pathname) {
  if (READ_ONLY_SUFFIXES.some((suffix) => pathname === suffix || pathname.endsWith(suffix))) {
    return true
  }

  return /\/organizations\/[^/]+\/usage$/.test(pathname)
}

function isTokenCountPath(pathname) {
  return pathname.endsWith('/v1/messages/count_tokens') || pathname.endsWith('/messages/count_tokens')
}

function classifyAuditProtocol(req = {}) {
  const pathname = getRequestPath(req)

  if (pathname.startsWith('/azure/')) {
    return 'azure-openai'
  }
  if (pathname.startsWith('/droid/')) {
    return 'droid'
  }
  if (pathname.startsWith('/antigravity/')) {
    return 'antigravity'
  }
  if (pathname.startsWith('/gemini-cli/')) {
    return 'gemini-cli'
  }
  if (pathname.startsWith('/gemini/') || pathname.startsWith('/openai/gemini/')) {
    return 'gemini'
  }
  if (pathname.startsWith('/openai/claude/')) {
    return 'openai-claude'
  }
  if (pathname.startsWith('/openai/')) {
    return 'openai'
  }
  if (pathname.startsWith('/api/') || pathname.startsWith('/claude/')) {
    return 'anthropic'
  }

  return 'unknown'
}

function isAuditEligibleRequest(req = {}) {
  if (String(req.method || '').toUpperCase() !== 'POST') {
    return false
  }

  const pathname = getRequestPath(req)
  if (EXCLUDED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix))) {
    return false
  }
  if (hasReadOnlySuffix(pathname) || isTokenCountPath(pathname)) {
    return false
  }

  return (
    pathname.includes('/v1/messages') ||
    pathname.includes('/v1/chat/completions') ||
    pathname.includes('/v1/completions') ||
    pathname.endsWith('/responses') ||
    pathname.endsWith('/v1/responses') ||
    pathname.endsWith('/chat/completions') ||
    pathname.endsWith('/embeddings') ||
    pathname.includes(':generatecontent') ||
    pathname.includes(':streamgeneratecontent')
  )
}

module.exports = {
  classifyAuditProtocol,
  getRequestPath,
  isAuditEligibleRequest
}
