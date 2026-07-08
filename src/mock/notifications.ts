/**
 * Notifications for the mock gateway — the server half of `client.notifications`.
 *
 * Production forwards each send to the hosted notification service, which
 * actually delivers the mail. The mock has nowhere to deliver in local dev, so
 * it ACCEPTS the send, logs a one-line summary (unless quiet), and returns the
 * same `{ success, messageId }` shape the real service does. No SMTP, no
 * network — sending an email in a test never leaves the process.
 *
 * The wire protocol is `/api/v1/notifications/<channel>` (see src/notifications.ts
 * for the client):
 *   POST /email  { to, subject, markdownText } → { success, messageId }
 *
 * The channel is the path segment, matching the real gateway. Only `email`
 * exists today; an unknown channel is a 404, the same as production.
 */

export interface MockNotifications {
    /** Route a `/api/v1/notifications/...` request. */
    handle(method: string, url: URL, raw: Buffer): { status: number; body: unknown }
}

export function createMockNotifications(options: { quiet?: boolean } = {}): MockNotifications {
    let counter = 0

    function handle(method: string, url: URL, raw: Buffer): { status: number; body: unknown } {
        // channel = everything after `/api/v1/notifications`, e.g. `email`.
        const channel = url.pathname.slice('/api/v1/notifications'.length).replace(/^\/+/, '')

        if (method !== 'POST' || !channel) {
            return {
                status: 400,
                body: {
                    error: 'channel_required',
                    message:
                        'Specify a channel, e.g. POST /api/v1/notifications/email with { to, subject, markdownText }.',
                },
            }
        }

        if (channel !== 'email') {
            return { status: 404, body: { error: `Unknown notification channel: ${channel}` } }
        }

        let body: { to?: unknown; subject?: unknown; markdownText?: unknown }
        try {
            body = raw.length ? JSON.parse(raw.toString('utf8')) : {}
        } catch {
            return { status: 400, body: { success: false, error: 'Invalid JSON body' } }
        }

        const raw_to = Array.isArray(body.to)
            ? body.to.map(String)
            : typeof body.to === 'string'
              ? [body.to]
              : []
        const to = raw_to.filter((addr) => addr.trim().length > 0)

        if (to.length === 0) {
            return { status: 400, body: { success: false, error: '`to` is required' } }
        }

        const messageId = `mock_${++counter}`

        if (!options.quiet) {
            const subject = typeof body.subject === 'string' ? body.subject : '(no subject)'
            console.log(
                `[dontcode-mock] email → ${to.join(', ')} · ${subject} (${messageId}, not actually sent)`
            )
        }

        return { status: 200, body: { success: true, messageId } }
    }

    return { handle }
}
