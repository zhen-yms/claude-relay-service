const crypto = require('crypto')
const zlib = require('zlib')

function normalizePrefix(prefix) {
  return String(prefix || 'ai-call-audit').replace(/^\/+|\/+$/g, '') || 'ai-call-audit'
}

function encodePathPart(value) {
  const raw = value === null || value === undefined || value === '' ? 'unknown' : String(value)
  return encodeURIComponent(raw)
}

function buildAuditObjectKey({ prefix, createdAt, apiKeyId, requestId, kind, sequence = 0 }) {
  const date = new Date(createdAt || Date.now()).toISOString().slice(0, 10)
  const normalizedSequence = Number.isInteger(Number(sequence)) ? Math.max(Number(sequence), 0) : 0
  const artifactFilename =
    normalizedSequence === 0
      ? `${encodePathPart(kind)}.json.gz`
      : `${encodePathPart(kind)}-${normalizedSequence}.json.gz`
  return [
    normalizePrefix(prefix),
    `dt=${date}`,
    `api_key=${encodePathPart(apiKeyId)}`,
    `request_id=${encodePathPart(requestId)}`,
    artifactFilename
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
