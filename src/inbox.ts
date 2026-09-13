import { DatabaseSync } from 'node:sqlite'
import type { AgentPayload } from './protocol.js'

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_INBOX = 1000

export class Inbox {
  private db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, created INTEGER NOT NULL,
      state TEXT NOT NULL, payload TEXT NOT NULL, result TEXT, error TEXT);`)
  }
  recover() { this.db.exec("UPDATE messages SET state='interrupted', error='Receiver stopped during processing; review before retrying' WHERE state='running'") }
  close() { this.db.close() }
  prune(now: number) { this.db.prepare("DELETE FROM messages WHERE created < ? AND state != 'running'").run(now - RETENTION_MS) }
  enqueue(payload: AgentPayload, now: number): 'accepted' | 'duplicate' | 'full' {
    this.prune(now)
    if (this.db.prepare('SELECT id FROM messages WHERE id = ?').get(payload.eventId)) return 'duplicate'
    const count = this.db.prepare('SELECT count(*) AS n FROM messages').get()!.n as number
    if (count >= MAX_INBOX) return 'full'
    this.db.prepare("INSERT INTO messages(id,created,state,payload) VALUES(?,?,'queued',?)").run(payload.eventId, now, JSON.stringify(payload))
    return 'accepted'
  }
  claim(): AgentPayload | null {
    const row = this.db.prepare("UPDATE messages SET state='running' WHERE id=(SELECT id FROM messages WHERE state='queued' ORDER BY created,id LIMIT 1) RETURNING payload").get()
    return row ? JSON.parse(row.payload as string) as AgentPayload : null
  }
  finish(id: string, result: string | null, error: string | null) {
    this.db.prepare("UPDATE messages SET state=?,result=?,error=? WHERE id=? AND state='running'").run(error ? 'failed' : 'completed', result, error, id)
  }
  list() { return this.db.prepare('SELECT id,created,state,result,error FROM messages ORDER BY created DESC LIMIT 100').all() }
}
