import { dontcode, isDontCodeError } from '../dist/index.js'
import { startDeviceAuth } from '../dist/node.js'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

/**
 * The gateway reports rate-limit budgets on every counted response, successes
 * included. These tests pin the SDK's job: get that signal out of the headers
 * and into the caller's hands, per namespace, on both paths.
 */

let nextResponse = null
const realFetch = globalThis.fetch

/** A minimal stand-in for `Response`, with real header semantics (get() is
 *  case-insensitive) so the parse is exercised the way fetch would drive it. */
function mockResponse({ status = 200, body = {}, headers = {} } = {}) {
    const lookup = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]))
    nextResponse = {
        ok: status >= 200 && status < 300,
        status,
        statusText: 'mock',
        headers: { get: (name) => lookup.get(String(name).toLowerCase()) ?? null },
        text: async () => (body === null ? '' : JSON.stringify(body)),
    }
}

const budget = ({ limit, remaining, reset = 42, policy }) => ({
    'RateLimit-Limit': limit,
    'RateLimit-Remaining': remaining,
    'RateLimit-Reset': reset,
    ...(policy ? { 'RateLimit-Policy': policy } : {}),
})

beforeEach(() => {
    mockResponse({ body: {} })
    globalThis.fetch = async () => nextResponse
})

afterEach(() => {
    globalThis.fetch = realFetch
    delete process.env.DONTCODE_API_KEY
})

describe('rate-limit headers on successful responses', () => {
    it('exposes the remaining budget after a successful call', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        mockResponse({
            body: { data: [] },
            headers: budget({ limit: 600, remaining: 599, reset: 37, policy: '600;w=60' }),
        })

        await client.db.users.find()

        assert.deepEqual(client.rateLimit.status('db'), {
            namespace: 'db',
            limit: 600,
            remaining: 599,
            reset: 37,
            policy: '600;w=60',
            exceeded: false,
        })
    })

    it('tracks each namespace separately', async () => {
        const client = dontcode({ apiKey: 'dc_test' })

        mockResponse({ body: { data: [] }, headers: budget({ limit: 600, remaining: 500 }) })
        await client.db.users.find()

        mockResponse({ body: { success: true }, headers: budget({ limit: 10, remaining: 1 }) })
        await client.db.migrate({ sql: 'select 1' })

        assert.equal(client.rateLimit.status('db').remaining, 500)
        assert.equal(client.rateLimit.status('db/migrate').remaining, 1)
        assert.deepEqual(
            client.rateLimit
                .all()
                .map((s) => s.namespace)
                .sort(),
            ['db', 'db/migrate']
        )
    })

    it('returns the most recent namespace when asked for no namespace in particular', async () => {
        const client = dontcode({ apiKey: 'dc_test' })

        mockResponse({ body: { data: [] }, headers: budget({ limit: 600, remaining: 500 }) })
        await client.db.users.find()

        mockResponse({ body: { success: true }, headers: budget({ limit: 300, remaining: 299 }) })
        await client.auth.login({ email: 'a@b.co', password: 'x' })

        assert.equal(client.rateLimit.status().namespace, 'auth')
        assert.equal(client.rateLimit.status().remaining, 299)
    })

    it('derives the namespace from the path, query string and all', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        mockResponse({ body: { value: null }, headers: budget({ limit: 1000, remaining: 998 }) })

        await client.cache.get('session:42')

        assert.equal(client.rateLimit.status('cache').remaining, 998)
    })

    it('reports nothing for a namespace whose responses carry no budget', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        mockResponse({ body: { data: [] } })

        await client.db.users.find()

        assert.equal(client.rateLimit.status('db'), undefined)
        assert.equal(client.rateLimit.status(), undefined)
        assert.deepEqual(client.rateLimit.all(), [])
    })
})

