import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const metadata = JSON.parse(readFileSync('package.json', 'utf8'))
const notice = readFileSync('NOTICE', 'utf8')
const root = mkdtempSync(join(tmpdir(), 'smuk-package-'))
const buildScript = resolve('scripts/build.mjs')

function assertLicensing(files) {
  assert.equal(createHash('sha256').update(files.LICENSE).digest('hex'),
    'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30', 'license differs from canonical Apache 2.0 text')
  assert.equal(files.NOTICE, notice, 'package attribution differs from source')
  assert.equal(JSON.parse(files['package.json']).license, 'Apache-2.0', 'package license metadata')
  assert.equal(JSON.parse(files['package.json']).version, metadata.version)
  const bundle = files['dist/smuk-receiver.mjs']
  assert.ok(bundle.startsWith('#!/usr/bin/env node\n'), 'standalone shebang must remain first')
  assert.ok(bundle.includes(files.LICENSE.trimEnd()), 'standalone must include complete license')
  assert.ok(bundle.includes(notice.trimEnd()), 'standalone must include attribution')
  assert.ok(files['dist/protocol.js'].includes('Copyright 2026 SMUK AI'), 'protocol attribution missing')
  assert.ok(files['dist/protocol.js'].includes('SPDX-License-Identifier: Apache-2.0'), 'protocol license missing')
}

try {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { encoding: 'utf8' }))
  const archive = join(root, pack.filename)
  const names = ['LICENSE', 'NOTICE', 'package.json', 'dist/smuk-receiver.mjs', 'dist/protocol.js']
  const files = Object.fromEntries(names.map(name => [name, execFileSync('tar', ['-xOf', archive, `package/${name}`], { encoding: 'utf8' })]))
  assertLicensing(files)
  assert.equal(pack.files.find(file => file.path === 'dist/smuk-receiver.mjs').mode & 0o111, 0o111, 'packaged CLI must be executable')
  assert.throws(() => assertLicensing({ ...files, LICENSE: '' }), /canonical Apache/)
  assert.throws(() => assertLicensing({ ...files, NOTICE: '' }), /attribution differs/)
  assert.throws(() => assertLicensing({ ...files, 'package.json': JSON.stringify({ ...metadata, license: 'UNLICENSED' }) }), /license metadata/)
  assert.throws(() => assertLicensing({ ...files, 'dist/smuk-receiver.mjs': files['dist/smuk-receiver.mjs'].replace(files.LICENSE.trimEnd(), '') }), /complete license/)
  assert.throws(() => assertLicensing({ ...files, 'dist/protocol.js': '' }), /protocol attribution/)

  // Exercise the actual build's failure path; missing legal files must not
  // destroy a previously built distribution or produce an unlicensed one.
  mkdirSync(join(root, 'dist'))
  writeFileSync(join(root, 'dist', 'existing'), 'previous build')
  for (const missing of ['LICENSE', 'NOTICE']) {
    const result = spawnSync(process.execPath, [buildScript], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes('ENOENT') && result.stderr.includes(missing))
    assert.equal(readFileSync(join(root, 'dist', 'existing'), 'utf8'), 'previous build')
    writeFileSync(join(root, missing), files[missing])
  }
  console.log('Actual package licensing, executable mode, broken fixtures and missing-license build failures verified')
} finally {
  rmSync(root, { recursive: true, force: true })
}
