/**
 * Cookie helpers, framework-agnostic by design. They return strings: a
 * `Set-Cookie` header value to write, or a parsed token to read. Your framework
 * applies them (`headers.append('Set-Cookie', …)`, SvelteKit `cookies.set`, a
 * Next `Response` cookie, etc.). The SDK never owns a request or response.
 *
 * Defaults match how DontCode's own apps store the session: an httpOnly cookie
 * so JavaScript can't read the token, `Secure`, `SameSite=Lax`, path `/`, and a
 * 7-day max age. Cross-site setups (your app and the gateway on different sites)
 * need `sameSite: 'none'`, which forces `Secure` on.
 */

/** Default cookie name for the end-user access token. */
export const DEFAULT_SESSION_COOKIE_NAME = 'dc_access_token'

/** One week, in seconds. Matches the default session lifetime DontCode issues. */
const DEFAULT_MAX_AGE_SECONDS = 60 * 60 * 24 * 7

export interface SessionCookieOptions {
    /** Cookie name. Default `dc_access_token`. */
    name?: string
    /** Lifetime in seconds. Default one week. Pass the token's `ExpiresIn` to
     *  keep the cookie and the token in lockstep. */
    maxAge?: number
    /** Default `/`. */
    path?: string
    domain?: string
    /** Default `true`. */
    secure?: boolean
    /** Default `true`. Keep the token unreadable from client JavaScript. */
    httpOnly?: boolean
    /** Default `'lax'`. Use `'none'` for cross-site (it forces `Secure`). */
    sameSite?: 'lax' | 'strict' | 'none'
}

function serialize(name: string, value: string, options: SessionCookieOptions, maxAge: number): string {
    const sameSite = options.sameSite ?? 'lax'
    // SameSite=None is meaningless without Secure (browsers drop it), so force
    // Secure on there; otherwise it defaults on and the caller can opt out.
    const secure = sameSite === 'none' ? true : (options.secure ?? true)
    const httpOnly = options.httpOnly ?? true
    const path = options.path ?? '/'

    const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `Max-Age=${maxAge}`]
    if (options.domain) parts.push(`Domain=${options.domain}`)
    parts.push(`SameSite=${sameSite.charAt(0).toUpperCase()}${sameSite.slice(1)}`)
    if (httpOnly) parts.push('HttpOnly')
    if (secure) parts.push('Secure')
    return parts.join('; ')
}

/** Build a `Set-Cookie` value that stores the access token. */
export function serializeSessionCookie(token: string, options: SessionCookieOptions = {}): string {
    const name = options.name ?? DEFAULT_SESSION_COOKIE_NAME
    const maxAge = options.maxAge ?? DEFAULT_MAX_AGE_SECONDS
    return serialize(name, token, options, maxAge)
}

/** Build a `Set-Cookie` value that clears the access token (logout). */
export function clearSessionCookie(options: SessionCookieOptions = {}): string {
    const name = options.name ?? DEFAULT_SESSION_COOKIE_NAME
    return serialize(name, '', options, 0)
}

/** Read the access token out of a `Cookie` request header, or `null`. Pass the
 *  raw header string (`name=value; name2=value2`). */
export function readSessionToken(
    cookieHeader: string | null | undefined,
    name: string = DEFAULT_SESSION_COOKIE_NAME
): string | null {
    if (!cookieHeader) return null
    for (const pair of cookieHeader.split(';')) {
        const eq = pair.indexOf('=')
        if (eq === -1) continue
        if (pair.slice(0, eq).trim() !== name) continue
        const raw = pair.slice(eq + 1).trim()
        if (!raw) return null
        try {
            return decodeURIComponent(raw)
        } catch {
            return raw
        }
    }
    return null
}
