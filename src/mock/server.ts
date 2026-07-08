/**
 * A local, zero-dependency-to-run mock of the DontCode v1 gateway.
 *
 * The SDK is a thin, typed proxy over a fixed HTTP wire protocol, so the
 * cleanest way to develop against it offline is to stand up a server that
 * speaks that same protocol. Point the SDK at it with a single env var and
 * everything else — auth, database, storage — works unchanged:
 *
 *     DONTCODE_API_URL=http://localhost:4000
 *     DONTCODE_API_KEY=dc_local_dev   # any dc_… value is accepted by default
 *
 * Fidelity comes from reusing production's exact pieces where it matters:
 *   - DB runs the real structured-query executor against in-process Postgres
 *     (PGlite), so the generated SQL, the `{ data }` envelopes, and the 409
 *     conflict signal all match the gateway.
 *   - `db.migrate` executes your real DDL against that same Postgres.
 *   - Auth issues real JWT-shaped tokens whose claims `decodeAccessToken`
 *     (and therefore `getSession`) reads exactly as it would in production.
 *   - Storage reads and writes real files and serves them over this server.
 *
 * It is a DEV tool: passwords are stored in plaintext, tokens are unsigned,
 * and there is no rate limiting. Never expose it to a network you don't trust.
 */
import { createMockCache } from './cache'
import { createMockNotifications } from './notifications'
import { createMockPayments, type PaymentsSnapshot } from './payments'
import { executeDbOperation, type Queryable } from './db-query'
import { createMockRealtime } from './realtime'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface MockServerOptions {
    /** Port to listen on. Default 4000. */
    port?: number
    /** Host/interface to bind. Default '127.0.0.1' (loopback only). */
    host?: string
    /**
     * Directory for persisted state (Postgres data, uploaded files, auth users).
     * Relative paths resolve from the cwd. Pass `null` for an ephemeral, in-memory
     * instance that starts empty every time (good for tests). Default
     * `.dontcode-mock`.
     */
    dataDir?: string | null
    /**
     * If set, only this exact API key is accepted (sent as `Authorization:
     * Bearer <key>`). If omitted, any `dc_…` bearer is accepted — the friendliest
     * default for local dev. A request with no bearer always gets a 401, matching
     * the real gateway's "Missing API key".
     */
    apiKey?: string
    /** Postgres schema the structured queries run against. Default 'public'. */
    schema?: string
    /** Suppress the startup banner and request logging. Default false. */
    quiet?: boolean
}

export interface MockServer {
    /** The base URL to put in `DONTCODE_API_URL`. */
    url: string
    port: number
    /** Stop the server and release its resources. */
    close(): Promise<void>
}

interface MockUser {
    id: string
    email: string
    password: string
    role?: string
    claims?: Record<string, unknown>
    verified: boolean
}

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days, matches the default cookie

// ── small helpers ────────────────────────────────────────────────────────────

function b64url(value: string | object): string {
    const str = typeof value === 'string' ? value : JSON.stringify(value)
    return Buffer.from(str).toString('base64url')
}

/** A JWT-shaped, UNSIGNED token. `decodeAccessToken` reads `parts[1]` as the
 *  claims and never checks the signature, so this is a faithful stand-in. */
function mintToken(user: MockUser): { AccessToken: string; ExpiresIn: number } {
    const now = Math.floor(Date.now() / 1000)
    const header = { alg: 'none', typ: 'JWT' }
    const payload = {
        sub: user.id,
        email: user.email,
        role: user.role,
        claims: user.claims,
        iat: now,
        exp: now + ACCESS_TOKEN_TTL_SECONDS,
    }
    return {
        AccessToken: `${b64url(header)}.${b64url(payload)}.${b64url('dontcode-mock')}`,
        ExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
    }
}

function decodeToken(token: string): { sub: string; exp?: number } | null {
    const parts = token.split('.')
    if (parts.length < 2) return null
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
        return typeof payload?.sub === 'string' ? payload : null
    } catch {
        return null
    }
}

