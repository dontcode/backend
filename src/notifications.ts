import { Transport } from './http'
import type { SendEmailInput, SendEmailResult } from './types'

const NOTIFICATIONS_PATH = '/api/v1/notifications'

/**
 * Email channel. Content is authored inline as GitHub-flavored Markdown
 * (`markdownText`) — there is no separate template system and no `html`/`text`
 * field. `to` takes one recipient or many.
 */
export class NotificationEmailApi {
    constructor(private readonly transport: Transport) {}

    /** Send a transactional email. Check `success` before assuming delivery. */
    send(input: SendEmailInput): Promise<SendEmailResult> {
        return this.transport.json<SendEmailResult>(`${NOTIFICATIONS_PATH}/email`, {
            to: Array.isArray(input.to) ? input.to : [input.to],
            subject: input.subject,
            markdownText: input.markdownText,
        })
    }
}

/**
 * Notifications: a typed proxy over `/api/v1/notifications`. One namespace per
 * channel — today `email`. Recipients and sender identity are scoped to your
 * project by the gateway. Future channels (push, sms) attach here without
 * touching callers.
 *
 * ```ts
 * const res = await client.notifications.email.send({
 *   to: 'user@example.com',
 *   subject: 'Welcome',
 *   markdownText: '# Hi\n\nThanks for signing up.',
 * })
 * if (!res.success) console.error(res.error)
 * ```
 */
export class NotificationsApi {
    /** Email channel — `client.notifications.email.send(...)`. */
    readonly email: NotificationEmailApi

    constructor(transport: Transport) {
        this.email = new NotificationEmailApi(transport)
    }
}

export function createNotifications(transport: Transport): NotificationsApi {
    return new NotificationsApi(transport)
}