describe('namespaces agree with the names the gateway reports', () => {
    /**
     * The gateway only names a budget when it refuses one; the SDK names it on
     * every call by deriving it from the path. Those two names have to be the
     * same string, or `err.scope` and `err.rateLimit.namespace` describe one
     * bucket under two keys and anything counting per namespace double-counts.
     */
    it('agrees with the gateway on a nested namespace', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        mockResponse({
            status: 429,
            body: {
                error: 'Rate limit exceeded. Try again in 12s.',
                rate_limit: true,
                timeleft: 12,
                // Exactly what the gateway sends for this budget.
                scope: 'db/migrate',
            },
            headers: { ...budget({ limit: 10, remaining: 0, reset: 12 }), 'Retry-After': 12 },
        })

        const err = await client.db.migrate({ sql: 'select 1' }).then(
            () => null,
            (e) => e
        )

        assert.ok(isDontCodeError(err))
        assert.equal(err.scope, 'db/migrate')
        assert.equal(err.rateLimit.namespace, err.scope)
    })

    it('keeps a nested namespace out of its parent budget', async () => {
        const client = dontcode({ apiKey: 'dc_test' })

        mockResponse({ body: { data: [] }, headers: budget({ limit: 600, remaining: 590 }) })
        await client.db.users.find()

        mockResponse({ body: { success: true }, headers: budget({ limit: 10, remaining: 2 }) })
        await client.db.migrate({ sql: 'select 1' })

        // The small migrate budget must never overwrite the big db one.
        assert.equal(client.rateLimit.status('db').remaining, 590)
        assert.equal(client.rateLimit.status('db/migrate').remaining, 2)
    })

    it('gives the device-auth bootstrap its own namespace, matching the gateway', async () => {
        mockResponse({
            status: 429,
            body: {
                error: 'Rate limit exceeded. Try again in 30s.',
                rate_limit: true,
                timeleft: 30,
                scope: 'auth/device/start',
            },
            headers: { ...budget({ limit: 20, remaining: 0, reset: 30 }), 'Retry-After': 30 },
        })

        const err = await startDeviceAuth('https://example.test', 'Test Tool').then(
            () => null,
            (e) => e
        )

        assert.ok(isDontCodeError(err))
        // Bootstrap has its own IP-keyed budget; filing it under `auth` would
        // report a budget the caller never spent from.
        assert.equal(err.rateLimit.namespace, 'auth/device/start')
        assert.equal(err.scope, err.rateLimit.namespace)
        assert.equal(err.retryAfter, 30)
    })
})

describe('onRateLimit observer', () => {
    it('fires on a success, so a caller can pace itself before being refused', async () => {
        const seen = []
        const client = dontcode({ apiKey: 'dc_test', onRateLimit: (s) => seen.push(s) })
        mockResponse({ body: { data: [] }, headers: budget({ limit: 600, remaining: 120 }) })

        await client.db.users.find()

        assert.equal(seen.length, 1)
        assert.equal(seen[0].namespace, 'db')
        assert.equal(seen[0].remaining, 120)
        assert.equal(seen[0].exceeded, false)
    })

    it('fires on a refusal too, marked as exceeded', async () => {
        const seen = []
        const client = dontcode({ apiKey: 'dc_test', onRateLimit: (s) => seen.push(s) })
        mockResponse({
            status: 429,
            body: {
                error: 'Rate limit exceeded. Try again in 12s.',
                rate_limit: true,
                timeleft: 12,
            },
            headers: { ...budget({ limit: 600, remaining: 0 }), 'Retry-After': 12 },
        })

        await assert.rejects(() => client.db.users.find())

        assert.equal(seen.length, 1)
        assert.equal(seen[0].exceeded, true)
        assert.equal(seen[0].retryAfter, 12)
    })

    it('does not let a throwing observer break the request', async () => {
        const client = dontcode({
            apiKey: 'dc_test',
            onRateLimit: () => {
                throw new Error('observer blew up')
            },
        })
        mockResponse({ body: { data: [{ id: 1 }] }, headers: budget({ limit: 600, remaining: 5 }) })

        const rows = await client.db.users.find()

        assert.deepEqual(rows, [{ id: 1 }])
        assert.equal(client.rateLimit.status('db').remaining, 5)
    })
})

