const fs = require('fs/promises')
const path = require('path')
const logger = require('../../utils/logger')
const { getAuditConfig } = require('./auditConfig')
const {
  classifyAuditProtocol,
  getRequestPath,
  isAuditEligibleRequest
} = require('./auditRouteClassifier')
const auditEventPublisher = require('./auditEventPublisher')
const auditRepository = require('./auditRepository')

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-goog-api-key',
  'api-key',
  'cookie',
  'set-cookie'
])

function toIsoString(value) {
  if (!value) {
    return null
  }
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function normalizeBody(value) {
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8')
  }
  return value
}

function sanitizeHeaders(headers = {}) {
  const result = {}
  for (const [rawKey, value] of Object.entries(headers || {})) {
    const key = String(rawKey).toLowerCase()
    result[key] = SENSITIVE_HEADER_NAMES.has(key) ? '[REDACTED]' : value
  }
  return result
}

function getResponseHeaders(res) {
  if (typeof res?.getHeaders === 'function') {
    return res.getHeaders()
  }
  return {}
}

function getCapturedStatusCode(context, res) {
  if (!res) {
    return null
  }
  if (context.terminationReason && res.headersSent !== true) {
    return null
  }
  return res.statusCode || null
}

function addDays(date, days) {
  const result = new Date(date.getTime())
  result.setUTCDate(result.getUTCDate() + days)
  return result
}

class AuditCaptureService {
  constructor(options = {}) {
    this.configProvider = options.configProvider || getAuditConfig
    this.eventPublisher = options.eventPublisher || auditEventPublisher
    this.repository = options.repository || auditRepository
  }

