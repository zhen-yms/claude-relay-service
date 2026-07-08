const EventEmitter = require('events')
const fs = require('fs/promises')
const os = require('os')
const path = require('path')

const mockSpoolDir = path.join(os.tmpdir(), 'audit-capture-service-test')

jest.mock(
  '../config/config',
  () => ({
    audit: {
      enabled: true,
      retentionDays: 180,
      failurePolicy: 'nonblocking',
      spoolDir: mockSpoolDir,
      streamKey: 'audit:events',
      streamMaxLength: 1000
    }
  }),
  { virtual: true }
)

jest.mock('../src/services/audit/auditEventPublisher', () => ({
  publishCaptureEvent: jest.fn().mockResolvedValue('1-0')
}))

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  info: jest.fn()
}))

const auditEventPublisher = require('../src/services/audit/auditEventPublisher')
const auditCaptureService = require('../src/services/audit/auditCaptureService')

function createReq() {
  return {
    method: 'POST',
    originalUrl: '/api/v1/messages',
    path: '/v1/messages',
    requestId: 'req_capture_test',
    requestStartedAt: Date.parse('2026-07-03T12:00:00.000Z'),
    headers: {
      authorization: 'Bearer cr_secret',
      'content-type': 'application/json',
      'user-agent': 'test-client/1.0'
    },
    body: {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'company prompt' }]
    },
    apiKey: {
      id: 'key_1',
      name: 'Shared Key',
      userId: 'user_1',
      userUsername: 'alice'
    }
  }
}

function createRes() {
  const res = new EventEmitter()
  res.statusCode = 200
  res.headers = {}
  res.headersSent = false
  res.writableEnded = false
  res.setHeader = jest.fn((key, value) => {
    res.headers[key.toLowerCase()] = value
  })
  res.getHeader = jest.fn((key) => res.headers[String(key).toLowerCase()])
  res.getHeaders = jest.fn(() => res.headers)
  res.json = jest.fn((payload) => {
    res.payload = payload
    res.emit('finish')
    return res
  })
  res.send = jest.fn((payload) => {
    res.payload = payload
    res.emit('finish')
    return res
  })
  res.write = jest.fn(() => true)
  res.end = jest.fn((payload) => {
    if (payload !== undefined) {
      res.payload = payload
    }
    res.writableEnded = true
    res.emit('finish')
    return res
  })
  return res
}

describe('auditCaptureService', () => {
  beforeEach(async () => {
    jest.clearAllMocks()
    await fs.rm(path.join(os.tmpdir(), 'audit-capture-service-test'), {
      recursive: true,
      force: true
    })
  })

  test('captures client request and response without changing res.json behavior', async () => {
    const req = createReq()
    const res = createRes()

    const context = auditCaptureService.start(req, res)
    expect(context).toBeTruthy()

    const payload = { id: 'msg_1', content: [{ type: 'text', text: 'answer' }] }
    const returnValue = res.json(payload)
    await auditCaptureService.finish(req, res)

    expect(returnValue).toBe(res)
    expect(res.payload).toEqual(payload)
    expect(auditEventPublisher.publishCaptureEvent).toHaveBeenCalledTimes(1)

    const event = auditEventPublisher.publishCaptureEvent.mock.calls[0][0]
    expect(event.requestId).toBe('req_capture_test')
    expect(event.userId).toBe('user_1')
    expect(event.userUsername).toBe('alice')
    expect(event.retentionUntil).toBe('2026-12-30T12:00:00.000Z')
    expect(event.eventSpoolPath).toEqual(expect.stringContaining('req_capture_test-event.json'))
    expect(event.artifacts.map((artifact) => artifact.kind).sort()).toEqual([
      'client_request',
      'response'
    ])

    const eventManifest = JSON.parse(await fs.readFile(event.eventSpoolPath, 'utf8'))
    expect(eventManifest.requestId).toBe('req_capture_test')
    expect(eventManifest.userUsername).toBe('alice')

    const clientArtifact = event.artifacts.find((artifact) => artifact.kind === 'client_request')
    const responseArtifact = event.artifacts.find((artifact) => artifact.kind === 'response')
    const clientPayload = JSON.parse(await fs.readFile(clientArtifact.spoolPath, 'utf8'))
    const responsePayload = JSON.parse(await fs.readFile(responseArtifact.spoolPath, 'utf8'))

    expect(clientPayload.body.messages[0].content).toBe('company prompt')
    expect(clientPayload.headers.authorization).toBe('[REDACTED]')
    expect(responsePayload.body).toEqual(payload)
  })
})
