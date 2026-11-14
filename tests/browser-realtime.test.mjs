import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { dontcode } from '../dist/index.js'
import { connectRealtime } from '../dist/browser/index.js'
import { startMockServer } from '../dist/mock/index.js'

/**
 * dontcode/browser's realtime against the mock gateway's real WebSocket: a
 * token from the app's server (here `getToken` calls the SDK directly, as a
 * route would), messages fanned out per channel, publish to peers, and a
 * fresh token on reconnect.
 */

let mock
let server

before(async () => {
    mock = await startMockServer({ dataDir: null, quiet: true, port: 0 })
    server = dontcode({ baseUrl: mock.url, apiKey: 'dc_test' })
})

after(async () => {
    await mock.close()
})

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))

describe('connectRealtime', () => {
    it('receives what the server publishes on its channels, per channel', async () => {
        const conn = await connectRealtime({
            channels: ['room:1', 'room:2'],
            getToken: (request) => server.realtime.mintToken(request),
        })
        try {
            const one = []
            const two = []
            conn.subscribe('room:1', (m) => one.push(m.payload))
            const stop = conn.subscribe('room:2', (m) => two.push(m.payload))

            await server.realtime.publish('room:1', { text: 'hi' })
            stop()
            await server.realtime.publish('room:2', { text: 'unheard' })
            await settle()

            assert.deepEqual(one, [{ text: 'hi' }])
            assert.deepEqual(two, [])
        } finally {
            conn.close()
        }
    })

    it('publishes to the other visitors on the channel', async () => {
        const getToken = (request) => server.realtime.mintToken(request)
        const a = await connectRealtime({ channels: ['chat:9'], getToken })
        const b = await connectRealtime({ channels: ['chat:9'], getToken })
        try {
            const heard = []
            b.subscribe('chat:9', (m) => heard.push(m.payload))

            a.publish('chat:9', { from: 'a' })
            await settle()

            assert.deepEqual(heard, [{ from: 'a' }])
        } finally {
            a.close()
            b.close()
        }
    })

    it('reads its token from the app route by default, and fails plainly when refused', async () => {
        const realFetch = globalThis.fetch
        const asked = []
        globalThis.fetch = async (url, init) => {
            asked.push({ url, body: JSON.parse(init.body) })
            return new Response(JSON.stringify({ error: 'Sign in first' }), { status: 401 })
        }
        try {
            await assert.rejects(
                () => connectRealtime({ channels: ['room:1'], identity: 'u1' }),
                /Sign in first/
            )
            assert.deepEqual(asked, [
                { url: '/api/realtime', body: { channels: ['room:1'], identity: 'u1' } },
            ])
        } finally {
            globalThis.fetch = realFetch
        }
    })

    it('asks for a fresh token and reconnects when the socket drops', async () => {
        let minted = 0
        const conn = await connectRealtime({
            channels: ['room:r'],
            getToken: async (request) => {
                minted++
                return server.realtime.mintToken(request)
            },
        })
        try {
            const heard = []
            conn.subscribe('room:r', (m) => heard.push(m.payload))

            conn.ws.close()
            await settle(900)
            await server.realtime.publish('room:r', { back: true })
            await settle()

            assert.equal(minted, 2)
            assert.deepEqual(heard, [{ back: true }])
        } finally {
            conn.close()
        }
    })
})
