/**
 * Realtime pub/sub for the mock gateway.
 *
 * Production terminates WebSockets at a dedicated realtime service; the SDK's
 * `RealtimeApi` only ever talks to its HTTP control plane (mint token, publish,
 * presence) and hands the browser a `{ token, url }` to connect with. To make
 * `client.realtime` work end to end offline, the mock has to be BOTH halves:
 * the control plane AND the socket the browser connects to. So this module
 *
 *   - mints channel-scoped tokens (unsigned, like the mock's auth tokens — the
 *     token literally carries its granted channels; there's no secret to keep),
 *   - upgrades WebSocket connections on the mock's own HTTP port, granting the
 *     token's channels for the life of the socket,
 *   - fans a publish (from the HTTP endpoint OR from a client `publish` frame)
 *     out to every socket subscribed to that channel.
 *
 * The wire protocol matches the hosted gateway (and the vendored client in
 * thunderlite's `realtimeClient.ts`): incoming `{type:'message',channel,payload}`,
 * outgoing publish `{type:'publish',channel,payload}`.
 *
 * The WebSocket framing (RFC 6455) is hand-rolled to keep the mock free of a
 * runtime dependency, mirroring how PGlite is the only (optional) one. It
 * handles what a browser actually sends: masked text frames (with 16/64-bit
 * extended lengths), fragmentation, ping/pong, and close. It is a DEV tool —
 * no per-message-deflate, no backpressure handling.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const DEFAULT_TTL_SECONDS = 3600

/** Opcodes we care about (RFC 6455 §5.2). */
const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

interface TokenGrant {
    channels: string[]
    identity?: string
    exp: number
}

interface Connection {
    id: string
    socket: Duplex
    channels: Set<string>
    identity?: string
    /** Buffer of bytes received but not yet forming a complete frame. */
    pending: Buffer
    /** Accumulated payload of a fragmented message, and its leading opcode. */
    fragments: Buffer[]
    fragmentOpcode: number
}

export interface MockRealtime {
    /** Mint a `{ token, url }` for a browser (the `/api/v1/realtime/token` body). */
    mintToken(input: { channels?: unknown; identity?: unknown; ttl?: unknown }): {
        token: string
        url: string
    }
    /** Server-side publish (the `/api/v1/realtime/publish` body). Returns delivered count. */
    publish(channel: string, payload: unknown): number
    /** Presence for a channel (the `/channels/:channel/presence` response). */
    presence(channel: string): Array<{ id: string; identity?: string }>
    /** Handle an HTTP `upgrade` event for a WebSocket connection. */
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
    /** Drop every connection (server shutdown). */
    close(): void
}

/**
 * Build the realtime engine. `wsUrl()` returns the base WebSocket URL to embed
 * in minted tokens — read lazily because the mock may bind port 0 and only
 * learn its real port after it starts listening.
 */
