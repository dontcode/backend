import { isQuotaRefusal, type RateLimitStatus } from './rate-limit'

/**
 * Every non-2xx response from the gateway surfaces as a DontCodeError. The
 * platform's error envelope is `{ error, ... }`, sometimes with a machine
 * `code` (e.g. `EmailNotVerified`, `ChallengeExpired`, `MfaNotOffered`) or
 * rate-limit fields. We preserve the whole body so callers can branch on it.
 *
 * Note: many "one more step" auth states (signup needing email verification,
 * login returning `mfa_required`) are 2xx successes, NOT errors; inspect the
 * resolved value for those. Errors are reserved for actual failures.
 *
 * Transport failures (no HTTP response at all) also surface as a DontCodeError
 * so callers have one error type: a timeout is status 408 / code `Timeout`, and
 * any other network failure is status 0 / code `NetworkError`. Neither is a
 * `401`, so a guard can distinguish "backend unavailable" from "signed out".
 */
export interface DontCodeErrorBody {
    error?: string
    /** Stable machine code, when the platform sends one. */
    code?: string
    /** Present on rate-limit refusals. Not every part of the platform answers
     *  one with a 429, so this flag can appear on other statuses too. */
    rate_limit?: boolean
    /** Seconds until the rate limit resets, on rate-limit refusals. */
    timeleft?: number
    /** Which budget was exhausted, on rate-limit refusals. */
    scope?: string
    /** The period of a plan's email limit that ran out (`daily` or
     *  `monthly`), on an email send refused for the plan's quota. */
    limit_kind?: string
    /** A corrected email address on a sign-up refusal
     *  (`UndeliverableEmailException`, `EmailTypoSuspected`). */
    did_you_mean?: string
    [key: string]: unknown
}

export class DontCodeError extends Error {
    /** HTTP status code of the failing response. */
    readonly status: number
    /** Stable machine code, when present (e.g. `EmailNotVerified`). */
    readonly code?: string
    /** The raw parsed response body. */
    readonly body: DontCodeErrorBody
    /** Budget the responder reported alongside this failure, when it reported
     *  one. Present on rate-limit refusals, and on any other failure from a
     *  namespace that counts requests. */
    readonly rateLimit?: RateLimitStatus

    constructor(status: number, body: DontCodeErrorBody, rateLimit?: RateLimitStatus) {
        const message =
            typeof body?.error === 'string' && body.error.length > 0
                ? body.error
                : `DontCode request failed with status ${status}`
        super(message)
        this.name = 'DontCodeError'
        this.status = status
        this.code = typeof body?.code === 'string' ? body.code : undefined
        this.body = body ?? {}
        if (rateLimit) this.rateLimit = rateLimit
    }

    /**
     * True when the request was refused for spending a rate-limit budget.
     *
     * Checks the body's `rate_limit` flag as well as the status: a 429 is the
     * common shape, but not the only one a refusal can arrive in, and treating
     * status alone as the test silently misreads the others as ordinary errors.
     * A used-up plan quota is a 429 as well, and is not a rate limit: see
     * `quotaExceeded`.
     */
    get rateLimited(): boolean {
        return !this.quotaExceeded && (this.status === 429 || this.body.rate_limit === true)
    }

    /**
     * True when the project's plan quota for the period is used up: the
     * month's database reads or writes (`DB_QUOTA_EXCEEDED`), or the day's or
     * month's emails. Unlike a rate limit, waiting and retrying is refused the
     * same way until the period turns over or the owner moves to a bigger
     * plan, so do not retry it; `retryAfter` is `undefined`.
     */
    get quotaExceeded(): boolean {
        return isQuotaRefusal(this.status, this.body)
    }

    /** Seconds to wait before retrying, when the responder said. `undefined`
     *  means it didn't, not that retrying immediately is fine. Never set on a
     *  used-up quota, which no wait clears. */
    get retryAfter(): number | undefined {
        if (this.quotaExceeded) return undefined
        if (this.rateLimit?.retryAfter !== undefined) return this.rateLimit.retryAfter
        const timeleft = this.body.timeleft
        return typeof timeleft === 'number' && Number.isFinite(timeleft) ? timeleft : undefined
    }

    /** A corrected email address the platform suggested on a sign-up
     *  refusal (e.g. `jane@gmail.com` for `jane@gmai.com`), safe to offer the
     *  person typing. */
    get didYouMean(): string | undefined {
        return typeof this.body.did_you_mean === 'string' ? this.body.did_you_mean : undefined
    }

    /** Which budget was exhausted, when the responder named it. */
    get scope(): string | undefined {
        return typeof this.body.scope === 'string' ? this.body.scope : this.rateLimit?.namespace
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
