import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
    DontCodeError,
    clearSessionCookie,
    decodeAccessToken,
    dontcode,
    isSessionExpired,
    readSessionToken,
    serializeSessionCookie,
} from '../dist/index.js'

/**
 * The session helpers are the fix for "auth guard stalls 20s then false-logs-out
 * the user". These tests pin the two behaviours that matter: optimistic mode
 * never touches the network, and a slow/unreachable gateway fails fast and
 * typed (never silently as a 401).
 */

// --- a fetch mock whose behaviour each test sets via `fetchImpl` -------------
let calls = []
let fetchImpl = null
const realFetch = globalThis.fetch

const okJson = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'mock',
    text: async () => JSON.stringify(body),
})

beforeEach(() => {
    calls = []
    fetchImpl = async () => okJson({ user: null })
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init })
        return fetchImpl(url, init)
    }
})

afterEach(() => {
    globalThis.fetch = realFetch
})

// --- helpers -----------------------------------------------------------------
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
/** A structurally-valid JWT (unsigned; the SDK decodes, it never verifies). */
const makeJwt = (payload) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`
const nowSeconds = () => Math.floor(Date.now() / 1000)
const futureToken = (extra = {}) =>
    makeJwt({ sub: 'u1', email: 'a@b.co', role: 'editor', exp: nowSeconds() + 3600, ...extra })

describe('decodeAccessToken', () => {
    it('decodes the payload without verifying the signature', () => {
        const decoded = decodeAccessToken(futureToken({ claims: { plan: 'pro' } }))
        assert.equal(decoded.sub, 'u1')
        assert.equal(decoded.email, 'a@b.co')
        assert.deepEqual(decoded.claims, { plan: 'pro' })
    })

    it('returns null for garbage, non-JWT strings, and payloads without a sub', () => {
        assert.equal(decodeAccessToken('not-a-jwt'), null)
        assert.equal(decodeAccessToken(''), null)
        assert.equal(decodeAccessToken('a.b.c'), null) // b is not base64url JSON
        assert.equal(decodeAccessToken(makeJwt({ email: 'a@b.co' })), null) // no sub
    })
})

describe('isSessionExpired', () => {
    it('is true past exp, false before it, false when exp is absent', () => {
        assert.equal(isSessionExpired(makeJwt({ sub: 'u', exp: nowSeconds() - 1 })), true)
        assert.equal(isSessionExpired(makeJwt({ sub: 'u', exp: nowSeconds() + 60 })), false)
        assert.equal(isSessionExpired(makeJwt({ sub: 'u' })), false)
        assert.equal(isSessionExpired('garbage'), false)
    })

    it('honours clock skew', () => {
        const token = makeJwt({ sub: 'u', exp: nowSeconds() + 10 })
        assert.equal(isSessionExpired(token, { skewSeconds: 30 }), true)
        assert.equal(isSessionExpired(token, { skewSeconds: 5 }), false)
    })
})

describe('cookie helpers', () => {
    it('serializes a secure, httpOnly, lax cookie with sane defaults', () => {
        const cookie = serializeSessionCookie('tok')
        assert.match(cookie, /^dc_access_token=tok/)
        assert.match(cookie, /Path=\//)
        assert.match(cookie, /Max-Age=604800/)
        assert.match(cookie, /SameSite=Lax/)
        assert.match(cookie, /HttpOnly/)
        assert.match(cookie, /Secure/)
    })

    it('forces Secure when SameSite=None even if the caller opts out', () => {
        const cookie = serializeSessionCookie('tok', { sameSite: 'none', secure: false })
        assert.match(cookie, /SameSite=None/)
        assert.match(cookie, /Secure/)
    })

    it('respects a custom name and max age', () => {
        const cookie = serializeSessionCookie('tok', { name: 'sess', maxAge: 3600 })
        assert.match(cookie, /^sess=tok/)
        assert.match(cookie, /Max-Age=3600/)
    })

    it('clears the cookie with Max-Age=0', () => {
        assert.match(clearSessionCookie(), /^dc_access_token=; .*Max-Age=0/)
    })

    it('reads the token back out of a Cookie header', () => {
        assert.equal(readSessionToken('a=1; dc_access_token=tok; b=2'), 'tok')
        assert.equal(readSessionToken('other=1'), null)
        assert.equal(readSessionToken(null), null)
        assert.equal(readSessionToken('sess=tok', 'sess'), 'tok')
    })

    it('round-trips a value through serialize and read', () => {
        const cookie = serializeSessionCookie('a.b-c_d')
        const header = cookie.split(';')[0] // "dc_access_token=a.b-c_d"
        assert.equal(readSessionToken(header), 'a.b-c_d')
    })
})

describe('transport timeout', () => {
    it('throws a typed Timeout (408) when the gateway hangs, not a 401', async () => {
        fetchImpl = (_url, init) =>
            new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () =>
                    reject(new DOMException('Aborted', 'AbortError'))
                )
            })
        const client = dontcode({ apiKey: 'dc_test', timeoutMs: 20 })
        await assert.rejects(
            () => client.auth.me({ accessToken: 'tok' }),
            (err) => {
                assert.ok(err instanceof DontCodeError)
                assert.equal(err.status, 408)
                assert.equal(err.code, 'Timeout')
                return true
            }
        )
    })

    it('throws a typed NetworkError (0) when fetch rejects outright', async () => {
        fetchImpl = async () => {
            throw new TypeError('fetch failed')
        }
        const client = dontcode({ apiKey: 'dc_test' })
        await assert.rejects(
            () => client.auth.me({ accessToken: 'tok' }),
            (err) => {
                assert.equal(err.status, 0)
                assert.equal(err.code, 'NetworkError')
                return true
            }
        )
    })
})

describe('auth.getSession', () => {
    it('optimistic mode resolves an active session with ZERO network calls', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        const session = await client.auth.getSession({ accessToken: futureToken() })
        assert.equal(session.status, 'active')
        assert.equal(session.verified, false)
        assert.equal(session.user.id, 'u1')
        assert.equal(session.user.role, 'editor')
        assert.equal(calls.length, 0)
    })

    it('reports anonymous for a missing/garbage token and expired for a stale one', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        assert.equal((await client.auth.getSession({ accessToken: 'garbage' })).status, 'anonymous')
        const expired = await client.auth.getSession({
            accessToken: makeJwt({ sub: 'u1', exp: nowSeconds() - 1 }),
        })
        assert.equal(expired.status, 'expired')
        assert.equal(calls.length, 0)
    })

    it('verified mode confirms via me() and caches the result', async () => {
        fetchImpl = async () => okJson({ user: { id: 'u1', email: 'a@b.co', role: 'admin' } })
        const client = dontcode({ apiKey: 'dc_test' })
        const token = futureToken()

        const first = await client.auth.getSession({ accessToken: token, mode: 'verified' })
        assert.equal(first.status, 'active')
        assert.equal(first.verified, true)
        assert.equal(first.user.role, 'admin') // from me(), not the token claims
        assert.equal(calls.length, 1)
        assert.equal(calls[0].url, 'https://backend.dontcode.co/api/v1/auth/me')

        const second = await client.auth.getSession({ accessToken: token, mode: 'verified' })
        assert.equal(second.verified, true)
        assert.equal(calls.length, 1) // served from cache, no second round-trip
    })

    it('verified mode treats a real 401 as signed out', async () => {
        fetchImpl = async () => okJson({ user: null }, 401)
        const client = dontcode({ apiKey: 'dc_test' })
        const session = await client.auth.getSession({
            accessToken: futureToken(),
            mode: 'verified',
        })
        assert.equal(session.status, 'anonymous')
        assert.equal(session.verified, true)
    })

    it('verified mode returns unavailable (not signed out) when the gateway times out', async () => {
        fetchImpl = (_url, init) =>
            new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () =>
                    reject(new DOMException('Aborted', 'AbortError'))
                )
            })
        const client = dontcode({ apiKey: 'dc_test', session: { verifyTimeoutMs: 20 } })
        const session = await client.auth.getSession({
            accessToken: futureToken(),
            mode: 'verified',
        })
        assert.equal(session.status, 'unavailable')
        assert.equal(session.user.id, 'u1') // optimistic user, so the app can fail open
        assert.equal(session.verified, false)

        // unavailable is NOT cached: the next call tries the gateway again.
        await client.auth.getSession({ accessToken: futureToken(), mode: 'verified' })
        assert.equal(calls.length, 2)
    })
})

describe('auth.sessionFromCookies', () => {
    it('reads the cookie header and resolves optimistically by default', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        const header = serializeSessionCookie(futureToken()).split(';')[0]
        const session = await client.auth.sessionFromCookies(header)
        assert.equal(session.status, 'active')
        assert.equal(session.user.id, 'u1')
        assert.equal(calls.length, 0)
    })

    it('returns an anonymous session when no cookie is present', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        const session = await client.auth.sessionFromCookies(null)
        assert.equal(session.status, 'anonymous')
        assert.equal(session.user, null)
    })
})
