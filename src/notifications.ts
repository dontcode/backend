import { isDontCodeError } from './errors'
import { Transport } from './http'
import type { BroadcastInput, BroadcastResult, SendEmailInput, SendEmailResult } from './types'

const NOTIFICATIONS_PATH = '/api/v1/notifications'

/**
 * Email, as an Insight app sends it: from DontCode in your app's design, each
 * recipient in their own language, logged on the project's Emails page.
 * Content is GitHub-flavored Markdown (`markdownText`); there is no template
 * system and no `html`/`text` field.
 */
export class NotificationEmailApi {
    constructor(private readonly transport: Transport) {}

    /**
     * Send to the people `to` names (`'owner'`, `'contact:<saved name>'`,
     * `{ user: id }` or an address from your data). A recipient DontCode
     * cannot resolve refuses the whole send, with the reason.
     */
    send(input: SendEmailInput): Promise<SendEmailResult> {
        return this.transport.json<SendEmailResult>(`${NOTIFICATIONS_PATH}/email`, {
            to: Array.isArray(input.to) ? input.to : [input.to],
            subject: input.subject,
            markdownText: input.markdownText,
            ...(input.replyTo ? { replyTo: input.replyTo } : {}),
            ...(input.locale ? { locale: input.locale } : {}),
            ...(input.action ? { action: input.action } : {}),
        })
    }

    /**
     * One email to everyone with a role, each in their own language. A first
     * batch goes at once and the rest is paced within the plan; call it from
     * code that checks the caller may (an admin), never straight from a page.
     */
    broadcast(input: BroadcastInput): Promise<BroadcastResult> {
        return this.transport.json<BroadcastResult>(`${NOTIFICATIONS_PATH}/email/broadcast`, {
            to: input.to,
            kind: input.kind ?? 'notice',
            versions: input.versions,
            ...(input.action ? { action: input.action } : {}),
            ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        })
    }

    /**
     * The owner's address, to show on a page ("or write directly"). Mail to
     * the owner never needs it: send to `'owner'`. Null for a project with no
     * owner, and when the read fails, so a page still renders.
     */
    async ownerAddress(): Promise<string | null> {
        try {
            const { email } = await this.transport.get<{ email?: string | null }>(
                `${NOTIFICATIONS_PATH}/owner`
            )
            return typeof email === 'string' && email ? email : null
        } catch (err) {
            if (
                isDontCodeError(err) &&
                (err.status === 503 || err.status === 0 || err.status === 408)
            ) {
                return null
            }
            throw err
        }
    }
}

/**
 * Notifications: a typed proxy over `/api/v1/notifications`, today email.
 *
 * ```ts
 * await client.notifications.email.send({
 *   to: ['owner', { user: order.buyer_id }],
 *   subject: 'New order',
 *   markdownText: `# Order ${order.id}`,
 *   action: { label: 'See the order', href: `https://shop.example/orders/${order.id}` },
 * })
 * ```
 */
export class NotificationsApi {
    /** Email channel: `client.notifications.email.send(...)`. */
    readonly email: NotificationEmailApi

    constructor(transport: Transport) {
        this.email = new NotificationEmailApi(transport)
    }
}

export function createNotifications(transport: Transport): NotificationsApi {
    return new NotificationsApi(transport)
}
