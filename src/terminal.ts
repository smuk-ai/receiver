import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

// Keep lines typed ahead of a prompt, while EOF consistently cancels setup.
export class Terminal {
  private lines: string[] = []
  private waiting: ((line: string | null) => void) | undefined
  private ended = false
  private reader
  constructor(private input: Readable = process.stdin, private output: Writable = process.stdout, onClose?: () => void) {
    this.reader = createInterface({ input, crlfDelay: Infinity })
    this.reader.on('line', line => {
      if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve(line) }
      else this.lines.push(line)
    })
    this.reader.on('close', () => { this.ended = true; this.waiting?.(null); this.waiting = undefined; onClose?.() })
  }
  async ask(prompt = ''): Promise<string | null> {
    this.output.write(prompt)
    if (this.ended) return null
    const line = this.lines.shift()
    if (line !== undefined) return line
    return new Promise(resolve => { this.waiting = resolve })
  }
  close() { this.reader.close(); this.input.pause() }
}
