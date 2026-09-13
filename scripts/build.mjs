import { execFileSync } from 'node:child_process'
import { chmodSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'

// The single-file download must carry the complete license and attribution.
// Read these first so missing legal files fail before touching existing output.
const license = readFileSync('LICENSE', 'utf8').trimEnd()
const notice = readFileSync('NOTICE', 'utf8').trimEnd()
rmSync('dist', { recursive: true, force: true })
execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], { stdio: 'inherit' })
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/smuk-receiver.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: { js: `#!/usr/bin/env node\n/*!\n${notice}\nSPDX-License-Identifier: Apache-2.0\n\n${license}\n*/\n// Requires Node.js 22.13+. See https://smuk.ai/agent-receiver.html.` },
})
chmodSync('dist/smuk-receiver.mjs', 0o755)
