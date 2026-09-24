import { spawn } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { SetupError, readyTunnelUrl } from './setup.js'

export interface ManagedTunnel { url: string; exited: Promise<void>; stop: () => Promise<void> }
// I/O composition; covered with an actual fake tunnel executable in e2e.
export async function startTunnel(executable: string, port: number, home: string, signal?: AbortSignal): Promise<ManagedTunnel> {
  if (!isAbsolute(executable)) throw new SetupError('The tunnel executable must have an absolute path. Run the SMUK installer again.')
  if (signal?.aborted) throw new SetupError('Connection cancelled.')
  const configDirectory = mkdtempSync(join(home, 'session-')), configPath = join(configDirectory, 'config.yml')
  writeFileSync(configPath, '{}\n', { mode: 0o600, flag: 'wx' })
  const child = spawn(executable, ['tunnel', '--config', configPath, '--no-autoupdate', '--metrics', '127.0.0.1:0', '--url', `http://127.0.0.1:${port}`], {
    env: { HOME: home, PATH: process.env.PATH, NO_COLOR: '1' }, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  })
  let exited = false, resolveExit!: () => void
  const exit = new Promise<void>(resolve => { resolveExit = resolve })
  child.once('close', () => { exited = true; rmSync(configDirectory, { recursive: true, force: true }); resolveExit() })
  const sendSignal = (name: NodeJS.Signals) => {
    if (exited) return
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name); else child.kill(name) } catch { child.kill(name) }
  }
  const stop = async () => {
    sendSignal('SIGTERM')
    const force = setTimeout(() => sendSignal('SIGKILL'), 1000)
    try { await exit } finally { clearTimeout(force) }
  }
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let log = '', settled = false
      const finish = (error?: Error, url?: string) => {
        if (settled) return
        settled = true; clearTimeout(timeout); signal?.removeEventListener('abort', abort)
        if (error) reject(error); else resolve(url!)
      }
      const abort = () => finish(new SetupError('Connection cancelled.'))
      signal?.addEventListener('abort', abort, { once: true })
      const timeout = setTimeout(() => finish(new SetupError('The public connection timed out. Check your network, then reconnect from SMUK.')), 30_000)
      child.once('error', () => finish(new SetupError('The connection helper could not start. Run the SMUK installer again.')))
      child.once('close', () => finish(new SetupError('The public connection stopped before it was ready. Reconnect from SMUK.')))
      const data = (chunk: Buffer) => {
        if (settled) return
        log += chunk.toString('utf8')
        if (Buffer.byteLength(log) > 32 * 1024) { finish(new SetupError('The connection helper did not provide a usable address. Reconnect from SMUK.')); return }
        const url = readyTunnelUrl(log)
        if (url) finish(undefined, url)
      }
      child.stdout!.on('data', data); child.stderr!.on('data', data)
    })
    return { url, exited: exit, stop }
  } catch (error) { await stop(); throw error }
}
