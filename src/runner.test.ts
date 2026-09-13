import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, it, expect, vi } from 'vitest'
import { agentCommand, parseAgentResult, runAgent, MAX_OUTPUT_BYTES } from './runner.js'
import { AGENT_PROVIDERS } from './protocol.js'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fakeStart() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) })
  child.kill.mockImplementation(() => { queueMicrotask(() => child.emit('close', null)); return true })
  const start = vi.fn(() => child)
  return { child, start: start as unknown as Parameters<typeof runAgent>[4], mock: start }
}
describe('CLI runner', () => {
  it('constructs valid headless CLI arguments with every security option attached to its value', () => {
    const codex = parseArgs({args:agentCommand('Codex').args, allowPositionals:true, options:{
      config:{type:'string',short:'c',multiple:true}, sandbox:{type:'string'},
      'ignore-user-config':{type:'boolean'},'ignore-rules':{type:'boolean'},ephemeral:{type:'boolean'},'skip-git-repo-check':{type:'boolean'},
    }})
    expect(codex.positionals).toEqual(['exec','-'])
    for (const key of ['ignore-user-config','ignore-rules','ephemeral','skip-git-repo-check'] as const) expect(codex.values[key]).toBe(true)
    expect(codex.values.sandbox).toBe('read-only')
    const settings = Object.fromEntries(codex.values.config!.map(c => { const at = c.indexOf('='); return [c.slice(0,at),JSON.parse(c.slice(at+1))] }))
    expect(settings).toMatchObject({approval_policy:'never',web_search:'disabled','tools.view_image':false,
      'apps._default.enabled':false,'features.shell_tool':false,'features.unified_exec':false,'features.apply_patch_freeform':false,
      'features.multi_agent':false,'features.memories':false,'features.computer_use':false,'features.plugins':false,
      'features.apps':false,'features.multi_agent_v2':false,mcp_servers:{},project_doc_max_bytes:0})
    const claude = parseArgs({args:agentCommand('Claude Code').args,options:{print:{type:'boolean',short:'p'},'safe-mode':{type:'boolean'},
      restricted:{type:'boolean'},tools:{type:'string'},'disallowedTools':{type:'string'},'strict-mcp-config':{type:'boolean'},
      'mcp-config':{type:'string'},'setting-sources':{type:'string'},'no-session-persistence':{type:'boolean'}}}).values
    expect(claude).toMatchObject({print:true,'safe-mode':true,restricted:true,tools:'',disallowedTools:'*','strict-mcp-config':true,'setting-sources':'','no-session-persistence':true})
    expect(JSON.parse(claude['mcp-config']!)).toEqual({mcpServers:{}})
    const gemini = parseArgs({args:agentCommand('Gemini CLI').args,options:{prompt:{type:'string'},extensions:{type:'string'}}}).values
    expect(gemini.prompt).toMatch(/JSON object/); expect(gemini.extensions).toBe('none')
    const grok = parseArgs({args:agentCommand('Grok Build').args,options:{'prompt-file':{type:'string'},tools:{type:'string'},deny:{type:'string'},
      'no-subagents':{type:'boolean'},'no-memory':{type:'boolean'},'disable-web-search':{type:'boolean'},'max-turns':{type:'string'}}}).values
    expect(grok).toMatchObject({'prompt-file':'message-input.txt',tools:'',deny:'MCPTool','no-subagents':true,'no-memory':true,'disable-web-search':true,'max-turns':'1'})
  })
  it('maps all providers to fixed commands with tool restrictions and no permission bypass', () => {
    expect(AGENT_PROVIDERS.map(p => agentCommand(p).command)).toEqual(['codex', 'claude', 'gemini', 'grok'])
    expect(agentCommand('Codex').args).toEqual(expect.arrayContaining(['--ignore-user-config', '--ephemeral', 'features.shell_tool=false', 'apps._default.enabled=false', 'tools.view_image=false', 'web_search="disabled"', 'mcp_servers={}']))
    expect(agentCommand('Claude Code').args).toEqual(expect.arrayContaining(['--safe-mode', '--restricted', '--tools', '', '--disallowedTools', '*', '--strict-mcp-config']))
    expect(agentCommand('Gemini CLI').args).toEqual(expect.arrayContaining(['--extensions', 'none']))
    expect(agentCommand('Grok Build').args).toEqual(expect.arrayContaining(['--tools', '', '--deny', 'MCPTool', '--no-subagents', '--disable-web-search']))
    for (const p of AGENT_PROVIDERS) expect(agentCommand(p).args.join(' ')).not.toMatch(/yolo|dangerously|always-approve/)
  })
  it('validates object results and refuses commands, arrays and non-JSON prose', () => {
    expect(parseAgentResult(' { "summary": "hi" }\n')).toBe('{"summary":"hi"}')
    expect(parseAgentResult('\uFEFF{"summary":"with a UTF-8 BOM"}\n')).toBe('{"summary":"with a UTF-8 BOM"}')
    for (const result of ['null', '[]', '"command"', 'true', '1', 'run this', '```json\n{}\n```']) expect(() => parseAgentResult(result)).toThrow()
  })
  it('passes hostile text as stdin only and returns bounded JSON output', async () => {
    const { child, start, mock } = fakeStart()
    const input = '$(touch /tmp/evil)\n--dangerously-bypass-approvals-and-sandbox'
    const promise = runAgent('Codex', input, '/empty-workdir', { PATH: '/bin' }, start)
    expect(mock).toHaveBeenCalledWith('codex', agentCommand('Codex').args, expect.objectContaining({ shell: false, cwd: '/empty-workdir', env: { PATH: '/bin' }, stdio:['pipe','pipe','pipe'], detached:true }))
    expect(child.stdin.read().toString()).toBe(input)
    child.stdout.write('{"result":'); child.stderr.write('provider progress'); child.stdout.write('"ok"}')
    child.emit('close', 0)
    await expect(promise).resolves.toBe('{"result":"ok"}')
  })
  it('fails closed on launch failure, nonzero exit, malformed output and timeout', async () => {
    for (const mode of ['launch', 'exit', 'invalid', 'timeout']) {
      const { child, start } = fakeStart()
      const promise = runAgent('Claude Code', 'input', '/empty', {}, start, 10)
      if (mode === 'launch') child.emit('error', new Error('secret paths'))
      if (mode === 'exit') child.emit('close', 1)
      if (mode === 'invalid') { child.stdout.write('not JSON'); child.emit('close', 0) }
      await expect(promise).rejects.toThrow(mode === 'timeout' ? /timed out/ : /Agent/)
      if (mode === 'timeout') expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    }
  })
  it('caps both stdout and stderr and tolerates a closed stdin', async () => {
    for (const stream of ['stdout', 'stderr'] as const) {
      const { child, start } = fakeStart()
      const cwd = mkdtempSync(join(tmpdir(), 'receiver-runner-'))
      const promise = runAgent('Grok Build', 'input', cwd, {}, start)
      expect(readFileSync(join(cwd, 'message-input.txt'), 'utf8')).toBe('input')
      expect(statSync(join(cwd,'message-input.txt')).mode & 0o777).toBe(0o600)
      await expect(runAgent('Grok Build', 'overwrite', cwd, {}, start)).rejects.toThrow()
      expect(readFileSync(join(cwd,'message-input.txt'),'utf8')).toBe('input')
      child.stdin.emit('error', new Error('EPIPE'))
      child[stream].write(Buffer.alloc(MAX_OUTPUT_BYTES + 1))
      await expect(promise).rejects.toThrow(/output limit/)
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      rmSync(cwd, { recursive: true })
    }
  })
  it('cancels an active child and refuses to launch after cancellation', async () => {
    const controller = new AbortController(), { child, start, mock } = fakeStart()
    const promise = runAgent('Codex', 'input', '/empty', {}, start, 1000, controller.signal)
    controller.abort()
    await expect(promise).rejects.toThrow('Processing stopped')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    await expect(runAgent('Codex', 'input', '/empty', {}, start, 1000, controller.signal)).rejects.toThrow('Processing stopped')
    expect(mock).toHaveBeenCalledTimes(1)
  })
  it('preserves multibyte characters across stdout chunks', async () => {
    const { child, start } = fakeStart(), promise = runAgent('Codex', 'input', '/empty', {}, start)
    const bytes = Buffer.from('{"text":"é"}')
    const at = bytes.indexOf(Buffer.from('é'))
    child.stdout.write(bytes.subarray(0, at + 1)); child.stdout.write(bytes.subarray(at + 1)); child.emit('close', 0)
    await expect(promise).resolves.toBe('{"text":"é"}')
  })
  it('kills the entire process group, falls back if the group vanished, and removes cancellation after settlement', async () => {
    for (const groupMissing of [false,true]) {
      const { child,start } = fakeStart(), controller = new AbortController()
      Object.assign(child,{pid:123456})
      const kill = vi.spyOn(process,'kill').mockImplementation(() => {
        if (groupMissing) throw new Error('ESRCH')
        queueMicrotask(() => child.emit('close',null)); return true
      })
      try {
        const promise = runAgent('Codex','input','/unused',{},start,1000,controller.signal)
        controller.abort()
        await expect(promise).rejects.toThrow(/stopped/)
        expect(kill).toHaveBeenCalledWith(-123456,'SIGKILL')
        expect(child.kill).toHaveBeenCalledTimes(groupMissing ? 1 : 0)
        if (groupMissing) expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      } finally { kill.mockRestore() }
    }
  })
  it('uses direct child termination on Windows or when a process group ID is unavailable', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('Unexpected process-group termination') })
    try {
      for (const [os, pid] of [['win32', 123456], ['linux', undefined]] as const) {
        Object.defineProperty(process, 'platform', { ...platform, value: os })
        const { child, start, mock } = fakeStart(), controller = new AbortController()
        Object.assign(child, { pid })
        const promise = runAgent('Codex', 'input', '/unused', {}, start, 1000, controller.signal)
        expect(mock).toHaveBeenCalledWith('codex', agentCommand('Codex').args,
          expect.objectContaining({ detached: os !== 'win32' }))
        controller.abort()
        await expect(promise).rejects.toThrow(/stopped/)
        expect(child.kill).toHaveBeenCalledWith('SIGKILL')
        expect(kill).not.toHaveBeenCalled()
      }
    } finally {
      Object.defineProperty(process, 'platform', platform)
      kill.mockRestore()
    }
  })
  it('allows exactly 128 KiB output, counts stderr with stdout, and rejects nonzero exit even with valid JSON', async () => {
    for (const stream of ['stdout','stderr'] as const) {
      const {child,start}=fakeStart(), promise=runAgent('Codex','input','/unused',{},start)
      const padding = Buffer.alloc(128*1024 - 2, ' ')
      child.stdout.write('{}'); child[stream].write(padding); child.emit('close',0)
      await expect(promise).resolves.toBe('{}')
      expect(child.kill).not.toHaveBeenCalled()
    }
    const {child,start}=fakeStart(), promise=runAgent('Codex','input','/unused',{},start)
    child.stdout.write('{}'); child.emit('close',1)
    await expect(promise).rejects.toThrow(/failed/)
  })
  it('enforces the two-minute default and clears its timer and listener on exit or launch failure', async () => {
    vi.useFakeTimers()
    try {
      const {child,start}=fakeStart(), promise=runAgent('Codex','input','/unused',{},start)
      const assertion=expect(promise).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(119999); expect(child.kill).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1); await assertion
      for (const fail of [false,true]) {
        const next=fakeStart(), controller=new AbortController()
        const result=runAgent('Codex','input','/unused',{},next.start,undefined,controller.signal)
        if (fail) { next.child.emit('error',new Error('missing')); await expect(result).rejects.toThrow(/could not start/) }
        else { next.child.stdout.write('{}'); next.child.emit('close',0); await expect(result).resolves.toBe('{}') }
        controller.abort(); await vi.advanceTimersByTimeAsync(120001)
        expect(next.child.kill).not.toHaveBeenCalled()
      }
    } finally { vi.useRealTimers() }
  })
})
