import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, openSync, closeSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { AGENT_PROVIDERS } from './protocol.js'
import { Inbox } from './inbox.js'
import { parseConfig } from './policy.js'
import { createReceiver } from './service.js'
import { superviseAgent, startWorker } from './supervisor.js'
import { processNext } from './worker.js'
import { assertAgentIsolation, geminiRestrictions } from './isolation.js'

// Composition root, exercised by test/e2e.mjs. No hosted SMUK credentials
// or model API keys are used here. All state stays in the user-owned directory.
async function main() {
  const [command, directory = './smuk-receiver-data', flag] = process.argv.slice(2)
  const root = resolve(directory), configPath = join(root, 'config.json')
  process.umask(0o077)
  if (command === 'init') {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      const nodeId = await rl.question('Agent Receiver node ID from SMUK: ')
      const provider = await rl.question(`Agent (${AGENT_PROVIDERS.join(', ')}): `)
      const instructionsFile = await rl.question('Path to a UTF-8 file containing your exact processing instructions: ')
      const sourceNodeIds = (await rl.question('Allowed source node IDs (comma separated): ')).split(',').map(s => s.trim()).filter(Boolean)
      const config = parseConfig({ nodeId, provider, instructions: readFileSync(instructionsFile, 'utf8'), sourceNodeIds,
        signingSecret: randomBytes(32).toString('hex'), senderIds: [], serverIds: [], channelIds: [] })
      writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' })
      console.log('Receiver configured. Paste this signing secret into the SMUK node:\n' + config.signingSecret)
      console.log('Run serve to receive messages. Add --process to enable the restricted CLI processor.')
    } finally { rl.close() }
    return
  }
  if (command !== 'serve' && command !== 'list') throw new Error('Usage: node smuk-receiver.mjs init|serve|list [data-directory] [--process]')
  if (flag && flag !== '--process') throw new Error('Unknown option')
  const config = parseConfig(JSON.parse(readFileSync(configPath, 'utf8')))
  if (command === 'list') {
    const inbox = new Inbox(join(root, 'inbox.sqlite'))
    try { console.log(JSON.stringify(inbox.list(), null, 2)) } finally { inbox.close() }
    return
  }
  if (flag === '--process' && process.platform === 'win32') throw new Error('Processing requires macOS or Linux for process-group termination')
  if (flag === '--process') assertAgentIsolation(config.provider, process.env.HOME)
  const port = Number(process.env.SMUK_RECEIVER_PORT ?? 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SMUK_RECEIVER_PORT')
  const lock = join(root, 'receiver.lock')
  closeSync(openSync(lock, 'wx', 0o600))
  process.once('exit', () => { rmSync(lock, { force: true }) })
  const inbox = new Inbox(join(root, 'inbox.sqlite'))
  inbox.recover()
  const server = createReceiver(config, inbox)
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok) })
  console.log(`Receiver listening on http://127.0.0.1:${port}/webhook; processing ${flag === '--process' ? 'enabled' : 'paused'}`)
  let stopping = false, timer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  let running: Promise<void> = Promise.resolve()
  const work = async () => {
    if (stopping) return
    try {
      inbox.prune(Date.now())
      if (flag === '--process' && !existsSync(join(root, 'PAUSE'))) {
        await processNext(config, inbox, async (input) => {
          assertAgentIsolation(config.provider, process.env.HOME)
          const cwd = mkdtempSync(join(tmpdir(), 'smuk-agent-work-'))
          // System settings override Gemini user/project settings. No tools or MCPs.
          const settings = join(cwd, 'gemini-settings.json')
          writeFileSync(settings, JSON.stringify(geminiRestrictions()), { mode: 0o600 })
          const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME,
            LANG: 'en_US.UTF-8', NO_COLOR: '1', GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings }
          try { return await superviseAgent(config.provider, input, cwd, env, controller.signal) }
          finally { rmSync(cwd, { recursive: true, force: true }) }
        })
      }
    } catch { console.error('Receiver storage/processing error; pausing processing'); writeFileSync(join(root, 'PAUSE'), '') }
    if (!stopping) timer = setTimeout(() => { running = work() }, 6000)
  }
  const shutdown = () => {
    stopping = true
    controller.abort()
    if (timer) clearTimeout(timer)
    server.close(() => { void running.finally(() => { inbox.close(); process.exit(0) }) })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  running = work()
}
if (process.argv[2] === '--worker') startWorker()
else main().catch(() => { console.error('Receiver could not start. Check the command, config, permissions, port and receiver.lock. Existing data has been preserved.'); process.exitCode = 1 })
