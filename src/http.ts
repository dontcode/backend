import { DontCodeError, type DontCodeErrorBody } from './errors'

/** Default per-request timeout. Without one, a slow or unreachable gateway can
 *  hang a request for the platform's full socket timeout (tens of seconds),
 *  which is the single worst failure mode for an auth guard on the hot path. */
export const DEFAULT_TIMEOUT_MS = 10_000

export interface TransportConfig {
    /** Project API key. When absent, no Authorization header is sent and the
     *  gateway responds with its own "Missing API key" 401. */
    apiKey?: string
    /** Gateway origin, already normalized (no trailing slash). */
    baseUrl: string
    /** Per-request timeout in ms. Defaults to `DEFAULT_TIMEOUT_MS`; `0` (or any
     *  non-positive value) disables it. */
    timeoutMs?: number
}

export interface RequestOptions {
    /** End-user access token, sent as `X-Access-Token` (separate from the
     *  project API key). Required by signed-in auth calls. */
    accessToken?: string
    /** Override the client's timeout for this one call (ms). `0` disables it. */
    timeoutMs?: number
}

/**
 * The single place network requests are made. Everything else in the SDK is a
 * typed shape around `json()` / `multipart()`. No retries, no caching, just a
 * faithful proxy of the v1 gateway.
 */
export class Transport {
    constructor(private readonly config: TransportConfig) {}

    private headers(opts?: RequestOptions): Record<string, string> {
        const headers: Record<string, string> = {}
        if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`
        if (opts?.accessToken) headers['X-Access-Token'] = opts.accessToken
        return headers
    }

    private url(path: string): string {
        return `${this.config.baseUrl}${path}`
    }

    private timeout(opts?: RequestOptions): number {
        const value = opts?.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS
        return value > 0 ? value : 0
    }

    /**
     * One fetch, with a timeout that turns "hung socket" into a fast, typed
     * failure. A timeout surfaces as `DontCodeError` with status 408 / code
     * `Timeout`; any other transport failure (DNS, refused, offline) as status
     * 0 / code `NetworkError`. Both are distinct from a real `401`, so an auth
     * guard can tell "backend is down" apart from "user is signed out".
     */
    private async send(path: string, init: RequestInit, opts?: RequestOptions): Promise<Response> {
        const timeoutMs = this.timeout(opts)
        const controller = timeoutMs > 0 ? new AbortController() : undefined
        const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined
        try {
            return await fetch(this.url(path), { ...init, signal: controller?.signal })
        } catch (err) {
            if (controller?.signal.aborted) {
                throw new DontCodeError(408, {
                    error: `Request to ${path} timed out after ${timeoutMs}ms`,
                    code: 'Timeout',
                })
            }
            throw new DontCodeError(0, {
                error: err instanceof Error ? err.message : 'Network request failed',
                code: 'NetworkError',
            })
        } finally {
            if (timer) clearTimeout(timer)
        }
    }

    /** POST a JSON body and parse the JSON response. */
    async json<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
        const res = await this.send(
            path,
            {
                method: 'POST',
                headers: { ...this.headers(opts), 'Content-Type': 'application/json' },
                body: JSON.stringify(body ?? {}),
            },
            opts
        )
        return this.parse<T>(res)
    }

    /** PUT a multipart form (file uploads). The runtime sets the boundary. */
    async multipart<T>(path: string, form: FormData, opts?: RequestOptions): Promise<T> {
        const res = await this.send(path, { method: 'PUT', headers: this.headers(opts), body: form }, opts)
        return this.parse<T>(res)
    }

    private async parse<T>(res: Response): Promise<T> {
        const raw = await res.text()
        let data: unknown = null
        if (raw) {
            try {
                data = JSON.parse(raw)
            } catch {
                data = { error: raw }
            }
        }
        if (!res.ok) {
            const body: DontCodeErrorBody =
                data && typeof data === 'object'
                    ? (data as DontCodeErrorBody)
                    : { error: res.statusText || 'Request failed' }
            throw new DontCodeError(res.status, body)
        }
        return data as T
    }
}
