const fs = require('fs/promises')
const os = require('os')
const path = require('path')

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn()
}))

const { AuditWorkerService } = require('../src/services/audit/auditWorkerService')

describe('AuditWorkerService', () => {
  let tempDir

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-worker-test-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('uploads artifacts, upserts metadata, and removes processed spool files', async () => {
    const spoolPath = path.join(tempDir, 'client_request.json')
    const eventSpoolPath = path.join(tempDir, 'req_1-event.json')
    await fs.writeFile(spoolPath, JSON.stringify({ body: { prompt: 'hello' } }))
    await fs.writeFile(eventSpoolPath, JSON.stringify({ requestId: 'req_1' }))

    const repository = {
      ensureSchema: jest.fn().mockResolvedValue(),
      upsertCall: jest.fn().mockResolvedValue(),
      replaceArtifacts: jest.fn().mockResolvedValue(),
      updateCaptureStatus: jest.fn().mockResolvedValue()
    }
    const objectStorage = {
      uploadArtifact: jest.fn().mockResolvedValue({
        bucket: 'audit',
        objectKey:
          'ai-call-audit/dt=2026-07-03/api_key=key_1/request_id=req_1/client_request.json.gz',
        bytes: 42,
        sha256: 'a'.repeat(64),
        contentType: 'application/json'
      })
    }
    const eventPublisher = {
      publishRetryEvent: jest.fn(),
      publishDeadLetterEvent: jest.fn()
    }
    const worker = new AuditWorkerService({ repository, objectStorage, eventPublisher })

    const result = await worker.processCaptureEvent({
      requestId: 'req_1',
      createdAt: '2026-07-03T12:00:00.000Z',
      apiKeyId: 'key_1',
      endpoint: '/api/v1/messages',
      protocol: 'anthropic',
      artifacts: [{ kind: 'client_request', spoolPath }],
      eventSpoolPath,
      attempt: 0
    })

    expect(result.processed).toBe(true)
    expect(objectStorage.uploadArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'client_request',
        spoolPath
      }),
      expect.objectContaining({
        requestId: 'req_1',
        apiKeyId: 'key_1'
      })
    )
    expect(repository.upsertCall).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req_1',
        captureStatus: 'stored'
      })
    )
    expect(repository.replaceArtifacts).toHaveBeenCalledWith('req_1', [
      expect.objectContaining({
        kind: 'client_request',
        objectKey: expect.stringContaining('/client_request.json.gz')
      })
    ])
    await expect(fs.stat(spoolPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(eventSpoolPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('publishes retry events and keeps spool files when processing fails', async () => {
    const spoolPath = path.join(tempDir, 'response.json')
    await fs.writeFile(spoolPath, JSON.stringify({ body: 'partial response' }))

    const repository = {
      ensureSchema: jest.fn().mockResolvedValue(),
      updateCaptureStatus: jest.fn().mockResolvedValue()
    }
    const objectStorage = {
      uploadArtifact: jest.fn().mockRejectedValue(new Error('minio unavailable'))
    }
    const eventPublisher = {
      publishRetryEvent: jest.fn().mockResolvedValue('2-0'),
      publishDeadLetterEvent: jest.fn()
    }
    const worker = new AuditWorkerService({
      repository,
      objectStorage,
      eventPublisher,
      maxAttempts: 3
    })

    const result = await worker.processCaptureEvent({
      requestId: 'req_retry',
      createdAt: '2026-07-03T12:00:00.000Z',
      apiKeyId: 'key_1',
      artifacts: [{ kind: 'response', spoolPath }],
      attempt: 1
    })

    expect(result.processed).toBe(false)
    expect(result.retry).toBe(true)
    expect(eventPublisher.publishRetryEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req_retry',
        attempt: 2,
        lastError: 'minio unavailable'
      })
    )
    await expect(fs.stat(spoolPath)).resolves.toBeTruthy()
  })
})
