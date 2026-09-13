import { describe, it, expect } from 'vitest'
import { Inbox, RETENTION_MS, MAX_INBOX } from './inbox.js'
import { payload } from '../test/fixtures.js'

describe('durable inbox', () => {
  it('expires records after seven calendar days during enqueue and releases storage on close', () => {
    const inbox = new Inbox(':memory:'), start = Date.parse('2026-09-01T00:00:00Z')
    inbox.enqueue(payload(), start)
    expect(inbox.enqueue(payload(), Date.parse('2026-09-08T00:00:00Z'))).toBe('duplicate')
    expect(inbox.enqueue(payload(), Date.parse('2026-09-08T00:00:00.001Z'))).toBe('accepted')
    inbox.close()
    expect(() => inbox.list()).toThrow()
  })
  it('deduplicates, claims once and records output without re-running completed messages', () => {
    const inbox = new Inbox(':memory:')
    try {
      expect(inbox.claim()).toBeNull()
      expect(inbox.enqueue(payload(), 1)).toBe('accepted')
      expect(inbox.enqueue(payload(), 2)).toBe('duplicate')
      expect(inbox.claim()).toEqual(payload())
      expect(inbox.claim()).toBeNull()
      inbox.finish(payload().eventId, '{"summary":"ok"}', null)
      expect(inbox.list()[0]).toMatchObject({ state: 'completed', result: '{"summary":"ok"}', error: null })
      inbox.finish(payload().eventId, null, 'late failure')
      expect(inbox.list()[0].state).toBe('completed')
      expect(inbox.enqueue(payload(), 3)).toBe('duplicate')
    } finally { inbox.close() }
  })
  it('holds interrupted and failed jobs, pruning only expired nonrunning work', () => {
    const inbox = new Inbox(':memory:')
    try {
      inbox.enqueue(payload(), 0); inbox.claim()
      inbox.prune(RETENTION_MS + 1)
      expect(inbox.list()).toHaveLength(1)
      inbox.recover()
      expect(inbox.list()[0].state).toBe('interrupted')
      expect(inbox.claim()).toBeNull()
      inbox.prune(RETENTION_MS)
      expect(inbox.list()).toHaveLength(1)
      inbox.prune(RETENTION_MS + 1)
      expect(inbox.list()).toEqual([])
      inbox.enqueue(payload(), RETENTION_MS + 1); inbox.claim(); inbox.finish(payload().eventId, null, 'failure')
      expect(inbox.list()[0]).toMatchObject({ state: 'failed', error: 'failure', result: null })
    } finally { inbox.close() }
  })
  it('bounds retained work while acknowledging known duplicates even when full', () => {
    const inbox = new Inbox(':memory:')
    try {
      for (let i = 0; i < MAX_INBOX; i++) expect(inbox.enqueue({ ...payload(), eventId: String(i) }, i)).toBe('accepted')
      expect(inbox.enqueue({ ...payload(), eventId: 'new' }, 1001)).toBe('full')
      expect(inbox.enqueue({ ...payload(), eventId: '0' }, 1001)).toBe('duplicate')
      expect(inbox.list()).toHaveLength(100)
      expect(inbox.claim()?.eventId).toBe('0')
    } finally { inbox.close() }
  })
})
