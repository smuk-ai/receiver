import type { AgentPayload } from '../src/protocol.js'
import type { ReceiverConfig } from '../src/policy.js'

const sourceNodeId = '11111111-1111-4111-8111-111111111111'
export const config: ReceiverConfig = {
  nodeId: 'out', provider: 'Codex', instructions: 'Summarize as JSON.', signingSecret: 'ab'.repeat(32),
  sourceNodeIds: [sourceNodeId], senderIds: [], channelIds: [], serverIds: [],
}

export const payload = (): AgentPayload => ({
  schemaVersion: 1,
  eventId: 'a'.repeat(64),
  agent: { provider: config.provider, instructions: config.instructions },
  message: {
    nodeId: config.nodeId,
    sourceNodeId,
    text: 'Hello from Discord!',
    sender: 'example_user',
    senderId: '234567890123456789',
    platform: 'discord',
    receivedAt: '2026-09-12T12:00:00.000Z',
    channelId: '123456789012345678',
    channelName: 'general',
    serverId: '987654321098765432',
    serverName: 'Example Server',
  },
})
