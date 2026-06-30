import { Transport } from './http'
import type { ConnectionToken, MintConnectionTokenInput, RealtimePresenceMember } from './types'

const REALTIME_PATH = '/api/v1/realtime'

/**
 * Realtime control plane: a typed proxy over `/api/v1/realtime`. This is the
 * server side — mint connection tokens for browsers, publish messages, and read
 * presence. The WebSocket itself terminates at the realtime service: hand the
 * `{ token, url }` from `mintToken` to a browser and connect to
 * `${url}?token=${token}`. Channels are namespaced to your project by the gateway.
 *
 * ```ts
 * // In your token endpoint, after authenticating the user:
 * const conn = await client.realtime.mintToken({ channels: [`room:${id}`], identity: userId })
 * // → return conn to the browser, which connects to `${conn.url}?token=${conn.token}`
 *
 * // From anywhere on your backend:
 * await client.realtime.publish(`room:${id}`, { text: 'hello' })
 * ```
 */
export class RealtimeApi {
    constructor(private readonly transport: Transport) {}

    /** Mint a short-lived, channel-scoped connection token for a browser. */
    mintToken(input: MintConnectionTokenInput): Promise<ConnectionToken> {
        return this.transport.json<ConnectionToken>(`${REALTIME_PATH}/token`, {
            channels: input.channels,
            identity: input.identity,
            ttl: input.ttl,
        })
    }

    /** Publish a message to a channel. Returns how many subscribers it reached. */
    async publish(channel: string, payload: unknown): Promise<number> {
        const r = await this.transport.json<{ delivered: number }>(`${REALTIME_PATH}/publish`, {
            channel,
            payload,
        })
        return r.delivered
    }

    /** Who is currently connected to a channel. */
    async presence(channel: string): Promise<RealtimePresenceMember[]> {
        const r = await this.transport.get<{ presence: RealtimePresenceMember[] }>(
            `${REALTIME_PATH}/channels/${encodeURIComponent(channel)}/presence`
        )
        return r.presence ?? []
    }
}

export function createRealtime(transport: Transport): RealtimeApi {
    return new RealtimeApi(transport)
}
