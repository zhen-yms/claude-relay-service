const { PassThrough } = require('stream')
const { EventEmitter } = require('events')
const crypto = require('crypto')
const { createAuditQueryApp, writeGzipLine } = require('../src/auditQueryApp')

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function routeHarness(service, exportTimeoutMs = 30000) {
  const { app } = createAuditQueryApp({
    configProvider: () => ({ maxConcurrentExports: 1, exportTimeoutMs }),
    repository: {},
    service,
    logger: { info() {}, warn() {}, error() {} }
  })
  const handler = app._router.stack.find(
    (layer) => layer.route?.path === '/v1/audit/exports/stream'
  ).route.stack[0].handle
  return () => {
    const req = Object.assign(new EventEmitter(), { body: {}, requestId: 'synthetic' })
    const res = new PassThrough({ highWaterMark: 1 })
    res.status = (code) => {
      res.statusCode = code
      return res
    }
    res.setHeader = () => {}
    res.json = (value) => {
      res.body = value
      res.end()
      return res
    }
    let gzip
    res.on('pipe', (source) => {
      gzip = source
    })
    const done = handler(req, res)
    return {
      req,
      res,
      done,
      get gzip() {
        return gzip
      }
    }
  }
}

async function waitFor(predicate) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('Synthetic stream did not reach expected state')
}

