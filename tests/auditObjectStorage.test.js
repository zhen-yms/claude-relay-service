const fs = require('fs/promises')
const os = require('os')
const path = require('path')

const { AuditObjectStorage } = require('../src/services/audit/auditObjectStorage')

describe('AuditObjectStorage', () => {
  let tempDir

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-object-storage-test-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('uses S3 metadata header names that survive nginx proxying', async () => {
    const spoolPath = path.join(tempDir, 'client_request.json')
    await fs.writeFile(spoolPath, JSON.stringify({ body: { prompt: 'hello' } }))

    const client = {
      send: jest.fn().mockResolvedValue({})
    }
    const storage = new AuditObjectStorage({
      client,
      configProvider: () => ({
        minioBucket: 'audit',
        objectKeyPrefix: 'ai-call-audit'
      })
    })

    await storage.uploadArtifact(
      { kind: 'client_request', spoolPath },
      {
        requestId: 'req_1',
        apiKeyId: 'key_1',
        createdAt: '2026-07-03T12:00:00.000Z'
      }
    )

    const command = client.send.mock.calls[0][0]
    expect(command.input.Metadata).toEqual({
      'request-id': 'req_1',
      'artifact-kind': 'client_request'
    })
    expect(Object.keys(command.input.Metadata)).toEqual(
      expect.not.arrayContaining(['request_id', 'artifact_kind'])
    )
  })
})
