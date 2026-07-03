const fs = require('fs/promises')
const logger = require('../../utils/logger')
const redis = require('../../models/redis')
const { getAuditConfig } = require('./auditConfig')
const auditRepository = require('./auditRepository')
const auditObjectStorage = require('./auditObjectStorage')
const auditEventPublisher = require('./auditEventPublisher')

function parseStreamEntry(entry) {
  const [messageId, fields] = entry
  const dataIndex = fields.findIndex((field) => field === 'data')
  if (dataIndex < 0 || dataIndex + 1 >= fields.length) {
    return { messageId, event: null }
  }

  try {
    return { messageId, event: JSON.parse(fields[dataIndex + 1]) }
  } catch (error) {
    return { messageId, event: null }
  }
}

class AuditWorkerService {
  constructor(options = {}) {
    this.repository = options.repository || auditRepository
    this.objectStorage = options.objectStorage || auditObjectStorage
    this.eventPublisher = options.eventPublisher || auditEventPublisher
    this.configProvider = options.configProvider || getAuditConfig
    this.maxAttempts = options.maxAttempts || this.configProvider().maxAttempts
    this.running = false
    this.loopPromise = null
  }

  async findEventManifestPaths(rootDir) {
    const results = []
    let entries
    try {
      entries = await fs.readdir(rootDir, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') {
        return results
      }
      throw error
    }

    for (const entry of entries) {
      const fullPath = `${rootDir}/${entry.name}`
      if (entry.isDirectory()) {
        results.push(...(await this.findEventManifestPaths(fullPath)))
      } else if (entry.isFile() && entry.name.endsWith('-event.json')) {
        results.push(fullPath)
      }
    }

    return results
  }

  async replaySpoolEvents() {
    const config = this.configProvider()
    const eventPaths = await this.findEventManifestPaths(config.spoolDir)
    let processed = 0

    for (const eventSpoolPath of eventPaths) {
      try {
        const raw = await fs.readFile(eventSpoolPath, 'utf8')
        const event = JSON.parse(raw)
        const result = await this.processCaptureEvent({
          ...event,
          eventSpoolPath: event.eventSpoolPath || eventSpoolPath
        })
        if (result.processed) {
          processed += 1
        }
      } catch (error) {
        logger.warn(`⚠️ Failed to replay audit spool event ${eventSpoolPath}: ${error.message}`)
      }
    }

    return { processed }
  }

  async processCaptureEvent(event = {}) {
    try {
      await this.repository.ensureSchema(new Date(event.createdAt || Date.now()))

      const uploadedArtifacts = []
      for (const artifact of event.artifacts || []) {
        const uploaded = await this.objectStorage.uploadArtifact(artifact, event)
        uploadedArtifacts.push({
          kind: artifact.kind,
          ...uploaded
        })
      }

      await this.repository.upsertCall({
        ...event,
        captureStatus: 'stored',
        error: null
      })
      await this.repository.replaceArtifacts(event.requestId, uploadedArtifacts)

      await Promise.all(
        (event.artifacts || []).map((artifact) => fs.rm(artifact.spoolPath, { force: true }))
      )
      if (event.eventSpoolPath) {
        await fs.rm(event.eventSpoolPath, { force: true })
      }

      return { processed: true }
    } catch (error) {
      const attempt = Number(event.attempt || 0) + 1
      const errorMessage = error?.message || String(error)
      await this.repository
        .updateCaptureStatus(event.requestId, 'retrying', errorMessage)
        .catch(() => {})

      if (attempt < this.maxAttempts) {
        await this.eventPublisher.publishRetryEvent({
          ...event,
          attempt,
          lastError: errorMessage
        })
        return { processed: false, retry: true, error: errorMessage }
      }

      await this.eventPublisher.publishDeadLetterEvent({
        ...event,
        attempt,
        lastError: errorMessage
      })
      await this.repository
        .updateCaptureStatus(event.requestId, 'failed', errorMessage)
        .catch(() => {})
      return { processed: false, retry: false, deadLetter: true, error: errorMessage }
    }
  }

  async recordUsage(requestId, usage = {}) {
    const config = this.configProvider()
    if (!config.enabled || !requestId) {
      return { recorded: false, reason: 'disabled_or_missing_request_id' }
    }

    try {
      await this.repository.updateUsage(requestId, usage)
      return { recorded: true }
    } catch (error) {
      logger.warn(`⚠️ Failed to update audit usage for ${requestId}: ${error.message}`)
      return { recorded: false, reason: 'error', message: error.message }
    }
  }

  async start() {
    const config = this.configProvider()
    if (!config.enabled || !config.workerEnabled || this.running) {
      return false
    }

    await this.repository.ensureSchema()
    await this.eventPublisher.createConsumerGroup(config.streamKey, config.workerGroup)
    await this.replaySpoolEvents()
    this.running = true
    this.loopPromise = this.pollLoop().catch((error) => {
      this.running = false
      logger.error('❌ Audit worker stopped unexpectedly:', error)
    })
    return true
  }

  stop() {
    this.running = false
  }

  async pollLoop() {
    const config = this.configProvider()
    const client = redis.getClientSafe()

    while (this.running) {
      const response = await client
        .xreadgroup(
          'GROUP',
          config.workerGroup,
          config.workerConsumer,
          'BLOCK',
          config.workerBlockMs,
          'COUNT',
          10,
          'STREAMS',
          config.streamKey,
          '>'
        )
        .catch((error) => {
          logger.warn(`⚠️ Audit worker poll failed: ${error.message}`)
          return null
        })

      if (!response) {
        await this.replaySpoolEvents().catch((error) => {
          logger.warn(`⚠️ Audit worker spool replay failed: ${error.message}`)
        })
        continue
      }

      for (const [, entries] of response) {
        for (const entry of entries) {
          const { messageId, event } = parseStreamEntry(entry)
          if (!event) {
            await client.xack(config.streamKey, config.workerGroup, messageId).catch(() => {})
            continue
          }

          await this.processCaptureEvent(event)
          await client.xack(config.streamKey, config.workerGroup, messageId).catch(() => {})
        }
      }
    }
  }
}

const auditWorkerService = new AuditWorkerService()

module.exports = auditWorkerService
module.exports.AuditWorkerService = AuditWorkerService
