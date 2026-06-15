/**
 * Every non-2xx response from the gateway surfaces as a DontCodeError. The
 * platform's error envelope is `{ error, ... }`, sometimes with a machine
 * `code` (e.g. `EmailNotVerified`, `ChallengeExpired`, `MfaNotOffered`) or
 * rate-limit fields. We preserve the whole body so callers can branch on it.
 *
 * Note: many "one more step" auth states (signup needing email verification,
 * login returning `mfa_required`) are 2xx successes, NOT errors; inspect the
 * resolved value for those. Errors are reserved for actual failures.
 */
export interface DontCodeErrorBody {
    error?: string
    /** Stable machine code, when the platform sends one. */
    code?: string
    /** Present on 429 responses. */
    rate_limit?: boolean
    /** Seconds until the rate limit resets, on 429 responses. */
    timeleft?: number
    [key: string]: unknown
}

export class DontCodeError extends Error {
    /** HTTP status code of the failing response. */
    readonly status: number
    /** Stable machine code, when present (e.g. `EmailNotVerified`). */
    readonly code?: string
    /** The raw parsed response body. */
    readonly body: DontCodeErrorBody

    constructor(status: number, body: DontCodeErrorBody) {
        const message =
            typeof body?.error === 'string' && body.error.length > 0
                ? body.error
                : `DontCode request failed with status ${status}`
        super(message)
        this.name = 'DontCodeError'
        this.status = status
        this.code = typeof body?.code === 'string' ? body.code : undefined
        this.body = body ?? {}
    }

    /** True when the request was rejected by the per-key rate limiter. */
    get rateLimited(): boolean {
        return this.status === 429
    }
}

/** Cross-bundle-safe check; works even if two copies of the SDK are loaded. */
export function isDontCodeError(err: unknown): err is DontCodeError {
    if (err instanceof DontCodeError) return true
    return (
        typeof err === 'object' &&
        err !== null &&
        (err as { name?: unknown }).name === 'DontCodeError'
    )
}
