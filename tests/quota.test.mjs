import { dontcode, isDontCodeError } from '../dist/index.js'
import { createMcpServer } from '../dist/mcp/index.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

/**
 * A plan's quota used up for its period (the month's database reads or
 * writes, the day's or month's emails) arrives as a 429, the same status as a
 * rate limit, but no wait clears it. These tests pin that the SDK and the MCP
 * server tell the two apart, so neither a BYOC app nor an agent retries a
 * quota on a timer.
 */

let nextResponse = null
const realFetch = globalThis.fetch

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

/** The per-minute window the gateway still reports on a quota refusal: it has room. */
const perMinute = (scope) => ({
    'RateLimit-Limit': 900,
    'RateLimit-Remaining': 850,
    'RateLimit-Reset': 42,
    'RateLimit-Scope': scope,
})

/** The gateway's answer once a month's database reads or writes are used up. */
const dbQuota = (budget) => ({
    status: 429,
    body: {
        error: `This project has used this month's database ${budget} on its plan.`,
        code: 'DB_QUOTA_EXCEEDED',
    },
    headers: perMinute(budget === 'reads' ? 'db/read' : 'db/write'),
})

/** The email service's answer once a plan's daily or monthly emails are used up. */
const emailLimit = (kind) => ({
    status: 429,
    body: {
        error: `Rate limited: free plan allows 100 emails per ${kind === 'daily' ? '24h' : '30d'} (you've sent 100).`,
        plan_slug: 'free',
        limit_kind: kind,
        limit: 100,
        used: 100,
    },
})

/** A per-minute rate limit, which a wait does clear. */
const rateLimit = {
    status: 429,
    body: { error: 'Rate limit exceeded. Try again in 30s.', rate_limit: true, timeleft: 30 },
    headers: {
        'RateLimit-Limit': 900,
        'RateLimit-Remaining': 0,
        'RateLimit-Reset': 30,
        'RateLimit-Scope': 'db/read',
        'Retry-After': 30,
    },
}

const refusal = (promise) =>
    promise.then(
        () => assert.fail('expected the call to be refused'),
        (err) => err
    )

beforeEach(() => {
    mockResponse({ body: {} })
    globalThis.fetch = async () => nextResponse
})

afterEach(() => {
    globalThis.fetch = realFetch
    delete process.env.DONTCODE_API_KEY
    delete process.env.DONTCODE_API_URL
})

describe('a used-up quota in the SDK', () => {
    for (const budget of ['reads', 'writes']) {
        it(`reads the month's database ${budget} used up as a quota, not a rate limit`, async () => {
            const client = dontcode({ apiKey: 'dc_test' })
            mockResponse(dbQuota(budget))

            const call =
                budget === 'reads' ? client.db.orders.find() : client.db.orders.insert({ total: 1 })
            const err = await refusal(call)

            assert.ok(isDontCodeError(err))
            assert.equal(err.status, 429)
            assert.equal(err.code, 'DB_QUOTA_EXCEEDED')
            assert.equal(err.quotaExceeded, true)
            assert.equal(err.rateLimited, false)
            assert.equal(err.retryAfter, undefined)
        })
    }

    it('leaves the per-minute budget on a quota refusal unexceeded, with no wait', async () => {
        const seen = []
        const client = dontcode({ apiKey: 'dc_test', onRateLimit: (s) => seen.push(s) })
        mockResponse(dbQuota('reads'))

        const err = await refusal(client.db.orders.find())

        const expected = {
            namespace: 'db/read',
            limit: 900,
            remaining: 850,
            reset: 42,
            exceeded: false,
        }
        assert.deepEqual(client.rateLimit.status('db/read'), expected)
        assert.deepEqual(err.rateLimit, expected)
        assert.deepEqual(seen, [expected])
    })

    for (const kind of ['daily', 'monthly']) {
        it(`reads the plan's ${kind} email limit as a quota`, async () => {
            const client = dontcode({ apiKey: 'dc_test' })
            mockResponse(emailLimit(kind))

            const err = await refusal(
                client.notifications.email.send({ to: 'a@b.co', subject: 'hi', markdownText: 'hi' })
            )

            assert.equal(err.quotaExceeded, true)
            assert.equal(err.rateLimited, false)
            assert.equal(err.retryAfter, undefined)
            assert.equal(err.rateLimit, undefined)
        })
    }

    it('keeps a per-minute rate limit a rate limit', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        mockResponse(rateLimit)

        const err = await refusal(client.db.orders.find())

        assert.equal(err.quotaExceeded, false)
        assert.equal(err.rateLimited, true)
        assert.equal(err.retryAfter, 30)
        assert.equal(err.rateLimit.exceeded, true)
    })

    it('reads no quota into a period it does not know or an ordinary error', async () => {
        const client = dontcode({ apiKey: 'dc_test' })

        mockResponse({ status: 400, body: { error: 'Bad request', limit_kind: 'weekly' } })
        const unknownPeriod = await refusal(client.db.orders.find())
        assert.equal(unknownPeriod.quotaExceeded, false)

        mockResponse({ status: 404, body: { error: 'No such table', code: 'NOT_FOUND' } })
        const notFound = await refusal(client.db.orders.find())
        assert.equal(notFound.quotaExceeded, false)
        assert.equal(notFound.rateLimited, false)
    })
})

describe('a used-up quota through the MCP server', () => {
    /** The real server, driven in-process by a real MCP client, as an AI tool would. */
    async function connect() {
        process.env.DONTCODE_API_KEY = 'dc_test'
        process.env.DONTCODE_API_URL = 'https://gateway.test'
        const server = createMcpServer()
        const client = new Client({ name: 'quota-test', version: '0.0.0' })
        const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
        await Promise.all([server.connect(serverSide), client.connect(clientSide)])
        return client
    }

    const textOf = (result) => result.content.map((c) => c.text).join('\n')

    it('tells the agent a used-up quota is not a rate limit and not to retry it', async () => {
        const mcp = await connect()
        mockResponse(dbQuota('writes'))

        const result = await mcp.callTool({
            name: 'db_insert',
            arguments: { table: 'orders', data: { total: 1 } },
        })

        assert.equal(result.isError, true)
        const text = textOf(result)
        assert.match(text, /month's database writes/)
        assert.match(text, /not a rate limit/)
        assert.match(text, /do not retry/)
        assert.doesNotMatch(text, /Rate limited|Wait \d+s/)
        await mcp.close()
    })

    it('still tells the agent how long to wait on a per-minute rate limit', async () => {
        const mcp = await connect()
        mockResponse(rateLimit)

        const result = await mcp.callTool({
            name: 'db_query',
            arguments: { table: 'orders' },
        })

        assert.equal(result.isError, true)
        const text = textOf(result)
        assert.match(text, /^Rate limited\./)
        assert.match(text, /Wait 30s before retrying/)
        await mcp.close()
    })
})
