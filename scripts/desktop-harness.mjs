#!/usr/bin/env node
/**
 * Build and freshness gate for the native desktop app.
 * A restart is deliberately a separate, opt-in phase after every check passes.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(new URL('..', import.meta.url).pathname)
const dist = join(root, 'dist')
const source = join(root, 'src')
const app = join(root, 'desktop', 'mac-native', 'Yomi.app')
const executable = join(app, 'Contents', 'MacOS', 'Yomi')
const nativeMain = join(root, 'desktop', 'mac-native', 'main.swift')
const nativeSourceRoot = join(root, 'desktop', 'mac-native')

function fail(message) {
  console.error(`[desktop:harness] ${message}`)
  process.exitCode = 1
}

function assertSource(condition, message) {
  if (!condition) fail('native regression: ' + message)
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env })
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed (${result.status ?? 'signal'})`)
    process.exit(1)
  }
}

function filesUnder(directory) {
  if (!existsSync(directory)) return []
  const result = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...filesUnder(path))
    else result.push(path)
  }
  return result
}

function mtime(path) {
  return statSync(path).mtimeMs
}

run('npm', ['run', 'build'])
mkdirSync(dist, { recursive: true })
writeFileSync(join(dist, '.yomi-build-stamp.json'), JSON.stringify({ builtAt: new Date().toISOString() }) + '\n')

// Static interaction/crash gates run before the native build. They keep the
// two failure modes that previously required a manual repro visible in CI:
// AppKit layout recursion and stale conversation results.
const nativeSwiftFiles = filesUnder(nativeSourceRoot).filter((path) => path.endsWith('.swift'))
const nativeText = nativeSwiftFiles.map((path) => readFileSync(path, 'utf8')).join('\n')
assertSource(!nativeText.includes('class LinkMessageTextView') || !nativeText.includes('override func layout()'), 'LinkMessageTextView must not invalidate intrinsic size from layout()')
assertSource(nativeText.includes('messageLoadGeneration'), 'conversation loads must carry a generation guard')
assertSource(!nativeText.includes('state.selectedChatId = item.id\n                                        state.loadChatMessages'), 'conversation selection must let the loader clear stale content before switching')
assertSource(nativeText.includes('deadline: .now() + 8'), 'conversation loads must time out')
assertSource(!nativeText.includes('Picker("訊息通道"'), 'LINE composer must not expose a recipient mode toggle')
assertSource(nativeText.includes('YomiCommandSurface'), 'Yomi must have a separate contextual command surface')
assertSource(nativeText.includes('private var composerEditorHeight: CGFloat {\n        // The destination changes'), 'composer height must stay mode-independent')
assertSource(!nativeText.includes('parent.isFocused || !textView.string.isEmpty ? 58 : 38'), 'focus must not resize the composer')
assertSource(!nativeText.includes('guard !isYomiMode else { return false }'), 'Yomi composer must accept dropped files')
assertSource(nativeText.includes('voiceInput.toggle(currentText: activeText)'), 'voice input must work in both composer modes')
assertSource(nativeText.includes('yomiStagedAttachments.map(\\.url.path)'), 'Yomi prompts must receive staged local file paths')
assertSource(nativeText.includes('yomi_guardian_introduction_seen_v2'), 'guardian introduction must be persisted as a first-use experience')
assertSource(nativeText.includes('我是阿聞') && nativeText.includes('我是吽行'), 'both guardians must introduce themselves by name')
assertSource(!nativeText.includes('黃泉雙狛') && nativeText.includes('兩位閱巡者，前來值勤'), 'guardian pair must use the original 閱巡者 identity')
assertSource(nativeText.includes('struct YomiGuardiansWatermark'), 'low-attention surfaces must support the guardian watermark')
assertSource(!nativeText.includes('.popover(isPresented: $showYomiSurface'), 'Briefing must open the full Yomi workspace instead of a utility popover')
assertSource(nativeText.includes('Text("交代 Yomi")') && nativeText.includes('Text("⌘J")'), 'Briefing must expose an outcome-oriented Yomi action with its shortcut')
assertSource(nativeText.includes('window?.appearance = NSAppearance(named: .aqua)') && nativeText.includes('window?.appearance = NSAppearance(named: .darkAqua)'), 'titlebar chrome must follow the selected theme')
assertSource(nativeText.includes('deadline: .now() + 120'), 'Codex streaming must have an inactivity watchdog')
assertSource(nativeText.includes('eventLogger.lifecycle("turn_reuse"'), 'subsequent prompts must reuse the active Codex thread')
assertSource(nativeText.includes('CodingToolBackendFactory') && nativeText.includes('agentBackend?.toolID'), 'coding tools must be selected through the shared backend abstraction')
assertSource(nativeText.includes('responseID == threadStartRequestID') && !nativeText.includes('responseID == 2'), 'thread startup must match its real JSON-RPC request id')
assertSource(nativeText.includes('terminateChildren(of: process.processIdentifier)'), 'stopping Codex must reap its MCP child process')
assertSource(nativeText.includes('agent-events.jsonl') && nativeText.includes('Prompts, deltas, LINE text'), 'agent diagnostics must be bounded and content-free')
assertSource(nativeText.includes('#selector(NSResponder.moveUp(_:))') && nativeText.includes('#selector(NSResponder.moveDown(_:))'), 'Yomi prompt must support keyboard history navigation')
assertSource(nativeText.includes('yomi_prompt_history_v1') && nativeText.includes('suffix(50)'), 'prompt history must be local, persistent, and bounded')
assertSource(nativeText.includes('Text("Yomi").font') && nativeText.includes('開啟完整 Yomi 對話'), 'every conversation header must expose the full Yomi workspace')
assertSource(nativeText.includes('if voiceStatusMessage != nil || state.isSendingReply || state.replyFeedback != nil'), 'empty composer status must not leave a blank padded row')
assertSource(nativeText.includes('private var isSystemEvent: Bool { msg.contentType == 18 }'), 'chat events must use a dedicated system renderer')
assertSource(nativeText.includes('private var isDecryptFailure: Bool') && nativeText.includes('icon: "info.circle.fill"'), 'decryption failures must render as a distinct system state')
assertSource(nativeText.includes('let naturalWidth = ceil(') && nativeText.includes('let width = min(maximumWidth'), 'text bubbles must size to content before reaching their maximum width')
assertSource(nativeText.includes('private var richCard: some View') && nativeText.includes('HStack(alignment: hasMedia ? .top : .bottom'), 'Flex media and caption must render as one top-aligned card')
assertSource(nativeText.includes('DesktopChatSnapshot') && nativeText.includes('chat-list-v1.json'), 'desktop startup must paint a bounded local chat snapshot before syncing')
assertSource(nativeText.includes('appendingPathComponent("runtime/node")') && nativeText.includes('appendingPathComponent("YomiCore")'), 'distributed desktop builds must prefer their bundled Node and YomiCore runtime')
assertSource(nativeText.includes('guard !chatRefreshInFlight else { return }'), 'chat loading must coalesce duplicate startup requests')
assertSource(nativeText.includes('withTimeInterval: 30.0') && nativeText.includes('if nextChats != self.chats'), 'background polling must avoid high-frequency no-op publishes')
assertSource(nativeText.includes('attentionNow') && nativeText.includes('attentionToday') && nativeText.includes('attentionKnow'), 'attention tiers must use a semantic urgency palette')
assertSource(nativeText.includes('value == 0 ? EnterpriseTheme.secondaryText.opacity(0.5)'), 'zero-value metrics must not compete for attention')
assertSource(nativeText.includes('memoryImage(for url: URL)') && nativeText.includes('DispatchQueue.global(qos: .utility).async'), 'disk image decoding must stay off the main thread')
assertSource(nativeText.includes('mcpServer/elicitation/request') && nativeText.includes('respondToElicitation'), 'MCP elicitation must be surfaced and answered')
assertSource(nativeText.includes('isTrustedYomiRequest') && nativeText.includes('rawServerName.caseInsensitiveCompare("yomi")'), 'all tools from the trusted Yomi server must be enabled by default')
assertSource(nativeText.includes('acceptForSession') && nativeText.includes('本次對話皆允許'), 'command approval must support session-scoped consent')
assertSource(nativeText.includes('acceptPermanently') && nativeText.includes('yomi_permanent_readonly_approvals_v1'), 'safe read-only approval must persist across Yomi sessions')
assertSource(nativeText.includes('永遠允許同類唯讀命令') && nativeText.includes('permittedPrefixes'), 'permanent approval must be visible and restricted to classified read-only commands')
assertSource(nativeText.includes('Text(command)') && nativeText.includes('Label(cwd, systemImage: "folder")'), 'approval UI must show the exact command and working directory')
assertSource(nativeText.includes('.padding(.leading, 16)') && nativeText.includes('.frame(height: 48, alignment: .center)'), 'secondary navigation must align to the compact content grid')

// Keep the search matching/snippet rules executable without launching SwiftUI.
// This catches regressions where filtering works but the visible attributed
// ranges or URL/date-adjacent Chinese matches disappear in the row renderer.
const searchTestBinary = `/tmp/yomi-search-support-test-${process.pid}`
run('swiftc', [
  join(root, 'desktop', 'mac-native', 'SearchSupport.swift'),
  join(root, 'scripts', 'search-support-test-main.swift'),
  '-o',
  searchTestBinary,
])
run(searchTestBinary, [])

run('npm', ['run', 'desktop:build'])

const sourceFiles = filesUnder(source).filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'))
for (const sourcePath of sourceFiles) {
  const outputPath = join(dist, relative(source, sourcePath).replace(/\.ts$/, '.js'))
  if (!existsSync(outputPath)) fail(`missing compiled artifact for ${relative(root, sourcePath)}: ${relative(root, outputPath)}`)
  else if (mtime(outputPath) < mtime(sourcePath)) fail(`stale compiled artifact: ${relative(root, outputPath)}`)
}

const nativeSources = [
  ...nativeSwiftFiles,
  join(root, 'desktop', 'mac-native', 'Info.plist'),
  join(root, 'desktop', 'mac-native', 'AppIcon.icns'),
  join(root, 'desktop', 'mac-native', 'Design', 'AppliedGlyphs', 'YomiKomainuLine.svg'),
  join(root, 'desktop', 'mac-native', 'Design', 'AppliedGlyphs', 'YomiKomainuAgent.svg'),
]
for (const sourcePath of nativeSources) {
  if (mtime(executable) < mtime(sourcePath)) fail(`stale native artifact: ${relative(root, sourcePath)}`)
}
const stamp = join(dist, '.yomi-build-stamp.json')
if (existsSync(stamp) && mtime(executable) < mtime(stamp)) fail('native executable predates the TypeScript build stamp')
for (const resource of [
  join(app, 'Contents', 'Info.plist'),
  join(app, 'Contents', 'Resources', 'AppIcon.icns'),
  join(app, 'Contents', 'Resources', 'YomiKomainuLine.svg'),
  join(app, 'Contents', 'Resources', 'YomiKomainuAgent.svg'),
]) {
  if (!existsSync(resource)) fail(`missing app resource: ${relative(root, resource)}`)
  else if (mtime(resource) < Math.max(...nativeSources.map(mtime))) fail(`stale app resource: ${relative(root, resource)}`)
}

run('codesign', ['--verify', '--deep', '--strict', app])
run('node', ['run.mjs', 'version'])
run('node', ['run.mjs', 'help'])

if (process.env.YOMI_HARNESS_SMOKE_CHATS === '1') {
  run('node', ['run.mjs', 'chats', '--first-page'])
}

if (process.argv.includes('--restart')) {
  spawnSync('pkill', ['-x', 'Yomi'], { cwd: root, stdio: 'ignore' })
  run('open', [app])
}

if (process.exitCode === 1) process.exit(1)
console.log('[desktop:harness] build, freshness, signature, and CLI smoke checks passed')
