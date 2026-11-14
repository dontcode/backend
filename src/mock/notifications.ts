/**
 * Notifications for the mock gateway: the server half of `client.notifications`.
 *
 * Production forwards each call to the hosted notification service, which
 * resolves every recipient and delivers the mail. The mock has nowhere to
 * deliver in local dev, so it checks the request the way the service does,
 * logs a one-line summary (unless quiet), and answers the service's shapes. No
 * SMTP, no network: sending an email in a test never leaves the process.
 *
 *   POST /email            { to, subject, markdownText, ... } → { success, messageId, messageIds }
 *   POST /email/broadcast  { to: { role }, kind, versions }  → { success, broadcastId, total }
 *   GET  /owner                                              → { email }
 *
 * Any other path is a 404, the same as production.
 */

export interface MockNotifications {
    /** Route a `/api/v1/notifications/...` request. */
    handle(method: string, url: URL, raw: Buffer): { status: number; body: unknown }
}

export interface MockNotificationsOptions {
    quiet?: boolean
    /** How many of the mock's users hold a role, for a broadcast's total. */
    countRole?: (role: string) => number
    /** Whether a user id is one of the mock's users. */
    isUser?: (id: string) => boolean
}

/** The owner's address offline: a reserved domain nobody receives mail at. */
export const MOCK_OWNER_EMAIL = 'owner@example.com'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const LANGUAGES = new Set(['ko', 'en', 'zh', 'ja'])
const MAX_RECIPIENTS = 50

/** A recipient as the service reads it, or why it cannot be one (lib/recipients.ts there). */
function describe(entry: unknown, isUser: (id: string) => boolean): string | { error: string } {
    if (typeof entry === 'string') {
        const value = entry.trim()
        if (value.toLowerCase() === 'owner') return 'owner'
        if (value.toLowerCase() === 'me') {
            return { error: "'me' is the signed-in person: send { user: <their id> }." }
        }
        if (value.toLowerCase().startsWith('contact:')) {
            return value.slice('contact:'.length).trim()
                ? value
                : { error: 'A saved address needs its name: contact:<name>.' }
        }
        return EMAIL.test(value) ? value : { error: `Not an email address: ${value.slice(0, 80)}` }
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const { user, role } = entry as { user?: unknown; role?: unknown }
        if (role !== undefined) {
            return { error: 'A role is a broadcast: send it with email.broadcast.' }
        }
        if (typeof user === 'string' && isUser(user)) return `user ${user}`
        return { error: 'An app user is { user: <their id> }, the id of one of your users.' }
    }
    return { error: 'Each recipient is a string or { user: <id> }.' }
}

export function createMockNotifications(options: MockNotificationsOptions = {}): MockNotifications {
    let counter = 0
    const isUser = options.isUser ?? (() => true)

    function log(line: string) {
        if (!options.quiet) console.log(`[dontcode-mock] ${line}`)
    }

    function parse(raw: Buffer): Record<string, unknown> | null {
        try {
            return raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : {}
        } catch {
            return null
        }
    }

    function email(body: Record<string, unknown>) {
        const list = Array.isArray(body.to) ? body.to : body.to === undefined ? [] : [body.to]
        if (list.length === 0) {
            return { status: 400, body: { success: false, error: '`to` is required' } }
        }
        if (list.length > MAX_RECIPIENTS) {
            return {
                status: 400,
                body: { success: false, error: `At most ${MAX_RECIPIENTS} recipients` },
            }
        }
        const named: string[] = []
        for (const entry of list) {
            const read = describe(entry, isUser)
            if (typeof read !== 'string')
                return { status: 400, body: { success: false, error: read.error } }
            named.push(read)
        }
        if (typeof body.subject !== 'string' || !body.subject.trim()) {
            return { status: 400, body: { success: false, error: 'subject is required' } }
        }
        if (typeof body.markdownText !== 'string' || !body.markdownText.trim()) {
            return { status: 400, body: { success: false, error: 'markdownText is required' } }
        }
        const messageIds = named.map(() => `mock_${++counter}`)
        log(
            `email → ${named.join(', ')} · ${body.subject} (${messageIds.join(', ')}, not actually sent)`
        )
        return { status: 200, body: { success: true, messageId: messageIds[0], messageIds } }
    }

    function broadcast(body: Record<string, unknown>) {
        const to = body.to as { role?: unknown } | undefined
        if (!to || typeof to.role !== 'string' || !to.role.trim()) {
            return { status: 400, body: { success: false, error: 'to is { role: "<role>" }' } }
        }
        if (body.kind !== undefined && body.kind !== 'notice' && body.kind !== 'promotion') {
            return {
                status: 400,
                body: { success: false, error: "kind is 'notice' or 'promotion'" },
            }
        }
        const versions = body.versions as
            | Record<string, { subject?: unknown; markdownText?: unknown }>
            | undefined
        if (!versions || typeof versions !== 'object' || Object.keys(versions).length === 0) {
            return {
                status: 400,
                body: {
                    success: false,
                    error: 'versions is { "<language>": { subject, markdownText } }, one per app language',
                },
            }
        }
        for (const [lang, version] of Object.entries(versions)) {
            if (!LANGUAGES.has(lang)) {
                return {
                    status: 400,
                    body: { success: false, error: `Not a language the platform writes: ${lang}` },
                }
            }
            if (typeof version?.subject !== 'string' || typeof version?.markdownText !== 'string') {
                return {
                    status: 400,
                    body: {
                        success: false,
                        error: `The ${lang} version needs a subject and markdownText`,
                    },
                }
            }
        }
        const total = options.countRole?.(to.role) ?? 0
        const broadcastId = `mock_broadcast_${++counter}`
        log(
            `broadcast (${body.kind ?? 'notice'}) → role ${to.role}, ${total} people (${broadcastId}, not actually sent)`
        )
        return { status: 200, body: { success: true, broadcastId, total } }
    }

    function handle(method: string, url: URL, raw: Buffer): { status: number; body: unknown } {
        const path = url.pathname.slice('/api/v1/notifications'.length).replace(/^\/+/, '')

        if (method === 'GET' && path === 'owner') {
            return { status: 200, body: { email: MOCK_OWNER_EMAIL } }
        }
        if (method === 'POST' && (path === 'email' || path === 'email/broadcast')) {
            const body = parse(raw)
            if (!body) return { status: 400, body: { success: false, error: 'Invalid JSON body' } }
            return path === 'email' ? email(body) : broadcast(body)
        }
        if (!path) {
            return {
                status: 400,
                body: {
                    error: 'channel_required',
                    message:
                        'Specify a channel, e.g. POST /api/v1/notifications/email with { to, subject, markdownText }.',
                },
            }
        }
        return { status: 404, body: { error: 'Unknown notifications operation' } }
    }

    return { handle }
}
