import { AuthApi } from './auth'
import { createDb, type DbClient } from './db'
import { Transport } from './http'
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
}

export interface DontCodeClient {
    auth: AuthApi
    db: DbClient
    storage: StorageClient
}

/** Read an env var without assuming `process` exists (e.g. in the browser). */
function fromEnv(name: string): string | undefined {
    if (typeof process === 'undefined' || !process.env) return undefined
    return process.env[name]
}

/**
 * Create a DontCode backend client. A thin, typed proxy over the v1 HTTP
 * gateway: auth, database, and storage. The API key scopes every request to
 * a single project; there is nothing else to configure.
 *
 * ```ts
 * import { dontcode } from '@dontcode/backend'
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

    const transport = new Transport({ apiKey, baseUrl })

    return {
        auth: new AuthApi(transport),
        db: createDb(transport),
        storage: createStorage(transport),
    }
}
