import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReceiver, readBody } from './service.js'
import { signAgentBody, verifyAgentBody, MAX_AGENT_BODY_BYTES } from './signature.js'
import { RECEIVER_VERSION } from './protocol.js'
import { readFileSync } from 'node:fs'
import { config, payload } from '../test/fixtures.js'

const now = 1789257600000, timestamp = String(now / 1000)
async function request(server: ReturnType<typeof createReceiver>, value: unknown = payload(), overrides: Record<string, unknown> = {}) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  const req = Object.assign(Readable.from([Buffer.from(raw)]), { url: '/webhook', method: 'POST', headers: {
    'content-type': 'application/json', 'x-smuk-timestamp': timestamp, 'x-smuk-signature': signAgentBody(raw, config.signingSecret, timestamp),
  }, ...overrides })
  let status = 0
  const headers: Record<string,string> = {}, resume = vi.spyOn(req,'resume')
  return new Promise<{ status: number; body: string; headers:Record<string,string>; drained:boolean }>((resolve) => {
    const res = { setHeader: (k:string,v:string) => { headers[k]=v }, writeHead: (s: number) => { status = s }, end: (body: string) => queueMicrotask(() => resolve({ status, body, headers, drained:resume.mock.calls.length > 0 })) }
    server.emit('request', req as unknown as IncomingMessage, res as unknown as ServerResponse)
  })
}
describe('receiver HTTP boundary', () => {
  it('accepts only signed POSTs and has no public read or control endpoints', async () => {
    const enqueue = vi.fn().mockReturnValue('accepted'), server = createReceiver(config, { enqueue }, () => now)
    expect(await request(server)).toMatchObject({status:202,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}})
    expect(enqueue).toHaveBeenCalledWith(payload(), now)
    for (const overrides of [{ method: 'GET' }, { url: '/inbox' }, { url: '/run' }, { url: '/webhook?x=1' }]) expect(await request(server, payload(), overrides)).toMatchObject({status:404,drained:true})
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(server.maxConnections).toBe(32)
    expect(server.requestTimeout).toBe(10000)
    expect(server.headersTimeout).toBe(10000)
  })
  it('rejects wrong content type, compression, missing or invalid signatures and tampered policies before enqueue', async () => {
    const enqueue = vi.fn(), server = createReceiver(config, { enqueue }, () => now)
    for (const headers of [{}, { 'content-type': 'text/plain' }, { 'content-type': 'application/json', 'content-encoding': 'gzip' }]) expect(await request(server, payload(), { headers })).toMatchObject({status:415,drained:true})
    expect(await request(server, payload(), { headers: { 'content-type': 'application/json' } })).toMatchObject({status:401,drained:true})
    const signature=signAgentBody(JSON.stringify(payload()),config.signingSecret,timestamp)
    for (const extra of [{'x-smuk-timestamp':[timestamp],'x-smuk-signature':signature},{'x-smuk-timestamp':timestamp,'x-smuk-signature':[signature]}])
      expect(await request(server,payload(),{headers:{'content-type':'application/json',...extra}})).toMatchObject({status:401,drained:true})
    expect((await request(server, payload(), { headers: { 'content-type': 'application/json', 'x-smuk-timestamp': timestamp, 'x-smuk-signature': 'bad' } })).status).toBe(401)
    expect((await request(server, '{')).status).toBe(400)
    expect((await request(server, { ...payload(), agent: { provider: 'Codex', instructions: 'evil' } })).status).toBe(403)
    expect((await request(server, 'x'.repeat(MAX_AGENT_BODY_BYTES + 1))).status).toBe(413)
    expect(enqueue).not.toHaveBeenCalled()
  })
  it('answers duplicate, full and persistence-failure outcomes honestly', async () => {
    const enqueue = vi.fn().mockReturnValueOnce('duplicate').mockReturnValueOnce('full').mockImplementationOnce(() => { throw new Error('secret path') })
    const server = createReceiver(config, { enqueue }, () => now)
    expect((await request(server)).status).toBe(200)
    expect((await request(server)).status).toBe(503)
    const failure = await request(server)
    expect(failure.status).toBe(503); expect(JSON.parse(failure.body)).toEqual({status:'inbox unavailable'})
  })
  it('caps requests before model or database work and resets the minute bucket', async () => {
    let clock = now
    const enqueue = vi.fn().mockReturnValue('accepted'), server = createReceiver(config, { enqueue }, () => clock)
    for (let i = 0; i < 60; i++) { clock++; expect((await request(server)).status).toBe(202) }
    expect(await request(server)).toMatchObject({status:429,drained:true})
    expect(enqueue).toHaveBeenCalledTimes(60)
    clock += 60000
    expect((await request(server)).status).toBe(202)
  })
  it('accepts UTF-8 JSON content type with parameters and whitespace', async () => {
    const server=createReceiver(config,{enqueue:()=> 'accepted'},()=>now)
    expect((await request(server,payload(),{headers:{'content-type':'application/json ; charset=utf-8','x-smuk-timestamp':timestamp,
      'x-smuk-signature':signAgentBody(JSON.stringify(payload()),config.signingSecret,timestamp)}})).status).toBe(202)
  })
  it('bounds raw byte reads including UTF-8 and aborts malformed streams', async () => {
    const req = (chunks: Buffer[]) => Readable.from(chunks) as unknown as IncomingMessage
    await expect(readBody(req([Buffer.alloc(MAX_AGENT_BODY_BYTES)]))).resolves.toHaveLength(MAX_AGENT_BODY_BYTES)
    await expect(readBody(req([Buffer.alloc(MAX_AGENT_BODY_BYTES), Buffer.from('é')]))).rejects.toThrow()
    const broken = Readable.from((async function* () { yield Buffer.from('a'); throw new Error('broken') })())
    await expect(readBody(broken as IncomingMessage)).rejects.toThrow('broken')
  })
})