function fileName(path: string): string {
    return path.split('/').filter(Boolean).pop() ?? path
}

/** Mirror of the gateway's path guard: no leading slashes, no traversal. */
function normalizePath(value: unknown, { allowEmpty = false } = {}): string | null {
    if (typeof value !== 'string') return allowEmpty && value === undefined ? '' : null
    const path = value.replace(/^\/+/, '').replace(/\/+$/, '')
    if (!allowEmpty && path.length === 0) return null
    if (path.split('/').some((segment) => segment === '..' || segment === '.')) return null
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(path)) return null
    return path
}

function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => resolve(Buffer.concat(chunks)))
        req.on('error', reject)
    })
}

// ── the server ────────────────────────────────────────────────────────────────

/**
 * Build and start a mock gateway. Resolves once it is listening; the resolved
 * handle's `url` is what goes in `DONTCODE_API_URL`.
 */
export async function startMockServer(options: MockServerOptions = {}): Promise<MockServer> {
    const port = options.port ?? 4000
    const host = options.host ?? '127.0.0.1'
    const schema = options.schema ?? 'public'
    const quiet = options.quiet ?? false
    const ephemeral = options.dataDir === null
    const dataDir = ephemeral
        ? mkdtempSync(join(tmpdir(), 'dontcode-mock-'))
        : (options.dataDir ?? '.dontcode-mock')

    if (!ephemeral) mkdirSync(dataDir, { recursive: true })

    // ── Postgres (PGlite), lazily imported so the core SDK stays dependency-free.
    const pglite = await loadPGlite()
    const pgDir = ephemeral ? undefined : join(dataDir, 'pgdata')
    const pg = pgDir ? new pglite.PGlite(pgDir) : new pglite.PGlite()
    await pg.query('SELECT 1') // force ready
    const db: Queryable = {
        query: async (sql, params) => {
            const r = await pg.query(sql, params as unknown[] | undefined)
            return { rows: r.rows as Array<Record<string, unknown>>, affectedRows: r.affectedRows }
        },
    }

    // ── Auth store (users), persisted to disk unless ephemeral.
    const authFile = join(dataDir, 'auth.json')
    const users = new Map<string, MockUser>()
    if (!ephemeral && existsSync(authFile)) {
        try {
            const saved: MockUser[] = JSON.parse(readFileSync(authFile, 'utf8'))
            for (const u of saved) users.set(u.email.toLowerCase(), u)
        } catch {
            /* corrupt store — start fresh */
        }
    }
    const persistUsers = () => {
        if (ephemeral) return
        writeFileSync(authFile, JSON.stringify([...users.values()], null, 2))
    }

    // ── Storage (filesystem + a content-type manifest).
    const storageDir = join(dataDir, 'storage')
    mkdirSync(storageDir, { recursive: true })
    const manifestFile = join(storageDir, 'manifest.json')
    const manifest = new Map<string, { contentType: string; size: number; lastModified: string }>()
    if (existsSync(manifestFile)) {
        try {
            for (const [k, v] of Object.entries(
                JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, never>
            ))
                manifest.set(k, v)
        } catch {
            /* ignore */
        }
    }
    const persistManifest = () =>
        writeFileSync(manifestFile, JSON.stringify(Object.fromEntries(manifest), null, 2))
    const objKey = (bucket: string, path: string) => `${bucket}/${path}`
    const objFile = (bucket: string, path: string) => join(storageDir, bucket, path)

    // Resolved to the real value once the server is listening (port may be 0 =
    // "pick any free port"). Handlers read it at request time, so it is set by then.
    let baseUrl = `http://localhost:${port}`

    // Realtime pub/sub: the HTTP control plane below plus a WebSocket server that
    // shares this port (see the `upgrade` handler after `listen`). Tokens embed a
    // ws:// URL derived from `baseUrl`, read lazily so it reflects the real port.
    const realtime = createMockRealtime({
        wsUrl: () => baseUrl.replace(/^http/, 'ws'),
        quiet,
    })

    // Ephemeral key-value cache (`client.cache`). In-memory only — a restart
    // starts empty, matching the cache's expiring semantics.
    const cache = createMockCache()

    // Notifications (`client.notifications`). Accepts sends and logs them; no
    // mail actually leaves the process in local dev.
    const notifications = createMockNotifications({ quiet })

    // Payments (`client.payments`). The plan/feature catalog and subscriptions
    // are durable domain state, so they persist to disk like auth/storage
    // (unless ephemeral). There is no real provider: `verify` trusts the
    // paymentId and records a paid receipt; entitlement resolves from the
    // catalog you seed with definePlans/defineFeatures/setPlanFeatures.
    const paymentsFile = join(dataDir, 'payments.json')
    const payments = createMockPayments({
        load: () => {
            if (ephemeral || !existsSync(paymentsFile)) return null
            try {
                return JSON.parse(readFileSync(paymentsFile, 'utf8')) as PaymentsSnapshot
            } catch {
                return null
            }
        },
        save: (snapshot) => {
            if (ephemeral) return
            writeFileSync(paymentsFile, JSON.stringify(snapshot, null, 2))
        },
    })

    function objectShape(bucket: string, path: string) {
        const meta = manifest.get(objKey(bucket, path))
        return {
            key: path,
            name: fileName(path),
            size: meta?.size ?? 0,
            contentType: meta?.contentType ?? 'application/octet-stream',
            lastModified: meta?.lastModified ?? new Date().toISOString(),
            isFolder: false,
        }
    }

    function writeObject(bucket: string, path: string, body: Buffer, contentType: string) {
        const file = objFile(bucket, path)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, body)
        manifest.set(objKey(bucket, path), {
            contentType,
            size: body.length,
            lastModified: new Date().toISOString(),
        })
        persistManifest()
    }

    // ── HTTP handler ──────────────────────────────────────────────────────────

    const server = createServer((req, res) => {
        handle(req, res).catch((err) => {
            if (!quiet) console.error('[dontcode-mock] handler error:', err)
            sendJson(res, 500, { error: err instanceof Error ? err.message : 'Internal error' })
        })
    })

    // Browsers connect the realtime WebSocket to this same port; the token in the
    // query string carries its granted channels (see ./realtime).
    server.on('upgrade', (req, socket, head) => realtime.handleUpgrade(req, socket, head))

    function sendJson(res: ServerResponse, status: number, body: unknown) {
        const json = JSON.stringify(body)
        res.writeHead(status, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        })
        res.end(json)
    }

    function checkApiKey(req: IncomingMessage): boolean {
        const header = req.headers['authorization']
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
        const key = header.slice(7).trim()
        if (options.apiKey) return key === options.apiKey
        return key.startsWith('dc_')
    }

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', baseUrl)
        const path = url.pathname
        const method = req.method ?? 'GET'

        if (method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
                'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Access-Token',
            })
            res.end()
            return
        }

        if (!quiet) console.log(`[dontcode-mock] ${method} ${path}`)

        // Health check / friendly root.
        if (path === '/' && method === 'GET') {
            sendJson(res, 200, { service: 'dontcode-mock', ok: true })
            return
        }

        // Serving + presigned-PUT of stored files. No API key — the URL is the cap.
        if (path.startsWith('/__storage/')) {
            await handleFileEndpoint(req, res, url, method)
            return
        }

        if (!path.startsWith('/api/v1/')) {
            sendJson(res, 404, { error: 'Not found' })
            return
        }

        // Every /api/v1 call needs a project API key.
        if (!checkApiKey(req)) {
            sendJson(res, 401, {
                error: 'Missing API key. Send it as: Authorization: Bearer <key>',
            })
            return
        }

        const raw = await readBody(req)

        if (path === '/api/v1/db' && method === 'POST') {
            const body = parseJson(raw)
            const {
                operation,
                tableName,
                options: opts,
            } = body as {
                operation?: string
                tableName?: string
                options?: Record<string, unknown>
            }
            if (!operation || !tableName) {
                sendJson(res, 400, { error: 'Operation and tableName are required' })
                return
            }
            const result = await executeDbOperation(db, schema, operation, tableName, opts ?? {})
            sendJson(res, result.status, result.body)
            return
        }

        if (path === '/api/v1/db/migrate' && method === 'POST') {
            const { sql } = parseJson(raw) as { sql?: string }
            if (!sql || typeof sql !== 'string') {
                sendJson(res, 400, { error: 'sql is required' })
                return
            }
            try {
                const results = await pg.exec(sql)
                sendJson(res, 200, {
                    success: true,
                    executedStatements: Array.isArray(results) ? results.length : 1,
                    warnings: [],
                })
            } catch (err) {
                sendJson(res, 400, {
                    success: false,
                    error: err instanceof Error ? err.message : 'Migration failed',
                })
            }
            return
        }

        if (path.startsWith('/api/v1/auth/') && method === 'POST') {
            await handleAuth(req, res, path.slice('/api/v1/auth/'.length), raw)
            return
        }

        if (path.startsWith('/api/v1/realtime')) {
            handleRealtime(res, path.slice('/api/v1/realtime'.length), method, raw)
            return
        }

        if (path.startsWith('/api/v1/cache/')) {
            const result = cache.handle(method, url, raw)
            sendJson(res, result.status, result.body)
            return
        }

        if (path.startsWith('/api/v1/notifications')) {
            const result = notifications.handle(method, url, raw)
            sendJson(res, result.status, result.body)
            return
        }

        if (path.startsWith('/api/v1/payments')) {
            const result = payments.handle(method, url, raw)
            sendJson(res, result.status, result.body)
            return
        }

        if (path === '/api/v1/storage') {
            if (method === 'POST') {
                await handleStorageJson(res, parseJson(raw) as Record<string, unknown>)
                return
            }
            if (method === 'PUT') {
                await handleStorageUpload(req, res, raw)
                return
            }
        }

        sendJson(res, 404, { error: 'Unknown endpoint' })
    }

    // ── Auth ────────────────────────────────────────────────────────────────

    async function handleAuth(
        req: IncomingMessage,
        res: ServerResponse,
        endpoint: string,
        raw: Buffer
    ): Promise<void> {
        const body = parseJson(raw) as Record<string, unknown>
        const accessToken =
            typeof req.headers['x-access-token'] === 'string'
                ? (req.headers['x-access-token'] as string)
                : undefined

        switch (endpoint) {
            case 'signup': {
                const email = String(body.email ?? '').trim()
                const password = String(body.password ?? '')
                if (!email || !password) {
                    sendJson(res, 400, { error: 'Email and password are required' })
                    return
                }
                if (users.has(email.toLowerCase())) {
                    sendJson(res, 409, { error: 'Email already registered', code: 'EmailExists' })
                    return
                }
                const user: MockUser = {
                    id: randomUUID(),
                    email,
                    password,
                    role: typeof body.role === 'string' ? body.role : undefined,
                    verified: true,
                }
                users.set(email.toLowerCase(), user)
                persistUsers()
                // No email-verification step in the mock: the account is ready to use.
                sendJson(res, 200, { success: true, userId: user.id, verified: true })
                return
            }

            case 'login': {
                const email = String(body.email ?? '').trim()
                const password = String(body.password ?? '')
                const user = users.get(email.toLowerCase())
                if (!user || user.password !== password) {
                    sendJson(res, 401, { error: 'Invalid email or password' })
                    return
                }
                sendJson(res, 200, { success: true, userId: user.id, tokens: mintToken(user) })
                return
            }

            case 'me': {
                const decoded = accessToken ? decodeToken(accessToken) : null
                if (!decoded || (decoded.exp && Date.now() / 1000 >= decoded.exp)) {
                    sendJson(res, 200, { user: null })
                    return
                }
                const user = [...users.values()].find((u) => u.id === decoded.sub)
                if (!user) {
                    sendJson(res, 200, { user: null })
                    return
                }
                sendJson(res, 200, {
                    user: { id: user.id, email: user.email, role: user.role, claims: user.claims },
                })
                return
            }

            case 'verify-email':
            case 'forgot-password':
            case 'reset-password':
                sendJson(res, 200, { success: true })
                return

            case 'mfa/enroll':
                sendJson(res, 200, {
                    success: true,
                    secret: 'MOCKMFASECRET',
                    otpauth_url: 'otpauth://totp/DontCodeMock?secret=MOCKMFASECRET',
                })
                return

            case 'mfa/enroll/confirm':
                sendJson(res, 200, { success: true, recovery_codes: ['mock-recovery-0001'] })
                return

            case 'mfa/disable':
                sendJson(res, 200, { success: true })
                return

            case 'mfa/challenge':
                // The mock's login never demands a second factor, so a challenge
                // should not occur. Be explicit rather than silently succeed.
                sendJson(res, 400, {
                    error: 'MFA is not enabled in the mock',
                    code: 'MfaNotOffered',
                })
                return

            default:
                sendJson(res, 404, { error: 'Unknown auth endpoint' })
        }
    }

    // ── Realtime (HTTP control plane; the socket half is the `upgrade` handler) ─

    function handleRealtime(res: ServerResponse, endpoint: string, method: string, raw: Buffer) {
        if (endpoint === '/token' && method === 'POST') {
            const body = parseJson(raw)
            sendJson(res, 200, realtime.mintToken(body))
            return
        }
        if (endpoint === '/publish' && method === 'POST') {
            const { channel, payload } = parseJson(raw) as { channel?: unknown; payload?: unknown }
            if (typeof channel !== 'string') {
                sendJson(res, 400, { error: 'channel is required' })
                return
            }
            sendJson(res, 200, { delivered: realtime.publish(channel, payload) })
            return
        }
        const presence = endpoint.match(/^\/channels\/([^/]+)\/presence$/)
        if (presence && method === 'GET') {
            sendJson(res, 200, { presence: realtime.presence(decodeURIComponent(presence[1])) })
            return
        }
        sendJson(res, 404, { error: 'Unknown realtime endpoint' })
    }

    // ── Storage (JSON operations) ─────────────────────────────────────────────

    async function handleStorageJson(res: ServerResponse, body: Record<string, unknown>) {
        const operation = body.operation
        const bucket = body.bucket === 'public' || body.bucket === 'private' ? body.bucket : null
        if (!bucket) {
            sendJson(res, 400, { error: 'bucket must be "public" or "private"' })
            return
        }

        const bad = (msg: string) => sendJson(res, 400, { error: msg })

        switch (operation) {
            case 'list': {
                const prefix = normalizePath(body.prefix, { allowEmpty: true })
                if (prefix === null) return bad('Invalid prefix')
                const objects: ReturnType<typeof objectShape>[] = []
                for (const key of manifest.keys()) {
                    if (!key.startsWith(`${bucket}/`)) continue
                    const path = key.slice(bucket.length + 1)
                    if (prefix && !path.startsWith(`${prefix}/`) && path !== prefix) continue
                    objects.push(objectShape(bucket, path))
                }
                sendJson(res, 200, {
                    objects,
                    folders: [],
                    prefix: prefix ? `${prefix}/` : '',
                    truncated: false,
                    continuationToken: null,
                })
                return
            }

            case 'remove': {
                const paths = Array.isArray(body.paths)
                    ? body.paths.map((p) => normalizePath(p))
                    : null
                if (!paths || paths.length === 0 || paths.some((p) => p === null)) {
                    return bad('paths must be a non-empty array of valid paths')
                }
                for (const p of paths as string[]) {
                    const file = objFile(bucket, p)
                    if (existsSync(file)) rmSync(file)
                    manifest.delete(objKey(bucket, p))
                }
                persistManifest()
                sendJson(res, 200, { deleted: paths.length })
                return
            }

            case 'move': {
                const from = normalizePath(body.from)
                const to = normalizePath(body.to)
                if (!from || !to) return bad('from and to are required')
                const fromFile = objFile(bucket, from)
                if (!existsSync(fromFile)) return sendJson(res, 404, { error: 'File not found' })
                const buf = readFileSync(fromFile)
                const meta = manifest.get(objKey(bucket, from))
                writeObject(bucket, to, buf, meta?.contentType ?? 'application/octet-stream')
                rmSync(fromFile)
                manifest.delete(objKey(bucket, from))
                persistManifest()
                sendJson(res, 200, { object: objectShape(bucket, to) })
                return
            }

            case 'createFolder': {
                const path = normalizePath(body.path)
                if (!path) return bad('path is required')
                mkdirSync(join(storageDir, bucket, path), { recursive: true })
                sendJson(res, 200, { created: `${path}/` })
                return
            }

            case 'download': {
                const path = normalizePath(body.path)
                if (!path) return bad('path is required')
                const file = objFile(bucket, path)
                if (!existsSync(file)) return sendJson(res, 404, { error: 'File not found' })
                const buf = readFileSync(file)
                if (buf.length > 8 * 1024 * 1024) {
                    return bad('File is too large to download inline; use getTemporaryUrl instead')
                }
                const meta = manifest.get(objKey(bucket, path))
                sendJson(res, 200, {
                    body: buf.toString('base64'),
                    contentType: meta?.contentType ?? 'application/octet-stream',
                    size: buf.length,
                })
                return
            }

            case 'getUrl': {
                if (bucket !== 'public') return bad('getUrl is only available on the public bucket')
                const path = normalizePath(body.path)
                if (!path) return bad('path is required')
                sendJson(res, 200, { url: `${baseUrl}/__storage/public/${path}` })
                return
            }

            case 'getTemporaryUrl': {
                const path = normalizePath(body.path)
                if (!path) return bad('path is required')
                const requested = Number(body.expiresIn)
                const expiresIn =
                    Number.isFinite(requested) && requested > 0
                        ? Math.min(Math.floor(requested), 7 * 24 * 60 * 60)
                        : 300
                sendJson(res, 200, {
                    url: `${baseUrl}/__storage/${bucket}/${path}?expires=${expiresIn}`,
                    expiresIn,
                })
                return
            }

            case 'presignUpload': {
                const path = normalizePath(body.path)
                if (!path) return bad('path is required')
                const contentType =
                    typeof body.contentType === 'string' && body.contentType.length > 0
                        ? body.contentType
                        : 'application/octet-stream'
                sendJson(res, 200, {
                    url: `${baseUrl}/__storage/${bucket}/${path}?upload=1&contentType=${encodeURIComponent(contentType)}`,
                    key: path,
                    expiresIn: 600,
                })
                return
            }

            default:
                bad('Invalid operation')
        }
    }

    // ── Storage (multipart upload) ────────────────────────────────────────────

    async function handleStorageUpload(req: IncomingMessage, res: ServerResponse, raw: Buffer) {
        const webReq = new Request(`${baseUrl}/api/v1/storage`, {
            method: 'PUT',
            headers: nodeHeaders(req),
            body: new Uint8Array(raw),
        })
        let form: FormData
        try {
            form = await webReq.formData()
        } catch {
            sendJson(res, 400, { error: 'Upload requires multipart/form-data with a file field' })
            return
        }
        const file = form.get('file')
        if (!(file instanceof File)) {
            sendJson(res, 400, { error: 'file and path are required' })
            return
        }
        const bucket = form.get('bucket')
        if (bucket !== 'public' && bucket !== 'private') {
            sendJson(res, 400, { error: 'bucket must be "public" or "private"' })
            return
        }
        const path = normalizePath(form.get('path'))
        if (!path) {
            sendJson(res, 400, { error: 'file and path are required' })
            return
        }
        const ctField = form.get('contentType')
        const contentType =
            typeof ctField === 'string' && ctField.length > 0
                ? ctField
                : file.type || 'application/octet-stream'
        const buf = Buffer.from(await file.arrayBuffer())
        writeObject(bucket, path, buf, contentType)
        sendJson(res, 200, { object: objectShape(bucket, path) })
    }

    // ── Direct file GET/PUT (public URLs, signed URLs, presigned uploads) ───────

    async function handleFileEndpoint(
        req: IncomingMessage,
        res: ServerResponse,
        url: URL,
        method: string
    ) {
        const rest = url.pathname.slice('/__storage/'.length)
        const slash = rest.indexOf('/')
        const bucket = slash === -1 ? rest : rest.slice(0, slash)
        const path = slash === -1 ? '' : rest.slice(slash + 1)
        if ((bucket !== 'public' && bucket !== 'private') || !path) {
            sendJson(res, 404, { error: 'Not found' })
            return
        }

        if (method === 'PUT' && url.searchParams.get('upload') === '1') {
            const buf = await readBody(req)
            const contentType =
                url.searchParams.get('contentType') ||
                (typeof req.headers['content-type'] === 'string'
                    ? req.headers['content-type']
                    : 'application/octet-stream')
            writeObject(bucket, decodeURIComponent(path), buf, contentType)
            res.writeHead(200, { 'Access-Control-Allow-Origin': '*' })
            res.end()
            return
        }

        const file = objFile(bucket, decodeURIComponent(path))
        if (!existsSync(file)) {
            sendJson(res, 404, { error: 'File not found' })
            return
        }
        const meta = manifest.get(objKey(bucket, decodeURIComponent(path)))
        const buf = readFileSync(file)
        res.writeHead(200, {
            'Content-Type': meta?.contentType ?? 'application/octet-stream',
            'Content-Length': buf.length,
            'Access-Control-Allow-Origin': '*',
        })
        res.end(buf)
    }

    // ── Listen ──────────────────────────────────────────────────────────────

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
            server.off('error', reject)
            resolve()
        })
    })

    const address = server.address()
    const actualPort = address && typeof address === 'object' ? address.port : port
    baseUrl = `http://localhost:${actualPort}`

    if (!quiet) {
        const where = ephemeral ? 'ephemeral (in-memory)' : dataDir
        console.log(
            `\n  DontCode mock gateway listening on ${baseUrl}\n` +
                `  data: ${where}\n\n` +
                `  Point your app at it:\n` +
                `    DONTCODE_API_URL=${baseUrl}\n` +
                `    DONTCODE_API_KEY=dc_local_dev\n`
        )
    }

    return {
        url: baseUrl,
        port: actualPort,
        close: async () => {
            realtime.close()
            await new Promise<void>((resolve) => server.close(() => resolve()))
            await pg.close?.()
            if (ephemeral) rmSync(dataDir, { recursive: true, force: true })
        },
    }
}

function parseJson(raw: Buffer): Record<string, unknown> {
    if (raw.length === 0) return {}
    try {
        const parsed = JSON.parse(raw.toString('utf8'))
        return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
        return {}
    }
}

function nodeHeaders(req: IncomingMessage): Headers {
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) headers.set(key, value.join(', '))
        else if (typeof value === 'string') headers.set(key, value)
    }
    return headers
}

// ── PGlite loader ──────────────────────────────────────────────────────────────

interface PGliteModule {
    PGlite: new (dataDir?: string) => {
        query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }>
        exec(sql: string): Promise<unknown[]>
        close?(): Promise<void>
    }
}

async function loadPGlite(): Promise<PGliteModule> {
    try {
        return (await import('@electric-sql/pglite')) as unknown as PGliteModule
    } catch {
        throw new Error(
            'The DontCode mock needs an in-process Postgres engine that is not installed.\n' +
                '  Install it with:  pnpm add -D @electric-sql/pglite   (or npm i -D @electric-sql/pglite)\n' +
                '  It ships as an optional dependency of @dontcode2/backend, so this usually means\n' +
                '  it was skipped (e.g. an install run with --no-optional).'
        )
    }
}
