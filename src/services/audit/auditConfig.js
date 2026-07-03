const path = require('path')

let appConfig = {}
try {
  appConfig = require('../../../config/config')
} catch (error) {
  appConfig = {}
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback
  }
  if (typeof value === 'boolean') {
    return value
  }
  const normalized = String(value).trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes'
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function getAuditConfig() {
  const configured = appConfig.audit || {}
  const retentionDays = Math.max(
    1,
    parseInteger(process.env.AUDIT_RETENTION_DAYS, configured.retentionDays || 180)
  )

  return {
    enabled: parseBoolean(process.env.AUDIT_CAPTURE_ENABLED, configured.enabled === true),
    retentionDays,
    failurePolicy: process.env.AUDIT_FAILURE_POLICY || configured.failurePolicy || 'nonblocking',
    postgresUrl: process.env.AUDIT_POSTGRES_URL || configured.postgresUrl || '',
    minioEndpoint: process.env.AUDIT_MINIO_ENDPOINT || configured.minioEndpoint || '',
    minioBucket: process.env.AUDIT_MINIO_BUCKET || configured.minioBucket || 'ai-call-audit',
    minioAccessKey: process.env.AUDIT_MINIO_ACCESS_KEY || configured.minioAccessKey || '',
    minioSecretKey: process.env.AUDIT_MINIO_SECRET_KEY || configured.minioSecretKey || '',
    minioRegion: process.env.AUDIT_MINIO_REGION || configured.minioRegion || 'us-east-1',
    objectKeyPrefix:
      process.env.AUDIT_OBJECT_KEY_PREFIX || configured.objectKeyPrefix || 'ai-call-audit',
    spoolDir:
      process.env.AUDIT_SPOOL_DIR ||
      configured.spoolDir ||
      path.join(process.cwd(), 'data', 'audit-spool'),
    streamKey: process.env.AUDIT_STREAM_KEY || configured.streamKey || 'audit:events',
    retryStreamKey:
      process.env.AUDIT_RETRY_STREAM_KEY || configured.retryStreamKey || 'audit:events:retry',
    deadLetterStreamKey:
      process.env.AUDIT_DEAD_LETTER_STREAM_KEY ||
      configured.deadLetterStreamKey ||
      'audit:events:dead-letter',
    streamMaxLength: Math.max(
      1000,
      parseInteger(process.env.AUDIT_STREAM_MAX_LENGTH, configured.streamMaxLength || 100000)
    ),
    workerEnabled: parseBoolean(
      process.env.AUDIT_WORKER_ENABLED,
      configured.workerEnabled !== false
    ),
    workerGroup: process.env.AUDIT_WORKER_GROUP || configured.workerGroup || 'audit-workers',
    workerConsumer:
      process.env.AUDIT_WORKER_CONSUMER || configured.workerConsumer || `worker-${process.pid}`,
    workerBlockMs: Math.max(
      100,
      parseInteger(process.env.AUDIT_WORKER_BLOCK_MS, configured.workerBlockMs || 5000)
    ),
    maxAttempts: Math.max(
      1,
      parseInteger(process.env.AUDIT_MAX_ATTEMPTS, configured.maxAttempts || 5)
    )
  }
}

module.exports = {
  getAuditConfig
}
