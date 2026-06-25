import { Transport } from './http'
import { readSessionToken } from './cookies'
import {
    SessionVerifier,
    decodeAccessToken,
    type DecodedSession,
    type GetSessionInput,
    type SessionOptions,
    type SessionResult,
} from './session'
import type {
    ForgotPasswordInput,
    LoginInput,
    LoginResult,
    MeResult,
    MfaChallengeInput,
    MfaDisableInput,
    MfaEnrollConfirmInput,
    MfaEnrollResult,
    ResetPasswordInput,
    SignupInput,
    SignupResult,
    SimpleResult,
    VerifyEmailInput,
} from './types'

const AUTH_BASE = '/api/v1/auth'

/** Shape of `GET /api/v1/info`: validates the credential and reports what it
 *  can do. For device tokens, capabilities follow the signed-in user's role. */
export interface InfoResult {
    project: { id: string; name: string | null }
    credential: {
        type: 'api_key' | 'device'
        role: string | null
        user_id: string | null
    }
    capabilities: Record<string, boolean>
}

/**
 * MFA is per-user and opt-in. `enroll`/`enrollConfirm`/`disable` act as the
 * signed-in user, so they need the end-user access token. `challenge` does
 * not; it completes a login that returned `mfa_required`, exchanging the
 * short-lived challenge token for real session tokens.
 */
export class MfaApi {
    constructor(private readonly transport: Transport) {}

    /** Complete an MFA login. Pass the `challenge_token` from `login`, plus
     *  either the authenticator `code` or a `recoveryCode`. */
    challenge(input: MfaChallengeInput): Promise<LoginResult> {
        return this.transport.json<LoginResult>(`${AUTH_BASE}/mfa/challenge`, {
            challenge_token: input.challengeToken,
            code: input.code,
            recovery_code: input.recoveryCode,
        })
    }

    /** Begin enrollment. Render the returned `otpauth_url` as a QR code.
     *  Enrollment stays pending until `enrollConfirm`. */
    enroll(input: { accessToken: string }): Promise<MfaEnrollResult> {
        return this.transport.json<MfaEnrollResult>(
            `${AUTH_BASE}/mfa/enroll`,
            {},
            { accessToken: input.accessToken }
        )
    }

    /** Confirm enrollment with the first authenticator code. The returned
     *  `recovery_codes` are shown once and never again. */
    enrollConfirm(input: MfaEnrollConfirmInput): Promise<SimpleResult> {
        return this.transport.json<SimpleResult>(
            `${AUTH_BASE}/mfa/enroll/confirm`,
            { code: input.code },
            { accessToken: input.accessToken }
        )
    }

    /** Turn MFA off. Proves possession of the second factor via `code` or
     *  `recoveryCode`. */
    disable(input: MfaDisableInput): Promise<SimpleResult> {
        return this.transport.json<SimpleResult>(
            `${AUTH_BASE}/mfa/disable`,
            { code: input.code, recovery_code: input.recoveryCode },
            { accessToken: input.accessToken }
        )
    }
}

/**
 * Fronts DontCode Auth with the same shapes as the gateway. Two behaviours are
 * project settings (not API flags) and your code must handle both states:
 * email verification (signup may not return tokens) and MFA (login may be two
 * steps). Branch on the resolved value; never assume one round-trip.
 */
export class AuthApi {
    readonly mfa: MfaApi
    private readonly sessions: SessionVerifier

    constructor(
        private readonly transport: Transport,
        sessionOptions?: SessionOptions
    ) {
        this.mfa = new MfaApi(transport)
        this.sessions = new SessionVerifier(this, sessionOptions)
    }

    /** Create an account. If the project requires email verification the
     *  response has `verification_required: true` and NO tokens; collect a
     *  code and call `verifyEmail`, then `login`. */
    signup(input: SignupInput): Promise<SignupResult> {
        return this.transport.json<SignupResult>(`${AUTH_BASE}/signup`, {
            email: input.email,
            password: input.password,
            name: input.name,
            role: input.role,
        })
    }

    /** Authenticate. Branch on `mfa_required`: when true you hold only a
     *  challenge (finish via `mfa.challenge`); otherwise `tokens` is your
     *  session. A 403 `EmailNotVerified` means the email step isn't done. */
    login(input: LoginInput): Promise<LoginResult> {
        return this.transport.json<LoginResult>(`${AUTH_BASE}/login`, {
            email: input.email,
            password: input.password,
        })
    }

    /** Validate the current credential (API key or device token) and report the
     *  project, the caller's role, and which capabilities that role grants.
     *  Backs the MCP "is my session still good" check. */
    info(): Promise<InfoResult> {
        return this.transport.get<InfoResult>('/api/v1/info')
    }

    /** Resolve the signed-in user from their access token, or `{ user: null }`.
     *  This is a network round-trip; for a per-navigation guard prefer
     *  `getSession`, which can answer offline and caches verified results. */
    me(input: { accessToken: string; timeoutMs?: number }): Promise<MeResult> {
        return this.transport.json<MeResult>(
            `${AUTH_BASE}/me`,
            {},
            { accessToken: input.accessToken, timeoutMs: input.timeoutMs }
        )
    }

    /**
     * Resolve an access token into a session for a route guard, the one call
     * that replaces "hit `me` on every navigation". Two modes:
     *
     *   - `'optimistic'` (default): decode the token locally and trust its
     *     claims. Zero network, zero stall. The right default for gating page
     *     loads. It does NOT verify the signature and will not notice a
     *     server-side revocation until the token's own `exp`.
     *   - `'verified'`: confirm against the gateway's `me`, cached for a short
     *     TTL with a hard timeout. Use it before sensitive actions. On a
     *     timeout/outage it returns `status: 'unavailable'` with the optimistic
     *     user, so you choose whether to fail open rather than the SDK guessing.
     *
     * See the BYOC docs ("Sessions") for the full reasoning and best practices.
     */
    getSession(input: GetSessionInput): Promise<SessionResult> {
        return this.sessions.getSession(input)
    }

    /** Read the access token from a `Cookie` request header and resolve it, in
     *  one call. `name` defaults to `dc_access_token`. Returns the anonymous
     *  session when no cookie is present. */
    sessionFromCookies(
        cookieHeader: string | null | undefined,
        options: { mode?: GetSessionInput['mode']; cookieName?: string } = {}
    ): Promise<SessionResult> {
        const token = readSessionToken(cookieHeader, options.cookieName)
        if (!token) return Promise.resolve({ status: 'anonymous', user: null, verified: false })
        return this.sessions.getSession({ accessToken: token, mode: options.mode })
    }

    /** Decode an access token's claims locally without a network call or any
     *  signature check. Convenience re-export of `decodeAccessToken`. */
    decodeToken(token: string): DecodedSession | null {
        return decodeAccessToken(token)
    }

    /** Confirm the 6-digit code emailed at signup. */
    verifyEmail(input: VerifyEmailInput): Promise<SimpleResult> {
        return this.transport.json<SimpleResult>(`${AUTH_BASE}/verify-email`, {
            code: input.code,
            email: input.email,
        })
    }

    forgotPassword(input: ForgotPasswordInput): Promise<SimpleResult> {
        return this.transport.json<SimpleResult>(`${AUTH_BASE}/forgot-password`, {
            email: input.email,
        })
    }

    resetPassword(input: ResetPasswordInput): Promise<SimpleResult> {
        return this.transport.json<SimpleResult>(`${AUTH_BASE}/reset-password`, {
            code: input.code,
            password: input.password,
            email: input.email,
        })
    }
}
