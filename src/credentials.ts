import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Local credential cache for the CLI / MCP server (Node only — never import
 * from the browser entry).
 *
 * The browser device-authorization flow hands back a short-lived,
 * project-scoped, user-bound `dct_` token. We cache it on disk so the MCP
 * server can reuse it across tool calls and restarts until it expires, then
 * the user signs in again. The file is written 0600 and lives under
 * `~/.dontcode` (override with `DONTCODE_CONFIG_DIR`).
 */

export interface StoredCredential {
    /** The `dct_` device token. Sent to the gateway as `Authorization: Bearer`. */
    access_token: string
    project_id: string
    /** ISO timestamp. */
    expires_at: string
    /** Gateway origin this credential is valid for. */
    base_url: string
}

/** Credentials keyed by gateway origin, so one machine can hold several. */
type Store = Record<string, StoredCredential>

function configDir(): string {
    return process.env.DONTCODE_CONFIG_DIR || join(homedir(), '.dontcode')
}

function credentialsPath(): string {
    return join(configDir(), 'credentials.json')
}

function readStore(): Store {
    try {
        return JSON.parse(readFileSync(credentialsPath(), 'utf8')) as Store
    } catch {
        return {}
    }
}

function writeStore(store: Store): void {
    const path = credentialsPath()
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 })
}

export function loadCredential(baseUrl: string): StoredCredential | null {
    return readStore()[baseUrl] ?? null
}

export function saveCredential(cred: StoredCredential): void {
    const store = readStore()
    store[cred.base_url] = cred
    writeStore(store)
}

export function clearCredential(baseUrl: string): void {
    const store = readStore()
    delete store[baseUrl]
    writeStore(store)
}

/** A small skew so we don't hand back a token that expires mid-request. */
export function isExpired(cred: StoredCredential, skewMs = 30_000): boolean {
    return new Date(cred.expires_at).getTime() - skewMs <= Date.now()
}

export interface ActiveToken {
    token?: string
    source: 'env' | 'device' | 'none'
    projectId?: string
    expiresAt?: string
}

/**
 * The credential the MCP server should use right now. An explicit
 * `DONTCODE_API_KEY` (e.g. CI) always wins; otherwise a cached, unexpired
 * device token; otherwise nothing (the user needs to run `login`).
 */
export function resolveActiveToken(baseUrl: string): ActiveToken {
    const env = process.env.DONTCODE_API_KEY
    if (env) return { token: env, source: 'env' }

    const cred = loadCredential(baseUrl)
    if (cred && !isExpired(cred)) {
        return {
            token: cred.access_token,
            source: 'device',
            projectId: cred.project_id,
            expiresAt: cred.expires_at,
        }
    }
    return { source: 'none' }
}
