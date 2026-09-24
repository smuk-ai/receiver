import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { Terminal } from './terminal.js'

it('keeps lines typed between prompts and writes each prompt', async () => {
  const input = new PassThrough(), output = new PassThrough(), terminal = new Terminal(input, output)
  let text = ''; output.on('data', chunk => { text += chunk })
  const first = terminal.ask('First: ')
  input.write('approve\nresults\n')
  expect(await first).toBe('approve')
  expect(await terminal.ask('Next: ')).toBe('results')
  expect(text).toBe('First: Next: ')
  terminal.close()
})
it('treats closed input as cancellation, including queued lines', async () => {
  const input = new PassThrough(), terminal = new Terminal(input, new PassThrough())
  const pending = terminal.ask()
  input.end()
  expect(await pending).toBeNull()
  expect(await terminal.ask()).toBeNull()
  terminal.close()
})

it('closing cancels a waiting prompt and stops reading the input stream', async () => {
  const input = new PassThrough(), terminal = new Terminal(input, new PassThrough())
  const waiting = terminal.ask()
  terminal.close()
  expect(await waiting).toBeNull()
  expect(input.isPaused()).toBe(true)
  expect(await terminal.ask()).toBeNull()
})

it('notifies the owner when input ends so startup work can be cancelled', async () => {
  const input = new PassThrough(), ended = vi.fn(), terminal = new Terminal(input, new PassThrough(), ended)
  const waiting = terminal.ask()
  input.end()
  expect(await waiting).toBeNull()
  expect(ended).toHaveBeenCalledTimes(1)
  terminal.close()
  expect(ended).toHaveBeenCalledTimes(1)
})
