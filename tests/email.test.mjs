import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { dontcode, isDontCodeError } from '../dist/index.js'
import { startMockServer } from '../dist/mock/index.js'

/**
 * Email as an Insight app sends it: recipients named by who controls them,
 * broadcasts to a role, and the owner's address for a page.
 */

let calls = []
let answers = []
const realFetch = globalThis.fetch

beforeEach(() => {
    calls = []
    answers = []
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init })
        return answers.shift() ?? json({ success: true, messageId: 'm1' })
    }
})

afterEach(() => {
    globalThis.fetch = realFetch
})

const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const client = () => dontcode({ apiKey: 'dc_test' })
const bodyOf = (call) => JSON.parse(call.init.body)

describe('email.send', () => {
    it('names the business, a saved inbox and an app user, with the button and reply-to', async () => {
        await client().notifications.email.send({
            to: ['owner', 'contact:lawyer', { user: '6f1d2c3b-0000-4000-8000-000000000001' }],
            subject: 'New booking',
            markdownText: '# Booking',
            replyTo: 'guest@example.com',
            locale: 'ko',
            action: { label: 'See it', href: 'https://shop.example/bookings/42' },
        })

        assert.equal(calls[0].url, 'https://backend.dontcode.co/api/v1/notifications/email')
        assert.deepEqual(bodyOf(calls[0]), {
            to: ['owner', 'contact:lawyer', { user: '6f1d2c3b-0000-4000-8000-000000000001' }],
            subject: 'New booking',
            markdownText: '# Booking',
            replyTo: 'guest@example.com',
            locale: 'ko',
            action: { label: 'See it', href: 'https://shop.example/bookings/42' },
        })
    })

    it('sends one recipient as a list, and leaves out what was not given', async () => {
        await client().notifications.email.send({
            to: 'owner',
            subject: 'Hi',
            markdownText: 'Hello',
        })

        assert.deepEqual(bodyOf(calls[0]), { to: ['owner'], subject: 'Hi', markdownText: 'Hello' })
    })
})

describe('email.broadcast', () => {
    it('sends a notice to a role in every language by default', async () => {
        answers.push(json({ success: true, broadcastId: 'b1', total: 120 }))

        const result = await client().notifications.email.broadcast({
            to: { role: 'buyer' },
            versions: {
                ko: { subject: '약관 변경', markdownText: '# 약관' },
                en: { subject: 'Terms', markdownText: '# Terms' },
            },
        })

        assert.equal(
            calls[0].url,
            'https://backend.dontcode.co/api/v1/notifications/email/broadcast'
        )
        assert.deepEqual(bodyOf(calls[0]), {
            to: { role: 'buyer' },
            kind: 'notice',
            versions: {
                ko: { subject: '약관 변경', markdownText: '# 약관' },
                en: { subject: 'Terms', markdownText: '# Terms' },
            },
        })
        assert.deepEqual(result, { success: true, broadcastId: 'b1', total: 120 })
    })

    it('marks a promotion as one', async () => {
        await client().notifications.email.broadcast({
            to: { role: 'member' },
            kind: 'promotion',
            versions: { en: { subject: 'Sale', markdownText: '20% off' } },
        })

        assert.equal(bodyOf(calls[0]).kind, 'promotion')
    })

    it('passes the refusal for a missing language through as an error', async () => {
        answers.push(
            json({ success: false, error: 'One version per app language: missing ko' }, 400)
        )

        await assert.rejects(
            () =>
                client().notifications.email.broadcast({
                    to: { role: 'buyer' },
                    versions: { en: { subject: 'x', markdownText: 'y' } },
                }),
            (err) => isDontCodeError(err) && err.status === 400 && /missing ko/.test(err.message)
        )
    })
})

describe('email.ownerAddress', () => {
    it("reads the owner's address with a GET", async () => {
        answers.push(json({ email: 'owner@shop.example' }))

        assert.equal(await client().notifications.email.ownerAddress(), 'owner@shop.example')
        assert.equal(calls[0].url, 'https://backend.dontcode.co/api/v1/notifications/owner')
        assert.equal(calls[0].init.method, 'GET')
    })

    it('is null with no owner, and when the read fails, so a page still renders', async () => {
        answers.push(json({ email: null }), json({ error: 'Try again later' }, 503))

        assert.equal(await client().notifications.email.ownerAddress(), null)
        assert.equal(await client().notifications.email.ownerAddress(), null)
    })

    it('still throws on a bad API key', async () => {
        answers.push(json({ error: 'Invalid API key' }, 401))

        await assert.rejects(
            () => client().notifications.email.ownerAddress(),
            (err) => err.status === 401
        )
    })
})

describe('mock gateway: email offline', () => {
    it('checks recipients and roles the way the service does', async () => {
        globalThis.fetch = realFetch
        const mock = await startMockServer({
            dataDir: null,
            quiet: true,
            port: 0,
            signupRoles: ['buyer'],
        })
        try {
            const c = dontcode({ baseUrl: mock.url, apiKey: 'dc_test' })
            const { userId } = await c.auth.signup({
                email: 'buyer@example.com',
                password: 'pw123456',
                role: 'buyer',
            })

            const sent = await c.notifications.email.send({
                to: ['owner', { user: userId }],
                subject: 'Order',
                markdownText: 'Thanks',
            })
            assert.equal(sent.messageIds.length, 2)

            for (const to of [
                'me',
                { user: '6f1d2c3b-0000-4000-8000-00000000dead' },
                { role: 'buyer' },
                'not-an-address',
            ]) {
                await assert.rejects(
                    () => c.notifications.email.send({ to, subject: 'x', markdownText: 'y' }),
                    (err) => isDontCodeError(err) && err.status === 400
                )
            }

            const broadcast = await c.notifications.email.broadcast({
                to: { role: 'buyer' },
                versions: { en: { subject: 'News', markdownText: 'Hi' } },
            })
            assert.equal(broadcast.total, 1)

            assert.equal(await c.notifications.email.ownerAddress(), 'owner@example.com')
        } finally {
            await mock.close()
        }
    })
})
