import { getEventListeners } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { approvedConfig, approvalSummary, completed, installationId, pairingLink, pairingRequest, parseManifest, quickTunnelUrl, readyTunnelUrl, SetupError } from './setup.js'

const manifest = { schemaVersion: 1 as const, nodeId: 'destination', provider: 'Codex' as const, instructions: 'Summarize exactly.\n', sourceNodeIds: ['source'] }
const token = 'ab'.repeat(32)
const config = { nodeId: manifest.nodeId, provider: manifest.provider, instructions: manifest.instructions, sourceNodeIds: ['old-source'],
  signingSecret: 'cd'.repeat(32), senderIds: ['person'], serverIds: ['server'], channelIds: ['channel'] }

describe('explicit local setup policy', () => {
  it('preserves exact instructions and returns independent approved source arrays', () => {
    const parsed = parseManifest(manifest)
    expect(parsed).toEqual(manifest)
    expect(parsed.sourceNodeIds).not.toBe(manifest.sourceNodeIds)
    expect(parseManifest({ ...manifest, instructions: 'a'.repeat(8000), nodeId: 'n'.repeat(200), sourceNodeIds: Array.from({ length: 100 }, (_, i) => String(i)) }).sourceNodeIds).toHaveLength(100)
  })
  it.each([null, [], {}, { ...manifest, schemaVersion: 2 }, { ...manifest, signingSecret: token }, { ...manifest, nodeId: '' },
    { ...manifest, nodeId: 'a'.repeat(201) }, { ...manifest, provider: 'bad' }, { ...manifest, instructions: '' },
    { ...manifest, instructions: '  \n' }, { ...manifest, instructions: 'a'.repeat(8001) }, { ...manifest, sourceNodeIds: [] },
    { ...manifest, nodeId: ['a'] }, { ...manifest, sourceNodeIds: [['a']] }, { ...manifest, sourceNodeIds: ['okay', ''] }, { ...manifest, sourceNodeIds: [''] }, { ...manifest, sourceNodeIds: ['a'.repeat(201)] }, { ...manifest, sourceNodeIds: ['x', 'x'] },
    { ...manifest, sourceNodeIds: Array.from({ length: 101 }, (_, i) => String(i)) }, { ...manifest, sourceNodeIds: 'source' }])('rejects malformed manifests %j', value => {
    expect(() => parseManifest(value)).toThrow('invalid')
  })
  it('derives deterministic traversal-free separate installation directories', () => {
    expect(installationId('https://smuk.example', '../private')).toMatch(/^[a-f0-9]{64}$/)
    expect(installationId('https://smuk.example', '../private')).toBe(installationId('https://smuk.example', '../private'))
    expect(installationId('https://smuk.example', 'a')).not.toBe(installationId('https://smuk.example', 'b'))
    expect(installationId('https://smuk.example', 'a')).not.toBe(installationId('https://other.example', 'a'))
  })
  it('creates a new independent config but preserves prior local credentials and filters on changed approval', () => {
    const secret = vi.fn(() => token)
    expect(approvedConfig(manifest, undefined, secret)).toEqual({ nodeId: manifest.nodeId, provider: 'Codex', instructions: manifest.instructions,
      sourceNodeIds: ['source'], signingSecret: token, senderIds: [], serverIds: [], channelIds: [] })
    expect(secret).toHaveBeenCalledTimes(1)
    const next = approvedConfig({ ...manifest, provider: 'Gemini CLI', instructions: 'Changed task.' }, config, secret)
    expect(next).toEqual({ ...config, provider: 'Gemini CLI', instructions: 'Changed task.', sourceNodeIds: ['source'] })
    expect(secret).toHaveBeenCalledTimes(1)
    next.senderIds.push('other'); next.sourceNodeIds.push('other')
    expect(config.senderIds).toEqual(['person']); expect(manifest.sourceNodeIds).toEqual(['source'])
    expect(() => approvedConfig({ ...manifest, nodeId: 'other' }, config, secret)).toThrow('different tile')
  })
  it('shows all approval fields and escapes terminal controls', () => {
    const summary = approvalSummary({ ...manifest, instructions: 'hello\x1b[2J\nworld', sourceNodeIds: ['x\rhidden'] }, 'https://smuk.example')
    expect(summary).toContain('https://smuk.example'); expect(summary).toContain('Codex'); expect(summary).toContain('destination')
    expect(summary).toContain('hello\\u001b[2J\\nworld'); expect(summary).toContain('x\\rhidden')
    expect(summary).not.toContain('\x1b'); expect(summary).not.toContain('\r')
  })
})

