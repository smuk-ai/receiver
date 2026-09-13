import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { agentEventId, signAgentBody, verifyAgentBody, MAX_AGENT_BODY_BYTES } from './signature.js'

const secret = 'ab'.repeat(32), ts = '1789257600', now = Number(ts) * 1000, body = Buffer.from('{"text":"héllo"}')
describe('signed delivery', () => {
  it('signs timestamp and exact bytes using the decoded per-destination secret', () => {
    const expected = 'v1=' + createHmac('sha256', Buffer.from(secret, 'hex')).update(ts + '.').update(body).digest('hex')
    expect(signAgentBody(body, secret, ts)).toBe(expected)
    expect(verifyAgentBody(body, secret, ts, expected, now)).toBe(true)
    expect(verifyAgentBody(body, secret, ts, expected, now + 300_000)).toBe(true)
    expect(verifyAgentBody(body, secret, ts, expected, now - 300_000)).toBe(true)
    expect(verifyAgentBody(body, secret, ts, expected, now + 301_000)).toBe(false)
    expect(verifyAgentBody(body, secret, ts, expected, now - 301_000)).toBe(false)
  })
  it('rejects tampering, malformed credentials and oversized bodies', () => {
    const sig = signAgentBody(body, secret, ts)
    for (const bad of ['', 'a'.repeat(64), 'v1=' + 'a'.repeat(63), 'x' + sig, sig + 'x', 'v1=' + 'é'.repeat(64)]) expect(verifyAgentBody(body, secret, ts, bad, now)).toBe(false)
    for (const key of ['', 'x'.repeat(64), secret + 'a', secret.slice(1), 'cd'.repeat(32)]) expect(verifyAgentBody(body, key, ts, sig, now)).toBe(false)
    for (const stamp of ['', 'not-date', ts + '0', ts.slice(1), '1789257601']) expect(verifyAgentBody(body, secret, stamp, sig, now)).toBe(false)
    expect(verifyAgentBody(Buffer.from(body + ' '), secret, ts, sig, now)).toBe(false)
    for (const size of [MAX_AGENT_BODY_BYTES, MAX_AGENT_BODY_BYTES + 1]) {
      const data = Buffer.alloc(size)
      expect(verifyAgentBody(data, secret, ts, signAgentBody(data, secret, ts), now)).toBe(size === MAX_AGENT_BODY_BYTES)
    }
  })
  it('rejects numerically equivalent timestamps unless they use exactly ten digits', () => {
    for (const stamp of ['0'+ts, ts+'.0', ' '+ts, ts+' '])
      expect(verifyAgentBody(body,secret,stamp,signAgentBody(body,secret,stamp),now)).toBe(false)
  })
  it('keeps identity stable on retries but separates different runs and payloads', () => {
    expect(agentEventId('r', 'payload')).toBe(agentEventId('r', 'payload'))
    expect(new Set([agentEventId('r', 'payload'), agentEventId('r2', 'payload'), agentEventId('r', 'other'), agentEventId('rpayload', '')]).size).toBe(4)
    expect(agentEventId('r', 'payload')).toMatch(/^[a-f0-9]{64}$/)
  })
})
