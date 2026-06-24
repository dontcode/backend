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
