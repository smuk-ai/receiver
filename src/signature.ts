import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const SIGNATURE_WINDOW_SECONDS = 300
export const MAX_AGENT_BODY_BYTES = 128 * 1024

// The run ID survives durable retries; body identity also distinguishes branches
// that template the same source message differently before reaching one endpoint.
export function agentEventId(runId: string, body: string): string {
  return createHash('sha256').update(JSON.stringify([runId, body])).digest('hex')
}

export function signAgentBody(body: string | Buffer, secret: string, timestamp: string): string {
  return 'v1=' + createHmac('sha256', Buffer.from(secret, 'hex')).update(timestamp + '.').update(body).digest('hex')
}

export function verifyAgentBody(body: Buffer, secret: string, timestamp: string, signature: string, now: number): boolean {
  if (body.length > MAX_AGENT_BODY_BYTES || !/^[a-f0-9]{64}$/.test(secret) || !/^\d{10}$/.test(timestamp) || !/^v1=[a-f0-9]{64}$/.test(signature)) return false
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > SIGNATURE_WINDOW_SECONDS) return false
  return timingSafeEqual(Buffer.from(signature), Buffer.from(signAgentBody(body, secret, timestamp)))
}
