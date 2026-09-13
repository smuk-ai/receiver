// Browser-safe wire contract shared by senders and the local receiver.
// Authentication covers the exact UTF-8 JSON bytes; unknown fields are not part
// of this protocol and are dropped by the receiver's policy boundary.
export const AGENT_PROVIDERS = ['Codex', 'Claude Code', 'Gemini CLI', 'Grok Build'] as const
export type AgentProvider = typeof AGENT_PROVIDERS[number]
export const MAX_INSTRUCTIONS = 8000

export interface AgentMessage {
  nodeId: string
  sourceNodeId: string | null
  text: string
  sender: string
  senderId: string | null
  platform: string
  receivedAt: string
  channelId: string | null
  channelName: string | null
  serverId: string | null
  serverName: string | null
}

export interface AgentPayload {
  schemaVersion: 1
  eventId: string
  agent: {
    // Raw senders may hold unvalidated configuration. ReceiverConfig narrows
    // this to AgentProvider only after the runtime policy check.
    provider: string
    instructions: string
  }
  message: AgentMessage
}
