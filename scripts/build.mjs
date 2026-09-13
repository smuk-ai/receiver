import { execFileSync } from 'node:child_process'
import { chmodSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'

rmSync('dist', { recursive: true, force: true })
execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], { stdio: 'inherit' })
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/smuk-receiver.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: { js: '#!/usr/bin/env node\n// SMUK user-owned receiver. Requires Node.js 22.13+. See https://smuk.ai/agent-receiver.html.' },
})
chmodSync('dist/smuk-receiver.mjs', 0o755)