describe('rate limits on the error path', () => {
    it('carries the budget and the wait on a 429', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        mockResponse({
            status: 429,
            body: {
                error: 'Rate limit exceeded. Try again in 30s.',
                rate_limit: true,
                timeleft: 30,
                scope: 'notifications',
            },
            headers: { ...budget({ limit: 60, remaining: 0, reset: 30 }), 'Retry-After': 30 },
        })

        const err = await client.notifications.email
            .send({ to: 'a@b.co', subject: 'hi', markdownText: 'hi' })
            .then(
                () => null,
                (e) => e
            )

        assert.ok(isDontCodeError(err))
        assert.equal(err.rateLimited, true)
        assert.equal(err.retryAfter, 30)
        assert.equal(err.scope, 'notifications')
        assert.equal(err.rateLimit.namespace, 'notifications')
        assert.equal(err.rateLimit.limit, 60)
        assert.equal(err.rateLimit.remaining, 0)
        assert.equal(err.rateLimit.exceeded, true)
    })

    it('recognises a rate-limit body that did not arrive as a 429', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        mockResponse({
            status: 503,
            body: { error: 'Too many requests', rate_limit: true, timeleft: 8 },
        })

        const err = await client.auth.login({ email: 'a@b.co', password: 'x' }).then(
            () => null,
            (e) => e
        )

        assert.ok(isDontCodeError(err))
        assert.equal(err.status, 503)
        assert.equal(err.rateLimited, true)
        assert.equal(err.retryAfter, 8)
        assert.equal(err.rateLimit.exceeded, true)
    })

    it('falls back to the window reset when a refusal names no wait', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        mockResponse({
            status: 429,
            body: { error: 'Rate limit exceeded' },
            headers: budget({ limit: 120, remaining: 0, reset: 17 }),
        })

        const err = await client.storage.private.list().then(
            () => null,
            (e) => e
        )

        assert.equal(err.rateLimited, true)
        assert.equal(err.retryAfter, 17)
    })

    it('still reports a refusal that carries no rate-limit headers at all', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        mockResponse({ status: 429, body: { error: 'Rate limit exceeded' } })

        const err = await client.auth.login({ email: 'a@b.co', password: 'x' }).then(
            () => null,
            (e) => e
        )

        assert.equal(err.rateLimited, true)
        assert.equal(err.rateLimit.namespace, 'auth')
        assert.equal(err.rateLimit.exceeded, true)
        assert.equal(err.retryAfter, undefined)
    })

    it('leaves an ordinary error alone', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        mockResponse({ status: 401, body: { error: 'Invalid credentials' } })

        const err = await client.auth.login({ email: 'a@b.co', password: 'x' }).then(
            () => null,
            (e) => e
        )

        assert.equal(err.rateLimited, false)
        assert.equal(err.retryAfter, undefined)
        assert.equal(err.rateLimit, undefined)
    })

    it('survives a response object with no headers', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        nextResponse = {
            ok: true,
            status: 200,
            statusText: 'mock',
            text: async () => JSON.stringify({ data: [] }),
        }

        assert.deepEqual(await client.db.users.find(), [])
        assert.equal(client.rateLimit.status('db'), undefined)
    })
})

describe('a budget the gateway names rather than the path implies', () => {
    /**
     * `/api/v1/db` carries two budgets, reads and writes, and the URL is the
     * same for both. The gateway therefore names the one it counted in
     * `RateLimit-Scope`, and that name has to win: guessing `db` from the path
     * would file both under one key, where each response overwrites the other's
     * reading and the caller paces itself off a number that flips.
     */
    it('files a budget under the scope the gateway reports, not the path', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        mockResponse({
            body: { data: [] },
            headers: {
                ...budget({ limit: 900, remaining: 873, policy: '900;w=60' }),
                'RateLimit-Scope': 'db/read',
            },
        })

        await client.db.users.find()

        assert.equal(client.rateLimit.status('db/read').remaining, 873)
        // Nothing under the path-derived name: one response, one budget.
        assert.equal(client.rateLimit.status('db'), undefined)
    })

    it('tracks db reads and db writes as the separate budgets they are', async () => {
        const client = dontcode({ apiKey: 'dc_test' })

        mockResponse({
            body: { data: [] },
            headers: { ...budget({ limit: 900, remaining: 12 }), 'RateLimit-Scope': 'db/read' },
        })
        await client.db.users.find()

        mockResponse({
            body: { data: {} },
            headers: { ...budget({ limit: 300, remaining: 299 }), 'RateLimit-Scope': 'db/write' },
        })
        await client.db.users.insert({ name: 'ada' })

        // Exhausting reads must not make writes look exhausted too, or a
        // client backs off from mutations it was still perfectly free to send.
        assert.equal(client.rateLimit.status('db/read').remaining, 12)
        assert.equal(client.rateLimit.status('db/write').remaining, 299)
        assert.deepEqual(
            client.rateLimit
                .all()
                .map((s) => s.namespace)
                .sort(),
            ['db/read', 'db/write']
        )
    })

    it('agrees with the gateway on which db budget refused the call', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        mockResponse({
            status: 429,
            body: { error: 'Rate limit exceeded.', rate_limit: true, timeleft: 8, scope: 'db/write' },
            headers: { 'RateLimit-Scope': 'db/write', 'Retry-After': 8 },
        })

        const err = await client.db.users
            .insert({ name: 'ada' })
            .then(() => null)
            .catch((e) => e)

        assert.ok(isDontCodeError(err))
        // `err.scope` and `err.rateLimit.namespace` must be one string, or
        // anything counting per budget counts the same bucket twice.
        assert.equal(err.rateLimit.namespace, 'db/write')
        assert.equal(err.scope, err.rateLimit.namespace)
        assert.equal(err.rateLimit.retryAfter, 8)
    })

    it('still derives a name from the path when no scope is sent', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        mockResponse({ body: { data: [] }, headers: budget({ limit: 600, remaining: 599 }) })

        await client.db.users.find()

        // Older gateways send no scope. Falling back beats dropping the budget.
        assert.equal(client.rateLimit.status('db').remaining, 599)
    })
})
