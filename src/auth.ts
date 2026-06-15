import { Transport } from './http'
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

    constructor(private readonly transport: Transport) {
        this.mfa = new MfaApi(transport)
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

    /** Resolve the signed-in user from their access token, or `{ user: null }`. */
    me(input: { accessToken: string }): Promise<MeResult> {
        return this.transport.json<MeResult>(`${AUTH_BASE}/me`, {}, { accessToken: input.accessToken })
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
