import { isDontCodeError } from './errors'
import type { AuthApi } from './auth'
import type { CurrentUser } from './types'

/**
 * Session helpers, framework-agnostic by design. They never touch a request or
 * response object; they take a token (or a cookie header) and return plain
 * data, so they slot into any framework's guard (Next middleware, SvelteKit
 * hooks, Express, a worker) without an adapter.
 *
 * The point of the module: an auth guard must not make a network round-trip on
 * every navigation, or a slow gateway stalls the page and a swallowed timeout
 * reads as "signed out". So there are two modes:
 *
 *   - optimistic — decode the token locally (no signature check, no network)
 *     and trust its claims for routing. Instant. Used for the common gate.
 *   - verified   — call the gateway's `me` once, cache the result for a short
 *     TTL, and hard-timeout the request. Used for sensitive actions.
 *
 * The trade-offs (no signature verification, revocation lag) are documented on
 * `getSession` and in the public BYOC docs; read them before choosing a mode.
 */

/** A JWT payload decoded WITHOUT verifying its signature. Trust accordingly. */
export interface DecodedSession {
    /** Subject — the user id. */
    sub: string
    email?: string
    role?: string
    claims?: Record<string, unknown>
    /** Expiry, seconds since the epoch (standard JWT `exp`). */
    exp?: number
    /** Issued-at, seconds since the epoch (standard JWT `iat`). */
    iat?: number
    [key: string]: unknown
}

export type SessionStatus =
    /** A usable session: a present, unexpired token (verified or optimistic). */
    | 'active'
    /** The token is present but past its `exp`. */
    | 'expired'
    /** No token, or an unparseable one. */
    | 'anonymous'
    /** Verified mode could not reach the gateway (timeout/network/5xx). The
     *  optimistically-decoded `user` is still returned so the caller can choose
     *  to fail open during an outage instead of logging everyone out. */
    | 'unavailable'

export interface SessionResult {
    status: SessionStatus
    /** The signed-in user, or `null` when anonymous/expired. In `verified` mode
     *  this came from the gateway; in `optimistic` (or `unavailable`) it was
     *  decoded from the token's own claims. */
    user: CurrentUser | null
    /** True only when `user` was confirmed by a gateway `me` call this request
     *  (or from a fresh cache entry of one). False for optimistic decodes. */
    verified: boolean
    /** The token's `exp` (seconds since epoch), when present. */
    expiresAt?: number
}

export interface GetSessionInput {
    accessToken: string
    /** `optimistic` (default): decode locally, zero network. `verified`: confirm
     *  against the gateway with caching + a hard timeout. */
    mode?: 'optimistic' | 'verified'
}

/** A place to cache verified sessions. Swap the default in-memory store for a
 *  shared one (Redis, KV) when running multiple instances. */
export interface SessionCache {
    get(token: string): SessionResult | undefined
    set(token: string, value: SessionResult, ttlMs: number): void
    delete?(token: string): void
}

export interface SessionOptions {
    /** Cache for verified sessions. Defaults to a per-process `InMemorySessionCache`. */
    cache?: SessionCache
    /** How long a verified session stays cached. Default 60_000 (60s). Keep it
     *  short: a cached session can outlive a server-side revocation by up to
     *  this long. */
    ttlMs?: number
    /** Timeout for the `me` call made by `verified` mode (ms). Default 5_000. */
    verifyTimeoutMs?: number
}

const DEFAULT_TTL_MS = 60_000
const DEFAULT_VERIFY_TIMEOUT_MS = 5_000

/** Default cache: a `Map` with per-entry TTL. Lives for the life of the process
 *  (and is shared across requests on a reused serverless instance). */
export class InMemorySessionCache implements SessionCache {
    private readonly store = new Map<string, { value: SessionResult; expiresAtMs: number }>()

    get(token: string): SessionResult | undefined {
        const hit = this.store.get(token)
        if (!hit) return undefined
        if (Date.now() >= hit.expiresAtMs) {
            this.store.delete(token)
            return undefined
        }
        return hit.value
    }

    set(token: string, value: SessionResult, ttlMs: number): void {
        this.store.set(token, { value, expiresAtMs: Date.now() + ttlMs })
    }

