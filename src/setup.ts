import { createHash } from 'node:crypto'
import { AGENT_PROVIDERS, MAX_INSTRUCTIONS, type AgentProvider } from './protocol.js'
import type { ReceiverConfig } from './policy.js'

export class SetupError extends Error {}
export interface SetupManifest {
  schemaVersion: 1
  nodeId: string
  destinationId?: string
  provider: AgentProvider
  instructions: string
  sourceNodeIds: string[]
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max

export function parseManifest(value: unknown): SetupManifest {
  if (!record(value) || Object.keys(value).filter(key => key !== 'destinationId').sort().join(',') !== 'instructions,nodeId,provider,schemaVersion,sourceNodeIds' ||
      value.schemaVersion !== 1 || !text(value.nodeId, 200) ||
      ('destinationId' in value && (!text(value.destinationId, 200) || value.destinationId !== value.nodeId)) || !AGENT_PROVIDERS.includes(value.provider as AgentProvider) ||
      !text(value.instructions, MAX_INSTRUCTIONS) || !value.instructions.trim() || !Array.isArray(value.sourceNodeIds) ||
      value.sourceNodeIds.length === 0 || value.sourceNodeIds.length > 100 || !value.sourceNodeIds.every(id => text(id, 200)) ||
      new Set(value.sourceNodeIds).size !== value.sourceNodeIds.length) throw new SetupError('This setup is invalid. Create a new connection command in SMUK.')
  return { schemaVersion: 1, nodeId: value.nodeId, ...('destinationId' in value ? { destinationId: value.destinationId as string } : {}), provider: value.provider as AgentProvider,
    instructions: value.instructions, sourceNodeIds: [...value.sourceNodeIds] as string[] }
}

export function pairingLink(value: string): { origin: string; token: string } {
  let url: URL
  try { url = new URL(value) } catch { throw new SetupError('Use the complete connection link from SMUK.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || !/^#[a-f0-9]{64}$/.test(url.hash))
    throw new SetupError('Use the HTTPS connection link from SMUK, including its setup code.')
  return { origin: url.origin, token: url.hash.slice(1) }
}

export function installationId(origin: string, nodeId: string): string { return createHash('sha256').update(JSON.stringify([origin, nodeId])).digest('hex') }

// Preserve locally chosen restrictions and signing keys on every reconnection.
export function approvedConfig(manifest: SetupManifest, previous: ReceiverConfig | undefined, newSecret: () => string): ReceiverConfig {
  if (previous && (previous.nodeId !== manifest.nodeId || previous.destinationId !== manifest.destinationId)) throw new SetupError('The saved receiver belongs to a different tile. Existing data was preserved.')
  return { nodeId: manifest.nodeId, ...(manifest.destinationId === undefined ? {} : { destinationId: manifest.destinationId }), provider: manifest.provider, instructions: manifest.instructions,
    sourceNodeIds: [...manifest.sourceNodeIds], signingSecret: previous?.signingSecret ?? newSecret(),
    senderIds: [...(previous?.senderIds ?? [])], serverIds: [...(previous?.serverIds ?? [])], channelIds: [...(previous?.channelIds ?? [])] }
}

export function approvalSummary(manifest: SetupManifest, origin: string): string {
  // JSON escaping prevents terminal control characters from hiding approval details.
  return `SMUK site: ${JSON.stringify(origin)}\nAgent: ${manifest.provider}\n${manifest.destinationId === undefined ? 'Tile' : 'Saved agent destination'}: ${JSON.stringify(manifest.nodeId)}\nInstructions (exact text):\n${JSON.stringify(manifest.instructions)}\nAllowed source tiles:\n${manifest.sourceNodeIds.map(id => '  ' + JSON.stringify(id)).join('\n')}`
}

const MAX_RESPONSE_BYTES = 64 * 1024
export async function pairingRequest(origin: string, token: string, endpoint: 'manifest' | 'complete', body?: unknown,
  request: typeof fetch = fetch, signal?: AbortSignal): Promise<unknown> {
  // Origin and token are parsed by pairingLink before this I/O boundary. An
  // injected request function lets tests simulate networking without HTTP bypasses.
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timer = setTimeout(abort, 10_000)
  try {
    const response = await request(`${origin}/api/receiver-pairings/${endpoint}`, { method: 'POST', redirect: 'error',
      signal: controller.signal, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (!response.ok) {
      await response.body?.cancel()
      if ([401, 403, 404, 409, 410].includes(response.status)) throw new SetupError('This connection command has expired or changed. Create a new one in SMUK.')
      throw new SetupError('SMUK could not complete the connection. Try a new connection command shortly.')
    }
    if (!response.body) throw new SetupError('SMUK returned an incomplete setup response. Try a new connection command.')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new SetupError('SMUK returned an oversized setup response.') }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    const raw = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown }
    catch { throw new SetupError('SMUK returned an invalid setup response. Try a new connection command.') }
  } catch (error) {
    if (error instanceof SetupError) throw error
    throw new SetupError('Could not reach SMUK securely. Check your connection and create a new connection command.')
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}

export function completed(value: unknown): boolean { return record(value) && Object.keys(value).length === 1 && value.ok === true }

export function quickTunnelUrl(log: string): string | null {
  const matches = log.match(/https:\/\/[^\s<>"'`]+(?=\s)/g) ?? []
  for (const candidate of matches) {
    // Match the whole logged URL; reject deceptive suffixes, paths and ports.
    if (/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(candidate) && new URL(candidate).hostname.split('.')[0]!.length <= 63) return candidate
  }
  return null
}

export function readyTunnelUrl(log: string): string | null {
  return /(?:^|\s)Registered tunnel connection(?:\s|$)/.test(log) ? quickTunnelUrl(log) : null
}
