const SHOW_COUNT = 10
const MAX_RESULT_CHARS = 4000
export function formatResults(rows: Record<string, unknown>[]): string {
  if (!rows.length) return 'No messages yet. Publish your blueprint, then send a matching message.'
  const labels: Record<string, string> = { queued: 'Waiting for processing', running: 'Processing', completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted' }
  const items = rows.slice(0, SHOW_COUNT).map(row => {
    const label = typeof row.state === 'string' ? labels[row.state] ?? 'Unknown status' : 'Unknown status'
    const timestamp = typeof row.created === 'number' && Number.isFinite(row.created) ? new Date(row.created) : new Date(NaN)
    const time = Number.isFinite(timestamp.getTime()) ? timestamp.toISOString().replace('T', ' ').replace('.000Z', ' UTC') : 'time unavailable'
    let detail = ''
    if (typeof row.result === 'string') {
      try {
        // JSON escaping keeps answers inert even when they contain terminal controls.
        const rendered = JSON.stringify(JSON.parse(row.result), null, 2)
        detail = rendered.length > MAX_RESULT_CHARS ? rendered.slice(0, MAX_RESULT_CHARS) + '\n… Full answer is saved locally; use the manual list command to read it.' : rendered
      } catch { detail = 'The saved answer could not be read.' }
    } else if (typeof row.error === 'string') detail = JSON.stringify(row.error)
    return `${label} · ${time}${detail ? '\n' + detail : ''}`
  })
  return `Latest ${items.length} message${items.length === 1 ? '' : 's'}:\n\n${items.join('\n\n')}`
}
