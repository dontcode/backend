/**
 * Rate-limit signal, lifted off the wire and made usable.
 *
 * The gateway emits `RateLimit-Limit / -Remaining / -Reset / -Policy` on every
 * counted response, successes included. That is the entire point of them: a
 * caller can slow down BEFORE it gets refused, instead of discovering the
 * budget by hitting the wall. Budgets are per namespace, so the signal is
 * tracked per namespace too — a chatty realtime loop tells you nothing about
 * how much migration budget is left.
 *
 * `Transport` is the only part of the SDK that ever holds a `Response`, so it
 * reads these headers there and hands the parsed result on. Nothing downstream
 * of it deals in headers.
 */

/** Just enough of `Headers` to read one field. Kept structural so a stubbed or
 *  polyfilled response can never crash the parse. */
export interface HeaderReader {
    get(name: string): string | null | undefined
}

/** One namespace's budget, as of the last response seen from it. Every numeric
 *  field is optional because a response that wasn't counted reports none of
 *  them, and guessing a number there would be worse than admitting silence. */
export interface RateLimitStatus {
    /** Public name of the budget: `db/read`, `db/write`, `db/migrate`, `auth`, …
     *  Always the same string the gateway reports as `RateLimit-Scope`, and as
     *  `scope` on a refusal. Note that `/api/v1/db` has two budgets, so its
     *  reads and writes are tracked separately. */
    namespace: string
    /** Requests allowed per window. */
    limit?: number
    /** Requests left in the current window. At `0`, the next call may be refused. */
    remaining?: number
    /** Whole seconds until the window resets. */
    reset?: number
    /** Raw policy string, e.g. `600;w=60`. */
    policy?: string
    /** Seconds to wait before retrying. Set when the request was refused. */
    retryAfter?: number
    /** True when this response *was* the refusal, not a survivor of the budget. */
    exceeded: boolean
}

/** Read-only view of what the client has learned about its budgets. */
export interface RateLimitView {
    /** Latest status for one namespace, or the most recent from any namespace
     *  when called with no argument. `undefined` until a counted response has
     *  come back, which also means "nothing is being counted here". */
    status(namespace?: string): RateLimitStatus | undefined
    /** Latest status for every namespace this client has called. */
    all(): RateLimitStatus[]
}

/** Fields of a platform error body that speak to rate limiting. Passed in
 *  rather than imported so this module stays dependency-free. */
export interface RateLimitHints {
    rate_limit?: unknown
    timeleft?: unknown
}

/**
 * Namespaces that live below the first path segment and hold their own budget.
 * Longest first, so a nested match always wins over its parent — otherwise
 * `db/migrate` would be filed under `db` and its far smaller budget would
 * silently overwrite the readings for the big one.
 *
 * These strings are exactly what the gateway reports as `scope` when it refuses
 * a request, so a namespace named here and the one named on the wire are always
 * the same value.
 */
const NESTED_NAMESPACES = ['auth/device/start', 'db/migrate']

/**
 * The namespace a request path spends from. A fallback only: it is a guess, and
 * one path can spend from more than one budget. `POST /api/v1/db` draws on
 * `db/read` for queries and `db/write` for mutations, and nothing in the URL
 * says which. Prefer the `RateLimit-Scope` the gateway sends; come here when a
 * response carries none, so a budget is still tracked under a sensible name
 * rather than dropped.
 */
export function namespaceFromPath(path: string): string {
    const rest = path.replace(/^\/api\/v1/, '').replace(/^\/+/, '')
    const [head = ''] = rest.split(/[?#]/)
    const segments = head.split('/').filter(Boolean)
    if (segments.length === 0) return 'info'
    for (const nested of NESTED_NAMESPACES) {
        const depth = nested.split('/').length
        if (segments.slice(0, depth).join('/') === nested) return nested
    }
    return segments[0] ?? 'info'
}

function num(raw: string | null | undefined): number | undefined {
    if (raw === null || raw === undefined || raw === '') return undefined
    const value = Number(raw)
    return Number.isFinite(value) ? value : undefined
}

function hint(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Parse the rate-limit story out of one response.
 *
 * Returns `undefined` when the response says nothing about a budget: an
 * unenforced namespace must not produce a status full of `undefined`s, or
 * "no limit here" becomes indistinguishable from "limit unknown".
 *
 * A refusal always produces a status, headers or not. Not every part of the
 * platform answers with `RateLimit-*`, and a caller that got refused still
 * needs to know it was a rate limit and roughly how long to wait.
 */
export function readRateLimit(
    status: number,
    headers: HeaderReader | undefined,
    path: string,
    hints?: RateLimitHints
): RateLimitStatus | undefined {
    const read = (name: string): string | undefined => {
        try {
            return headers?.get?.(name) ?? undefined
        } catch {
            return undefined
        }
    }

    const scope = read('RateLimit-Scope') || undefined
    const limit = num(read('RateLimit-Limit'))
    const remaining = num(read('RateLimit-Remaining'))
    const reset = num(read('RateLimit-Reset'))
    const policy = read('RateLimit-Policy') || undefined
    const retryAfterHeader = num(read('Retry-After'))
    const exceeded = status === 429 || hints?.rate_limit === true

    const counted =
        limit !== undefined ||
        remaining !== undefined ||
        reset !== undefined ||
        policy !== undefined ||
        retryAfterHeader !== undefined
    if (!counted && !exceeded) return undefined

    // On a refusal, fall back through everything that carries a wait: the
    // header, the body's `timeleft`, then the window reset.
    const retryAfter = exceeded
        ? (retryAfterHeader ?? hint(hints?.timeleft) ?? reset)
        : retryAfterHeader

    return {
        // The gateway is authoritative about which budget it counted; the path
        // is only a guess, and a wrong guess makes two budgets overwrite each
        // other's readings under one key.
        namespace: scope ?? namespaceFromPath(path),
        ...(limit !== undefined ? { limit } : {}),
        ...(remaining !== undefined ? { remaining } : {}),
        ...(reset !== undefined ? { reset } : {}),
        ...(policy !== undefined ? { policy } : {}),
        ...(retryAfter !== undefined ? { retryAfter } : {}),
        exceeded,
    }
}
