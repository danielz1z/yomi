import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { LineQrLogin } from '../qr/index.js'
import { performQrLogin } from './qr-login-flow.js'

/**
 * Run performQrLogin against a LineQrLogin whose login() only records what
 * certificate it was offered and then fails, so nothing past the certificate
 * decision (LineClient, getProfile) is ever reached and no network is touched.
 *
 * @param storedCertificate - What `line_certificate` holds in the store.
 * @returns The certificate argument login() received.
 */
async function certificateOfferedToLogin(storedCertificate: string | null) {
  const offered: { value: unknown; called: boolean } = {
    value: 'never-called',
    called: false,
  }
  const original = LineQrLogin.prototype.login
  LineQrLogin.prototype.login = async (savedCertificate?: string) => {
    offered.value = savedCertificate
    offered.called = true
    throw new Error('stop after certificate decision')
  }
  try {
    const service = Object.assign(new EventEmitter(), {
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      startupFlowLogger: null,
      state: 'disconnected',
      setState(next: string) {
        service.state = next
      },
      credentialStore: {
        async get(key: string) {
          return key === 'line_certificate' ? storedCertificate : null
        },
      },
    })
    service.on('error', () => {})
    await expect(
      performQrLogin(service, 'logging_in', 'connected', 'error'),
    ).rejects.toThrow('stop after certificate decision')
    expect(service.state).toBe('error')
  } finally {
    LineQrLogin.prototype.login = original
  }
  expect(offered.called).toBe(true)
  return offered.value
}

test('with no stored certificate, login() is offered undefined — not "" or null', async () => {
  // A revoke deletes line_certificate; the store then answers null. That
  // must reach LineQrLogin as "no certificate" so the flow's own
  // `this.certificate || ''` handling applies, never as a stale string.
  expect(await certificateOfferedToLogin(null)).toBeUndefined()
  expect(await certificateOfferedToLogin('')).toBeUndefined()
})

test('a stored certificate is still offered for the skip-PIN path', async () => {
  expect(await certificateOfferedToLogin('device-cert')).toBe('device-cert')
})