describe('audit export slot lifecycle', () => {
  test('real HTTP client disconnect returns capacity for a subsequent gzip export', async () => {
    const http = require('http')
    const request = require('supertest')
    const token = 'synthetic-audit-test-token-not-a-real-credential'
    let firstSignal
    let firstReturned = false
    let calls = 0
    const { app } = createAuditQueryApp({
      configProvider: () => ({
        tokenSha256: crypto.createHash('sha256').update(token).digest('hex'),
        maxConcurrentExports: 1,
        exportTimeoutMs: 1000
      }),
      repository: {},
      logger: { info() {}, warn() {}, error() {} },
      service: {
        prepareExport: () => ({}),
        async *exportRecords(_body, { signal }) {
          calls += 1
          if (calls === 1) {
            firstSignal = signal
            const synthetic = crypto.randomBytes(128 * 1024).toString('hex')
            try {
              while (!signal.aborted) {
                yield { synthetic }
              }
            } finally {
              firstReturned = true
            }
          } else {
            yield { type: 'summary', complete: true }
          }
        }
      }
    })
    const server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    let client
    try {
      await new Promise((resolve, reject) => {
        client = http.request(
          {
            host: '127.0.0.1',
            port: server.address().port,
            method: 'POST',
            path: '/v1/audit/exports/stream',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
          },
          (res) => {
            res.once('data', () => {
              res.destroy()
              client.destroy()
              resolve()
            })
            res.on('error', () => {})
          }
        )
        client.on('error', reject)
        client.end('{}')
      })
      await waitFor(() => firstSignal.aborted && firstReturned)
      await request(server)
        .post('/v1/audit/exports/stream')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(200)
      expect(calls).toBe(2)
    } finally {
      client?.destroy()
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test.each(['close', 'error'])(
    'gzip %s cancels the export and releases the slot',
    async (event) => {
      const gate = deferred()
      let signal
      const start = routeHarness({
        prepareExport: () => ({}),
        async *exportRecords(_body, options) {
          ;({ signal } = options)
          await gate.promise
          yield {}
        }
      })
      const first = start()
      first.gzip.destroy(event === 'error' ? new Error('synthetic gzip error') : undefined)
      await new Promise((resolve) => setImmediate(resolve))
      const cancelled = signal.aborted && first.res.destroyed
      const second = start()
      const status = second.res.statusCode
      first.req.emit('aborted')
      second.req.emit('aborted')
      gate.resolve()
      await Promise.all([first.done, second.done])
      expect(cancelled).toBe(true)
      expect(status).toBe(200)
    }
  )

  test('holds the slot and timeout through final gzip flush', async () => {
    const start = routeHarness(
      {
        prepareExport: () => ({}),
        async *exportRecords() {
          yield { type: 'summary', complete: true }
        }
      },
      50
    )
    const first = start()
    await first.done
    const blocked = start()
    await blocked.done
    expect(blocked.res.statusCode).toBe(429)
    await waitFor(() => first.res.destroyed)
    expect(first.gzip.destroyed).toBe(true)
    const next = start()
    next.res.resume()
    await next.done
    await waitFor(() => next.res.writableFinished)
    const last = start()
    expect(last.res.statusCode).toBe(200)
    last.res.resume()
    await last.done
    await waitFor(() => last.res.writableFinished)
  })

  test('an error-summary write cannot wait past the export timeout', async () => {
    const start = routeHarness(
      {
        prepareExport: () => ({}),
        async *exportRecords() {
          yield { type: 'header' }
          throw new (require('../src/services/audit/auditQueryErrors').AuditQueryError)(
            400,
            'synthetic',
            crypto.randomBytes(256 * 1024).toString('hex')
          )
        }
      },
      50
    )
    const first = start()
    expect(await outcomeWithin(first.done)).toBe('resolved')
    expect(first.res.destroyed).toBe(true)
    expect(first.gzip.destroyed).toBe(true)
  })

  test.each(['disconnect', 'timeout'])(
    '%s destroys blocked gzip and permits the next export',
    async (cause) => {
      let signal
      let returned = false
      const start = routeHarness(
        {
          prepareExport: () => ({}),
          async *exportRecords(_body, options) {
            ;({ signal } = options)
            try {
              yield { synthetic: crypto.randomBytes(256 * 1024).toString('hex') }
            } finally {
              returned = true
            }
          }
        },
        cause === 'timeout' ? 50 : 30000
      )
      const first = start()
      await waitFor(() => first.gzip?.writableNeedDrain && first.gzip.listenerCount('drain') > 0)
      if (cause === 'disconnect') {
        first.res.destroy()
      }
      await waitFor(() => signal.aborted)
      const outcome = await outcomeWithin(first.done)
      const destroyed = first.gzip.destroyed && first.res.destroyed
      // Always clean up, including when running the regression against broken code.
      first.gzip.destroy()
      await first.done
      const second = start()
      const status = second.res.statusCode
      second.res.destroy()
      second.gzip?.destroy()
      await second.done
      expect(outcome).toBe('resolved')
      expect(destroyed).toBe(true)
      expect(returned).toBe(true)
      expect(status).toBe(200)
      expect(first.req.listenerCount('aborted')).toBe(0)
    }
  )

  test('abort releases exactly once even when an iterator ignores cancellation', async () => {
    const gates = []
    const start = routeHarness({
      prepareExport: () => ({}),
      async *exportRecords() {
        const gate = deferred()
        gates.push(gate)
        await gate.promise
        yield { type: 'summary', complete: true }
      }
    })
    const first = start()
    first.req.emit('aborted')
    first.res.emit('close')
    const second = start()
    const secondStatus = second.res.statusCode
    gates[0].resolve()
    await first.done
    const third = start()
    const thirdStatus = third.res.statusCode
    // Unblock every iterator before asserting.
    gates.forEach((gate) => gate.resolve())
    second.res.resume()
    third.res.resume()
    await Promise.all([second.done, third.done])
    expect(secondStatus).toBe(200)
    expect(thirdStatus).toBe(429)
  })
})

async function outcomeWithin(promise, ms = 200) {
  let timer
  try {
    return await Promise.race([
      promise.then(
        () => 'resolved',
        () => 'rejected'
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('pending'), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('audit export backpressure', () => {
  test('a pre-aborted signal writes no bytes', async () => {
    const stream = new PassThrough()
    const controller = new AbortController()
    controller.abort()
    await expect(writeGzipLine(stream, {}, controller.signal)).rejects.toThrow()
    expect(stream.readableLength).toBe(0)
    stream.destroy()
  })

  test('normal drain resolves and removes all temporary listeners', async () => {
    const stream = new PassThrough({ highWaterMark: 1 })
    const controller = new AbortController()
    const pending = writeGzipLine(stream, { synthetic: true }, controller.signal)
    stream.resume()
    expect(await outcomeWithin(pending)).toBe('resolved')
    for (const event of ['drain', 'close', 'finish', 'error']) {
      expect(stream.listenerCount(event)).toBe(0)
    }
    expect(require('events').getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    stream.destroy()
  })

  test.each(['close', 'finish', 'error'])('%s interrupts a blocked write', async (event) => {
    const stream = new PassThrough({ highWaterMark: 1 })
    const pending = writeGzipLine(stream, { synthetic: true })
    if (event === 'close') {
      stream.destroy()
    } else if (event === 'error') {
      stream.destroy(new Error('synthetic failure'))
    } else {
      stream.emit('finish')
    }
    const outcome = await outcomeWithin(pending)
    stream.destroy()
    expect(outcome).toBe('rejected')
    expect(stream.listenerCount('drain')).toBe(0)
    expect(stream.listenerCount('close')).toBe(0)
    expect(stream.listenerCount('finish')).toBe(0)
  })

  test('already destroyed streams reject without waiting for a lost close event', async () => {
    const stream = new PassThrough()
    stream.destroy()
    await new Promise((resolve) => setImmediate(resolve))
    expect(await outcomeWithin(writeGzipLine(stream, {}))).toBe('rejected')
  })

  test('abort interrupts a blocked write and removes wait listeners', async () => {
    const stream = new PassThrough({ highWaterMark: 1 })
    const controller = new AbortController()
    const pending = writeGzipLine(stream, { synthetic: 'data' }, controller.signal)
    expect(stream.writableNeedDrain).toBe(true)
    controller.abort()
    const outcome = await outcomeWithin(pending)
    stream.destroy()
    expect(outcome).toBe('rejected')
    expect(stream.listenerCount('drain')).toBe(0)
    expect(stream.listenerCount('error')).toBe(0)
    expect(stream.listenerCount('close')).toBe(0)
  })
})
