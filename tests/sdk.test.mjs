import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { DontCodeError, dontcode, isDontCodeError } from '../dist/index.js'

/**
 * The SDK is a faithful proxy: these tests assert it forms the exact requests
 * the v1 gateway expects (URL, method, headers, body) and shapes responses the
 * way callers consume them. `fetch` is mocked so nothing leaves the process.
 */

let calls = []
let nextResponse = null
const realFetch = globalThis.fetch

function mockResponse({ status = 200, body = {} } = {}) {
    nextResponse = {
        ok: status >= 200 && status < 300,
        status,
        statusText: 'mock',
        text: async () => (body === null ? '' : JSON.stringify(body)),
    }
}

beforeEach(() => {
    calls = []
    mockResponse({ body: {} })
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init })
        return nextResponse
    }
})

afterEach(() => {
    globalThis.fetch = realFetch
    delete process.env.DONTCODE_API_KEY
    delete process.env.DONTCODE_API_URL
})

const last = () => calls[calls.length - 1]
const bodyOf = (call) => JSON.parse(call.init.body)
const headerOf = (call, name) => call.init.headers[name]

describe('client construction', () => {
    it('defaults the base URL and sends the API key as a Bearer token', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        await client.auth.login({ email: 'a@b.co', password: 'x' })
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/auth/login')
        assert.equal(headerOf(last(), 'Authorization'), 'Bearer dc_test')
    })

    it('falls back to DONTCODE_API_KEY and DONTCODE_API_URL from the env', async () => {
        process.env.DONTCODE_API_KEY = 'dc_env'
        process.env.DONTCODE_API_URL = 'https://self.hosted.example'
        const client = dontcode()
        await client.auth.login({ email: 'a@b.co', password: 'x' })
        assert.equal(last().url, 'https://self.hosted.example/api/v1/auth/login')
        assert.equal(headerOf(last(), 'Authorization'), 'Bearer dc_env')
    })

    it('strips a trailing slash from a custom base URL', async () => {
        const client = dontcode({ apiKey: 'dc_test', baseUrl: 'https://x.example/' })
        await client.auth.login({ email: 'a@b.co', password: 'x' })
        assert.equal(last().url, 'https://x.example/api/v1/auth/login')
    })

    it('sends no Authorization header when no key is set anywhere', async () => {
        const client = dontcode()
        await client.auth.login({ email: 'a@b.co', password: 'x' })
        assert.equal(headerOf(last(), 'Authorization'), undefined)
    })
})

describe('auth', () => {
    it('signup forwards the allowlisted fields', async () => {
        mockResponse({ body: { success: true, userId: 'u1', verification_required: true } })
        const client = dontcode({ apiKey: 'dc_test' })
        const res = await client.auth.signup({
            email: 'a@b.co',
            password: 'pw',
            role: 'editor',
        })
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/auth/signup')
        assert.deepEqual(bodyOf(last()), { email: 'a@b.co', password: 'pw', role: 'editor' })
        assert.equal(res.verification_required, true)
    })

    it('me sends the end-user token in X-Access-Token, not Authorization', async () => {
        mockResponse({ body: { user: { id: 'u1', email: 'a@b.co' } } })
        const client = dontcode({ apiKey: 'dc_test' })
        await client.auth.me({ accessToken: 'user-token' })
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/auth/me')
        assert.equal(headerOf(last(), 'X-Access-Token'), 'user-token')
        assert.equal(headerOf(last(), 'Authorization'), 'Bearer dc_test')
    })

    it('mfa.challenge maps camelCase inputs to the snake_case wire shape', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        await client.auth.mfa.challenge({ challengeToken: 'ch', recoveryCode: 'rc' })
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/auth/mfa/challenge')
        assert.deepEqual(bodyOf(last()), { challenge_token: 'ch', recovery_code: 'rc' })
    })

    it('mfa.enroll posts an empty body with the access token', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        await client.auth.mfa.enroll({ accessToken: 'user-token' })
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/auth/mfa/enroll')
        assert.equal(headerOf(last(), 'X-Access-Token'), 'user-token')
        assert.deepEqual(bodyOf(last()), {})
    })
})

