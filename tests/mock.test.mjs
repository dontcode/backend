import { dontcode, isDontCodeError } from '../dist/index.js'
import { startMockServer } from '../dist/mock/index.js'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { after, before, describe, it } from 'node:test'

/**
 * The mock gateway is only useful if the real SDK can drive it unchanged. These
 * tests run the actual `dontcode()` client against an ephemeral mock and assert
 * the full surface — db (incl. the 409 conflict signal), auth (token round-trip
 * through `getSession`), and storage (upload → public URL → download).
 */

let mock
let client

before(async () => {
    mock = await startMockServer({ dataDir: null, quiet: true, port: 0 })
    client = dontcode({ baseUrl: mock.url, apiKey: 'dc_test' })
    await client.db.migrate({
        sql: `CREATE TABLE IF NOT EXISTS maps (
            id serial primary key,
            name text unique,
            owner text
        );`,
    })
})

after(async () => {
    await mock.close()
})

describe('mock gateway — database', () => {
    it('inserts and reads back a row', async () => {
        const { id } = await client.db.maps.insert({ name: 'demo', owner: 'u1' })
        assert.ok(id != null)
        const row = await client.db.maps.findFirst({ where: { id } })
        assert.equal(row.name, 'demo')
    })

    it('signals a unique conflict as a 409 DontCodeError', async () => {
        await assert.rejects(
            () => client.db.maps.insert({ name: 'demo', owner: 'u2' }),
            (err) => isDontCodeError(err) && err.status === 409
        )
    })

    it('honors where operators, count, update, and delete', async () => {
        await client.db.maps.insert({ name: 'Another', owner: 'u1' })
        const found = await client.db.maps.find({
            where: { name: { contains: 'other', mode: 'insensitive' } },
        })
        assert.equal(found.length, 1)
        assert.equal(await client.db.maps.count({ where: { owner: 'u1' } }), 2)
        assert.equal(
            (await client.db.maps.update({ where: { name: 'demo' }, data: { owner: 'u9' } })).count,
            1
        )
        assert.equal((await client.db.maps.delete({ where: { name: 'Another' } })).count, 1)
    })
})

describe('mock gateway — auth', () => {
    it('round-trips signup → login → getSession → me', async () => {
        assert.equal((await client.auth.signup({ email: 'a@b.com', password: 'pw' })).success, true)
        const login = await client.auth.login({ email: 'a@b.com', password: 'pw' })
        assert.ok(login.tokens?.AccessToken)

        const session = await client.auth.getSession({ accessToken: login.tokens.AccessToken })
        assert.equal(session.status, 'active')
        assert.equal(session.user.email, 'a@b.com')

        const me = await client.auth.me({ accessToken: login.tokens.AccessToken })
        assert.equal(me.user.email, 'a@b.com')
    })

    it('rejects a wrong password with 401', async () => {
        await assert.rejects(
            () => client.auth.login({ email: 'a@b.com', password: 'nope' }),
            (err) => isDontCodeError(err) && err.status === 401
        )
    })
})

describe('mock gateway — storage', () => {
    it('uploads to the public bucket and serves a working URL', async () => {
        await client.storage.public.upload('img/logo.txt', 'hello-mock', 'text/plain')
        const { url } = await client.storage.public.getUrl('img/logo.txt')
        const served = await fetch(url).then((r) => r.text())
        assert.equal(served, 'hello-mock')
    })

    it('downloads a private object inline as base64', async () => {
        await client.storage.private.upload('p/secret.txt', 'sekret', 'text/plain')
        const dl = await client.storage.private.download('p/secret.txt')
        assert.equal(Buffer.from(dl.body, 'base64').toString(), 'sekret')
    })
})

describe('mock gateway — auth guard', () => {
    it('returns 401 when no API key is sent', async () => {
        const keyless = dontcode({ baseUrl: mock.url })
        await assert.rejects(
            () => keyless.db.maps.count(),
            (err) => isDontCodeError(err) && err.status === 401
        )
    })
})

