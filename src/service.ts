import { createServer, type IncomingMessage } from 'node:http'
import { verifyAgentBody, signAgentBody, SIGNATURE_WINDOW_SECONDS, MAX_AGENT_BODY_BYTES } from './signature.js'
import { acceptPayload, acceptVerification, type ReceiverConfig } from './policy.js'
import { RECEIVER_VERIFY_RESPONSE, RECEIVER_VERSION, type ReceiverMode, type ReceiverVerificationResponse } from './protocol.js'
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

// Public surface accepts deliveries and signed approval challenges only. No
// inbox, result, configuration, or run endpoint is exposed to the sender.
export function createReceiver(config: ReceiverConfig, inbox: Pick<Inbox, 'enqueue'>, now = Date.now, mode: () => ReceiverMode = () => 'receiving') {
  let minute = 0, requests = 0
  // Timestamp acceptance includes future timestamps. Keep each nonce through the
  // entire remaining signature window, not merely five minutes after arrival.
  const challenges = new Map<string, number>()
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    const answer = (status: number, message: string) => { res.writeHead(status); res.end(JSON.stringify({ status: message })) }
    if ((req.url !== '/webhook' && req.url !== '/verify') || req.method !== 'POST') { answer(404, 'not found'); req.resume(); return }
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
    let value: unknown
    try { value = JSON.parse(body.toString('utf8')) } catch { answer(400, 'invalid JSON'); return }
    if (req.url === '/verify') {
      const challenge = acceptVerification(value, config)
      if (!challenge) { answer(403, 'verification does not match approval'); return }
      const seconds = Math.floor(now() / 1000)
      for (const [nonce, expiry] of challenges) if (expiry < seconds) challenges.delete(nonce)
      if (challenges.has(challenge.nonce)) { answer(409, 'challenge already used'); return }
      // The shared 60/minute limit normally bounds this further. Fail closed if
      // an unusual clock jump prevents expiry instead of evicting live nonces.
      if (challenges.size >= 720) { answer(503, 'verification unavailable'); return }
      challenges.set(challenge.nonce, Number(timestamp) + SIGNATURE_WINDOW_SECONDS)
      let state: ReceiverMode
      try { state = mode() } catch { answer(503, 'verification unavailable'); return }
      const response: ReceiverVerificationResponse = { schemaVersion: 1, type: RECEIVER_VERIFY_RESPONSE,
        nonce: challenge.nonce, approval: 'matched', mode: state, receiverVersion: RECEIVER_VERSION }
      const responseBody = JSON.stringify(response), responseTimestamp = String(seconds)
      res.setHeader('x-smuk-timestamp', responseTimestamp)
      res.setHeader('x-smuk-signature', signAgentBody(responseBody, config.signingSecret, responseTimestamp))
      res.writeHead(200); res.end(responseBody); return
    }
    const payload = acceptPayload(value, config)
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
