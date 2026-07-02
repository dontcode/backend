import { detectRepoName, login, pollDeviceToken, startDeviceAuth } from '../dist/node.js'
import { createMcpServer } from '../dist/node.js'
import { loadCredential } from '../dist/node.js'
import { isDontCodeError } from '../dist/index.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'

/**
 * The device-authorization client drives the browser sign-in flow end to end:
 * start -> (user approves) -> poll -> short-lived token, cached locally. We
 * stand up a tiny gateway that speaks the same start/token contract as
 * /api/v1/auth/device/* and assert the client's behaviour against it.
 */

let server
let baseUrl
// Test-controlled: how many pending polls before the token is issued.
let pendingPolls = 0
// Captured body of the most recent /start call, so tests can assert on the
// client_name / repo_name hints the client sends.
let lastStartBody = null

function readJson(req) {
    return new Promise((resolve) => {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
            try {
                resolve(JSON.parse(body || '{}'))
            } catch {
                resolve({})
            }
        })
    })
}

before(async () => {
    server = createServer(async (req, res) => {
        const send = (status, obj) => {
            res.writeHead(status, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(obj))
        }
        if (req.url === '/api/v1/auth/device/start') {
            lastStartBody = await readJson(req)
            return send(200, {
                device_code: 'dev-secret',
                user_code: 'BKLM-7Q2X',
                verification_uri: `${baseUrl}/device`,
                verification_uri_complete: `${baseUrl}/device?code=BKLM-7Q2X`,
                interval: 1,
                expires_in: 30,
            })
        }
        if (req.url === '/api/v1/auth/device/token') {
            const body = await readJson(req)
            if (body.device_code !== 'dev-secret') return send(400, { error: 'invalid_grant' })
            if (pendingPolls > 0) {
                pendingPolls--
                return send(428, { error: 'authorization_pending: waiting' })
            }
            return send(200, {
                access_token: 'dct_issued',
                token_type: 'Bearer',
                expires_in: 3600,
                project_id: 'p1',
            })
        }
        send(404, { error: 'not found' })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(() => new Promise((resolve) => server.close(resolve)))

describe('device flow', () => {
    it('starts a flow and returns a verification URL + code', async () => {
        const start = await startDeviceAuth(baseUrl, 'Test Tool')
        assert.equal(start.user_code, 'BKLM-7Q2X')
        assert.match(start.verification_uri_complete, /code=BKLM-7Q2X/)
    })

    it('sends the client and repo name hints on start', async () => {
        await startDeviceAuth(baseUrl, 'Test Tool', 'my-repo')
        assert.equal(lastStartBody.client_name, 'Test Tool')
        assert.equal(lastStartBody.repo_name, 'my-repo')
    })

    it('detects a repo name from the environment', async () => {
        // In this repo the git toplevel (or cwd) basename is a non-empty name.
        const name = await detectRepoName()
        assert.ok(typeof name === 'string' && name.length > 0)
    })

    it('polls through pending and resolves a token', async () => {
        pendingPolls = 1
        const start = await startDeviceAuth(baseUrl)
        const token = await pollDeviceToken(baseUrl, start)
        assert.equal(token.access_token, 'dct_issued')
        assert.equal(token.project_id, 'p1')
    })

    it('reports WaitTimeout (not failure) when the slice ends while still pending', async () => {
        pendingPolls = 1000 // never approves within the slice
        const start = await startDeviceAuth(baseUrl)
        await assert.rejects(
            () => pollDeviceToken(baseUrl, start, { maxWaitMs: 1200 }),
            (err) => isDontCodeError(err) && err.code === 'WaitTimeout'
        )
    })
})

describe('login() caches the credential', () => {
    let dir
    let savedDir
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'dontcode-login-'))
        savedDir = process.env.DONTCODE_CONFIG_DIR
        process.env.DONTCODE_CONFIG_DIR = dir
    })
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
        if (savedDir === undefined) delete process.env.DONTCODE_CONFIG_DIR
        else process.env.DONTCODE_CONFIG_DIR = savedDir
    })

    it('signs in and stores the token for the gateway', async () => {
        pendingPolls = 0
        const cred = await login({ baseUrl, open: false })
        assert.equal(cred.access_token, 'dct_issued')
        assert.equal(loadCredential(baseUrl).access_token, 'dct_issued')
        // login() auto-detects the repo hint when none is given.
        assert.ok(typeof lastStartBody.repo_name === 'string' && lastStartBody.repo_name.length > 0)
    })
})

describe('MCP server', () => {
    it('builds without throwing (tool schemas valid)', () => {
        const server = createMcpServer()
        assert.ok(server)
    })
})
