import { acceptPayload, agentInput, type ReceiverConfig } from './policy.js'
import type { Inbox } from './inbox.js'

// Single consumer, explicit start, one run at a time, at most 10 starts/minute.
// Failure is held for review: no automatic retry can silently burn a quota.
export async function processNext(config: ReceiverConfig, inbox: Pick<Inbox, 'claim' | 'finish'>,
  run: (input: string) => Promise<string>): Promise<boolean> {
  const payload = inbox.claim()
  if (!payload) return false
  // Revalidate queued work too: local policy can change while jobs wait.
  if (!acceptPayload(payload, config)) {
    inbox.finish(payload.eventId, null, 'Queued message no longer matches receiver policy')
    return true
  }
  try {
    const result = await run(agentInput(payload, config))
    inbox.finish(payload.eventId, result, null)
  } catch {
    inbox.finish(payload.eventId, null, 'Processing failed; check CLI installation, sign-in, output format and limits. No automatic retry.')
  }
  return true
}
