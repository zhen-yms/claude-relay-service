const zlib = require('zlib')

const {
  buildAuditObjectKey,
  gzipJsonPayload,
  sha256Hex
} = require('../src/services/audit/auditArtifactHelper')

describe('auditArtifactHelper', () => {
  test('builds deterministic MinIO object keys for audit artifacts', () => {
    const key = buildAuditObjectKey({
      prefix: 'ai-call-audit',
      createdAt: '2026-07-03T12:34:56.000Z',
      apiKeyId: 'key/with spaces',
      requestId: 'req_123',
      kind: 'client_request'
    })

    expect(key).toBe(
      'ai-call-audit/dt=2026-07-03/api_key=key%2Fwith%20spaces/request_id=req_123/client_request.json.gz'
    )
  })

  test('gzips JSON payloads and returns matching sha256 hashes', () => {
    const payload = {
      requestId: 'req_123',
      body: {
        messages: [{ role: 'user', content: 'hello' }]
      }
    }

    const compressed = gzipJsonPayload(payload)
    const decompressed = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'))

    expect(decompressed).toEqual(payload)
    expect(sha256Hex(compressed)).toMatch(/^[a-f0-9]{64}$/)
  })
})
