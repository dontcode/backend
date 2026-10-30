import { dontcode } from '../dist/index.js'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

/**
 * Every auth call made for a visitor names that visitor to the gateway, read
 * off the request the app's server is answering (src/visitor.ts), so the
 * platform's per-visitor sign-in limits count each visitor rather than the
 * app's server. `fetch` is mocked so nothing leaves the process.
 */

let calls = []
let responseBody = {}
const realFetch = globalThis.fetch

beforeEach(() => {
    calls = []
    responseBody = {}
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init })
        return {
            ok: true,
            status: 200,
            statusText: 'mock',
            text: async () => JSON.stringify(responseBody),
        }
    }
})

afterEach(() => {
    globalThis.fetch = realFetch
})

const VISITOR_NAMES = [
    'x-dontcode-client-ip',
    'x-dontcode-client-agent',
    'x-dontcode-client-country',
]
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'

/** What Vercel puts on a request from a visitor in Seoul. */
const FROM_SEOUL = {
    'x-forwarded-for': '203.0.113.7, 76.76.21.21',
    'x-real-ip': '203.0.113.7',
    'user-agent': IPHONE,
    'x-vercel-ip-country': 'KR',
}

const fromVisitor = (headers) =>
    new Request('https://shop.example/api/login', { method: 'POST', headers })

/** The visitor headers the last call sent, and nothing else. */
function sentVisitor() {
    const headers = calls[calls.length - 1].init.headers
    return Object.fromEntries(
        Object.entries(headers).filter(([name]) => name.startsWith('x-dontcode-client-'))
    )
}

async function loginFrom(request) {
    const client = dontcode({ apiKey: 'dc_test' })
    await client.auth.login({ email: 'a@b.co', password: 'pw', request })
    return sentVisitor()
}

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
const liveToken = () =>
    `${b64url({ alg: 'HS256' })}.${b64url({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`

describe('the visitor on the wire', () => {
    it('names the address, user agent and country under the names the gateway reads', async () => {
        assert.deepEqual(await loginFrom(fromVisitor(FROM_SEOUL)), {
            'x-dontcode-client-ip': '203.0.113.7',
            'x-dontcode-client-agent': IPHONE,
            'x-dontcode-client-country': 'KR',
        })
    })

    it('reads a Fetch Request, a Headers object, Node req and a bare header record alike', async () => {
        const expected = await loginFrom(fromVisitor(FROM_SEOUL))
        assert.deepEqual(await loginFrom(new Headers(FROM_SEOUL)), expected)
        assert.deepEqual(await loginFrom({ headers: { ...FROM_SEOUL }, method: 'POST' }), expected)
        assert.deepEqual(await loginFrom({ ...FROM_SEOUL }), expected)
    })

    it("joins a Node header that arrived as a list before taking x-forwarded-for's first entry", async () => {
        const visitor = await loginFrom({
            headers: { 'x-forwarded-for': ['203.0.113.7', '76.76.21.21'] },
        })
        assert.equal(visitor['x-dontcode-client-ip'], '203.0.113.7')
    })

    it('sends nothing for a call made without a request', async () => {
        assert.deepEqual(await loginFrom(undefined), {})
    })
})

describe('the address', () => {
    it("takes x-forwarded-for's first entry, never its last", async () => {
        const visitor = await loginFrom(
            fromVisitor({ 'x-forwarded-for': '203.0.113.7, 76.76.21.21' })
        )
        assert.equal(visitor['x-dontcode-client-ip'], '203.0.113.7')
    })

    it('falls back to x-real-ip when x-forwarded-for is missing or not an address', async () => {
        assert.equal(
            (await loginFrom(fromVisitor({ 'x-real-ip': '203.0.113.8' })))['x-dontcode-client-ip'],
            '203.0.113.8'
        )
        assert.equal(
            (
                await loginFrom(
                    fromVisitor({ 'x-forwarded-for': 'unknown', 'x-real-ip': '203.0.113.8' })
                )
            )['x-dontcode-client-ip'],
            '203.0.113.8'
        )
    })

    it('keeps an IPv6 address', async () => {
        const visitor = await loginFrom(fromVisitor({ 'x-forwarded-for': '2001:db8::1' }))
        assert.equal(visitor['x-dontcode-client-ip'], '2001:db8::1')
    })

    for (const [what, value] of [
        ['a word', 'unknown'],
        ['a port', '203.0.113.7:443'],
        ['a bad quad', '203.0.113.256'],
        ['a leading zero', '203.0.113.07'],
        ['a range', '203.0.113.0/24'],
        ['a host', 'shop.example.com'],
        ['a bracketed IPv6', '[2001:db8::1]'],
        ['an IPv6 with a path', '::1]/x'],
        ['two IPv6 gaps', '2001::db8::1'],
        ['a blank', '   '],
    ]) {
        it(`sends no address for ${what}`, async () => {
            const visitor = await loginFrom(
                fromVisitor({ 'x-forwarded-for': value, 'x-real-ip': value })
            )
            assert.equal(visitor['x-dontcode-client-ip'], undefined)
        })
    }
})

