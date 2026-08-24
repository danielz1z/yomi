# Yomi Desktop for Windows

The Windows desktop app is the Rust tray companion in `desktop/`. It uses the
Windows-native tray menu and notifications provided by `tray-icon`, `muda`,
and `notify-rust`, with WebView2 supplied by `wry` for the compact workspace.

The app shares the LINE session written by the Yomi MCP server. On Windows the
credential file is `%APPDATA%\\yomi\\line-credentials.json`; `YOMI_DATA_DIR`
can override that location for isolated test runs.

## Coding tools

The popover auto-detects `codex`, `claude`, `agy` (Antigravity), `opencode`,
and `ollama` on `PATH`. Select a detected provider, enter a task, and run it
without a shell intermediary. Every provider receives the complete Yomi MCP
tool surface (including send and login tools) enabled by default. Set
`YOMI_OLLAMA_MODEL` to select a local Ollama model; it defaults to `llama3.2`.

For Codex and Claude Code, set `YOMI_RUN_MJS` when the installed desktop app
cannot infer the repository's `run.mjs` path. `YOMI_NODE_PATH` can select a
specific Node executable. The desktop injects the Yomi MCP server config for
those providers and always exports `YOMI_MCP_TOOLS=all` for every provider.

## Build and verify

From the repository root on a Windows machine with Rust, the MSVC toolchain,
and the WebView2 runtime installed:

```powershell
npm run desktop:windows:harness
npm run desktop:windows:build
```

`desktop:windows:harness` runs the TypeScript build and lint gates, Rust
formatting and tests, then builds the Windows release binary. On macOS or
Linux it performs a Windows target check instead of invoking the MSVC linker.
