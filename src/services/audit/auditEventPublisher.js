const redis = require('../../models/redis')
const logger = require('../../utils/logger')
const { getAuditConfig } = require('./auditConfig')

function buildEvent(eventType, eventData = {}) {
  return {
    eventId: `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
    eventType,
    timestamp: new Date().toISOString(),
    version: '1.0',
    ...eventData
  }
}

class AuditEventPublisher {
  async publishToStream(streamKey, eventData) {
    const config = getAuditConfig()
    if (!config.enabled) {
      return null
    }

    try {
      const client = redis.getClientSafe()
      return await client.xadd(
        streamKey,
        'MAXLEN',
        '~',
        config.streamMaxLength,
        '*',
        'data',
        JSON.stringify(eventData)
      )
    } catch (error) {
      logger.warn(`⚠️ Failed to publish audit event: ${error.message}`)
      return null
    }
  }

  async publishCaptureEvent(eventData) {
    const config = getAuditConfig()
    return this.publishToStream(config.streamKey, buildEvent('audit.capture.completed', eventData))
  }

  async publishRetryEvent(eventData) {
    const config = getAuditConfig()
    return this.publishToStream(config.retryStreamKey, buildEvent('audit.capture.retry', eventData))
  }

  async publishDeadLetterEvent(eventData) {
    const config = getAuditConfig()
    return this.publishToStream(
      config.deadLetterStreamKey,
      buildEvent('audit.capture.dead_letter', eventData)
    )
  }

  async createConsumerGroup(streamKey, groupName) {
    try {
      const client = redis.getClientSafe()
      await client.xgroup('CREATE', streamKey, groupName, '0', 'MKSTREAM')
      return true
    } catch (error) {
      if (String(error.message || '').includes('BUSYGROUP')) {
        return true
      }
      logger.warn(`⚠️ Failed to create audit consumer group: ${error.message}`)
      return false
    }
  }
}

module.exports = new AuditEventPublisher()
module.exports.AuditEventPublisher = AuditEventPublisher
