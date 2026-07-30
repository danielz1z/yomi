/**
 * Reading what the connected client can do — where its capabilities come
 * from, and what the elicitation ones mean (MCP 2026-07-28).
 *
 * WHERE. There are two sources and picking the wrong one silently reports a
 * capable client as incapable. On a legacy connection the client declares its
 * capabilities once in `initialize`, which is what `getClientCapabilities()`
 * returns. On a 2026-07-28 connection there is no handshake — every request
 * carries its own `_meta` envelope instead. `serveStdio` does NOT backfill
 * the accessor from that envelope (only the HTTP entry does, via
 * `seedClientIdentityFromEnvelope`), so over stdio `getClientCapabilities()`
 * is EMPTY on the modern era no matter what the client declared. Read the
 * envelope first; fall back to the accessor. See `clientCapabilitiesOf`.
 *
 * WHAT. The revision split the client's `elicitation` capability into per-mode
 * sub-capabilities — `{ form?: {...}, url?: {...} }` (see
 * node_modules/@modelcontextprotocol/core/dist/auth-*.d.mts,
 * `ClientCapabilitiesSchema`). Presence of the `elicitation` object alone no
 * longer implies the client will accept a FORM elicitation: a client may
 * declare `{ url: {} }` only, and `elicitation/create` with a
 * `requestedSchema` would then fail against it.
 *
 * Older clients (and current ones that have not adopted the split) declare a
 * bare `elicitation: {}` with no sub-keys. That has always meant form
 * elicitation — the only mode that existed before this revision — so an
 * `elicitation` object with NEITHER sub-key is treated as form-capable. Only
 * a client that explicitly declares `url` without `form` is taken at its word
 * as url-only.
 *
 * Kept separate from ./ui/capability.ts, which detects the MCP Apps UI
 * extension — a different capability on a different axis.
 */
import type { ClientCapabilities, Server } from '@modelcontextprotocol/server'
import { CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server'

/** The slice of a request handler's context this module reads. */
interface CapabilityContext {
  mcpReq: { envelope?: object }
}

/**
 * The capabilities the CURRENT request's client declared.
 *
 * @param server - MCP Server instance (the legacy, handshake-scoped source).
 * @param ctx - Request handler context (the modern, per-request source).
 * @returns The declared capabilities, or undefined when the client declared
 * none and no envelope carried any.
 */
export function clientCapabilitiesOf(
  server: Server,
  ctx: CapabilityContext | undefined,
): ClientCapabilities | undefined {
  // The envelope type is opaque (`RequestMetaEnvelope = {}`) — the SDK models
  // it as a bag of reserved keys, so reaching the declared capabilities off it
  // needs an index-signature view rather than a property access.
  const envelope = ctx?.mcpReq.envelope as
    | Record<string, ClientCapabilities | undefined>
    | undefined
  return (
    envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? server.getClientCapabilities()
  )
}

/**
 * Does the connected client accept form-mode elicitation (`elicitation/create`
 * carrying a `requestedSchema`)?
 *
 * @param capabilities - Result of `server.getClientCapabilities()`.
 * @returns True when the client declared `elicitation.form`, or declared a
 * bare `elicitation` with no mode sub-keys at all (pre-2026-07-28 shape).
 */
export function supportsFormElicitation(
  capabilities: ClientCapabilities | undefined,
): boolean {
  const elicitation = capabilities?.elicitation
  if (!elicitation || typeof elicitation !== 'object') {
    return false
  }
  if ('form' in elicitation && elicitation.form) {
    return true
  }
  // A client that named `url` and not `form` is url-only; one that named
  // neither predates the split and can only have meant form.
  return !('url' in elicitation && elicitation.url)
}

/**
 * Does the connected client accept url-mode elicitation (`elicitation/create`
 * with `mode: "url"`, answered out-of-band and closed by a
 * `notifications/elicitation/complete`)?
 *
 * Not used by any flow yet — url mode has no observed client support, the
 * same trap ./ui/login-app.ts documents for MCP Apps. Exported so a future
 * url-mode path can gate on the real declaration rather than assume it.
 *
 * @param capabilities - Result of `server.getClientCapabilities()`.
 * @returns True only when the client explicitly declared `elicitation.url`.
 */
export function supportsUrlElicitation(
  capabilities: ClientCapabilities | undefined,
): boolean {
  const elicitation = capabilities?.elicitation
  if (!elicitation || typeof elicitation !== 'object') {
    return false
  }
  return 'url' in elicitation && Boolean(elicitation.url)
}
