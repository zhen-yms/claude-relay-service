const {
  isAuditEligibleRequest,
  classifyAuditProtocol
} = require('../src/services/audit/auditRouteClassifier')

describe('auditRouteClassifier', () => {
  test('captures authenticated AI POST endpoints across supported protocol families', () => {
    const eligibleRequests = [
      { method: 'POST', originalUrl: '/api/v1/messages', path: '/v1/messages' },
      { method: 'POST', originalUrl: '/claude/v1/messages', path: '/v1/messages' },
      { method: 'POST', originalUrl: '/openai/v1/responses', path: '/v1/responses' },
      { method: 'POST', originalUrl: '/openai/v1/chat/completions', path: '/v1/chat/completions' },
      { method: 'POST', originalUrl: '/azure/chat/completions', path: '/chat/completions' },
      {
        method: 'POST',
        originalUrl: '/gemini/v1beta/models/gemini-2.5-pro:streamGenerateContent',
        path: '/v1beta/models/gemini-2.5-pro:streamGenerateContent'
      },
      { method: 'POST', originalUrl: '/droid/claude/v1/messages', path: '/claude/v1/messages' },
      { method: 'POST', originalUrl: '/antigravity/api/v1/messages', path: '/v1/messages' }
    ]

    for (const req of eligibleRequests) {
      expect(isAuditEligibleRequest(req)).toBe(true)
      expect(classifyAuditProtocol(req)).not.toBe('unknown')
    }
  })

  test('excludes read-only and administrative routes', () => {
    const excludedRequests = [
      { method: 'GET', originalUrl: '/api/v1/models', path: '/v1/models' },
      { method: 'GET', originalUrl: '/openai/usage', path: '/usage' },
      { method: 'GET', originalUrl: '/openai/key-info', path: '/key-info' },
      {
        method: 'POST',
        originalUrl: '/api/v1/messages/count_tokens',
        path: '/v1/messages/count_tokens'
      },
      { method: 'POST', originalUrl: '/admin/request-details', path: '/request-details' },
      { method: 'POST', originalUrl: '/users/login', path: '/login' }
    ]

    for (const req of excludedRequests) {
      expect(isAuditEligibleRequest(req)).toBe(false)
    }
  })
})
