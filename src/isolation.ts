import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentProvider } from './protocol.js'

// Grok lacks a documented switch disabling all inherited startup/prompt hooks.
// Refuse those discovery paths, rather than pretending --tools disables hooks.
export function assertAgentIsolation(provider: AgentProvider, home: string | undefined, exists = existsSync, platform = process.platform): void {
  if (!home) throw new Error('A signed-in dedicated OS account is required')
  if (provider !== 'Grok Build') return
  // macOS MDM can inject executable hooks through preferences, outside these
  // file discovery paths. Until that can be audited, Grok processing is Linux only.
  if (platform !== 'linux') throw new Error('Grok processing requires a clean Linux account')
  const forbidden = [
    '.grok/config.toml', '.grok/hooks', '.grok/plugins', '.grok/skills', '.grok/AGENTS.md', '.grok/mcp.json',
    '.grok/managed_config.toml', '.grok/requirements.toml', '.grok/lsp.json', '.claude.json', '.cursor/mcp.json',
    '.claude/settings.json', '.claude/settings.local.json', '.claude/plugins', '.claude/skills', '.claude/CLAUDE.md',
    '.cursor/hooks.json', '.agents',
  ]
  if ([...forbidden.map(path => join(home, path)), '/etc/grok/managed_config.toml', '/etc/grok/requirements.toml'].some(path => exists(path)))
    throw new Error('Grok requires a clean dedicated account without inherited config, hooks, plugins or skills')
}

export function geminiRestrictions() {
  return { tools: { core: [], discoveryCommand: '', callCommand: '' }, mcp: { allowed: [] },
    hooksConfig: { enabled: false }, skills: { enabled: false }, experimental: { enableAgents: false },
    security: { disableYoloMode: true } }
}
