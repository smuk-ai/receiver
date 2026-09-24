import { writeFileSync, mkdtempSync, rmSync, existsSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Inbox } from './inbox.js'
import type { ReceiverConfig } from './policy.js'
import { createReceiver } from './service.js'
import { superviseAgent } from './supervisor.js'
import { processNext } from './worker.js'
import { assertAgentIsolation, geminiRestrictions } from './isolation.js'
import { formatResults } from './results.js'
import { SetupError } from './setup.js'

export function lockReceiver(root: string): () => void {
  const path = join(root, 'receiver.lock')
  try { closeSync(openSync(path, 'wx', 0o600)) }
  catch { throw new SetupError('This receiver is already running or has a leftover lock. Stop its other terminal first. After a crash, verify its old processes have stopped before removing receiver.lock.') }
  let released = false
  return () => { if (!released) { released = true; rmSync(path, { force: true }) } }
}
export interface ReceiverSession {
  port: number
  enableProcessing(): void
  pause(): void
  results(): string
  stop(): Promise<void>
}

// Trusted local lifecycle only. The tunneled HTTP surface remains write-only.
export async function startSession(root: string, config: ReceiverConfig, port: number, processing = false, signal?: AbortSignal): Promise<ReceiverSession> {
  if (signal?.aborted) throw new SetupError('Receiver startup cancelled.')
  const checkProcessing = () => {
    if (process.platform === 'win32') throw new SetupError('Processing requires macOS or Linux. This computer can still receive messages.')
    try { assertAgentIsolation(config.provider, process.env.HOME) }
    catch { throw new SetupError('This agent cannot process safely in this computer account. Grok requires a clean Linux account. Follow the agent prerequisites in the setup guide.') }
  }
  if (processing) checkProcessing()
  const inbox = new Inbox(join(root, 'inbox.sqlite'))
  inbox.recover()
  const server = createReceiver(config, inbox)
  try { await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok) }) }
  catch { inbox.close(); throw new SetupError('The receiver could not open its local port. Stop the other receiver or choose a different SMUK_RECEIVER_PORT.') }
  if (signal?.aborted) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    inbox.close(); throw new SetupError('Receiver startup cancelled.')
  }
  const address = server.address()
  if (!address || typeof address === 'string') { server.close(); inbox.close(); throw new SetupError('The receiver could not open its local address.') }
  let enabled = processing, stopping = false, timer: ReturnType<typeof setTimeout> | undefined, stopped: Promise<void> | undefined
  const controller = new AbortController()
  let running: Promise<void> = Promise.resolve()
  const work = async () => {
    if (stopping) return
    try {
      inbox.prune(Date.now())
      if (enabled && !existsSync(join(root, 'PAUSE'))) {
        await processNext(config, inbox, async input => {
          assertAgentIsolation(config.provider, process.env.HOME)
          const cwd = mkdtempSync(join(tmpdir(), 'smuk-agent-work-'))
          const settings = join(cwd, 'gemini-settings.json')
          writeFileSync(settings, JSON.stringify(geminiRestrictions()), { mode: 0o600 })
          const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME,
            LANG: 'en_US.UTF-8', NO_COLOR: '1', GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings }
          try { return await superviseAgent(config.provider, input, cwd, env, controller.signal) }
          finally { rmSync(cwd, { recursive: true, force: true }) }
        })
      }
    } catch { enabled = false; console.error('Receiver storage/processing error; pausing processing'); writeFileSync(join(root, 'PAUSE'), '') }
    if (!stopping) timer = setTimeout(() => { running = work() }, 6000)
  }
  running = work()
  return { port: address.port,
    enableProcessing() { checkProcessing(); rmSync(join(root, 'PAUSE'), { force: true }); enabled = true },
    pause() { enabled = false; writeFileSync(join(root, 'PAUSE'), '') },
    results() {
      const rows = inbox.list()
      return formatResults(rows)
    },
    stop() {
      if (stopped) return stopped
      stopping = true; controller.abort(); if (timer) clearTimeout(timer)
      // Active inbound sockets are short lived, but shutdown must not wait on a sender.
      server.closeAllConnections()
      stopped = new Promise<void>(resolve => server.close(() => { void running.finally(() => { inbox.close(); resolve() }) }))
      return stopped
    },
  }
}