export function createMockRealtime(opts: { wsUrl: () => string; quiet?: boolean }): MockRealtime {
    const connections = new Set<Connection>()

    const now = () => Math.floor(Date.now() / 1000)

    const encodeToken = (grant: TokenGrant): string =>
        Buffer.from(JSON.stringify(grant)).toString('base64url')

    const decodeToken = (token: string): TokenGrant | null => {
        try {
            const grant = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as TokenGrant
            if (!Array.isArray(grant.channels)) return null
            if (typeof grant.exp === 'number' && grant.exp < now()) return null
            return grant
        } catch {
            return null
        }
    }

    function mintToken(input: { channels?: unknown; identity?: unknown; ttl?: unknown }) {
        const channels = Array.isArray(input.channels) ? input.channels.map(String) : []
        const ttl =
            typeof input.ttl === 'number' && input.ttl > 0 ? Math.floor(input.ttl) : DEFAULT_TTL_SECONDS
        const grant: TokenGrant = {
            channels,
            identity: typeof input.identity === 'string' ? input.identity : undefined,
            exp: now() + ttl,
        }
        return { token: encodeToken(grant), url: opts.wsUrl() }
    }

    function publish(channel: string, payload: unknown, exclude?: Connection): number {
        const frame = encodeText(JSON.stringify({ type: 'message', channel, payload }))
        let delivered = 0
        for (const conn of connections) {
            if (conn === exclude) continue
            if (!conn.channels.has(channel)) continue
            if (writeFrame(conn, frame)) delivered++
        }
        return delivered
    }

    function presence(channel: string) {
        const members: Array<{ id: string; identity?: string }> = []
        for (const conn of connections) {
            if (conn.channels.has(channel)) members.push({ id: conn.id, identity: conn.identity })
        }
        return members
    }

    function writeFrame(conn: Connection, frame: Buffer): boolean {
        try {
            conn.socket.write(frame)
            return true
        } catch {
            drop(conn)
            return false
        }
    }

    function drop(conn: Connection): void {
        if (!connections.has(conn)) return
        connections.delete(conn)
        conn.socket.destroy()
    }

    function handleUpgrade(req: IncomingMessage, socket: Duplex, _head: Buffer): void {
        const key = req.headers['sec-websocket-key']
        const url = new URL(req.url ?? '/', 'http://localhost')
        const token = url.searchParams.get('token')
        const grant = token ? decodeToken(token) : null

        if (typeof key !== 'string' || !grant) {
            // A bad/expired token gets a plain 401 and the socket closed — the
            // client's `open()` rejects and it falls back to polling.
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
            socket.destroy()
            return
        }

        const accept = createHash('sha1')
            .update(key + WS_GUID)
            .digest('base64')
        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
        )

        const conn: Connection = {
            id: randomUUID(),
            socket,
            channels: new Set(grant.channels),
            identity: grant.identity,
            pending: Buffer.alloc(0),
            fragments: [],
            fragmentOpcode: OP_TEXT,
        }
        connections.add(conn)
        if (!opts.quiet) {
            console.log(`[dontcode-mock] ws connect ${conn.id} → [${grant.channels.join(', ')}]`)
        }

        socket.on('data', (chunk: Buffer) => onData(conn, chunk))
        socket.on('close', () => connections.delete(conn))
        socket.on('error', () => drop(conn))
    }

    function onData(conn: Connection, chunk: Buffer): void {
        conn.pending = conn.pending.length ? Buffer.concat([conn.pending, chunk]) : chunk
        for (;;) {
            const frame = readFrame(conn.pending)
            if (!frame) break
            conn.pending = frame.rest
            handleFrame(conn, frame.fin, frame.opcode, frame.payload)
        }
    }

    function handleFrame(conn: Connection, fin: boolean, opcode: number, payload: Buffer): void {
        switch (opcode) {
            case OP_PING:
                writeFrame(conn, encodeControl(OP_PONG, payload))
                return
            case OP_PONG:
                return
            case OP_CLOSE:
                writeFrame(conn, encodeControl(OP_CLOSE, Buffer.alloc(0)))
                drop(conn)
                return
            case OP_TEXT:
            case OP_BINARY:
                conn.fragments = [payload]
                conn.fragmentOpcode = opcode
                break
            case OP_CONTINUATION:
                conn.fragments.push(payload)
                break
            default:
                return
        }
        if (!fin) return
        const message = Buffer.concat(conn.fragments)
        conn.fragments = []
        onMessage(conn, message.toString('utf8'))
    }

    function onMessage(conn: Connection, raw: string): void {
        let frame: { type?: string; channel?: string; payload?: unknown }
        try {
            frame = JSON.parse(raw)
        } catch {
            return
        }
        // The only client→server verb is `publish`. A client may only publish to
        // a channel its token granted (same set it's subscribed to).
        if (frame.type === 'publish' && typeof frame.channel === 'string') {
            if (!conn.channels.has(frame.channel)) return
            // A publisher doesn't receive an echo of its own message.
            publish(frame.channel, frame.payload, conn)
        }
    }

    function close(): void {
        for (const conn of connections) conn.socket.destroy()
        connections.clear()
    }

    return { mintToken, publish, presence, handleUpgrade, close }
}

// ── RFC 6455 framing ────────────────────────────────────────────────────────

interface ParsedFrame {
    fin: boolean
    opcode: number
    payload: Buffer
    /** Bytes after this frame — carried into the next parse. */
    rest: Buffer
}

/**
 * Parse one frame from the front of `buffer`, or null if it isn't complete yet.
 * Browser→server frames are always masked; we unmask in place.
 */
function readFrame(buffer: Buffer): ParsedFrame | null {
    if (buffer.length < 2) return null
    const b0 = buffer[0]
    const b1 = buffer[1]
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let offset = 2

    if (len === 126) {
        if (buffer.length < offset + 2) return null
        len = buffer.readUInt16BE(offset)
        offset += 2
    } else if (len === 127) {
        if (buffer.length < offset + 8) return null
        len = Number(buffer.readBigUInt64BE(offset))
        offset += 8
    }

    let mask: Buffer | null = null
    if (masked) {
        if (buffer.length < offset + 4) return null
        mask = buffer.subarray(offset, offset + 4)
        offset += 4
    }

    if (buffer.length < offset + len) return null
    let payload = buffer.subarray(offset, offset + len)
    if (mask) {
        const out = Buffer.allocUnsafe(len)
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]
        payload = out
    }
    return { fin, opcode, payload, rest: buffer.subarray(offset + len) }
}

/** Encode a server→client text frame (unmasked, as the spec requires). */
function encodeText(data: string): Buffer {
    const payload = Buffer.from(data, 'utf8')
    const len = payload.length
    let header: Buffer
    if (len < 126) {
        header = Buffer.from([0x80 | OP_TEXT, len])
    } else if (len < 0x10000) {
        header = Buffer.allocUnsafe(4)
        header[0] = 0x80 | OP_TEXT
        header[1] = 126
        header.writeUInt16BE(len, 2)
    } else {
        header = Buffer.allocUnsafe(10)
        header[0] = 0x80 | OP_TEXT
        header[1] = 127
        header.writeBigUInt64BE(BigInt(len), 2)
    }
    return Buffer.concat([header, payload])
}

/** Encode a control frame (close/ping/pong) — payload is always tiny (<126). */
function encodeControl(opcode: number, payload: Buffer): Buffer {
    return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload])
}
