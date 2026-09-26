import { it, expect, vi } from 'vitest'
import { processNext } from './worker.js'
import { config, payload } from '../test/fixtures.js'
it('does no model work when idle and passes approved messages to the runner', async () => {
  const run = vi.fn().mockResolvedValue('{"summary":"ok"}'), finish = vi.fn()
  expect(await processNext(config, { claim: () => null, finish }, run)).toBe(false)
  expect(run).not.toHaveBeenCalled()
  expect(await processNext(config, { claim: payload, finish }, run)).toBe(true)
  expect(run).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify(payload().message)))
  expect(finish).toHaveBeenCalledWith(payload().eventId, '{"summary":"ok"}', null)
})
it('holds revoked and failed work without retrying or exposing provider errors', async () => {
  const run = vi.fn().mockRejectedValue(new Error('secret credential')), finish = vi.fn()
  expect(await processNext({ ...config, instructions: 'changed' }, { claim: payload, finish }, run)).toBe(true)
  expect(run).not.toHaveBeenCalled()
  expect(finish).toHaveBeenCalledWith(payload().eventId, null, expect.stringContaining('policy'))
  await processNext(config, { claim: payload, finish }, run)
  expect(run).toHaveBeenCalledTimes(1)
  // Inbox.finish treats an empty error as successful completion.
  expect(finish.mock.calls[1][2]).toMatch(/\S/)
  expect(finish.mock.calls[1][2]).not.toContain('secret credential')
  expect(finish.mock.calls[1][1]).toBeNull()
})
it('rechecks a saved destination on dequeue and retains the actual tile in agent input', async () => {
  const saved = { ...config, destinationId: config.nodeId }, p = payload()
  const delivery = { ...p, agent: { ...p.agent, destinationId: config.nodeId }, message: { ...p.message, nodeId: 'actual-tile' } }
  const run = vi.fn().mockResolvedValue('{"ok":true}'), finish = vi.fn()
  await processNext(saved, { claim: () => delivery, finish }, run)
  expect(JSON.parse(run.mock.calls[0][0].split('UNTRUSTED_MESSAGE_JSON:\n')[1]).nodeId).toBe('actual-tile')
  for (const policy of [config, { ...saved, destinationId: 'other', nodeId: 'other' }, { ...saved, sourceNodeIds: ['revoked'] }]) {
    run.mockClear(); finish.mockClear()
    expect(await processNext(policy, { claim: () => delivery, finish }, run)).toBe(true)
    expect(run).not.toHaveBeenCalled()
    expect(finish).toHaveBeenCalledWith(delivery.eventId, null, expect.stringContaining('policy'))
  }
})
