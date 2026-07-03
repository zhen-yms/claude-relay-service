const fs = require('fs/promises')
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const { buildAuditObjectKey, gzipJsonPayload, sha256Hex } = require('./auditArtifactHelper')
const { getAuditConfig } = require('./auditConfig')

class AuditObjectStorage {
  constructor(options = {}) {
    this.configProvider = options.configProvider || getAuditConfig
    this.client = options.client || null
  }

  getClient(config) {
    if (this.client) {
      return this.client
    }

    this.client = new S3Client({
      endpoint: config.minioEndpoint,
      region: config.minioRegion,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.minioAccessKey,
        secretAccessKey: config.minioSecretKey
      }
    })
    return this.client
  }

  async uploadArtifact(artifact, call = {}) {
    const config = this.configProvider()
    const raw = await fs.readFile(artifact.spoolPath, 'utf8')
    const payload = JSON.parse(raw)
    const body = gzipJsonPayload(payload)
    const objectKey = buildAuditObjectKey({
      prefix: config.objectKeyPrefix,
      createdAt: call.createdAt,
      apiKeyId: call.apiKeyId,
      requestId: call.requestId,
      kind: artifact.kind
    })

    await this.getClient(config).send(
      new PutObjectCommand({
        Bucket: config.minioBucket,
        Key: objectKey,
        Body: body,
        ContentType: 'application/json',
        ContentEncoding: 'gzip',
        Metadata: {
          request_id: String(call.requestId || ''),
          artifact_kind: String(artifact.kind || '')
        }
      })
    )

    return {
      kind: artifact.kind,
      bucket: config.minioBucket,
      objectKey,
      bytes: body.length,
      sha256: sha256Hex(body),
      contentType: 'application/json',
      createdAt: new Date().toISOString()
    }
  }
}

module.exports = new AuditObjectStorage()
module.exports.AuditObjectStorage = AuditObjectStorage
