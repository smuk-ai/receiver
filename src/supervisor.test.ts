import { it, expect } from 'vitest'
import { superviseAgent } from './supervisor.js'

it('settles when the actual watchdog fork fails before it can emit exit', async () => {
  await expect(superviseAgent('Codex', 'message', '/nonexistent-smuk-receiver-directory', {}, new AbortController().signal)).rejects.toThrow(/failed/)
}, 1000)

it('does not start a watchdog after processing has stopped', async () => {
  const controller = new AbortController(); controller.abort()
  await expect(superviseAgent('Codex', 'message', '/unused', {}, controller.signal)).rejects.toThrow(/stopped/)
})