  start(req, res = null) {
    const config = this.configProvider()
    if (!config.enabled || !isAuditEligibleRequest(req)) {
      return null
    }

    const startedAt = req.requestStartedAt ? new Date(req.requestStartedAt) : new Date()
    const createdAt = new Date()
    const context = {
      requestId: req.requestId || `audit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      createdAt: createdAt.toISOString(),
      requestStartedAt: startedAt.toISOString(),
      retentionUntil: addDays(startedAt, config.retentionDays).toISOString(),
      endpoint: getRequestPath(req),
      method: req.method || null,
      protocol: classifyAuditProtocol(req),
      apiKeyId: req.apiKey?.id || null,
      apiKeyName: req.apiKey?.name || null,
      userId: req.apiKey?.userId || null,
      userUsername: req.apiKey?.userUsername || null,
      stream: Boolean(req.body?.stream),
      artifacts: [],
      pendingWrites: [],
      responseChunks: [],
      responseBody: undefined,
      responseContentType: null,
      finished: false,
      finishPromise: null,
      terminationReason: null,
      config
    }

    req.auditContext = context
    this.captureClientRequest(req)

    if (res) {
      this.wrapResponse(req, res)
    }

    return context
  }

  captureClientRequest(req) {
    const context = req.auditContext
    if (!context) {
      return null
    }

    return this.writeArtifact(context, 'client_request', {
      kind: 'client_request',
      capturedAt: new Date().toISOString(),
      requestId: context.requestId,
      method: req.method || null,
      endpoint: context.endpoint,
      protocol: context.protocol,
      headers: sanitizeHeaders(req.headers || {}),
      query: req.query || null,
      body: req.body === undefined ? null : req.body
    })
  }

  captureUpstreamRequest(req, provider, payload, meta = {}) {
    const context = req?.auditContext
    if (!context || context.finished) {
      return null
    }

    return this.writeArtifact(context, 'upstream_request', {
      kind: 'upstream_request',
      capturedAt: new Date().toISOString(),
      requestId: context.requestId,
      provider,
      meta,
      body: payload === undefined ? null : payload
    })
  }

  wrapResponse(req, res) {
    if (!req.auditContext || res._auditCaptureWrapped) {
      return
    }

    res._auditCaptureWrapped = true
    const originalJson = typeof res.json === 'function' ? res.json.bind(res) : null
    const originalSend = typeof res.send === 'function' ? res.send.bind(res) : null
    const originalWrite = typeof res.write === 'function' ? res.write.bind(res) : null
    const originalEnd = typeof res.end === 'function' ? res.end.bind(res) : null

    if (originalJson) {
      res.json = (body) => {
        req.auditContext.responseBody = body
        req.auditContext.responseContentType = 'application/json'
        return originalJson(body)
      }
    }

    if (originalSend) {
      res.send = (body) => {
        req.auditContext.responseBody = normalizeBody(body)
        req.auditContext.responseContentType = res.getHeader?.('content-type') || null
        return originalSend(body)
      }
    }

    if (originalWrite) {
      res.write = (chunk, ...args) => {
        if (chunk !== undefined && chunk !== null) {
          req.auditContext.responseChunks.push(
            Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
          )
        }
        return originalWrite(chunk, ...args)
      }
    }

    if (originalEnd) {
      res.end = (chunk, ...args) => {
        if (chunk !== undefined && chunk !== null) {
          req.auditContext.responseChunks.push(
            Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
          )
        }
        return originalEnd(chunk, ...args)
      }
    }

    const finalize = (terminationReason = null) => {
      const context = req.auditContext
      if (terminationReason && !context.finishPromise && !context.terminationReason) {
        context.terminationReason = terminationReason
      }
      this.finish(req, res).catch((error) => {
        logger.warn(`⚠️ Failed to finalize audit capture: ${error.message}`)
      })
    }

    if (typeof res.once === 'function') {
      res.once('finish', () => finalize())
      res.once('close', () => {
        if (res.writableFinished !== true) {
          finalize('client_disconnected')
        }
      })
    }

    if (typeof req.once === 'function') {
      req.once('aborted', () => finalize('client_aborted'))
    }
  }

  async writeArtifact(context, kind, payload) {
    const sequence = context.artifacts.filter((artifact) => artifact.kind === kind).length
    const date = context.createdAt.slice(0, 10)
    const dir = path.join(context.config.spoolDir, date)
    const filename = `${context.requestId}-${kind}-${sequence}.json`
    const spoolPath = path.join(dir, filename)
    const writePromise = fs
      .mkdir(dir, { recursive: true })
      .then(() => fs.writeFile(spoolPath, JSON.stringify(payload), 'utf8'))
      .then(() => {
        context.artifacts.push({
          kind,
          sequence,
          spoolPath,
          contentType: 'application/json'
        })
      })

    context.pendingWrites.push(writePromise)
    return writePromise
  }

  async captureResponse(context, res) {
    if (context.artifacts.some((artifact) => artifact.kind === 'response')) {
      return
    }

    const body =
      context.responseChunks.length > 0
        ? {
            raw: context.responseChunks.join(''),
            encoding: 'utf8'
          }
        : context.responseBody === undefined
          ? null
          : context.responseBody

    await this.writeArtifact(context, 'response', {
      kind: 'response',
      capturedAt: new Date().toISOString(),
      requestId: context.requestId,
      statusCode: getCapturedStatusCode(context, res),
      headers: getResponseHeaders(res),
      contentType: context.responseContentType,
      terminationReason: context.terminationReason,
      body
    })
  }

  async writeEventManifest(context, event) {
    const date = context.createdAt.slice(0, 10)
    const dir = path.join(context.config.spoolDir, date)
    const eventSpoolPath = path.join(dir, `${context.requestId}-event.json`)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(eventSpoolPath, JSON.stringify(event), 'utf8')
    return eventSpoolPath
  }

  async finish(req, res = null) {
    const context = req?.auditContext
    if (!context) {
      return { published: false, reason: 'missing_context' }
    }

    if (context.finishPromise) {
      return context.finishPromise
    }

    context.finishPromise = this._finish(context, res)
    return context.finishPromise
  }

  async _finish(context, res) {
    if (context.finished) {
      return { published: false, reason: 'already_finished' }
    }

    context.finished = true
    await Promise.all(context.pendingWrites)
    await this.captureResponse(context, res)
    await Promise.all(context.pendingWrites)

    const statusCode = getCapturedStatusCode(context, res)
    const aborted = Boolean(context.terminationReason)

    const event = {
      requestId: context.requestId,
      createdAt: context.createdAt,
      requestStartedAt: context.requestStartedAt,
      retentionUntil: context.retentionUntil,
      endpoint: context.endpoint,
      method: context.method,
      protocol: context.protocol,
      apiKeyId: context.apiKeyId,
      apiKeyName: context.apiKeyName,
      userId: context.userId,
      userUsername: context.userUsername,
      status: aborted ? 'aborted' : statusCode >= 400 ? 'error' : 'ok',
      statusCode,
      stream: context.stream,
      captureStatus: 'pending',
      artifacts: context.artifacts,
      meta: aborted ? { terminationReason: context.terminationReason } : {}
    }

    event.eventSpoolPath = await this.writeEventManifest(context, event)
    await this.eventPublisher.publishCaptureEvent(event)
    return { published: true, event }
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
      logger.warn(`⚠️ Failed to backfill audit usage for ${requestId}: ${error.message}`)
      return { recorded: false, reason: 'error', message: error.message }
    }
  }
}

module.exports = new AuditCaptureService()
module.exports.AuditCaptureService = AuditCaptureService
