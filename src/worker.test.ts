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