describe('the user agent and country', () => {
    it('trims the user agent and cuts a long one at 512 rather than dropping it', async () => {
        assert.equal(
            (await loginFrom(fromVisitor({ 'user-agent': `  ${IPHONE}  ` })))[
                'x-dontcode-client-agent'
            ],
            IPHONE
        )
        const long = 'A'.repeat(600)
        assert.equal(
            (await loginFrom(fromVisitor({ 'user-agent': long })))['x-dontcode-client-agent'],
            'A'.repeat(512)
        )
    })

    it('reads the country Vercel, Cloudflare or CloudFront reports, upper-cased', async () => {
        for (const name of ['x-vercel-ip-country', 'cf-ipcountry', 'cloudfront-viewer-country']) {
            const visitor = await loginFrom(fromVisitor({ [name]: 'kr' }))
            assert.equal(visitor['x-dontcode-client-country'], 'KR', name)
        }
    })

    it("skips Cloudflare's unknown XX and anything that is not two letters", async () => {
        assert.equal(
            (
                await loginFrom(
                    fromVisitor({ 'cf-ipcountry': 'XX', 'cloudfront-viewer-country': 'JP' })
                )
            )['x-dontcode-client-country'],
            'JP'
        )
        for (const value of ['XX', 'KOR', 'K1', 'T1', ' ']) {
            const visitor = await loginFrom(fromVisitor({ 'x-vercel-ip-country': value }))
            assert.equal(visitor['x-dontcode-client-country'], undefined, value)
        }
    })
})

describe('a visitor cannot choose what is sent', () => {
    it('never copies x-dontcode-client-* headers the visitor sent', async () => {
        const spoofed = {
            'x-dontcode-client-ip': '198.51.100.99',
            'x-dontcode-client-agent': 'spoofed',
            'x-dontcode-client-country': 'US',
        }
        assert.deepEqual(await loginFrom(fromVisitor(spoofed)), {})
        assert.deepEqual(
            await loginFrom(fromVisitor({ ...spoofed, ...FROM_SEOUL })),
            await loginFrom(fromVisitor(FROM_SEOUL))
        )
    })

    it('is not confused by a header the visitor named "headers"', async () => {
        const visitor = await loginFrom({ headers: 'x', 'x-real-ip': '203.0.113.8' })
        assert.equal(visitor['x-dontcode-client-ip'], '203.0.113.8')
    })
})

describe('it never throws', () => {
    const throwing = {
        get() {
            throw new Error('headers are gone')
        },
    }
    const explodingRecord = {}
    Object.defineProperty(explodingRecord, 'x-forwarded-for', {
        enumerable: true,
        get() {
            throw new Error('getter blew up')
        },
    })

    for (const [what, request] of [
        ['null', null],
        ['a string', 'GET /'],
        ['a number', 42],
        ['an empty object', {}],
        ['a get that throws', throwing],
        ['a request whose headers get throws', { headers: throwing }],
        ['a header getter that throws', explodingRecord],
    ]) {
        it(`still makes the call, with no visitor, for ${what}`, async () => {
            assert.deepEqual(await loginFrom(request), {})
            assert.equal(calls.length, 1)
        })
    }
})

describe('every call made for a visitor names them', () => {
    const request = fromVisitor(FROM_SEOUL)
    const accessToken = liveToken()
    const callsForVisitor = {
        signup: (c) => c.auth.signup({ email: 'a@b.co', password: 'pw', request }),
        login: (c) => c.auth.login({ email: 'a@b.co', password: 'pw', request }),
        'mfa.challenge': (c) => c.auth.mfa.challenge({ challengeToken: 'ch', code: '1', request }),
        'mfa.enroll': (c) => c.auth.mfa.enroll({ accessToken, request }),
        'mfa.enrollConfirm': (c) => c.auth.mfa.enrollConfirm({ accessToken, code: '1', request }),
        'mfa.disable': (c) => c.auth.mfa.disable({ accessToken, code: '1', request }),
        me: (c) => c.auth.me({ accessToken, request }),
        'getSession (verified)': (c) =>
            c.auth.getSession({ accessToken, mode: 'verified', request }),
        'sessionFromCookies (verified)': (c) =>
            c.auth.sessionFromCookies(`dc_access_token=${accessToken}`, {
                mode: 'verified',
                request,
            }),
        verifyEmail: (c) => c.auth.verifyEmail({ email: 'a@b.co', code: '123456', request }),
        forgotPassword: (c) => c.auth.forgotPassword({ email: 'a@b.co', request }),
        resetPassword: (c) => c.auth.resetPassword({ code: '1', password: 'pw', request }),
        requestAccountDeletion: (c) => c.auth.requestAccountDeletion({ accessToken, request }),
        deleteAccount: (c) => c.auth.deleteAccount({ accessToken, code: '123456', request }),
    }

    for (const [name, make] of Object.entries(callsForVisitor)) {
        it(name, async () => {
            responseBody = { user: { id: 'u1', email: 'a@b.co' } }
            await make(dontcode({ apiKey: 'dc_test' }))
            assert.equal(calls.length, 1)
            assert.deepEqual(Object.keys(sentVisitor()).sort(), [...VISITOR_NAMES].sort())
            assert.equal(sentVisitor()['x-dontcode-client-ip'], '203.0.113.7')
        })
    }

    it('and the credential check, which has no visitor, names none', async () => {
        await dontcode({ apiKey: 'dc_test' }).auth.info()
        assert.deepEqual(sentVisitor(), {})
    })
})
