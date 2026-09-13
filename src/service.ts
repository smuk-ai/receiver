import { createServer, type IncomingMessage } from 'node:http'
import { verifyAgentBody, MAX_AGENT_BODY_BYTES } from './signature.js'
import { acceptPayload, type ReceiverConfig } from './policy.js'
import type { Inbox } from './inbox.js'

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const part of req) {
    const chunk = Buffer.from(part)
    size += chunk.length
    if (size > MAX_AGENT_BODY_BYTES) throw new Error('Body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

// Public surface is write-only. No inbox, result, configuration, or run endpoint
// is exposed to the tunnel, browser, or sender.
export function createReceiver(config: ReceiverConfig, inbox: Pick<Inbox, 'enqueue'>, now = Date.now) {
  let minute = 0, requests = 0
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    const answer = (status: number, message: string) => { res.writeHead(status); res.end(JSON.stringify({ status: message })) }
    if (req.url !== '/webhook' || req.method !== 'POST') { answer(404, 'not found'); req.resume(); return }
    const current = Math.floor(now() / 60_000)
    if (current !== minute) { minute = current; requests = 0 }
    if (++requests > 60) { answer(429, 'rate limited'); req.resume(); return }
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json' || req.headers['content-encoding']) {
      answer(415, 'application/json required'); req.resume(); return
    }
    const timestamp = req.headers['x-smuk-timestamp'], signature = req.headers['x-smuk-signature']
    if (typeof timestamp !== 'string' || typeof signature !== 'string') { answer(401, 'invalid signature'); req.resume(); return }
    let body: Buffer
    try { body = await readBody(req) } catch { answer(413, 'invalid body'); return }
    if (!verifyAgentBody(body, config.signingSecret, timestamp, signature, now())) { answer(401, 'invalid signature'); return }
    let payload
    try { payload = acceptPayload(JSON.parse(body.toString('utf8')), config) } catch { answer(400, 'invalid JSON'); return }
    if (!payload) { answer(403, 'delivery does not match approved node, instructions or sources'); return }
    try {
      const result = inbox.enqueue(payload, now())
      answer(result === 'full' ? 503 : result === 'duplicate' ? 200 : 202, result)
    } catch { answer(503, 'inbox unavailable') }
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  server.maxConnections = 32
  return server
}
