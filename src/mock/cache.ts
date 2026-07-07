/**
 * Key-value cache for the mock gateway — the server half of `client.cache`.
 *
 * Production backs this with Redis; the mock keeps it in a plain in-process Map
 * because the cache is explicitly EPHEMERAL (the SDK docs say so). Unlike the
 * mock's db/auth/storage, nothing here is persisted to disk — a restart starts
 * empty, which matches how an expiring cache behaves anyway.
 *
 * The wire protocol is `/api/v1/cache/...` (see src/cache.ts for the client):
 *   GET    /kv/:key                 → { value } | 404 (miss)
 *   PUT    /kv/:key?ttl=&nx=  (body) → { set }
 *   DELETE /kv/:key                 → { deleted }
 *   POST   /expire/:key  { ttl }    → { applied }
 *   POST   /hset/:key    { fields } → { written }
 *   GET    /hgetall/:key            → { value } | 404
 *   POST   /sadd/:key    { members }→ { added }
 *   GET    /smembers/:key           → { value } | 404
 *   POST   /srem/:key    { members }→ { removed }
 *
 * A miss (or an expired key) is a 404, which the SDK's `cache.get` /
 * `hgetAll` / `sMembers` map to `null` / `null` / `[]`.
 */

interface Entry {
    /** Raw JSON for kv, a plain object for hashes, a Set<string> for sets. */
    value: unknown
    /** Epoch ms when this key expires, or null for no expiry. */
    expireAt: number | null
}

export interface MockCache {
    /** Route a `/api/v1/cache/...` request. `url` carries ttl/nx query params. */
    handle(method: string, url: URL, raw: Buffer): { status: number; body: unknown }
}

export function createMockCache(): MockCache {
    const store = new Map<string, Entry>()
    const now = () => Date.now()

    /** Fetch a live entry, evicting it first if its TTL has passed. */
    const live = (key: string): Entry | null => {
        const entry = store.get(key)
        if (!entry) return null
        if (entry.expireAt != null && entry.expireAt <= now()) {
            store.delete(key)
            return null
        }
        return entry
    }

    const ttlToExpiry = (ttl: unknown): number | null => {
        const n = Number(ttl)
        return Number.isFinite(n) && n > 0 ? now() + Math.floor(n) * 1000 : null
    }

    const notFound = { status: 404, body: { error: 'Not found' } }

    function handle(method: string, url: URL, raw: Buffer): { status: number; body: unknown } {
        // subPath = everything after `/api/v1/cache`, e.g. `/kv/session%3A42`.
        const sub = url.pathname.slice('/api/v1/cache'.length).replace(/^\/+/, '')
        const slash = sub.indexOf('/')
        const op = slash === -1 ? sub : sub.slice(0, slash)
        const key = slash === -1 ? '' : decodeURIComponent(sub.slice(slash + 1))
        if (!key) return { status: 400, body: { error: 'key is required' } }

        const body = () => parseJsonBody(raw)

        switch (`${method} ${op}`) {
            case 'GET kv': {
                const entry = live(key)
                return entry ? { status: 200, body: { value: entry.value } } : notFound
            }
            case 'PUT kv': {
                const value = parseAnyJson(raw)
                const nx = url.searchParams.get('nx') === 'true'
                if (nx && live(key)) return { status: 200, body: { set: false } }
                store.set(key, { value, expireAt: ttlToExpiry(url.searchParams.get('ttl')) })
                return { status: 200, body: { set: true } }
            }
            case 'DELETE kv': {
                const existed = live(key) != null
                store.delete(key)
                return { status: 200, body: { deleted: existed } }
            }
            case 'POST expire': {
                const entry = live(key)
                if (!entry) return { status: 200, body: { applied: false } }
                const { ttl } = body() as { ttl?: unknown }
                entry.expireAt = ttl == null ? null : ttlToExpiry(ttl)
                return { status: 200, body: { applied: true } }
            }
            case 'POST hset': {
                const { fields } = body() as { fields?: Record<string, unknown> }
                if (!fields || typeof fields !== 'object') {
                    return { status: 400, body: { error: 'fields is required' } }
                }
                const hash = asRecord(live(key))
                for (const [k, v] of Object.entries(fields)) hash[k] = v
                store.set(key, { value: hash, expireAt: live(key)?.expireAt ?? null })
                return { status: 200, body: { written: Object.keys(fields).length } }
            }
            case 'GET hgetall': {
                const entry = live(key)
                return entry ? { status: 200, body: { value: entry.value } } : notFound
            }
            case 'POST sadd': {
                const members = memberList(body())
                const set = asSet(live(key))
                let added = 0
                for (const m of members) if (!set.has(m)) (set.add(m), added++)
                store.set(key, { value: set, expireAt: live(key)?.expireAt ?? null })
                return { status: 200, body: { added } }
            }
            case 'GET smembers': {
                const entry = live(key)
                if (!entry) return notFound
                return { status: 200, body: { value: [...asSet(entry)] } }
            }
            case 'POST srem': {
                const members = memberList(body())
                const entry = live(key)
                if (!entry) return { status: 200, body: { removed: 0 } }
                const set = asSet(entry)
                let removed = 0
                for (const m of members) if (set.delete(m)) removed++
                return { status: 200, body: { removed } }
            }
            default:
                return { status: 404, body: { error: 'Unknown cache endpoint' } }
        }
    }

    return { handle }
}

/** Coerce an entry's value into a hash, tolerating a wrong-typed prior value. */
function asRecord(entry: Entry | null): Record<string, unknown> {
    const v = entry?.value
    return v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Set)
        ? (v as Record<string, unknown>)
        : {}
}

/** Coerce an entry's value into a string set, tolerating a wrong-typed prior value. */
function asSet(entry: Entry | null): Set<string> {
    return entry?.value instanceof Set ? (entry.value as Set<string>) : new Set<string>()
}

function memberList(body: Record<string, unknown>): string[] {
    return Array.isArray(body.members) ? body.members.map(String) : []
}

/** Parse a JSON object body (for the POST endpoints); `{}` on empty/garbage. */
function parseJsonBody(raw: Buffer): Record<string, unknown> {
    const parsed = parseAnyJson(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
}

/** Parse ANY JSON value (kv `set` stores primitives, arrays, objects, null). */
function parseAnyJson(raw: Buffer): unknown {
    if (raw.length === 0) return null
    try {
        return JSON.parse(raw.toString('utf8'))
    } catch {
        return null
    }
}
