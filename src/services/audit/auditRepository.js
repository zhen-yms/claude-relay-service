const { Pool } = require('pg')
const { getAuditConfig } = require('./auditConfig')

class AuditRepository {
  constructor(options = {}) {
    this.configProvider = options.configProvider || getAuditConfig
    this.pool = options.pool || null
    this.schemaReady = false
  }

  getPool() {
    if (this.pool) {
      return this.pool
    }

    const config = this.configProvider()
    if (!config.postgresUrl) {
      throw new Error('AUDIT_POSTGRES_URL is required when audit worker is enabled')
    }

    this.pool = new Pool({ connectionString: config.postgresUrl })
    return this.pool
  }

  async query(sql, params = []) {
    return this.getPool().query(sql, params)
  }

  getMonthBoundary(date = new Date()) {
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
    const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
    return { start, end }
  }

  async ensureSchema(referenceDate = new Date()) {
    if (this.schemaReady) {
      return
    }

    await this.query(`
      CREATE TABLE IF NOT EXISTS audit_calls (
        request_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        request_started_at TIMESTAMPTZ NULL,
        endpoint TEXT NULL,
        method TEXT NULL,
        protocol TEXT NULL,
        api_key_id TEXT NULL,
        api_key_name TEXT NULL,
        user_id TEXT NULL,
        user_username TEXT NULL,
        account_id TEXT NULL,
        account_type TEXT NULL,
        model TEXT NULL,
        status TEXT NULL,
        status_code INTEGER NULL,
        stream BOOLEAN NOT NULL DEFAULT FALSE,
        input_tokens BIGINT NOT NULL DEFAULT 0,
        output_tokens BIGINT NOT NULL DEFAULT 0,
        cache_read_tokens BIGINT NOT NULL DEFAULT 0,
        cache_create_tokens BIGINT NOT NULL DEFAULT 0,
        total_tokens BIGINT NOT NULL DEFAULT 0,
        cost NUMERIC(20, 10) NOT NULL DEFAULT 0,
        real_cost NUMERIC(20, 10) NOT NULL DEFAULT 0,
        retention_until TIMESTAMPTZ NOT NULL,
        capture_status TEXT NOT NULL,
        error TEXT NULL,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (request_id, created_at)
      ) PARTITION BY RANGE (created_at)
    `)

    await this.query(`
      ALTER TABLE IF EXISTS audit_calls
      ADD COLUMN IF NOT EXISTS user_username TEXT NULL
    `)

    await this.query(`
      CREATE TABLE IF NOT EXISTS audit_artifacts (
        id BIGSERIAL PRIMARY KEY,
        call_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        bucket TEXT NOT NULL,
        object_key TEXT NOT NULL,
        bytes BIGINT NOT NULL,
        sha256 TEXT NOT NULL,
        content_type TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

    await this.ensureMonthlyPartition(referenceDate)
    this.schemaReady = true
  }

  async ensureMonthlyPartition(date = new Date()) {
    const { start, end } = this.getMonthBoundary(date)
    const suffix = `${start.getUTCFullYear()}_${String(start.getUTCMonth() + 1).padStart(2, '0')}`
    const startLiteral = start.toISOString().replace(/'/g, "''")
    const endLiteral = end.toISOString().replace(/'/g, "''")
    await this.query(`
      CREATE TABLE IF NOT EXISTS audit_calls_${suffix}
      PARTITION OF audit_calls
      FOR VALUES FROM ('${startLiteral}') TO ('${endLiteral}')
    `)
  }

  async upsertCall(call = {}) {
    await this.ensureSchema(new Date(call.createdAt || Date.now()))
    await this.query(
      `
        INSERT INTO audit_calls (
          request_id, created_at, request_started_at, endpoint, method, protocol,
          api_key_id, api_key_name, user_id, user_username, account_id, account_type, model,
          status, status_code, stream, input_tokens, output_tokens, cache_read_tokens,
          cache_create_tokens, total_tokens, cost, real_cost, retention_until,
          capture_status, error, meta, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17, $18,
          $19, $20, $21, $22, $23, $24,
          $25, $26, $27::jsonb, now()
        )
        ON CONFLICT (request_id, created_at) DO UPDATE SET
          request_started_at = EXCLUDED.request_started_at,
          endpoint = EXCLUDED.endpoint,
          method = EXCLUDED.method,
          protocol = EXCLUDED.protocol,
          api_key_id = EXCLUDED.api_key_id,
          api_key_name = EXCLUDED.api_key_name,
          user_id = COALESCE(EXCLUDED.user_id, audit_calls.user_id),
          user_username = COALESCE(EXCLUDED.user_username, audit_calls.user_username),
          account_id = COALESCE(EXCLUDED.account_id, audit_calls.account_id),
          account_type = COALESCE(EXCLUDED.account_type, audit_calls.account_type),
          model = COALESCE(EXCLUDED.model, audit_calls.model),
          status = EXCLUDED.status,
          status_code = EXCLUDED.status_code,
          stream = EXCLUDED.stream,
          input_tokens = EXCLUDED.input_tokens,
          output_tokens = EXCLUDED.output_tokens,
          cache_read_tokens = EXCLUDED.cache_read_tokens,
          cache_create_tokens = EXCLUDED.cache_create_tokens,
          total_tokens = EXCLUDED.total_tokens,
          cost = EXCLUDED.cost,
          real_cost = EXCLUDED.real_cost,
          retention_until = EXCLUDED.retention_until,
          capture_status = EXCLUDED.capture_status,
          error = EXCLUDED.error,
          meta = audit_calls.meta || EXCLUDED.meta,
          updated_at = now()
      `,
      [
        call.requestId,
        call.createdAt,
        call.requestStartedAt || null,
        call.endpoint || null,
        call.method || null,
        call.protocol || null,
        call.apiKeyId || null,
        call.apiKeyName || null,
        call.userId || null,
        call.userUsername || null,
        call.accountId || null,
        call.accountType || null,
        call.model || null,
        call.status || null,
        call.statusCode || null,
        call.stream === true,
        call.inputTokens || 0,
        call.outputTokens || 0,
        call.cacheReadTokens || 0,
        call.cacheCreateTokens || 0,
        call.totalTokens || 0,
        call.cost || 0,
        call.realCost || 0,
        call.retentionUntil,
        call.captureStatus || 'pending',
        call.error || null,
        JSON.stringify(call.meta || {})
      ]
    )
  }

  async replaceArtifacts(requestId, artifacts = []) {
    await this.query('DELETE FROM audit_artifacts WHERE request_id = $1', [requestId])
    for (const artifact of artifacts) {
      await this.query(
        `
          INSERT INTO audit_artifacts (
            call_id, request_id, kind, bucket, object_key, bytes, sha256, content_type, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          requestId,
          requestId,
          artifact.kind,
          artifact.bucket,
          artifact.objectKey,
          artifact.bytes,
          artifact.sha256,
          artifact.contentType,
          artifact.createdAt || new Date().toISOString()
        ]
      )
    }
  }

  async updateCaptureStatus(requestId, status, error = null) {
    await this.query(
      `
        UPDATE audit_calls
        SET capture_status = $2, error = $3, updated_at = now()
        WHERE request_id = $1
      `,
      [requestId, status, error]
    )
  }

  async updateUsage(requestId, usage = {}) {
    await this.query(
      `
        UPDATE audit_calls
        SET
          account_id = COALESCE($2, account_id),
          account_type = COALESCE($3, account_type),
          model = COALESCE($4, model),
          input_tokens = $5,
          output_tokens = $6,
          cache_read_tokens = $7,
          cache_create_tokens = $8,
          total_tokens = $9,
          cost = $10,
          real_cost = $11,
          updated_at = now()
        WHERE request_id = $1
      `,
      [
        requestId,
        usage.accountId || null,
        usage.accountType || null,
        usage.model || null,
        usage.inputTokens || 0,
        usage.outputTokens || 0,
        usage.cacheReadTokens || 0,
        usage.cacheCreateTokens || 0,
        usage.totalTokens || 0,
        usage.cost || 0,
        usage.realCost || 0
      ]
    )
  }
}

module.exports = new AuditRepository()
module.exports.AuditRepository = AuditRepository
