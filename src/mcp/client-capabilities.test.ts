import { expect, test } from 'bun:test'
import type { ClientCapabilities, Server } from '@modelcontextprotocol/server'
import { CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server'
import {
  clientCapabilitiesOf,
  supportsFormElicitation,
  supportsUrlElicitation,
} from './client-capabilities.js'

/** Cast helper: these fixtures are wire shapes, not SDK-constructed values. */
const caps = (value: unknown) => value as ClientCapabilities | undefined

/** A Server stand-in whose handshake-scoped accessor answers `declared`. */
const serverWith = (declared: unknown) =>
  ({ getClientCapabilities: () => declared }) as unknown as Server

/** A handler context carrying a modern-era per-request envelope. */
const ctxWith = (declared: unknown) => ({
  mcpReq: { envelope: { [CLIENT_CAPABILITIES_META_KEY]: declared } },
})

test('modern-era capabilities come from the per-request envelope', () => {
  // The regression this guards: over stdio the accessor is EMPTY on the
  // modern era, so reading it alone reports an elicitation-capable client as
  // incapable and silently downgrades login to the two-call fallback.
  const resolved = clientCapabilitiesOf(
    serverWith(undefined),
    ctxWith({ elicitation: { form: {} } }),
  )
  expect(supportsFormElicitation(resolved)).toBe(true)
})

test('legacy-era capabilities fall back to the handshake accessor', () => {
  const resolved = clientCapabilitiesOf(serverWith({ elicitation: {} }), {
    mcpReq: {},
  })
  expect(supportsFormElicitation(resolved)).toBe(true)
  expect(clientCapabilitiesOf(serverWith(undefined), undefined)).toBeUndefined()
})

test('a client declaring no elicitation supports neither mode', () => {
  expect(supportsFormElicitation(caps(undefined))).toBe(false)
  expect(supportsFormElicitation(caps({}))).toBe(false)
  expect(supportsUrlElicitation(caps({}))).toBe(false)
})

test('a bare elicitation object is the pre-2026-07-28 form shape', () => {
  expect(supportsFormElicitation(caps({ elicitation: {} }))).toBe(true)
  expect(supportsUrlElicitation(caps({ elicitation: {} }))).toBe(false)
})

test('a url-only client is not offered a form elicitation', () => {
  const urlOnly = caps({ elicitation: { url: {} } })
  expect(supportsFormElicitation(urlOnly)).toBe(false)
  expect(supportsUrlElicitation(urlOnly)).toBe(true)
})

test('a client declaring both modes supports both', () => {
  const both = caps({ elicitation: { form: {}, url: {} } })
  expect(supportsFormElicitation(both)).toBe(true)
  expect(supportsUrlElicitation(both)).toBe(true)
})

test('form declared alone does not imply url support', () => {
  const formOnly = caps({ elicitation: { form: { applyDefaults: true } } })
  expect(supportsFormElicitation(formOnly)).toBe(true)
  expect(supportsUrlElicitation(formOnly)).toBe(false)
})
