// Real HTTPS pairing, bundled CLI, fake tunnel + agent, and durable local state.
// No external tunnel, provider sign-in, real credentials or paid calls.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:https'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, createHmac } from 'node:crypto'

const root = mkdtempSync(join(tmpdir(), 'smuk-setup-e2e-')), bundle = resolve('dist/smuk-receiver.mjs')
const home = join(root, 'home'), bin = join(root, 'bin'), calls = join(root, 'calls'), tunnelState = join(root, 'tunnel.json')
mkdirSync(home); mkdirSync(bin)
const cert = join(root, 'cert.pem'), key = join(root, 'key.pem')
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' })
const token = 'a1'.repeat(32), manifest = { schemaVersion: 1, nodeId: 'setup-destination', provider: 'Codex', instructions: 'Summarize as JSON.\n', sourceNodeIds: ['source'] }
let completions = [], rejectComplete = false
const api = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
  assert.equal(req.headers.authorization, 'Bearer ' + token)
  assert.equal(req.method, 'POST')
  assert.ok(!req.url.includes(token))
  res.setHeader('content-type', 'application/json')
  if (req.url === '/api/receiver-pairings/manifest') { res.end(JSON.stringify(manifest)); return }
  assert.equal(req.url, '/api/receiver-pairings/complete')
  let text = ''; for await (const chunk of req) text += chunk
  completions.push(JSON.parse(text))
  res.statusCode = rejectComplete ? 404 : 200
  res.end(JSON.stringify(rejectComplete ? { error: 'private diagnostic' } : { ok: true }))
}).listen(0, '127.0.0.1')
await once(api, 'listening')
const link = `https://localhost:${api.address().port}/#${token}`
const fakeTunnel = join(bin, 'cloudflared')
writeFileSync(fakeTunnel, `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(tunnelState)},JSON.stringify({args,home:process.env.HOME,pid:process.pid,env:process.env.UNTRUSTED_TEST_ENV}));
process.stderr.write('https://kind-test-tree.trycloudflare.com\\nRegistered tunnel connection connIndex=0\\n');
setInterval(()=>{},1000);
`, { mode: 0o700 })
writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
const fs=require('node:fs');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);
process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(calls)},input+'\\n');console.log(JSON.stringify({summary:'done'}));});
`, { mode: 0o700 })
let data = join(home, '.smuk', 'receivers', createHash('sha256').update(JSON.stringify([new URL(link).origin, manifest.nodeId])).digest('hex'))
let configFile = join(data, 'config.json')
let child, output = ''
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check()) return; await sleep(40) }
  throw new Error('Setup timed out: ' + output)
}
function launch(tunnel = fakeTunnel) {
  output = ''
  child = spawn(process.execPath, [bundle, 'setup', link, '--tunnel', tunnel], { env: { ...process.env, HOME: home, PATH: bin + ':' + process.env.PATH, NODE_EXTRA_CA_CERTS: cert, UNTRUSTED_TEST_ENV: 'private' }, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c)
  return child
}
async function finish(signal) {
  const current = child
  if (!current || current.exitCode !== null) return
  if (signal) current.kill(signal); else current.stdin.write('quit\n')
  await Promise.race([once(current, 'exit'), sleep(5000).then(() => { if (current.exitCode === null) throw new Error('Setup would not stop: ' + output) })])
  child = null
}
function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
function payload(n, instructions = manifest.instructions, source = 'source') {
  return { schemaVersion: 1, eventId: String(n).padStart(64, '0'), agent: { provider: manifest.provider, instructions, ...(manifest.destinationId ? { destinationId: manifest.destinationId } : {}) },
    message: { nodeId: manifest.destinationId ? 'actual-blueprint-tile-' + n : manifest.nodeId, sourceNodeId: source, text: 'hello', sender: 'sender', senderId: null,
      platform: 'discord', receivedAt: new Date().toISOString(), channelId: null, channelName: null, serverId: null, serverName: null } }
}
async function post(value, path = '/webhook') {
  const state = JSON.parse(readFileSync(tunnelState)), local = state.args[state.args.indexOf('--url') + 1]
  const config = JSON.parse(readFileSync(configFile)), body = JSON.stringify(value), timestamp = String(Math.floor(Date.now() / 1000))
  const signature = 'v1=' + createHmac('sha256', Buffer.from(config.signingSecret, 'hex')).update(timestamp + '.' + body).digest('hex')
  return fetch(local + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-smuk-timestamp': timestamp, 'x-smuk-signature': signature }, body })
}
function rows() { return JSON.parse(execFileSync(process.execPath, [bundle, 'list', data], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) }
let nonce = 0
async function verify(mode) {
  const challenge = { schemaVersion: 1, type: 'smuk.receiver.verify', nonce: (++nonce).toString(16).padStart(64, '0'),
    nodeId: manifest.nodeId, ...(manifest.destinationId ? { destinationId: manifest.destinationId } : {}),
    provider: manifest.provider, instructions: manifest.instructions, sourceNodeIds: manifest.sourceNodeIds }
  const before = rows(), beforeCalls = existsSync(calls) ? readFileSync(calls, 'utf8') : null
  const response = await post(challenge, '/verify'), body = await response.text()
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(body), { schemaVersion: 1, type: 'smuk.receiver.verified', nonce: challenge.nonce,
    approval: 'matched', mode, receiverVersion: JSON.parse(readFileSync('package.json')).version })
  const key = JSON.parse(readFileSync(configFile)).signingSecret, time = response.headers.get('x-smuk-timestamp')
  assert.equal(response.headers.get('x-smuk-signature'), 'v1=' + createHmac('sha256', Buffer.from(key, 'hex')).update(time + '.' + body).digest('hex'))
  assert.deepEqual(rows(), before, 'verification changed the inbox')
  assert.equal(existsSync(calls) ? readFileSync(calls, 'utf8') : null, beforeCalls, 'verification launched the agent')
  assert.equal((await post(challenge, '/verify')).status, 409)
}

try {
  launch(); await until(() => output.includes('Type approve'))
  assert.ok(output.includes('Summarize as JSON.\\n')); assert.ok(output.includes('"source"'))
  child.stdin.end()
  await once(child, 'exit'); child = null
  assert.equal(existsSync(configFile), false, 'EOF created a configuration')
  assert.equal(completions.length, 0)

  launch(); await until(() => output.includes('Type approve')); child.stdin.write('approve\n')
  await until(() => output.includes('Connected. Return to SMUK'))
  const original = JSON.parse(readFileSync(configFile)), tunnel = JSON.parse(readFileSync(tunnelState))
  assert.equal(statSync(configFile).mode & 0o777, 0o600)
  assert.equal(statSync(data).mode & 0o777, 0o700)
  assert.equal(completions.length, 1)
  assert.deepEqual(completions[0], { url: 'https://kind-test-tree.trycloudflare.com/webhook', signingSecret: original.signingSecret })
  assert.ok(tunnel.home.startsWith(data)); assert.notEqual(tunnel.home, home); assert.equal(tunnel.env, undefined)
  assert.equal(tunnel.args[0], 'tunnel'); assert.ok(tunnel.args.includes('--no-autoupdate'))
  assert.equal(tunnel.args[tunnel.args.indexOf('--metrics') + 1], '127.0.0.1:0')
  assert.equal(readFileSync(tunnel.args[tunnel.args.indexOf('--config') + 1], 'utf8'), '{}\n')
  assert.ok(!output.includes(original.signingSecret)); assert.ok(!output.includes(token))
  const local = tunnel.args[tunnel.args.indexOf('--url') + 1]
  for (const path of ['/config', '/results', '/status', '/']) assert.equal((await fetch(local + path)).status, 404)
  await verify('receiving')
  assert.equal((await post(payload(1))).status, 202)
  await sleep(200); assert.equal(rows()[0].state, 'queued'); assert.equal(existsSync(calls), false)
  child.stdin.write('results\n'); await until(() => output.includes('Waiting for processing'))

  // A simultaneous setup must not overwrite the active policy or its lock.
  const other = spawn(process.execPath, [bundle, 'setup', link, '--tunnel', fakeTunnel], { env: { ...process.env, HOME: home, NODE_EXTRA_CA_CERTS: cert }, stdio: ['pipe', 'pipe', 'pipe'] })
  let otherText = ''; other.stderr.on('data', c => otherText += c)
  await once(other, 'exit'); assert.equal(other.exitCode, 1); assert.ok(otherText.includes('already running'))
  assert.equal(existsSync(join(data, 'receiver.lock')), true)
  child.stdin.write('process\n')
  await until(() => rows()[0].state === 'completed')
  await verify('processing')
  child.stdin.write('pause\n'); await until(() => output.includes('processing paused'))
  await verify('paused')
  assert.equal((await post(payload(2))).status, 202)
  await sleep(6300); assert.equal(rows().find(r => r.id === payload(2).eventId).state, 'queued')
  await finish('SIGHUP'); assert.equal(alive(tunnel.pid), false); assert.equal(existsSync(join(data, 'receiver.lock')), false)

  // Changed instructions require new local approval; cancellation keeps bytes intact.
  manifest.instructions = 'New task.'
  const saved = readFileSync(configFile, 'utf8')
  launch(); await until(() => output.includes('Type approve')); child.stdin.write('no\n'); await once(child, 'exit'); child = null
  assert.equal(readFileSync(configFile, 'utf8'), saved)
  launch(); await until(() => output.includes('Type approve')); child.stdin.write('approve\n')
  await until(() => output.includes('Connected. Return to SMUK'))
  const updated = JSON.parse(readFileSync(configFile))
  assert.equal(updated.signingSecret, original.signingSecret); assert.equal(updated.instructions, 'New task.')
  assert.equal(rows().length, 2); assert.equal(rows().find(r => r.id === payload(2).eventId).state, 'queued')
  await sleep(200); assert.equal(readFileSync(calls, 'utf8').split('PROCESSING_TASK_JSON:').length - 1, 1, 'restart enabled processing')
  child.stdin.write('process\n')
  await until(() => rows().find(r => r.id === payload(2).eventId).state === 'failed')
  assert.equal(readFileSync(calls, 'utf8').split('PROCESSING_TASK_JSON:').length - 1, 1, 'old queued policy was processed')
  await finish()

  rejectComplete = true
  launch(); await until(() => output.includes('Type approve')); child.stdin.write('approve\n')
  await once(child, 'exit'); assert.equal(child.exitCode, 1); child = null
  assert.ok(output.includes('expired or changed')); assert.ok(!output.includes('private diagnostic'))
  assert.equal(alive(JSON.parse(readFileSync(tunnelState)).pid), false)
  assert.equal(existsSync(join(data, 'receiver.lock')), false)
  rejectComplete = false

  // An announced hostname is not readiness; EOF during startup cleans up immediately.
  const waitingTunnel = join(bin, 'waiting-tunnel'), waitingState = join(root, 'waiting-tunnel.pid')
  writeFileSync(waitingTunnel, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(waitingState)},String(process.pid));process.stderr.write('https://waiting-test.trycloudflare.com\\n');setInterval(()=>{},1000);\n`, { mode: 0o700 })
  const beforeWaiting = completions.length
  launch(waitingTunnel); await until(() => output.includes('Type approve')); child.stdin.write('approve\n')
  await until(() => existsSync(waitingState)); await sleep(100)
  assert.equal(completions.length, beforeWaiting, 'hostname announcement incorrectly counted as a ready tunnel')
  child.stdin.end()
  const waitingChild = child
  await Promise.race([once(waitingChild, 'exit'), sleep(5000).then(() => { if (waitingChild.exitCode === null) throw new Error('EOF did not cancel tunnel startup') })])
  child = null
  assert.equal(alive(Number(readFileSync(waitingState, 'utf8'))), false)
  assert.equal(existsSync(join(data, 'receiver.lock')), false)

  const broken = join(bin, 'broken-tunnel')
  writeFileSync(broken, '#!/usr/bin/env node\nprocess.exit(2)\n', { mode: 0o700 })
  launch(broken); await until(() => output.includes('Type approve')); child.stdin.write('approve\n')
  await once(child, 'exit'); assert.equal(child.exitCode, 1); child = null
  assert.ok(output.includes('stopped before it was ready')); assert.equal(existsSync(join(data, 'receiver.lock')), false)
  assert.equal(JSON.parse(readFileSync(configFile)).signingSecret, original.signingSecret)

  // A slow tunnel shutdown must not leave the six-second AI scheduler alive.
  const stubborn = join(bin, 'stubborn-tunnel')
  writeFileSync(stubborn, readFileSync(fakeTunnel, 'utf8').replace('setInterval(()=>{},1000);', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"), { mode: 0o700 })
  launch(stubborn); await until(() => output.includes('Type approve')); child.stdin.write('approve\n')
  await until(() => output.includes('Connected. Return to SMUK'))
  const beforeQuitCalls = readFileSync(calls, 'utf8')
  assert.equal((await post(payload(3))).status, 202)
  await sleep(5300)
  child.stdin.write('process\n'); await until(() => output.includes('AI processing enabled'))
  await finish()
  assert.equal(readFileSync(calls, 'utf8'), beforeQuitCalls, 'an agent started after the user quit')
  assert.equal(rows().find(row => row.id === payload(3).eventId).state, 'queued')
  assert.equal(alive(JSON.parse(readFileSync(tunnelState)).pid), false)

  launch(); await until(() => output.includes('Type approve')); child.stdin.write('approve\n'); await until(() => output.includes('Connected. Return to SMUK'))
  process.kill(JSON.parse(readFileSync(tunnelState)).pid, 'SIGTERM')
  await once(child, 'exit'); child = null
  assert.ok(output.includes('public connection stopped')); assert.equal(existsSync(join(data, 'receiver.lock')), false)
  // Saved-agent setup retains a stable profile identity while different tiles
  // deliver through it. Verification never consumes queue capacity or runs AI.
  const legacyConfig = configFile, oldConfig = readFileSync(legacyConfig, 'utf8')
  manifest.nodeId = 'saved-agent-profile'; manifest.destinationId = manifest.nodeId
  data = join(home, '.smuk', 'receivers', createHash('sha256').update(JSON.stringify([new URL(link).origin, manifest.nodeId])).digest('hex'))
  configFile = join(data, 'config.json')
  launch(); await until(() => output.includes('Type approve'))
  assert.ok(output.includes('Saved agent destination: "saved-agent-profile"'))
  child.stdin.write('approve\n'); await until(() => output.includes('Connected. Return to SMUK'))
  assert.equal(JSON.parse(readFileSync(configFile)).destinationId, manifest.destinationId)
  assert.equal(readFileSync(legacyConfig, 'utf8'), oldConfig, 'saved-agent setup changed legacy installation')
  await verify('receiving')
  const deliveries = [payload(10), payload(11)]
  for (const delivery of deliveries) assert.equal((await post(delivery)).status, 202)
  const database = new DatabaseSync(join(data, 'inbox.sqlite'), { readOnly: true })
  try { assert.deepEqual(database.prepare('SELECT payload FROM messages').all().map(row => JSON.parse(row.payload).message.nodeId).sort(), deliveries.map(p => p.message.nodeId).sort()) } finally { database.close() }
  const unapproved = { ...payload(12), agent: { ...payload(12).agent, destinationId: 'different-profile' } }
  assert.equal((await post(unapproved)).status, 403)
  child.stdin.write('pause\n'); await until(() => output.includes('processing paused')); await verify('paused')
  await finish()
  console.log('SETUP APPROVAL, HTTPS PAIRING, PRIVATE TUNNEL, LOCAL CONTROLS, RECONNECT, POLICY RECHECK, FAILURE AND CLEANUP OK')
} finally {
  await finish('SIGTERM')
  await new Promise(resolve => api.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
