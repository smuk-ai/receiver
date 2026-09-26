import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, renameSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { AGENT_PROVIDERS } from './protocol.js'
import { Inbox } from './inbox.js'
import { parseConfig, type ReceiverConfig } from './policy.js'
import { startWorker } from './supervisor.js'
import { Terminal } from './terminal.js'
import { lockReceiver, startSession, type ReceiverSession } from './session.js'
import { startTunnel, type ManagedTunnel } from './tunnel.js'
import { SetupError, pairingLink, parseManifest, installationId, approvedConfig, approvalSummary, pairingRequest, completed } from './setup.js'

// Composition root, exercised by test/e2e.mjs. Public HTTP never exposes local
// configuration, agent controls or answers. Signed verification reports only
// whether approval matches and the local processing opt-in mode.
async function main() {
  const [command, value, ...options] = process.argv.slice(2)
  process.umask(0o077)
  let session: ReceiverSession | undefined, tunnel: ManagedTunnel | undefined, terminal: Terminal | undefined, unlock: (() => void) | undefined
  let closing = false, connected = false, cleaning: Promise<void> = Promise.resolve()
  const cancellation = new AbortController()
  const cleanup = () => {
    closing = true; cancellation.abort(); terminal?.close()
    // Disable scheduling/cancel AI immediately. Never wait for the tunnel's
    // termination grace period before stopping work on the user's computer.
    const currentSession = session; session = undefined
    const stopSession = currentSession?.stop()
    const currentTunnel = tunnel; tunnel = undefined
    const stopTunnel = currentTunnel?.stop()
    cleaning = Promise.all([cleaning, stopSession, stopTunnel]).then(() => {})
    return cleaning
  }
  const interrupted = () => { if (!closing) void cleanup().finally(() => { process.exitCode = 0 }) }
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted); process.once('SIGHUP', interrupted)
  try {
    if (command === 'setup') {
      if (!value || options.length !== 2 || options[0] !== '--tunnel' || !options[1]) throw new SetupError('Use the complete connection command copied from SMUK.')
      const link = pairingLink(value)
      terminal = new Terminal(process.stdin, process.stdout, interrupted)
      const manifest = parseManifest(await pairingRequest(link.origin, link.token, 'manifest', undefined, undefined, cancellation.signal))
      if (closing) return
      const root = join(homedir(), '.smuk', 'receivers', installationId(link.origin, manifest.nodeId)), configPath = join(root, 'config.json')
      mkdirSync(root, { recursive: true, mode: 0o700 })
      unlock = lockReceiver(root)
      let previous: ReceiverConfig | undefined
      if (existsSync(configPath)) {
        try { previous = parseConfig(JSON.parse(readFileSync(configPath, 'utf8'))) }
        catch { throw new SetupError('The saved receiver configuration could not be read. Existing data was preserved.') }
      }
      console.log('\nReview this receiver on your computer:\n' + approvalSummary(manifest, link.origin))
      if (previous) console.log('Your saved inbox, signing key and local sender/channel/server restrictions will be kept.')
      const approval = await terminal.ask('\nType approve to save this setup and receive messages (AI processing stays off): ')
      if (approval !== 'approve' || closing) { console.log('Setup cancelled. Your receiver configuration was not changed.'); return }
      const config = parseConfig(approvedConfig(manifest, previous, () => randomBytes(32).toString('hex')))
      // The held receiver lock prevents another serving/setup process from seeing
      // a changing policy. Rename commits the complete file atomically.
      const temporary = join(root, 'config-' + randomBytes(8).toString('hex') + '.tmp')
      try {
        writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' })
        renameSync(temporary, configPath)
      } finally { rmSync(temporary, { force: true }) }
      session = await startSession(root, config, 0, false, cancellation.signal)
      if (closing) return
      console.log('Opening your temporary public connection…')
      const tunnelHome = join(root, 'tunnel-home')
      mkdirSync(tunnelHome, { recursive: true, mode: 0o700 })
      tunnel = await startTunnel(options[1], session.port, tunnelHome, cancellation.signal)
      if (closing) return
      void tunnel.exited.then(() => { if (!closing) { console.error('The public connection stopped. Reconnect from your SMUK tile.'); interrupted() } })
      const response = await pairingRequest(link.origin, link.token, 'complete', { url: tunnel.url + '/webhook', signingSecret: config.signingSecret }, undefined, cancellation.signal)
      if (!completed(response)) throw new SetupError('SMUK did not confirm the connection. Reconnect from the tile; your local inbox is safe.')
      if (closing) return
      connected = true
      console.log('Connected. Return to SMUK and Publish your blueprint.\nReceiving is on. AI processing is off. Keep this terminal open.\nCommands: process — enable AI; pause — stop new AI jobs; results — show local answers; quit — stop.')
      while (!closing) {
        const line = await terminal.ask('receiver> ')
        if (line === null || line.trim() === 'quit') break
        try {
          if (line.trim() === 'process') { session.enableProcessing(); console.log('AI processing enabled. Your agent account and usage limits apply.') }
          else if (line.trim() === 'pause') { session.pause(); console.log('AI processing paused. Any current job may finish; messages still arrive.') }
          else if (line.trim() === 'results') console.log(session.results())
          else console.log('Use process, pause, results, or quit.')
        } catch (error) { console.error(error instanceof SetupError ? error.message : 'The command could not complete. Processing has not been enabled.') }
      }
      return
    }
    const root = resolve(value ?? './smuk-receiver-data'), configPath = join(root, 'config.json')
    if (command === 'init') {
      if (options.length) throw new SetupError('Usage: node smuk-receiver.mjs init [data-directory]')
      mkdirSync(root, { recursive: true, mode: 0o700 })
      terminal = new Terminal(process.stdin, process.stdout, interrupted)
      const nodeId = await terminal.ask('Agent Receiver node ID from SMUK: ')
      const provider = await terminal.ask(`Agent (${AGENT_PROVIDERS.join(', ')}): `)
      const instructionsFile = await terminal.ask('Path to a UTF-8 file containing your exact processing instructions: ')
      const sources = await terminal.ask('Allowed source node IDs (comma separated): ')
      if (nodeId === null || provider === null || instructionsFile === null || sources === null || closing) throw new SetupError('Setup cancelled. Your configuration was not changed.')
      let instructions: string
      try { instructions = readFileSync(instructionsFile, 'utf8') } catch { throw new SetupError('The instructions file could not be read. Check its path and try again.') }
      const config = parseConfig({ nodeId, provider, instructions, sourceNodeIds: sources.split(',').map(s => s.trim()).filter(Boolean),
        signingSecret: randomBytes(32).toString('hex'), senderIds: [], serverIds: [], channelIds: [] })
      try { writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' }) }
      catch { throw new SetupError('A configuration already exists here or the folder is not writable. Existing data was preserved.') }
      console.log('Receiver configured. Paste this signing secret into the SMUK node:\n' + config.signingSecret)
      console.log('Run serve to receive messages. Add --process to enable the restricted CLI processor.')
      return
    }
    if (command !== 'serve' && command !== 'list') throw new SetupError('Connect from your SMUK tile, or use: node smuk-receiver.mjs init|serve|list [data-directory] [--process]')
    if (options.length > 1 || (options.length && (options[0] !== '--process' || command !== 'serve'))) throw new SetupError('Unknown option. Only serve accepts --process.')
    let config: ReceiverConfig
    try { config = parseConfig(JSON.parse(readFileSync(configPath, 'utf8'))) }
    catch { throw new SetupError('No readable receiver configuration was found. Connect from your SMUK tile or run init first.') }
    if (command === 'list') {
      const inbox = new Inbox(join(root, 'inbox.sqlite'))
      try { console.log(JSON.stringify(inbox.list(), null, 2)) } finally { inbox.close() }
      return
    }
    const port = Number(process.env.SMUK_RECEIVER_PORT ?? 8787)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SetupError('SMUK_RECEIVER_PORT must be a whole number from 1 to 65535.')
    unlock = lockReceiver(root)
    session = await startSession(root, config, port, options[0] === '--process', cancellation.signal)
    if (closing) return
    console.log(`Receiver listening on http://127.0.0.1:${session.port}/webhook; processing ${options[0] === '--process' ? 'enabled' : 'paused'}`)
    await new Promise<void>(resolve => {
      const end = () => { resolve() }
      process.once('SIGINT', end); process.once('SIGTERM', end); process.once('SIGHUP', end)
    })
  } finally { await cleanup(); unlock?.(); if (connected) console.log('Receiver stopped. To reconnect, use Connect computer on the same tile in SMUK. Your inbox and approved settings are saved.'); process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted); process.removeListener('SIGHUP', interrupted) }
}
if (process.argv[2] === '--worker') startWorker()
else main().catch(error => { console.error(error instanceof SetupError ? error.message : 'Receiver could not start. Check the configuration and folder permissions. Existing data has been preserved.'); process.exitCode = 1 })
