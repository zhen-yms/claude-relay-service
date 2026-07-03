const EventEmitter = require('events')

jest.mock(
  '../config/config',
  () => ({
    security: {
      apiKeyPrefix: 'cr_'
    },
    userMessageQueue: {
      enabled: false
    },
    concurrency: {
      leaseSeconds: 300,
      renewIntervalSeconds: 0,
      cleanupGraceSeconds: 30
    }
  }),
  { virtual: true }
)

jest.mock('../src/services/apiKeyService', () => ({
  validateApiKey: jest.fn()
}))

jest.mock('../src/services/userService', () => ({}))
jest.mock('../src/models/redis', () => ({
  getClient: jest.fn(() => ({
    get: jest.fn(),
    set: jest.fn(),
    incr: jest.fn()
  })),
  getNextResetTime: jest.fn(() => new Date('2026-07-06T00:00:00.000Z'))
}))
jest.mock('../src/validators/clientValidator', () => ({
  validateRequest: jest.fn(() => ({ allowed: true, clientName: 'test', matchedClient: 'test' }))
}))
jest.mock('../src/validators/clients/claudeCodeValidator', () => ({
  validate: jest.fn(() => true)
}))
jest.mock('../src/services/claudeRelayConfigService', () => ({
  isClaudeCodeOnlyEnabled: jest.fn().mockResolvedValue(false),
  getConfig: jest.fn().mockResolvedValue({})
}))
jest.mock('../src/utils/statsHelper', () => ({
  calculateWaitTimeStats: jest.fn(() => ({ sampleCount: 0 }))
}))
jest.mock('../src/utils/modelHelper', () => ({
  isClaudeFamilyModel: jest.fn(() => false)
}))
jest.mock('../src/services/audit/auditCaptureService', () => ({
  start: jest.fn()
}))
jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  security: jest.fn(),
  debug: jest.fn(),
  performance: jest.fn()
}))

const apiKeyService = require('../src/services/apiKeyService')
const auditCaptureService = require('../src/services/audit/auditCaptureService')
const { authenticateApiKey } = require('../src/middleware/auth')

function createRes() {
  const res = new EventEmitter()
  res.setHeader = jest.fn()
  res.set = jest.fn(() => res)
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res
}

describe('authenticateApiKey audit integration', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    apiKeyService.validateApiKey.mockResolvedValue({
      valid: true,
      keyData: {
        id: 'key_1',
        name: 'Shared AI Key',
        tokenLimit: 0,
        concurrencyLimit: 0,
        rateLimitWindow: 0,
        rateLimitRequests: 0,
        rateLimitCost: 0,
        dailyCostLimit: 0,
        totalCostLimit: 0,
        weeklyOpusCostLimit: 0,
        permissions: ['claude'],
        enableModelRestriction: false,
        restrictedModels: [],
        enableClientRestriction: false,
        allowedClients: []
      }
    })
  })

  test('starts audit capture after successful API key authentication', async () => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.originalUrl = '/api/v1/messages'
    req.path = '/v1/messages'
    req.headers = {
      authorization: 'Bearer cr_valid_key',
      'user-agent': 'test-client/1.0'
    }
    req.query = {}
    req.body = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }]
    }
    const res = createRes()
    const next = jest.fn()

    await authenticateApiKey(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(req.apiKey.id).toBe('key_1')
    expect(auditCaptureService.start).toHaveBeenCalledWith(req, res)
  })
})
