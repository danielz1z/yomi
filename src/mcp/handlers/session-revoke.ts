/**
 * Mid-tool LINE revoke handling for the MCP server's tools/call catch block.
 */

import { isLineAuthInvalidatedError } from '../../line/client/index.js'
import type { LineProtocolService } from '../../line/core/service.js'
import type { Logger } from '../../util/log.js'
import { sessionRevokedError } from './shared.js'

/**
 * Translate a tool failure caused by LINE revoking this device's token.
 *
 * A mid-session V3_TOKEN_CLIENT_LOGGED_OUT (a competing login, a CLI probe
 * against the same credentials) is not a tool bug. Run the same teardown the
 * resume path uses — `invalidateSession` stops polling and clears the dead
 * token, refresh token and login certificate, keeping phone/region — so the
 * gate short-circuits later calls AND the next `login_qr` cannot offer LINE
 * a revoked certificate. Only flipping `loginRequired` used to leave that
 * certificate on disk, and the following QR login died with INVALID_CONTEXT.
 *
 * @param service - Live LINE service the tool was running against.
 * @param error - Error the tool handler threw.
 * @param toolName - Tool being executed, for the log line.
 * @param log - Server logger.
 * @returns The user-facing revoked-session result, or null when the error is
 * not an auth invalidation and the caller should report it as a tool failure.
 */
export async function handleToolAuthInvalidated(
  service: LineProtocolService,
  error: unknown,
  toolName: string,
  log: Pick<Logger, 'warn'>,
) {
  if (!isLineAuthInvalidatedError(error)) {
    return null
  }
  const message =
    (error as { message?: string })?.message ?? String(error ?? '')
  log.warn('tool.session_revoked', { error: message, tool: toolName })
  await service.invalidateSession(`tool_auth_invalidated:${toolName}`)
  return sessionRevokedError(message)
}