    delete(token: string): void {
        this.store.delete(token)
    }
}

function base64UrlDecode(segment: string): string {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.length % 4 === 0 ? base64 : base64 + '='.repeat(4 - (base64.length % 4))
    if (typeof atob === 'function') {
        const binary = atob(padded)
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
        return new TextDecoder().decode(bytes)
    }
    // Node without a global atob (older runtimes); Buffer is always present there.
    return Buffer.from(padded, 'base64').toString('utf8')
}

/**
 * Decode a JWT access token's payload WITHOUT verifying its signature, or
 * return `null` if it is not a parseable JWT. This is deliberately cheap and
 * offline; it is not proof the token is genuine. DontCode tokens are signed
 * with a secret the gateway never shares, so the only authority on a token is
 * the gateway's `me` endpoint — use `getSession({ mode: 'verified' })` when you
 * need that authority.
 */
export function decodeAccessToken(token: string): DecodedSession | null {
    if (!token || typeof token !== 'string') return null
    const parts = token.split('.')
    if (parts.length < 2) return null
    try {
        const payload = JSON.parse(base64UrlDecode(parts[1])) as Record<string, unknown>
        if (!payload || typeof payload.sub !== 'string') return null
        return payload as DecodedSession
    } catch {
        return null
    }
}

/** True when a token (or already-decoded payload) is past its `exp`. A token
 *  with no `exp` is treated as not expired (the caller cannot prove otherwise
 *  offline). `skewSeconds` widens the window to absorb clock drift. */
export function isSessionExpired(
    input: string | DecodedSession | null,
    opts: { skewSeconds?: number } = {}
): boolean {
    const decoded = typeof input === 'string' ? decodeAccessToken(input) : input
    if (!decoded || typeof decoded.exp !== 'number') return false
    const nowSeconds = Date.now() / 1000
    return nowSeconds >= decoded.exp - (opts.skewSeconds ?? 0)
}

function userFromClaims(decoded: DecodedSession): CurrentUser {
    return {
        id: decoded.sub,
        email: typeof decoded.email === 'string' ? decoded.email : '',
        role: decoded.role,
        claims: decoded.claims,
    }
}

/**
 * Resolves access tokens into sessions for `AuthApi`. Holds the verified-session
 * cache and timeout policy. Not exported directly; reach it via
 * `client.auth.getSession` / `client.auth.sessionFromCookies`.
 */
export class SessionVerifier {
    private readonly cache: SessionCache
    private readonly ttlMs: number
    private readonly verifyTimeoutMs: number

    constructor(
        private readonly auth: AuthApi,
        options: SessionOptions = {}
    ) {
        this.cache = options.cache ?? new InMemorySessionCache()
        this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
        this.verifyTimeoutMs = options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS
    }

    async getSession({ accessToken, mode = 'optimistic' }: GetSessionInput): Promise<SessionResult> {
        const decoded = decodeAccessToken(accessToken)
        if (!decoded) return { status: 'anonymous', user: null, verified: false }
        if (isSessionExpired(decoded)) {
            return { status: 'expired', user: null, verified: false, expiresAt: decoded.exp }
        }

        const optimistic: SessionResult = {
            status: 'active',
            user: userFromClaims(decoded),
            verified: false,
            expiresAt: decoded.exp,
        }
        if (mode === 'optimistic') return optimistic

        const cached = this.cache.get(accessToken)
        if (cached) return cached

        try {
            const { user } = await this.auth.me({
                accessToken,
                timeoutMs: this.verifyTimeoutMs,
            })
            const result: SessionResult = user
                ? { status: 'active', user, verified: true, expiresAt: decoded.exp }
                : { status: 'anonymous', user: null, verified: true }
            this.cache.set(accessToken, result, this.ttlMs)
            return result
        } catch (err) {
            // A real 401 means the gateway rejected the token: the user is out.
            if (isDontCodeError(err) && err.status === 401) {
                return { status: 'anonymous', user: null, verified: true }
            }
            // Timeout / network / 5xx: the backend is unreachable, not a verdict
            // on the user. Hand back the optimistic session marked unavailable so
            // the caller decides whether to fail open. Not cached.
            return { ...optimistic, status: 'unavailable' }
        }
    }
}
