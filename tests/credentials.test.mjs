import {
    clearCredential,
    isExpired,
    loadCredential,
    resolveActiveToken,
    saveCredential,
} from '../dist/node.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

/**
 * The local credential cache underpins the MCP server: it stores the
 * short-lived device token the browser flow hands back, scoped per gateway,
 * and decides which credential the server should use right now.
 */

const BASE = 'https://backend.example.com'
let dir
let savedEnvDir
let savedApiKey

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dontcode-cred-'))
    savedEnvDir = process.env.DONTCODE_CONFIG_DIR
    savedApiKey = process.env.DONTCODE_API_KEY
    process.env.DONTCODE_CONFIG_DIR = dir
    delete process.env.DONTCODE_API_KEY
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (savedEnvDir === undefined) delete process.env.DONTCODE_CONFIG_DIR
    else process.env.DONTCODE_CONFIG_DIR = savedEnvDir
    if (savedApiKey === undefined) delete process.env.DONTCODE_API_KEY
    else process.env.DONTCODE_API_KEY = savedApiKey
})

const cred = (overrides = {}) => ({
    access_token: 'dct_abc',
    project_id: 'p1',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    base_url: BASE,
    ...overrides,
})

describe('credential cache', () => {
    it('round-trips and clears a credential per gateway', () => {
        assert.equal(loadCredential(BASE), null)
        saveCredential(cred())
        assert.equal(loadCredential(BASE).access_token, 'dct_abc')

        // A different gateway is isolated.
        assert.equal(loadCredential('https://other.example.com'), null)

        clearCredential(BASE)
        assert.equal(loadCredential(BASE), null)
    })

    it('detects expiry with skew', () => {
        assert.equal(isExpired(cred({ expires_at: new Date(Date.now() + 600_000).toISOString() })), false)
        assert.equal(isExpired(cred({ expires_at: new Date(Date.now() - 1000).toISOString() })), true)
        // Within the default 30s skew counts as expired.
        assert.equal(isExpired(cred({ expires_at: new Date(Date.now() + 5_000).toISOString() })), true)
    })
})

describe('resolveActiveToken', () => {
    it('prefers an explicit API key (non-interactive use)', () => {
        process.env.DONTCODE_API_KEY = 'dc_envkey'
        saveCredential(cred())
        const active = resolveActiveToken(BASE)
        assert.equal(active.source, 'env')
        assert.equal(active.token, 'dc_envkey')
    })

    it('falls back to a cached, unexpired device token', () => {
        saveCredential(cred())
        const active = resolveActiveToken(BASE)
        assert.equal(active.source, 'device')
        assert.equal(active.token, 'dct_abc')
        assert.equal(active.projectId, 'p1')
    })

    it('reports none when the cached token is expired', () => {
        saveCredential(cred({ expires_at: new Date(Date.now() - 1000).toISOString() }))
        assert.equal(resolveActiveToken(BASE).source, 'none')
    })
})
