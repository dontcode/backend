/**
 * Who your server is calling the auth service for.
 *
 * The platform limits sign-in attempts per visitor (ten failed passwords from
 * one address in 15 minutes, and the like). The gateway only ever sees your
 * server, so every auth call made for a visitor names that visitor, read off
 * the request your server is answering for them: their IP address, their
 * browser's user agent and, when your host reports it, their country. Without
 * them every visitor of your app would count as one, and ten mistyped
 * passwords would refuse everyone's sign-in.
 */

/**
 * The headers the visitor travels in. Twins, change all together: the v1
 * gateway (dontcode-backend lib/public-api/visitor.ts, VISITOR_HEADERS), which
 * passes them on only for a request carrying your API key; the auth service
 * (auth-service lib/db/extract-request-info.ts, CLIENT_IP_HEADER and the agent
 * and country names beside it); and @dontcode/auth (src/server/client-ip.ts).
 */
export const VISITOR_HEADERS = {
    ip: 'x-dontcode-client-ip',
    agent: 'x-dontcode-client-agent',
    country: 'x-dontcode-client-country',
} as const

/** A longer user agent is cut to this, never dropped. The gateway cuts at the same length. */
export const MAX_AGENT_LENGTH = 512

/** Anything with a `get`: a Fetch `Headers`, or Next's `await headers()`. */
export interface HeaderGetter {
    get(name: string): string | null | undefined
}

/** Node's `req.headers` (Express, Fastify, Koa): lower-cased names. */
export type HeaderRecord = { readonly [name: string]: string | readonly string[] | undefined }

/**
 * The request your server is answering, in whatever shape your framework
 * hands it over: a Fetch `Request` (Next route handlers, SvelteKit, Remix,
 * Hono's `c.req.raw`), Node's `req` (Express, Fastify, Koa), or its headers
 * alone (`await headers()` in a Next server action).
 */
export type VisitorRequest =
    | { readonly headers: HeaderGetter | HeaderRecord }
    | HeaderGetter
    | HeaderRecord

/** What Cloudflare says when it does not know the country. */
const UNKNOWN_COUNTRY = 'XX'

/** Where hosts put the visitor's country: Vercel, Cloudflare, CloudFront. */
const COUNTRY_HEADERS = ['x-vercel-ip-country', 'cf-ipcountry', 'cloudfront-viewer-country']

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/** One IP address, no list, port, range or host. `node:net` is not available in
 *  every runtime this package runs in, so IPv6 is checked by the URL parser. */
function isIp(value: string): boolean {
    if (IPV4.test(value)) return true
    if (!value.includes(':') || !/^[0-9a-f:.]+$/i.test(value)) return false
    try {
        new URL(`http://[${value}]`)
        return true
    } catch {
        return false
    }
}

function headerReader(request: VisitorRequest): (name: string) => string | undefined {
    // A request carries its headers; a headers object is read as it is. A
    // visitor's own header named `headers` is a string, so it never counts.
    const nested = (request as { headers?: unknown }).headers
    const source = (
        nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : request
    ) as HeaderGetter | HeaderRecord
    if (typeof source.get === 'function') {
        const getter = source as HeaderGetter
        return (name) => getter.get(name) ?? undefined
    }
    const record = source as HeaderRecord
    return (name) => {
        const value = record[name]
        return typeof value === 'string' ? value : value?.join(', ')
    }
}

/**
 * The headers that name the visitor of the request your server is answering,
 * or `{}` when there is no request or nothing in it to go on. It never throws.
 *
 * The address is the first entry of `x-forwarded-for`, else `x-real-ip`, and
 * only when it is a single valid IP. Vercel sets both to the address that
 * connected and overwrites whatever a visitor sends in them. On a host whose
 * proxy appends to `x-forwarded-for` instead, its first entry is what the
 * visitor sent, which can only move your own app's per-visitor counters: the
 * platform keeps them per project. The user agent is the request's own,
 * trimmed and cut at MAX_AGENT_LENGTH; the country is the two letters your
 * host reports, upper-cased.
 *
 * A visitor who sends `x-dontcode-client-*` headers to your app changes
 * nothing: they are never read here.
 */
export function visitorHeaders(request: VisitorRequest | null | undefined): Record<string, string> {
    if (!request || typeof request !== 'object') return {}
    try {
        const read = headerReader(request)
        const ip = [read('x-forwarded-for')?.split(',')[0], read('x-real-ip')]
            .map((value) => value?.trim())
            .find((value) => !!value && isIp(value))
        const agent = read('user-agent')?.trim().slice(0, MAX_AGENT_LENGTH)
        const country = COUNTRY_HEADERS.map((name) => read(name)?.trim()).find(
            (value) =>
                !!value && /^[A-Za-z]{2}$/.test(value) && value.toUpperCase() !== UNKNOWN_COUNTRY
        )

        const headers: Record<string, string> = {}
        if (ip) headers[VISITOR_HEADERS.ip] = ip
        if (agent) headers[VISITOR_HEADERS.agent] = agent
        if (country) headers[VISITOR_HEADERS.country] = country.toUpperCase()
        return headers
    } catch {
        return {}
    }
}

/** Mixed into every auth input made for one of your visitors. */
export interface ForVisitor {
    /**
     * The request your server is answering for this visitor (see
     * `VisitorRequest`). Their address, user agent and country go with the
     * call, so the platform's per-visitor sign-in limits count them rather
     * than your server. Leave it out and the call still works; the per-address
     * limit is then skipped for it.
     */
    request?: VisitorRequest
}
