#!/usr/bin/env node
/**
 * Installed-artifact MCP smoke test.
 *
 * Starts the packaged server twice: once pinned to the stateless 2026-07-28
 * protocol and once through the legacy initialize flow. Each connection lists
 * every tool and calls get_scope_policy so the probe reaches Yomi application
 * code and its SQLite boundary, not merely the SDK shell.
 */

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const entry = process.argv[2]
if (!entry) {
  console.error('usage: smoke-mcp.mjs <path-to-run.mjs>')
  process.exit(2)
}

const dbPath = join(mkdtempSync(join(tmpdir(), 'yomi-smoke-')), 'index.db')

/**
 * Verify one protocol era against a fresh packaged-server process.
 *
 * @param {'modern' | 'legacy'} expectedEra
 * @param {boolean} supportsApps
 */
async function verifyEra(expectedEra, supportsApps = false) {
  const client = new Client(
    {
      name: `install-smoke-${expectedEra}${supportsApps ? '-apps' : ''}`,
      version: '0',
    },
    {
      capabilities: supportsApps
        ? {
            extensions: {
              'io.modelcontextprotocol/ui': {
                mimeTypes: ['text/html;profile=mcp-app'],
              },
            },
          }
        : {},
      versionNegotiation:
        expectedEra === 'modern'
          ? { mode: { pin: '2026-07-28' } }
          : { mode: 'legacy' },
    },
  )
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, 'serve'],
    env: { ...process.env, YOMI_INDEX_DB_PATH: dbPath },
    stderr: 'pipe',
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk
  })

  try {
    await client.connect(transport)
    const actualEra = client.getProtocolEra()
    if (actualEra !== expectedEra) {
      throw new Error(`negotiated ${actualEra}; expected ${expectedEra}`)
    }

    const toolList = await client.listTools()
    const { tools } = toolList
    if (tools.length !== 41) {
      throw new Error(`tools/list returned ${tools.length} tools; expected 41`)
    }
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
      throw new Error('tools/list returned duplicate tool names')
    }
    if (
      expectedEra === 'modern' &&
      (toolList.ttlMs !== 0 || toolList.cacheScope !== 'private')
    ) {
      throw new Error(
        `modern tools/list cache fields are invalid: ${JSON.stringify(toolList)}`,
      )
    }
    const invalidTool = tools.find(
      (tool) =>
        !tool.name ||
        tool.inputSchema?.type !== 'object' ||
        !tool.inputSchema.properties,
    )
    if (invalidTool) {
      throw new Error(`invalid tool schema: ${JSON.stringify(invalidTool)}`)
    }

    const loginTool = tools.find((tool) => tool.name === 'login')
    const resources = await client.listResources()
    if (resources.resources.length !== 1) {
      throw new Error(
        `resources/list returned ${resources.resources.length}; expected 1`,
      )
    }
    if (loginTool?._meta?.ui?.resourceUri !== 'ui://yomi/login') {
      throw new Error('login tool is missing its MCP Apps resource link')
    }
    const resource = await client.readResource({ uri: 'ui://yomi/login' })
    const html = resource.contents[0]
    if (
      html?.mimeType !== 'text/html;profile=mcp-app' ||
      !('text' in html) ||
      !html.text.includes('ui/initialize')
    ) {
      throw new Error(`invalid MCP Apps resource: ${JSON.stringify(html)}`)
    }
    try {
      await client.readResource({ uri: 'ui://yomi/not-found' })
      throw new Error('unknown resources/read unexpectedly succeeded')
    } catch (error) {
      if (error.code !== -32602) {
        throw new Error(
          `unknown resource returned ${error.code}; expected -32602`,
        )
      }
    }

    const result = await client.callTool({
      name: 'get_scope_policy',
      arguments: {},
    })
    const text = result.content?.find((block) => block.type === 'text')?.text
    if (result.isError || !text) {
      throw new Error(
        `get_scope_policy failed: ${JSON.stringify(result)}`,
      )
    }
    return `${expectedEra}${supportsApps ? '+apps' : ''} ${tools.length} tools / ${text.length} policy bytes`
  } catch (error) {
    const detail = stderr ? `\n--- server stderr ---\n${stderr}` : ''
    throw new Error(`${expectedEra} smoke failed: ${error.message}${detail}`, {
      cause: error,
    })
  } finally {
    await client.close().catch(() => {})
  }
}

try {
  const modern = await verifyEra('modern')
  const modernApps = await verifyEra('modern', true)
  const legacy = await verifyEra('legacy')
  console.log(`OK: ${modern}; ${modernApps}; ${legacy}`)
} catch (error) {
  console.error(`FAIL: ${error.message}`)
  process.exit(1)
}
