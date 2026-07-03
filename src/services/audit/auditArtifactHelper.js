const crypto = require('crypto')
const zlib = require('zlib')

function normalizePrefix(prefix) {
  return String(prefix || 'ai-call-audit').replace(/^\/+|\/+$/g, '') || 'ai-call-audit'
}

function encodePathPart(value) {
  const raw = value === null || value === undefined || value === '' ? 'unknown' : String(value)
  return encodeURIComponent(raw)
}

function buildAuditObjectKey({ prefix, createdAt, apiKeyId, requestId, kind }) {
  const date = new Date(createdAt || Date.now()).toISOString().slice(0, 10)
  return [
    normalizePrefix(prefix),
    `dt=${date}`,
    `api_key=${encodePathPart(apiKeyId)}`,
    `request_id=${encodePathPart(requestId)}`,
    `${encodePathPart(kind)}.json.gz`
  ].join('/')
}

function gzipJsonPayload(payload) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'))
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

module.exports = {
  buildAuditObjectKey,
  gzipJsonPayload,
  sha256Hex
}
