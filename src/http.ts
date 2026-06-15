import { DontCodeError, type DontCodeErrorBody } from './errors'

export interface TransportConfig {
    /** Project API key. When absent, no Authorization header is sent and the
     *  gateway responds with its own "Missing API key" 401. */
    apiKey?: string
    /** Gateway origin, already normalized (no trailing slash). */
    baseUrl: string
}

export interface RequestOptions {
    /** End-user access token, sent as `X-Access-Token` (separate from the
     *  project API key). Required by signed-in auth calls. */
    accessToken?: string
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

    /** POST a JSON body and parse the JSON response. */
    async json<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
        const res = await fetch(this.url(path), {
            method: 'POST',
            headers: { ...this.headers(opts), 'Content-Type': 'application/json' },
            body: JSON.stringify(body ?? {}),
        })
        return this.parse<T>(res)
    }

    /** PUT a multipart form (file uploads). The runtime sets the boundary. */
    async multipart<T>(path: string, form: FormData, opts?: RequestOptions): Promise<T> {
        const res = await fetch(this.url(path), {
            method: 'PUT',
            headers: this.headers(opts),
            body: form,
        })
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
