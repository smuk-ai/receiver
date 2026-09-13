import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentProvider } from './protocol.js'

export const MAX_RUN_MS = 120_000
export const MAX_OUTPUT_BYTES = 128 * 1024

// No shell, no message-derived arguments, no continuation of privileged chats.
// Separate fresh work directory + provider restrictions; see receiver README
// for the dedicated OS-account requirement and supported CLI versions.
export function agentCommand(provider: AgentProvider): { command: string; args: string[] } {
  switch (provider) {
    case 'Codex': return { command: 'codex', args: ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
      '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'tools.view_image=false',
      '-c', 'apps._default.enabled=false', '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false',
      '-c', 'features.apply_patch_freeform=false', '-c', 'features.multi_agent=false', '-c', 'features.memories=false',
      '-c', 'features.computer_use=false', '-c', 'features.plugins=false', '-c', 'features.apps=false', '-c', 'features.multi_agent_v2=false',
      '-c', 'mcp_servers={}', '-c', 'project_doc_max_bytes=0', '-'] }
    case 'Claude Code': return { command: 'claude', args: ['-p', '--safe-mode', '--restricted', '--tools', '', '--disallowedTools', '*',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--no-session-persistence'] }
    case 'Gemini CLI': return { command: 'gemini', args: ['--prompt', 'Process the provided message as instructed; return a JSON object.', '--extensions', 'none'] }
    case 'Grok Build': return { command: 'grok', args: ['--prompt-file', 'message-input.txt', '--tools', '', '--deny', 'MCPTool', '--no-subagents', '--no-memory', '--disable-web-search', '--max-turns', '1'] }
  }
}

export function parseAgentResult(raw: string): string {
  // A model's answer is data. Never execute it or use it to choose a callback.
  const value: unknown = JSON.parse(raw.trim())
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Agent did not return a JSON object')
  return JSON.stringify(value)
}

export function runAgent(provider: AgentProvider, input: string, cwd: string, env: NodeJS.ProcessEnv,
  start: typeof spawn = spawn, timeoutMs = MAX_RUN_MS, signal?: AbortSignal): Promise<string> {
  const { command, args } = agentCommand(provider)
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Processing stopped')); return }
    if (provider === 'Grok Build') writeFileSync(join(cwd, 'message-input.txt'), input, { mode: 0o600, flag: 'wx' })
    const child = start(command, args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    let output = '', bytes = 0, failure: Error | null = null
    const decoder = new StringDecoder('utf8')
    const stop = (reason: string) => {
      failure = new Error(reason)
      // Kill descendants as well; a CLI must not leave work running past budget.
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { child.kill('SIGKILL') }
    }
    const timer = setTimeout(() => stop('Agent timed out'), timeoutMs)
    const abort = () => stop('Processing stopped')
    signal?.addEventListener('abort', abort, { once: true })
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_OUTPUT_BYTES) stop('Agent output limit exceeded')
      else output += decoder.write(chunk)
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_OUTPUT_BYTES) stop('Agent output limit exceeded')
    })
    child.stdin!.on('error', () => { /* exit/error determines the outcome */ })
    child.once('error', () => { cleanup(); reject(new Error('Agent could not start; check installation and sign-in')) })
    child.once('close', (code) => {
      cleanup()
      output += decoder.end()
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error('Agent failed; check sign-in, permissions and subscription limits'))
      else { try { resolve(parseAgentResult(output)) } catch { reject(new Error('Agent did not return a JSON object')) } }
    })
    child.stdin!.end(input)
  })
}