describe('mock gateway — cache (kv)', () => {
    it('round-trips a value and misses on an unknown key', async () => {
        assert.equal(await client.cache.get('missing'), null)
        assert.equal(await client.cache.set('k1', { step: 2 }), true)
        assert.deepEqual(await client.cache.get('k1'), { step: 2 })
    })

    it('honors nx (set-if-absent) and del', async () => {
        assert.equal(await client.cache.set('nxkey', 'first', { nx: true }), true)
        assert.equal(await client.cache.set('nxkey', 'second', { nx: true }), false)
        assert.equal(await client.cache.get('nxkey'), 'first')
        assert.equal(await client.cache.del('nxkey'), true)
        assert.equal(await client.cache.del('nxkey'), false)
        assert.equal(await client.cache.get('nxkey'), null)
    })

    it('expires a key after its ttl', async () => {
        await client.cache.set('ttlkey', 'v', { ttl: 1 })
        assert.equal(await client.cache.get('ttlkey'), 'v')
        // ttl is whole seconds; nudge just past it.
        await new Promise((r) => setTimeout(r, 1100))
        assert.equal(await client.cache.get('ttlkey'), null)
    })

    it('supports hashes and sets', async () => {
        assert.equal(await client.cache.hset('h1', { a: 1, b: 'two' }), 2)
        assert.deepEqual(await client.cache.hgetAll('h1'), { a: 1, b: 'two' })
        assert.equal(await client.cache.hgetAll('nope'), null)

        assert.equal(await client.cache.sAdd('s1', 'x', 'y', 'x'), 2)
        assert.deepEqual((await client.cache.sMembers('s1')).sort(), ['x', 'y'])
        assert.deepEqual(await client.cache.sMembers('nope'), [])
        assert.equal(await client.cache.sRem('s1', 'x', 'z'), 1)
        assert.deepEqual(await client.cache.sMembers('s1'), ['y'])
    })
})

describe('mock gateway — realtime', () => {
    // Open a WebSocket with a minted token and collect parsed `message` frames.
    const connect = async (token, url) => {
        const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`)
        const messages = []
        ws.addEventListener('message', (ev) => messages.push(JSON.parse(ev.data)))
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true })
            ws.addEventListener('error', () => reject(new Error('ws open failed')), { once: true })
        })
        return { ws, messages }
    }
    const settle = () => new Promise((r) => setTimeout(r, 100))

    it('mints a channel-scoped token pointing at a ws:// url', async () => {
        const conn = await client.realtime.mintToken({ channels: ['game:x'], identity: 'u1' })
        assert.ok(conn.token)
        assert.match(conn.url, /^ws:\/\//)
    })

    it('delivers a server-side publish to a subscribed socket only', async () => {
        const { token, url } = await client.realtime.mintToken({ channels: ['game:a'] })
        const { ws, messages } = await connect(token, url)

        const delivered = await client.realtime.publish('game:a', { event: { id: 7 } })
        const missed = await client.realtime.publish('game:b', { event: { id: 8 } })
        await settle()

        assert.equal(delivered, 1)
        assert.equal(missed, 0)
        assert.equal(messages.length, 1)
        assert.deepEqual(messages[0], {
            type: 'message',
            channel: 'game:a',
            payload: { event: { id: 7 } },
        })
        ws.close()
    })

    it('reports presence and fans a client publish out to peers, not the sender', async () => {
        const { token, url } = await client.realtime.mintToken({ channels: ['game:c'], identity: 'p1' })
        const a = await connect(token, url)
        const b = await connect(token, url)

        const presence = await client.realtime.presence('game:c')
        assert.equal(presence.length, 2)
        assert.ok(presence.every((m) => m.identity === 'p1'))

        a.ws.send(JSON.stringify({ type: 'publish', channel: 'game:c', payload: { hi: true } }))
        await settle()

        assert.equal(a.messages.length, 0, 'publisher should not receive its own message')
        assert.equal(b.messages.length, 1)
        assert.deepEqual(b.messages[0].payload, { hi: true })
        a.ws.close()
        b.ws.close()
    })

    it('rejects a WebSocket opened with a bad token', async () => {
        const { url } = await client.realtime.mintToken({ channels: ['game:d'] })
        const ws = new WebSocket(`${url}?token=not-a-real-token`)
        const outcome = await new Promise((resolve) => {
            ws.addEventListener('open', () => resolve('open'), { once: true })
            ws.addEventListener('error', () => resolve('error'), { once: true })
            ws.addEventListener('close', () => resolve('close'), { once: true })
        })
        assert.notEqual(outcome, 'open', 'a bad token must not establish a connection')
    })
})
