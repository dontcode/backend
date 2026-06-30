import { isDontCodeError } from './errors'
import { Transport } from './http'
import type { CacheSetOptions } from './types'

const CACHE_PATH = '/api/v1/cache'

const enc = (key: string) => encodeURIComponent(key)

/** Treat a 404 from the gateway as a cache miss rather than an error. */
function asMiss<T>(err: unknown, fallback: T): T {
    if (isDontCodeError(err) && err.status === 404) return fallback
    throw err
}

/**
 * Key-value cache: a typed proxy over `/api/v1/cache`. Keys are namespaced to
 * your project by the gateway; values are JSON. This is ephemeral storage —
 * use `db` for anything that must be durable.
 *
 * ```ts
 * await client.cache.set('session:42', { step: 2 }, { ttl: 3600 })
 * const s = await client.cache.get<{ step: number }>('session:42') // null if expired
 * ```
 */
export class CacheClient {
    constructor(private readonly transport: Transport) {}

    /** Read a value. Returns `null` on a miss or expiry. */
    async get<T = unknown>(key: string): Promise<T | null> {
        try {
            const r = await this.transport.get<{ value: T }>(`${CACHE_PATH}/kv/${enc(key)}`)
            return r.value
        } catch (err) {
            return asMiss<T | null>(err, null)
        }
    }

    /** Set a value, optionally with a TTL (seconds) or set-if-absent (`nx`).
     *  Returns `false` when `nx` is set and the key already existed. */
    async set(key: string, value: unknown, options: CacheSetOptions = {}): Promise<boolean> {
        const params = new URLSearchParams()
        if (options.ttl != null) params.set('ttl', String(options.ttl))
        if (options.nx) params.set('nx', 'true')
        const qs = params.toString() ? `?${params}` : ''
        const r = await this.transport.put<{ set: boolean }>(`${CACHE_PATH}/kv/${enc(key)}${qs}`, value)
        return r.set
    }

    /** Delete a key. Returns whether it existed. */
    async del(key: string): Promise<boolean> {
        const r = await this.transport.del<{ deleted: boolean }>(`${CACHE_PATH}/kv/${enc(key)}`)
        return r.deleted
    }

    /** Set or clear (`null`) the TTL on an existing key. Returns `false` if absent. */
    async expire(key: string, ttl: number | null): Promise<boolean> {
        const r = await this.transport.json<{ applied: boolean }>(`${CACHE_PATH}/expire/${enc(key)}`, {
            ttl,
        })
        return r.applied
    }

    // --- hashes -------------------------------------------------------------

    /** Set fields on a hash. Returns the number of fields written. */
    async hset(key: string, fields: Record<string, unknown>): Promise<number> {
        const r = await this.transport.json<{ written: number }>(`${CACHE_PATH}/hset/${enc(key)}`, {
            fields,
        })
        return r.written
    }

    /** Read a whole hash. Returns `null` on a miss. */
    async hgetAll<T = Record<string, unknown>>(key: string): Promise<T | null> {
        try {
            const r = await this.transport.get<{ value: T }>(`${CACHE_PATH}/hgetall/${enc(key)}`)
            return r.value
        } catch (err) {
            return asMiss<T | null>(err, null)
        }
    }

    // --- sets ---------------------------------------------------------------

    /** Add members to a set. Returns the number newly added. */
    async sAdd(key: string, ...members: string[]): Promise<number> {
        const r = await this.transport.json<{ added: number }>(`${CACHE_PATH}/sadd/${enc(key)}`, {
            members,
        })
        return r.added
    }

    /** List set members. Returns `[]` on a miss. */
    async sMembers(key: string): Promise<string[]> {
        try {
            const r = await this.transport.get<{ value: string[] }>(
                `${CACHE_PATH}/smembers/${enc(key)}`
            )
            return r.value ?? []
        } catch (err) {
            return asMiss<string[]>(err, [])
        }
    }

    /** Remove members from a set. Returns the number removed. */
    async sRem(key: string, ...members: string[]): Promise<number> {
        const r = await this.transport.json<{ removed: number }>(`${CACHE_PATH}/srem/${enc(key)}`, {
            members,
        })
        return r.removed
    }
}

export function createCache(transport: Transport): CacheClient {
    return new CacheClient(transport)
}
