const { AuditRepository } = require('../src/services/audit/auditRepository')

describe('AuditRepository', () => {
  test('persists user username snapshots with audit calls', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [] })
    }
    const repository = new AuditRepository({
      pool,
      configProvider: () => ({ postgresUrl: 'postgres://unused' })
    })

    await repository.upsertCall({
      requestId: 'req_1',
      createdAt: '2026-07-03T12:00:00.000Z',
      requestStartedAt: '2026-07-03T11:59:59.000Z',
      retentionUntil: '2026-12-30T12:00:00.000Z',
      endpoint: '/api/v1/messages',
      method: 'POST',
      protocol: 'anthropic',
      apiKeyId: 'key_1',
      apiKeyName: 'Shared Key',
      userId: 'user_1',
      userUsername: 'alice',
      captureStatus: 'stored'
    })

    const insertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO audit_calls'))
    expect(insertCall).toBeTruthy()
    expect(insertCall[0]).toContain('user_username')
    expect(insertCall[1]).toContain('alice')
  })
})
