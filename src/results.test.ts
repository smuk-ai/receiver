import { expect, it } from 'vitest'
import { formatResults } from './results.js'
const created = Date.UTC(2026, 8, 23, 12)
it('shows readable states, timestamps and parsed JSON answers', () => {
  expect(formatResults([])).toContain('No messages yet')
  const text = formatResults([{ state: 'completed', created, result: JSON.stringify({ summary: 'Hello\x1b[2J' }) },
    { state: 'queued', created }, { state: 'running', created }, { state: 'failed', created, error: 'Stopped\x1b[2J' },
    { state: 'interrupted', created }])
  expect(text).toContain('Completed · 2026-09-23 12:00:00 UTC')
  expect(text).toContain('Waiting for processing'); expect(text).toContain('Processing'); expect(text).toContain('Failed'); expect(text).toContain('Interrupted')
  expect(text).toContain('"summary": "Hello\\u001b[2J"')
  expect(text).toContain('"Stopped\\u001b[2J"')
  expect(text).not.toContain('\x1b'); expect(text).not.toContain('"result":')
  expect(formatResults([{ state: 'queued', created }])).toContain('Latest 1 message:')
})
it('bounds display without changing stored results and handles invalid saved data', () => {
  const rows = Array.from({ length: 11 }, (_, i) => ({ state: 'completed', created, result: JSON.stringify({ n: i }) }))
  const text = formatResults(rows)
  expect(text).toContain('Latest 10 messages:'); expect(text).toContain('"n": 9'); expect(text).not.toContain('"n": 10')
  expect(rows).toHaveLength(11)
  expect(formatResults([{ state: 'nonsense', created: 'bad' }])).toContain('Unknown status · time unavailable')
  expect(formatResults([{ state: null, created: Infinity }])).toContain('Unknown status · time unavailable')
  expect(formatResults([{ state: ['completed'], created: '2026-09-23' }])).toContain('Unknown status · time unavailable')
  expect(formatResults([{ state: 'queued', created, error: 12345 }])).not.toContain('12345')
  expect(formatResults([{ state: 'completed', created: 1e100, result: 'bad json' }])).toContain('saved answer could not be read')
  const exact = JSON.stringify('a'.repeat(3998))
  expect(formatResults([{ state: 'completed', created, result: exact }])).toContain(exact)
  expect(formatResults([{ state: 'completed', created, result: exact }])).not.toContain('Full answer')
  const truncated = formatResults([{ state: 'completed', created, result: JSON.stringify('a'.repeat(4100) + 'PRIVATE_TAIL') }])
  expect(truncated).toContain('Full answer is saved locally')
  expect(truncated).not.toContain('PRIVATE_TAIL')
})
