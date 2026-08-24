/**
 * macOS Keychain backing store for Yomi credentials.
 *
 * Vendored from the host app's system/auth keychain service. Used by
 * CredentialStore when running on darwin; other platforms fall back to a
 * plain JSON file (see credential-store.ts).
 */

import { spawn } from 'node:child_process'
import { createCliLogger } from '../util/log.js'

/**
 * Yomi's Keychain service name. Yomi performs a first-party
 * passwordless LINE login (see the `login` MCP tool) and persists the
 * resulting session here — auth token, certificate, refresh token, mid,
 * and the E2EE NaCl keypair. Shared between Yomi MCP and Yomi Desktop.
 */
const SERVICE_NAME = 'dev.rikai.yomi.credentials'
const authLog = createCliLogger('AUTH')

export interface CredentialResult {
  success: boolean
  account?: string
  password?: string
  error?: string
}

/**
 * Wrapper for macOS `security` keychain CLI commands.
 */
class KeychainCommands {
  constructor(private serviceName: string) {}

  /**
   * Store a credential in Keychain.
   *
   * @param account - Account name.
   * @param password - Password to store.
   * @returns Promise resolving to credential result.
   */
  async set(account: string, password: string): Promise<CredentialResult> {
    return new Promise((resolve) => {
      const child = spawn('security', [
        'add-generic-password',
        '-s',
        this.serviceName,
        '-a',
        account,
        '-w',
        password,
        '-U',
        '-A',
      ])

      let stderr = ''
      child.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        if (code === 0) {
          authLog.debug('keychain.store.complete', { account })
          resolve({ success: true, account })
        } else {
          authLog.error('keychain.store.failed', {
            account,
            error: stderr || 'Failed to store credential',
          })
          resolve({
            success: false,
            error: stderr || 'Failed to store credential',
          })
        }
      })

      child.on('error', (err) => {
        authLog.error('keychain.store.error', { account, error: err.message })
        resolve({ success: false, error: err.message })
      })
    })
  }

  /**
   * Retrieve a credential from Keychain.
   *
   * @param account - Account name.
   * @returns Promise resolving to credential result.
   */
  async get(account: string): Promise<CredentialResult> {
    return new Promise((resolve) => {
      const child = spawn('security', [
        'find-generic-password',
        '-s',
        this.serviceName,
        '-a',
        account,
        '-w',
      ])

      let stdout = ''
      let stderr = ''

      child.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      child.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          resolve({
            success: true,
            account,
            password: stdout.trim(),
          })
        } else {
          resolve({
            success: false,
            account,
            error: stderr.includes('could not be found')
              ? 'Credential not found'
              : stderr || 'Failed to retrieve credential',
          })
        }
      })

      child.on('error', (err) => {
        resolve({ success: false, account, error: err.message })
      })
    })
  }

  /**
   * Delete a credential from Keychain.
   *
   * @param account - Account name.
   * @returns Promise resolving to credential result.
   */
  async delete(account: string): Promise<CredentialResult> {
    return new Promise((resolve) => {
      const child = spawn('security', [
        'delete-generic-password',
        '-s',
        this.serviceName,
        '-a',
        account,
      ])

      let stderr = ''
      child.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        if (code === 0) {
          authLog.debug('keychain.delete.complete', { account })
          resolve({ success: true, account })
        } else {
          resolve({
            success: false,
            account,
            error: stderr.includes('could not be found')
              ? 'Credential not found'
              : stderr || 'Failed to delete credential',
          })
        }
      })

      child.on('error', (err) => {
        resolve({ success: false, account, error: err.message })
      })
    })
  }
}

/**
 * Service for managing macOS Keychain credentials.
 *
 * Direct reads, writes, and deletes on the canonical Yomi namespace.
 */
export class KeychainService {
  private commands: KeychainCommands

  constructor() {
    this.commands = new KeychainCommands(SERVICE_NAME)
  }

  /**
   * Stores a credential in Keychain.
   *
   * @param account - Account name.
   * @param password - Password to store.
   * @returns Promise resolving to credential result.
   */
  async setCredential(
    account: string,
    password: string,
  ): Promise<CredentialResult> {
    return await this.commands.set(account, password)
  }

  /**
   * Retrieves a credential from Keychain.
   *
   * @param account - Account name.
   * @returns Promise resolving to credential result.
   */
  async getCredential(account: string): Promise<CredentialResult> {
    return await this.commands.get(account)
  }

  /**
   * Deletes a credential from Keychain.
   *
   * @param account - Account name.
   * @returns Promise resolving to credential result.
   */
  async deleteCredential(account: string): Promise<CredentialResult> {
    return await this.commands.delete(account)
  }
}

let keychainServiceInstance: KeychainService | null = null

/**
 * Gets the singleton keychain service instance.
 *
 * @returns The KeychainService instance.
 */
export function getKeychainService(): KeychainService {
  if (!keychainServiceInstance) {
    keychainServiceInstance = new KeychainService()
  }
  return keychainServiceInstance
}
