import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReceiver, readBody } from './service.js'
import { signAgentBody, MAX_AGENT_BODY_BYTES } from './signature.js'
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