describe('signed receiver verification', () => {
  const challenge = (nonce = 'c'.repeat(64)) => ({ schemaVersion: 1, type: 'smuk.receiver.verify', nonce, nodeId: config.nodeId,
    provider: config.provider, instructions: config.instructions, sourceNodeIds: [...config.sourceNodeIds] })
  const headers = (body: unknown, time = now) => ({ 'content-type': 'application/json', 'x-smuk-timestamp': String(Math.floor(time / 1000)),
    'x-smuk-signature': signAgentBody(JSON.stringify(body), config.signingSecret, String(Math.floor(time / 1000))) })
  it('returns only a nonce-bound signed approval and current mode without enqueuing or exposing configuration', async () => {
    expect(RECEIVER_VERSION).toBe(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
    const enqueue = vi.fn(), mode = vi.fn<() => 'receiving' | 'processing' | 'paused'>().mockReturnValueOnce('receiving').mockReturnValueOnce('processing').mockReturnValueOnce('paused')
    const server = createReceiver(config, { enqueue }, () => now, mode)
    for (const [i, state] of ['receiving', 'processing', 'paused'].entries()) {
      const value = challenge(String(i).repeat(64)), result = await request(server, value, { url: '/verify' })
      expect(result.status).toBe(200)
      expect(JSON.parse(result.body)).toEqual({ schemaVersion: 1, type: 'smuk.receiver.verified', nonce: value.nonce, approval: 'matched', mode: state, receiverVersion: RECEIVER_VERSION })
      expect(result.headers).toMatchObject({ 'cache-control': 'no-store', 'content-type': 'application/json', 'x-content-type-options': 'nosniff', 'x-smuk-timestamp': timestamp })
      expect(verifyAgentBody(Buffer.from(result.body), config.signingSecret, result.headers['x-smuk-timestamp'], result.headers['x-smuk-signature'], now)).toBe(true)
      expect(verifyAgentBody(Buffer.from(result.body.replace(value.nonce, 'f'.repeat(64))), config.signingSecret, result.headers['x-smuk-timestamp'], result.headers['x-smuk-signature'], now)).toBe(false)
      expect(result.body).not.toContain(config.signingSecret)
      expect(result.body).not.toContain(config.instructions)
    }
    expect(enqueue).not.toHaveBeenCalled()
    expect(mode).toHaveBeenCalledTimes(3)
    expect(JSON.parse((await request(createReceiver(config, { enqueue }, () => now), challenge(), { url: '/verify' })).body).mode).toBe('receiving')
  })
  it('authenticates before approval checks and denies payload confusion, mismatches and public reads', async () => {
    const enqueue = vi.fn(), mode = vi.fn(() => 'processing' as const), server = createReceiver(config, { enqueue }, () => now, mode)
    for (const overrides of [{ method: 'GET' }, { url: '/verify?x=1' }, { url: '/verify/extra' }])
      expect((await request(server, challenge(), { url: '/verify', ...overrides })).status).toBe(404)
    expect((await request(server, '{', { url: '/verify', headers: { 'content-type': 'application/json', 'x-smuk-timestamp': timestamp, 'x-smuk-signature': 'bad' } })).status).toBe(401)
    expect((await request(server, '{', { url: '/verify' })).status).toBe(400)
    for (const value of [payload(), { ...challenge(), instructions: 'changed' }, { ...challenge(), sourceNodeIds: ['other'] }])
      expect((await request(server, value, { url: '/verify' })).status).toBe(403)
    expect((await request(server, challenge())).status).toBe(403)
    expect((await request(server, 'x'.repeat(MAX_AGENT_BODY_BYTES + 1), { url: '/verify' })).status).toBe(413)
    expect((await request(server, challenge(), { url: '/verify', headers: headers(challenge(), now - 301000) })).status).toBe(401)
    expect(enqueue).not.toHaveBeenCalled(); expect(mode).not.toHaveBeenCalled()
  })
  it('rejects repeated challenges through the entire signature window including future-dated requests', async () => {
    let clock = now
    const enqueue = vi.fn(), mode = vi.fn(() => 'receiving' as const), server = createReceiver(config, { enqueue }, () => clock, mode)
    const value = challenge(), originalHeaders = headers(value, now + 300000)
    expect((await request(server, value, { url: '/verify', headers: originalHeaders })).status).toBe(200)
    expect((await request(server, value, { url: '/verify', headers: originalHeaders })).status).toBe(409)
    clock += 600000
    expect((await request(server, value, { url: '/verify', headers: originalHeaders })).status).toBe(409)
    clock += 1000
    expect((await request(server, value, { url: '/verify', headers: originalHeaders })).status).toBe(401)
    expect((await request(server, value, { url: '/verify', headers: headers(value, clock) })).status).toBe(200)
    expect(mode).toHaveBeenCalledTimes(2); expect(enqueue).not.toHaveBeenCalled()
  })
  it('shares the ingress rate limit with deliveries and fails closed when mode cannot be read', async () => {
    const enqueue = vi.fn().mockReturnValue('accepted'), server = createReceiver(config, { enqueue }, () => now)
    for (let i = 0; i < 59; i++) expect((await request(server)).status).toBe(202)
    expect((await request(server, challenge(), { url: '/verify' })).status).toBe(200)
    expect((await request(server, challenge('d'.repeat(64)), { url: '/verify' })).status).toBe(429)
    const broken = createReceiver(config, { enqueue }, () => now, () => { throw new Error('private local path') })
    const result = await request(broken, challenge(), { url: '/verify' })
    expect(result.status).toBe(503); expect(JSON.parse(result.body)).toEqual({ status: 'verification unavailable' })
    expect(result.headers['x-smuk-signature']).toBeUndefined()
  })
  it('bounds replay memory despite backward clock jumps without evicting valid challenges', async () => {
    let clock = now
    const enqueue = vi.fn(), server = createReceiver(config, { enqueue }, () => clock)
    for (let i = 0; i < 720; i++) {
      clock = now + (i % 2) * 60000
      const value = challenge(i.toString(16).padStart(64, '0'))
      expect((await request(server, value, { url: '/verify', headers: headers(value, now + 300000) })).status).toBe(200)
    }
    clock = now
    const value = challenge('f'.repeat(64))
    expect((await request(server, value, { url: '/verify', headers: headers(value, now + 300000) })).status).toBe(503)
    expect((await request(server, challenge('0'.repeat(64)), { url: '/verify' })).status).toBe(409)
    clock = now + 601000
    expect((await request(server, value, { url: '/verify', headers: headers(value, clock) })).status).toBe(200)
    expect(enqueue).not.toHaveBeenCalled()
  })
})
