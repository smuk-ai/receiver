import { it, expect } from 'vitest'
import { assertAgentIsolation, geminiRestrictions } from './isolation.js'
it('refuses Grok inherited execution paths and requires an explicit signed-in home', () => {
  expect(() => assertAgentIsolation('Codex', undefined)).toThrow()
  expect(() => assertAgentIsolation('Codex', '/dedicated', () => true)).not.toThrow()
  expect(() => assertAgentIsolation('Grok Build', '/dedicated', () => false, 'linux')).not.toThrow()
  for (const platform of ['darwin', 'win32'] as const) expect(() => assertAgentIsolation('Grok Build', '/dedicated', () => false, platform)).toThrow(/Linux/)
  for (const path of ['.grok/config.toml', '.grok/hooks', '.grok/plugins', '.grok/skills', '.grok/AGENTS.md', '.grok/mcp.json',
    '.grok/managed_config.toml', '.grok/requirements.toml', '.grok/lsp.json', '.claude.json', '.cursor/mcp.json',
    '.claude/settings.json', '.claude/settings.local.json', '.claude/plugins', '.claude/skills', '.claude/CLAUDE.md', '.cursor/hooks.json', '.agents'])
    expect(() => assertAgentIsolation('Grok Build', '/dedicated', candidate => String(candidate) === '/dedicated/' + path, 'linux')).toThrow(/clean dedicated account/)
  for (const system of ['/etc/grok/managed_config.toml', '/etc/grok/requirements.toml'])
    expect(() => assertAgentIsolation('Grok Build', '/dedicated', candidate => String(candidate) === system, 'linux')).toThrow(/clean dedicated account/)
})
it('disables Gemini built-ins, external discovery, hooks and agent/skill discovery', () => {
  const settings = geminiRestrictions()
  expect(settings.tools.core).toEqual([])
  expect(settings.tools.discoveryCommand).toBe(''); expect(settings.tools.callCommand).toBe('')
  expect(settings.mcp.allowed).toEqual([])
  expect(settings.hooksConfig.enabled).toBe(false)
  expect(settings.skills.enabled).toBe(false)
  expect(settings.experimental.enableAgents).toBe(false)
  expect(settings.security.disableYoloMode).toBe(true)
})