describe('pairing transport boundary', () => {
  it('extracts token from an HTTPS fragment and retains the exact origin', () => {
    expect(pairingLink('https://smuk.example:8443/#' + token)).toEqual({ origin: 'https://smuk.example:8443', token })
  })
  it.each(['garbage', 'http://smuk.example/#', 'https://user:pass@smuk.example/#', 'https://smuk.example/path#', 'https://smuk.example/?q=1#', 'https://smuk.example/#short', 'https://smuk.example/#extra#' + token, 'https://smuk.example/#' + token + 'extra', 'https://smuk.example/#' + 'z'.repeat(64)])('rejects invalid pairing links %s', prefix => {
    const link = prefix.endsWith('#') ? prefix + token : prefix
    expect(() => pairingLink(link)).toThrow(SetupError)
  })
  it('uses fixed endpoint, bearer auth, redirect refusal and bounded JSON handling', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify(manifest)))
    expect(await pairingRequest('https://smuk.example', token, 'manifest', undefined, request)).toEqual(manifest)
    expect(request).toHaveBeenCalledWith('https://smuk.example/api/receiver-pairings/manifest', expect.objectContaining({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer ' + token } }))
    const options = request.mock.calls[0] as unknown as [string, RequestInit]
    expect(options[1].signal).toBeInstanceOf(AbortSignal)
    expect(options[1].body).toBeUndefined()
    const complete = vi.fn(async () => new Response('{"ok":true}'))
    expect(await pairingRequest('https://smuk.example', token, 'complete', { url: 'https://x.example/webhook', signingSecret: token }, complete)).toEqual({ ok: true })
    expect(complete).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://x.example/webhook', signingSecret: token }) }))
  })
  it.each([401, 403, 404, 409, 410])('explains an expired or invalid connection without revealing server details (%s)', async status => {
    await expect(pairingRequest('https://smuk.example', token, 'manifest', undefined, async () => new Response('private details', { status }))).rejects.toThrow('expired or changed')
  })
  it('handles network, body-read, refusal, absent and malformed bodies safely', async () => {
    await expect(pairingRequest('https://smuk.example', token, 'manifest', undefined, async () => { throw new Error(token) })).rejects.toThrow('Could not reach SMUK securely')
    await expect(pairingRequest('https://smuk.example', token, 'manifest', undefined, async () => new Response('private', { status: 500 }))).rejects.toThrow('could not complete')
    await expect(pairingRequest('https://smuk.example', token, 'manifest', undefined, async () => new Response(null))).rejects.toThrow('incomplete')
    await expect(pairingRequest('https://smuk.example', token, 'manifest', undefined, async () => new Response('not json'))).rejects.toThrow('invalid setup response')
    await expect(pairingRequest('https://smuk.example', token, 'manifest', undefined, async () => new Response(new Uint8Array([0xff])))).rejects.toThrow('invalid setup response')
    const failed = new ReadableStream({ pull(controller) { controller.error(new Error('private')) } })
    await expect(pairingRequest('https://smuk.example', token, 'manifest', undefined, async () => new Response(failed))).rejects.toThrow('Could not reach SMUK securely')
  })
  it('joins multibyte chunks, releases the reader, timer and cancellation listener on success', async () => {
    vi.useFakeTimers()
    try {
      const encoded = new TextEncoder().encode(JSON.stringify({ task: 'Hi 😀' }))
      const stream = new ReadableStream({ start(controller) { controller.enqueue(encoded.slice(0, 3)); controller.enqueue(encoded.slice(3, 15)); controller.enqueue(encoded.slice(15)); controller.close() } })
      const controller = new AbortController()
      expect(await pairingRequest('https://smuk.example', token, 'manifest', undefined, async () => new Response(stream), controller.signal)).toEqual({ task: 'Hi 😀' })
      expect(stream.locked).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      await expect(pairingRequest('https://smuk.example', token, 'manifest', undefined, async () => new Response(null, { status: 404 }))).rejects.toThrow('expired or changed')
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('caps actual streamed bytes and accepts exactly the byte limit', async () => {
    const exact = JSON.stringify('a'.repeat(65534))
    expect((await pairingRequest('https://smuk.example', token, 'manifest', undefined, async () => new Response(exact)) as string).length).toBe(65534)
    await expect(pairingRequest('https://smuk.example', token, 'manifest', undefined, async () => new Response(exact + ' '))).rejects.toThrow('oversized')
  })
  it('cancels requests after 10 seconds and when locally interrupted', async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn((_url: string | URL | Request, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        if (options?.signal?.aborted) reject(new Error('cancelled'))
        options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')))
      }))
      const waiting = pairingRequest('https://smuk.example', token, 'manifest', undefined, request)
      const rejection = expect(waiting).rejects.toThrow('Could not reach SMUK securely')
      await vi.advanceTimersByTimeAsync(9999)
      expect(request.mock.calls[0]![1]!.signal!.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1); await rejection
      const controller = new AbortController()
      const interrupted = pairingRequest('https://smuk.example', token, 'manifest', undefined, request, controller.signal)
      controller.abort()
      await expect(interrupted).rejects.toThrow('Could not reach SMUK securely')
      await expect(pairingRequest('https://smuk.example', token, 'manifest', undefined, request, controller.signal)).rejects.toThrow('Could not reach SMUK securely')
    } finally { vi.useRealTimers() }
  })
  it('requires an exact completion acknowledgement', () => {
    expect(completed({ ok: true })).toBe(true)
    for (const value of [null, [], {}, { ok: false }, { ok: 'true' }, { ok: true, url: 'unexpected' }]) expect(completed(value)).toBe(false)
  })
})

