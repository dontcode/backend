import type { ConnectionToken } from '../types'

/**
 * Realtime in the browser: subscribe and publish over the socket your server
 * opened the door to. The API key never reaches the page: your server mints a
 * channel-scoped token (`client.realtime.mintToken`) for a visitor it has
 * checked, and this connects with it, fans messages out per channel, and
 * reconnects with backoff (asking for a fresh token) when the socket drops.
 * Twin of @dontcode/realtime's client (src/client/realtime-client.ts).
 */

export interface RealtimeMessage<T = unknown> {
    channel: string
    payload: T
}

export type RealtimeHandler<T = unknown> = (message: RealtimeMessage<T>) => void

export interface ConnectRealtimeOptions {
    /** The channels this page uses: the token is minted for exactly these. */
    channels: string[]
    /** Shown in presence, when your route passes it on to `mintToken`. */
    identity?: string
    /**
     * Your route that answers `client.realtime.mintToken(...)` for this visitor:
     * POSTed `{ channels, identity }`, answering `{ token, url }`. Default
     * `/api/realtime`. Or pass `getToken` to fetch it your own way.
     */
    endpoint?: string
    getToken?: (request: { channels: string[]; identity?: string }) => Promise<ConnectionToken>
}

export class RealtimeConnection {
    private ws: WebSocket | null = null
    private readonly handlers = new Map<string, Set<RealtimeHandler>>()
    private closed = false
    private backoff = 500

    constructor(private readonly options: ConnectRealtimeOptions) {}

    private async token(): Promise<ConnectionToken> {
        const request = { channels: this.options.channels, identity: this.options.identity }
        if (this.options.getToken) return this.options.getToken(request)
        const res = await fetch(this.options.endpoint ?? '/api/realtime', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(request),
        })
        if (!res.ok) {
            const err = (await res.json().catch(() => ({}))) as { error?: string }
            throw new Error(err.error || `Could not get a realtime token (${res.status})`)
        }
        return (await res.json()) as ConnectionToken
    }

    /** Open the socket. Resolves once it is connected. */
    async open(): Promise<void> {
        const { token, url } = await this.token()
        await new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`)
            this.ws = ws
            let opened = false
            ws.onopen = () => {
                opened = true
                this.backoff = 500
                resolve()
            }
            ws.onmessage = (event) => this.dispatch(event.data)
            ws.onerror = () => {
                if (!opened) reject(new Error('Realtime connection error'))
            }
            ws.onclose = () => {
                if (!opened) reject(new Error('Realtime connection closed'))
                else if (!this.closed) this.reconnect()
            }
        })
    }

    private dispatch(raw: unknown): void {
        let frame: { type?: string; channel?: string; payload?: unknown }
        try {
            frame = JSON.parse(String(raw))
        } catch {
            return
        }
        if (frame.type !== 'message' || !frame.channel) return
        for (const handler of this.handlers.get(frame.channel) ?? []) {
            handler({ channel: frame.channel, payload: frame.payload })
        }
    }

    private reconnect(): void {
        const delay = Math.min(this.backoff, 10_000)
        this.backoff = Math.min(this.backoff * 2, 10_000)
        setTimeout(() => {
            if (this.closed) return
            this.open().catch(() => this.reconnect())
        }, delay)
    }

    /** Handle a channel's messages. Returns the function that stops. */
    subscribe<T = unknown>(channel: string, handler: RealtimeHandler<T>): () => void {
        let set = this.handlers.get(channel)
        if (!set) {
            set = new Set()
            this.handlers.set(channel, set)
        }
        set.add(handler as RealtimeHandler)
        return () => {
            this.handlers.get(channel)?.delete(handler as RealtimeHandler)
        }
    }

    /** Send to a channel the token grants; everyone else on it receives it, not you. */
    publish(channel: string, payload: unknown): void {
        this.ws?.send(JSON.stringify({ type: 'publish', channel, payload }))
    }

    /** Close for good (in a component's cleanup); no reconnect follows. */
    close(): void {
        this.closed = true
        this.ws?.close()
        this.ws = null
    }
}

/** Connect and open in one call. */
export async function connectRealtime(
    options: ConnectRealtimeOptions
): Promise<RealtimeConnection> {
    const connection = new RealtimeConnection(options)
    await connection.open()
    return connection
}
