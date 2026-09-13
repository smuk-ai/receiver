import { fork } from 'node:child_process'
import { rmSync } from 'node:fs'
import type { AgentProvider } from './protocol.js'
import { runAgent } from './runner.js'

// I/O composition, exercised against the bundled artifact by test/e2e.mjs.
// A separate watchdog owns the runner's timeout. IPC disconnect survives the
// receiver's SIGKILL and cancels the whole CLI process group.
export function superviseAgent(provider: AgentProvider, input: string, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Processing stopped')); return }
    const child = fork(process.argv[1], ['--worker'], { cwd, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    let result: string | undefined, failed = false
    const stop = () => child.kill('SIGTERM')
    signal.addEventListener('abort', stop, { once: true })
    child.on('message', value => {
      if (typeof value === 'string') result = value
      else failed = true
    })
    child.on('error', () => { failed = true })
    // A failed fork emits error + close, but never exit.
    child.once('close', code => {
      signal.removeEventListener('abort', stop)
      if (!signal.aborted && !failed && code === 0 && result !== undefined) resolve(result)
      else reject(new Error('Agent processing failed or stopped'))
    })
    child.send({ provider, input }, error => { if (error) { failed = true; stop() } })
  })
}

export function startWorker() {
  if (!process.send) throw new Error('Worker requires a local supervisor')
  const controller = new AbortController()
  let started = false
  const stop = () => { controller.abort(); if (!started) process.exit(1) }
  process.once('disconnect', stop)
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  process.once('message', async ({ provider, input }: { provider: AgentProvider; input: string }) => {
    started = true
    let result: string | null = null
    try { result = await runAgent(provider, input, process.cwd(), process.env, undefined, undefined, controller.signal) }
    catch { /* no provider error or stderr crosses the IPC boundary */ }
    finally { rmSync(process.cwd(), { recursive: true, force: true }) }
    if (process.connected) process.send!(result, () => process.exit(result === null ? 1 : 0))
    else process.exit(1)
  })
}