describe('temporary tunnel address parsing', () => {
  it('accepts only complete generated HTTPS hosts', () => {
    expect(quickTunnelUrl('Info https://kind-fast-tree.trycloudflare.com\n')).toBe('https://kind-fast-tree.trycloudflare.com')
    expect(quickTunnelUrl('https://' + 'a'.repeat(63) + '.trycloudflare.com\n')).not.toBeNull()
    for (const value of ['http://a.trycloudflare.com', 'https://a.trycloudflare.com.evil', 'https://a.trycloudflare.com:44', 'https://a.trycloudflare.com/path',
      'https://user@a.trycloudflare.com', 'https://a.trycloudflare.com?x=1', 'https://a.trycloudflare.com#x', 'https://-a.trycloudflare.com',
      'https://' + 'a'.repeat(64) + '.trycloudflare.com']) expect(quickTunnelUrl(value + '\n')).toBeNull()
    expect(quickTunnelUrl('https://a.trycloudflare.com')).toBeNull()
    expect(quickTunnelUrl('no address')).toBeNull()
    expect(quickTunnelUrl('https://evil.example\nhttps://x.trycloudflare.com\n')).toBe('https://x.trycloudflare.com')
  })
})

it('waits for an actual tunnel registration and rejects similar log messages', () => {
  const url = 'https://test-tree.trycloudflare.com'
  expect(readyTunnelUrl(url + '\n')).toBeNull()
  expect(readyTunnelUrl('Registered tunnel connection connIndex=0\n')).toBeNull()
  expect(readyTunnelUrl('Registered tunnel connection connIndex=0\n' + url + '\n')).toBe(url)
  expect(readyTunnelUrl(url + '\nINF Registered tunnel connection connIndex=0\n')).toBe(url)
  expect(readyTunnelUrl(url + '\nRegistered tunnel connection')).toBe(url)
  expect(readyTunnelUrl(url + '\nnotRegistered tunnel connection error\n')).toBeNull()
  expect(readyTunnelUrl(url + '\nRegistered tunnel connections failed\n')).toBeNull()
})
