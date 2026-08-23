#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const bundle = resolve(process.argv[2] || 'build/desktop-core-macos')
const manifestPath = join(bundle, 'desktop-bundle.json')

function fail(message) {
  console.error(`[desktop:package:harness] ${message}`)
  process.exit(1)
}

function filesUnder(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

if (!existsSync(manifestPath)) fail(`missing ${manifestPath}`)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const core = join(bundle, 'YomiCore')
const runtime = join(bundle, 'runtime')
const runtimeBinary = join(runtime, manifest.platform === 'windows' ? 'node.exe' : 'node')
for (const required of [
  join(core, 'run.mjs'),
  join(core, 'dist', 'mcp', 'server.js'),
  join(core, 'LICENSE'),
  join(core, 'NOTICE'),
  join(runtime, 'NODE-LICENSE'),
  runtimeBinary,
]) {
  if (!existsSync(required)) fail(`missing bundled file: ${required}`)
}
for (const excluded of [
  join(core, 'node_modules', '@huggingface'),
  join(core, 'node_modules', 'onnxruntime-node'),
  join(core, 'node_modules', 'onnxruntime-web'),
  join(core, 'node_modules', 'onnxruntime-common'),
]) {
  if (existsSync(excluded)) fail(`lite bundle contains deferred ML dependency: ${excluded}`)
}
if (
  existsSync(join(core, 'src')) ||
  filesUnder(join(core, 'dist')).some((path) => path.endsWith('.test.js') || path.endsWith('.test.ts'))
) {
  fail('bundle contains source or test files')
}
const maxBytes = Number(process.env.YOMI_DESKTOP_MAX_UNPACKED_MB || 220) * 1024 * 1024
if (manifest.bytes.total > maxBytes) fail('bundle exceeds unpacked size budget')
if (statSync(runtimeBinary).size > manifest.bytes.runtime) fail('runtime size accounting is invalid')

const smoke = spawnSync(runtimeBinary, [join(core, 'run.mjs'), 'version'], {
  cwd: core,
  encoding: 'utf8',
  env: { ...process.env, YOMI_SKIP_UPDATE_CHECK: '1' },
})
if (smoke.status !== 0 || smoke.stdout.trim() !== manifest.version) {
  fail(`installed-core smoke failed: ${smoke.stderr || smoke.stdout}`)
}

console.log(
  `[desktop:package:harness] ${manifest.platform}/${manifest.semantic} ` +
    `${(manifest.bytes.total / 1024 / 1024).toFixed(1)} MB, structure and runtime smoke passed`,
)