describe('db', () => {
    it('find sends the structured-query protocol and unwraps { data }', async () => {
        mockResponse({ body: { data: [{ id: 1 }, { id: 2 }] } })
        const client = dontcode({ apiKey: 'dc_test' })
        const rows = await client.db.maps.find({ where: { ownerId: 'u1' }, limit: 10 })
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/db')
        assert.deepEqual(bodyOf(last()), {
            operation: 'find',
            tableName: 'maps',
            options: { where: { ownerId: 'u1' }, limit: 10 },
        })
        assert.deepEqual(rows, [{ id: 1 }, { id: 2 }])
    })

    it('supports the callable form for awkward table names', async () => {
        mockResponse({ body: { data: null } })
        const client = dontcode({ apiKey: 'dc_test' })
        await client.db('user-profiles').findFirst({ where: { id: 1 } })
        assert.equal(bodyOf(last()).tableName, 'user-profiles')
        assert.equal(bodyOf(last()).operation, 'findFirst')
    })

    it('insert returns the unwrapped { id }', async () => {
        mockResponse({ body: { data: { id: 42 } } })
        const client = dontcode({ apiKey: 'dc_test' })
        const res = await client.db.maps.insert({ name: 'm' })
        assert.deepEqual(bodyOf(last()).options, { data: { name: 'm' } })
        assert.deepEqual(res, { id: 42 })
    })

    it('update threads where + data through to the gateway', async () => {
        mockResponse({ body: { data: { count: 3 } } })
        const client = dontcode({ apiKey: 'dc_test' })
        const res = await client.db.maps.update({ where: { id: 1 }, data: { name: 'n' } })
        assert.equal(bodyOf(last()).operation, 'update')
        assert.deepEqual(bodyOf(last()).options, { where: { id: 1 }, data: { name: 'n' } })
        assert.deepEqual(res, { count: 3 })
    })

    it('migrate posts to the migrate route and returns the body verbatim', async () => {
        mockResponse({ body: { success: true, executedStatements: 1, warnings: [] } })
        const client = dontcode({ apiKey: 'dc_test' })
        const res = await client.db.migrate({ sql: 'CREATE TABLE t (id int);' })
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/db/migrate')
        assert.deepEqual(bodyOf(last()), { sql: 'CREATE TABLE t (id int);' })
        assert.deepEqual(res, { success: true, executedStatements: 1, warnings: [] })
    })
})

describe('storage', () => {
    it('public.getUrl posts the public bucket', async () => {
        mockResponse({ body: { url: 'https://cdn/x' } })
        const client = dontcode({ apiKey: 'dc_test' })
        const res = await client.storage.public.getUrl('img/a.png')
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/storage')
        assert.deepEqual(bodyOf(last()), { operation: 'getUrl', bucket: 'public', path: 'img/a.png' })
        assert.equal(res.url, 'https://cdn/x')
    })

    it('private.list scopes to the private bucket', async () => {
        mockResponse({ body: { objects: [], folders: [], prefix: '', truncated: false, continuationToken: null } })
        const client = dontcode({ apiKey: 'dc_test' })
        await client.storage.private.list('docs')
        assert.deepEqual(bodyOf(last()), { operation: 'list', bucket: 'private', prefix: 'docs' })
    })

    it('upload PUTs multipart/form-data without a JSON content-type', async () => {
        mockResponse({ body: { object: { key: 'docs/a.txt' } } })
        const client = dontcode({ apiKey: 'dc_test' })
        await client.storage.private.upload('docs/a.txt', 'hello', 'text/plain')
        assert.equal(last().init.method, 'PUT')
        assert.equal(headerOf(last(), 'Content-Type'), undefined)
        assert.ok(last().init.body instanceof FormData)
        const form = last().init.body
        assert.equal(form.get('bucket'), 'private')
        assert.equal(form.get('path'), 'docs/a.txt')
        assert.equal(form.get('contentType'), 'text/plain')
        assert.ok(form.get('file'))
    })
})

describe('errors', () => {
    it('throws DontCodeError carrying status, code, and body on failure', async () => {
        mockResponse({ status: 403, body: { error: 'Email not verified', code: 'EmailNotVerified' } })
        const client = dontcode({ apiKey: 'dc_test' })
        await assert.rejects(
            () => client.auth.login({ email: 'a@b.co', password: 'x' }),
            (err) => {
                assert.ok(isDontCodeError(err))
                assert.ok(err instanceof DontCodeError)
                assert.equal(err.status, 403)
                assert.equal(err.code, 'EmailNotVerified')
                assert.equal(err.message, 'Email not verified')
                return true
            }
        )
    })

    it('flags rate-limit responses', async () => {
        mockResponse({ status: 429, body: { error: 'slow down', rate_limit: true, timeleft: 12 } })
        const client = dontcode({ apiKey: 'dc_test' })
        await assert.rejects(
            () => client.db.maps.find(),
            (err) => {
                assert.equal(err.status, 429)
                assert.equal(err.rateLimited, true)
                assert.equal(err.body.timeleft, 12)
                return true
            }
        )
    })
})
