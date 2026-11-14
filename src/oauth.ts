import type { Transport } from './http'
import type {
    OAuthAuthorizeInput,
    OAuthAuthorizeResult,
    OAuthCallbackInput,
    OAuthCallbackResult,
    OAuthProvider,
    OAuthProviderName,
} from './types'

const AUTH_BASE = '/api/v1/auth'

/**
 * How each provider is asked: its authorize URL, the scopes DontCode needs (a
 * verified email above all) and any extra parameters. Twins of @dontcode/auth
 * src/server/oauth.ts PROVIDER_PRESETS: change both together.
 */
const PROVIDER_PRESETS: Record<
    OAuthProviderName,
    { authorizeUrl: string; scopes: string[]; extraParams?: Record<string, string> }
> = {
    kakao: {
        authorizeUrl: 'https://kauth.kakao.com/oauth/authorize',
        scopes: ['profile_nickname', 'account_email'],
    },
    google: {
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        scopes: ['openid', 'email', 'profile'],
        extraParams: { access_type: 'offline', prompt: 'consent' },
    },
    github: {
        // user:email lets the auth service pick the primary verified address
        // even when the person keeps their public email private.
        authorizeUrl: 'https://github.com/login/oauth/authorize',
        scopes: ['user:email'],
    },
    apple: {
        // Apple sends the name and email only with a form POST to the callback.
        authorizeUrl: 'https://appleid.apple.com/auth/authorize',
        scopes: ['name', 'email'],
        extraParams: { response_mode: 'form_post' },
    },
}

/** How long the provider list is kept per client: the owner's switch lands within it. */
const PROVIDERS_TTL_MS = 60_000

/** A random state: 32 bytes, URL-safe, from the platform's crypto (Node 18+, browsers, edge). */
function randomState(): string {
    const bytes = new Uint8Array(32)
    globalThis.crypto.getRandomValues(bytes)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Social sign-in (Kakao, Google, GitHub, Apple) with the provider apps the
 * owner set up under Users > Sign-in settings. Their client secrets stay with
 * DontCode; your server only builds the authorize URL and hands the code back.
 *
 *   1. `providers()`: the buttons to show.
 *   2. `authorizeUrl({ provider, redirectUri })`: send the visitor there, with
 *      the returned `state` in a short-lived cookie (`serializeOAuthStateCookie`).
 *   3. On your callback, check the state (`oauthStateMatches`), then
 *      `callback({ provider, code, redirectUri })`: `login`'s answer.
 */
export class OAuthApi {
    private cached?: { at: number; providers: OAuthProvider[] }

    constructor(private readonly transport: Transport) {}

    /** The social sign-ins the owner turned on, with their public client IDs. */
    async providers(): Promise<OAuthProvider[]> {
        if (this.cached && Date.now() - this.cached.at < PROVIDERS_TTL_MS) {
            return this.cached.providers
        }
        const { providers } = await this.transport.get<{ providers?: OAuthProvider[] }>(
            `${AUTH_BASE}/oauth/providers`
        )
        const list = (providers ?? []).filter(
            (p): p is OAuthProvider =>
                !!p && typeof p.clientId === 'string' && p.name in PROVIDER_PRESETS
        )
        this.cached = { at: Date.now(), providers: list }
        return list
    }

    /**
     * The provider's authorize URL for this visitor. Throws when the owner has
     * not turned that provider on, so a button is never shown that cannot work.
     */
    async authorizeUrl(input: OAuthAuthorizeInput): Promise<OAuthAuthorizeResult> {
        const preset = PROVIDER_PRESETS[input.provider]
        if (!preset) throw new Error(`Unknown sign-in provider "${input.provider}"`)
        const provider = (await this.providers()).find((p) => p.name === input.provider)
        if (!provider) {
            throw new Error(
                `${input.provider} sign-in is not turned on for this project (Users > Sign-in settings)`
            )
        }
        const state = input.state ?? randomState()
        const params = new URLSearchParams({
            client_id: provider.clientId,
            redirect_uri: input.redirectUri,
            response_type: 'code',
            state,
            ...(preset.scopes.length > 0 ? { scope: preset.scopes.join(' ') } : {}),
            ...preset.extraParams,
        })
        return {
            url: `${preset.authorizeUrl}?${params.toString()}`,
            state,
            formPost: preset.extraParams?.response_mode === 'form_post',
        }
    }

    /**
     * Finish the sign-in: the auth service exchanges the code with the owner's
     * client secret and answers as `login` does (`tokens`, or `mfa_required`
     * with a `challenge_token`). A new person is created on the way, with the
     * project's sign-up rules applied. Check the state before calling this.
     */
    callback(input: OAuthCallbackInput): Promise<OAuthCallbackResult> {
        return this.transport.json<OAuthCallbackResult>(
            `${AUTH_BASE}/oauth/callback`,
            {
                provider: input.provider,
                code: input.code,
                redirect_uri: input.redirectUri,
                ...(input.role ? { role: input.role } : {}),
                ...(input.appleUser ? { user: input.appleUser } : {}),
            },
            { request: input.request }
        )
    }
}
