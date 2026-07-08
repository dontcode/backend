import { AuthApi } from './auth'
import { CacheClient, createCache } from './cache'
import { createDb, type DbClient } from './db'
import { Transport } from './http'
import { createNotifications, NotificationsApi } from './notifications'
import { createPayments, PaymentsApi } from './payments'
import { createRealtime, RealtimeApi } from './realtime'
import type { SessionOptions } from './session'
import { createStorage, type StorageClient } from './storage'

const DEFAULT_BASE_URL = 'https://backend.dontcode.co'

export interface DontCodeClientOptions {
    /** Project API key (`dc_…`). Defaults to `process.env.DONTCODE_API_KEY`.
     *  If neither is set, requests fail naturally with the gateway's
     *  "Missing API key" 401. */
    apiKey?: string
    /** Gateway origin. Defaults to `process.env.DONTCODE_API_URL`, then to
     *  `https://backend.dontcode.co`. */
    baseUrl?: string
    /** Per-request network timeout in ms. Defaults to 10_000; `0` disables it.
     *  Without one, a slow gateway can hang a request for the full socket
     *  timeout, the worst case for an auth guard. */
    timeoutMs?: number
    /** Caching + timeout policy for `auth.getSession` / `auth.sessionFromCookies`. */
    session?: SessionOptions
}

export interface DontCodeClient {
    auth: AuthApi
    db: DbClient
    storage: StorageClient
    cache: CacheClient
    realtime: RealtimeApi
    notifications: NotificationsApi
    payments: PaymentsApi
}

/** Read an env var without assuming `process` exists (e.g. in the browser). */
function fromEnv(name: string): string | undefined {
    if (typeof process === 'undefined' || !process.env) return undefined
    return process.env[name]
}

/**
 * Create a DontCode backend client. A thin, typed proxy over the v1 HTTP
 * gateway: auth, database, storage, cache, realtime, notifications, and payments.
 * The API key scopes every request to a single project; there is nothing else to
 * configure.
 *
 * ```ts
 * import { dontcode } from '@dontcode2/backend'
 * const client = dontcode() // reads DONTCODE_API_KEY
 * await client.auth.signup({ email, password, role: 'editor' })
 * ```
 */
export function dontcode(options: DontCodeClientOptions = {}): DontCodeClient {
    const apiKey = options.apiKey ?? fromEnv('DONTCODE_API_KEY')
    const baseUrl = (options.baseUrl ?? fromEnv('DONTCODE_API_URL') ?? DEFAULT_BASE_URL).replace(
        /\/+$/,
        ''
    )

    const transport = new Transport({ apiKey, baseUrl, timeoutMs: options.timeoutMs })

    return {
        auth: new AuthApi(transport, options.session),
        db: createDb(transport),
        storage: createStorage(transport),
        cache: createCache(transport),
        realtime: createRealtime(transport),
        notifications: createNotifications(transport),
        payments: createPayments(transport),
    }
}
