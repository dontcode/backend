import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { DontCodeError, dontcode, isDontCodeError } from '../dist/index.js'

/**
 * The SDK is a faithful proxy: these tests assert it forms the exact requests
 * the v1 gateway expects (URL, method, headers, body) and shapes responses the
 * way callers consume them. `fetch` is mocked so nothing leaves the process.
 */

let calls = []
let nextResponse = null
const realFetch = globalThis.fetch

function mockResponse({ status = 200, body = {} } = {}) {
    nextResponse = {
        ok: status >= 200 && status < 300,
        status,
        statusText: 'mock',
        text: async () => (body === null ? '' : JSON.stringify(body)),
    }
}

beforeEach(() => {
    calls = []
    mockResponse({ body: {} })
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init })
        return nextResponse
    }
})

afterEach(() => {
    globalThis.fetch = realFetch
    delete process.env.DONTCODE_API_KEY
    delete process.env.DONTCODE_API_URL
    delete process.env.DONTCODE_APP_URL
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL
    delete process.env.NETLIFY
    delete process.env.URL
    delete process.env.SITE_NAME
    delete process.env.SITE_ID
    delete process.env.RENDER_EXTERNAL_URL
    delete process.env.RAILWAY_PUBLIC_DOMAIN
    delete process.env.FLY_APP_NAME
    delete process.env.KOYEB_PUBLIC_DOMAIN
})

const last = () => calls[calls.length - 1]
const bodyOf = (call) => JSON.parse(call.init.body)
const headerOf = (call, name) => call.init.headers[name]

describe('client construction', () => {
    it('defaults the base URL and sends the API key as a Bearer token', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        await client.auth.login({ email: 'a@b.co', password: 'x' })
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/auth/login')
        assert.equal(headerOf(last(), 'Authorization'), 'Bearer dc_test')
    })

    it('falls back to DONTCODE_API_KEY and DONTCODE_API_URL from the env', async () => {
        process.env.DONTCODE_API_KEY = 'dc_env'
        process.env.DONTCODE_API_URL = 'https://self.hosted.example'
        const client = dontcode()
        await client.auth.login({ email: 'a@b.co', password: 'x' })
        assert.equal(last().url, 'https://self.hosted.example/api/v1/auth/login')
        assert.equal(headerOf(last(), 'Authorization'), 'Bearer dc_env')
    })

    it('strips a trailing slash from a custom base URL', async () => {
        const client = dontcode({ apiKey: 'dc_test', baseUrl: 'https://x.example/' })
        await client.auth.login({ email: 'a@b.co', password: 'x' })
        assert.equal(last().url, 'https://x.example/api/v1/auth/login')
    })

    it('sends no Authorization header when no key is set anywhere', async () => {
        const client = dontcode()
        await client.auth.login({ email: 'a@b.co', password: 'x' })
        assert.equal(headerOf(last(), 'Authorization'), undefined)
    })

    it('sends an explicit appUrl as X-App-Url, normalized to its origin', async () => {
        const client = dontcode({ apiKey: 'dc_test', appUrl: 'https://myapp.example/deep/page' })
        await client.auth.login({ email: 'a@b.co', password: 'x' })
        assert.equal(headerOf(last(), 'X-App-Url'), 'https://myapp.example')
    })

    it('detects the app URL from DONTCODE_APP_URL, then the host env', async () => {
        process.env.DONTCODE_APP_URL = 'https://configured.example'
        process.env.VERCEL_PROJECT_PRODUCTION_URL = 'vercel.example'
        let client = dontcode({ apiKey: 'dc_test' })
        await client.auth.login({ email: 'a@b.co', password: 'x' })
        assert.equal(headerOf(last(), 'X-App-Url'), 'https://configured.example')

        delete process.env.DONTCODE_APP_URL
        client = dontcode({ apiKey: 'dc_test' })
        await client.auth.login({ email: 'a@b.co', password: 'x' })
        assert.equal(headerOf(last(), 'X-App-Url'), 'https://vercel.example')
    })

    it('detects Netlify at runtime, where only URL/SITE_NAME/SITE_ID exist', async () => {
        // Netlify functions do NOT get the NETLIFY env var at runtime.
        process.env.URL = 'https://petsof.netlify.app'
        process.env.SITE_NAME = 'petsof'
        const client = dontcode({ apiKey: 'dc_test' })
        await client.auth.login({ email: 'a@b.co', password: 'x' })
        assert.equal(headerOf(last(), 'X-App-Url'), 'https://petsof.netlify.app')
    })

    it('detects Render, Railway, and Fly.io from their runtime env vars', async () => {
        process.env.RENDER_EXTERNAL_URL = 'https://myapp.onrender.com'
        let client = dontcode({ apiKey: 'dc_test' })
        await client.auth.login({ email: 'a@b.co', password: 'x' })
        assert.equal(headerOf(last(), 'X-App-Url'), 'https://myapp.onrender.com')
        delete process.env.RENDER_EXTERNAL_URL

        process.env.RAILWAY_PUBLIC_DOMAIN = 'myapp.up.railway.app'
        client = dontcode({ apiKey: 'dc_test' })
        await client.auth.login({ email: 'a@b.co', password: 'x' })
        assert.equal(headerOf(last(), 'X-App-Url'), 'https://myapp.up.railway.app')
        delete process.env.RAILWAY_PUBLIC_DOMAIN

        process.env.FLY_APP_NAME = 'myapp'
        client = dontcode({ apiKey: 'dc_test' })
        await client.auth.login({ email: 'a@b.co', password: 'x' })
        assert.equal(headerOf(last(), 'X-App-Url'), 'https://myapp.fly.dev')
        delete process.env.FLY_APP_NAME

        process.env.KOYEB_PUBLIC_DOMAIN = 'myapp-org-1a2b.koyeb.app'
        client = dontcode({ apiKey: 'dc_test' })
        await client.auth.login({ email: 'a@b.co', password: 'x' })
        assert.equal(headerOf(last(), 'X-App-Url'), 'https://myapp-org-1a2b.koyeb.app')
    })

    it('ignores a bare URL env var without a Netlify marker', async () => {
        // `URL` is too generic a name to trust on its own.
        process.env.URL = 'https://something.example'
        const client = dontcode({ apiKey: 'dc_test' })
        await client.auth.login({ email: 'a@b.co', password: 'x' })
        assert.equal(headerOf(last(), 'X-App-Url'), undefined)
    })

    it('sends no X-App-Url when nothing is configured, opted out, or invalid', async () => {
        let client = dontcode({ apiKey: 'dc_test' })
        await client.auth.login({ email: 'a@b.co', password: 'x' })
        assert.equal(headerOf(last(), 'X-App-Url'), undefined)

        process.env.VERCEL_PROJECT_PRODUCTION_URL = 'vercel.example'
        client = dontcode({ apiKey: 'dc_test', appUrl: '' })
        await client.auth.login({ email: 'a@b.co', password: 'x' })
        assert.equal(headerOf(last(), 'X-App-Url'), undefined)

        client = dontcode({ apiKey: 'dc_test', appUrl: 'http://insecure.example' })
        await client.auth.login({ email: 'a@b.co', password: 'x' })
        assert.equal(headerOf(last(), 'X-App-Url'), undefined)
    })
})

describe('auth', () => {
    it('signup forwards the allowlisted fields', async () => {
        mockResponse({ body: { success: true, userId: 'u1', verification_required: true } })
        const client = dontcode({ apiKey: 'dc_test' })
        const res = await client.auth.signup({
            email: 'a@b.co',
            password: 'pw',
            role: 'editor',
        })
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/auth/signup')
        assert.deepEqual(bodyOf(last()), { email: 'a@b.co', password: 'pw', role: 'editor' })
        assert.equal(res.verification_required, true)
    })

    it('me sends the end-user token in X-Access-Token, not Authorization', async () => {
        mockResponse({ body: { user: { id: 'u1', email: 'a@b.co' } } })
        const client = dontcode({ apiKey: 'dc_test' })
        await client.auth.me({ accessToken: 'user-token' })
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/auth/me')
        assert.equal(headerOf(last(), 'X-Access-Token'), 'user-token')
        assert.equal(headerOf(last(), 'Authorization'), 'Bearer dc_test')
    })

    it('mfa.challenge maps camelCase inputs to the snake_case wire shape', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        await client.auth.mfa.challenge({ challengeToken: 'ch', recoveryCode: 'rc' })
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/auth/mfa/challenge')
        assert.deepEqual(bodyOf(last()), { challenge_token: 'ch', recovery_code: 'rc' })
    })

    it('mfa.enroll posts an empty body with the access token', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        await client.auth.mfa.enroll({ accessToken: 'user-token' })
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/auth/mfa/enroll')
        assert.equal(headerOf(last(), 'X-Access-Token'), 'user-token')
        assert.deepEqual(bodyOf(last()), {})
    })
})

describe('db', () => {
    it('find sends the structured-query protocol and unwraps { data }', async () => {
        mockResponse({ body: { data: [{ id: 1 }, { id: 2 }] } })
        const client = dontcode({ apiKey: 'dc_test' })
        const rows = await client.db.maps.find({ where: { ownerId: 'u1' }, limit: 10 })
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/db')
        assert.deepEqual(bodyOf(last()), {
            operation: 'find',
            tableName: 'maps',
            options: { where: { ownerId: 'u1' }, limit: 10 },
        })
        assert.deepEqual(rows, [{ id: 1 }, { id: 2 }])
    })

    it('supports the callable form for awkward table names', async () => {
        mockResponse({ body: { data: null } })
        const client = dontcode({ apiKey: 'dc_test' })
        await client.db('user-profiles').findFirst({ where: { id: 1 } })
        assert.equal(bodyOf(last()).tableName, 'user-profiles')
        assert.equal(bodyOf(last()).operation, 'findFirst')
    })

    it('insert returns the unwrapped { id }', async () => {
        mockResponse({ body: { data: { id: 42 } } })
        const client = dontcode({ apiKey: 'dc_test' })
        const res = await client.db.maps.insert({ name: 'm' })
        assert.deepEqual(bodyOf(last()).options, { data: { name: 'm' } })
        assert.deepEqual(res, { id: 42 })
    })

    it('update threads where + data through to the gateway', async () => {
        mockResponse({ body: { data: { count: 3 } } })
        const client = dontcode({ apiKey: 'dc_test' })
        const res = await client.db.maps.update({ where: { id: 1 }, data: { name: 'n' } })
        assert.equal(bodyOf(last()).operation, 'update')
        assert.deepEqual(bodyOf(last()).options, { where: { id: 1 }, data: { name: 'n' } })
        assert.deepEqual(res, { count: 3 })
    })

    it('migrate posts to the migrate route and returns the body verbatim', async () => {
        mockResponse({ body: { success: true, executedStatements: 1, warnings: [] } })
        const client = dontcode({ apiKey: 'dc_test' })
        const res = await client.db.migrate({ sql: 'CREATE TABLE t (id int);' })
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/db/migrate')
        assert.deepEqual(bodyOf(last()), { sql: 'CREATE TABLE t (id int);' })
        assert.deepEqual(res, { success: true, executedStatements: 1, warnings: [] })
    })
})

describe('storage', () => {
    it('public.getUrl posts the public bucket', async () => {
        mockResponse({ body: { url: 'https://cdn/x' } })
        const client = dontcode({ apiKey: 'dc_test' })
        const res = await client.storage.public.getUrl('img/a.png')
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/storage')
        assert.deepEqual(bodyOf(last()), { operation: 'getUrl', bucket: 'public', path: 'img/a.png' })
        assert.equal(res.url, 'https://cdn/x')
    })

    it('private.list scopes to the private bucket', async () => {
        mockResponse({ body: { objects: [], folders: [], prefix: '', truncated: false, continuationToken: null } })
        const client = dontcode({ apiKey: 'dc_test' })
        await client.storage.private.list('docs')
        assert.deepEqual(bodyOf(last()), { operation: 'list', bucket: 'private', prefix: 'docs' })
    })

    it('upload PUTs multipart/form-data without a JSON content-type', async () => {
        mockResponse({ body: { object: { key: 'docs/a.txt' } } })
        const client = dontcode({ apiKey: 'dc_test' })
        await client.storage.private.upload('docs/a.txt', 'hello', 'text/plain')
        assert.equal(last().init.method, 'PUT')
        assert.equal(headerOf(last(), 'Content-Type'), undefined)
        assert.ok(last().init.body instanceof FormData)
        const form = last().init.body
        assert.equal(form.get('bucket'), 'private')
        assert.equal(form.get('path'), 'docs/a.txt')
        assert.equal(form.get('contentType'), 'text/plain')
        assert.ok(form.get('file'))
    })
})

describe('notifications', () => {
    it('email.send posts to the email channel and passes the response through', async () => {
        mockResponse({ body: { success: true, messageId: 'msg_1' } })
        const client = dontcode({ apiKey: 'dc_test' })
        const res = await client.notifications.email.send({
            to: 'user@example.com',
            subject: 'Welcome',
            markdownText: '# Hi',
        })
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/notifications/email')
        assert.equal(headerOf(last(), 'Authorization'), 'Bearer dc_test')
        assert.deepEqual(bodyOf(last()), {
            to: ['user@example.com'],
            subject: 'Welcome',
            markdownText: '# Hi',
        })
        assert.equal(res.success, true)
        assert.equal(res.messageId, 'msg_1')
    })

    it('email.send normalizes a single recipient to an array and keeps arrays as-is', async () => {
        const client = dontcode({ apiKey: 'dc_test' })
        await client.notifications.email.send({ to: 'solo@x.co', subject: 's', markdownText: 'b' })
        assert.deepEqual(bodyOf(last()).to, ['solo@x.co'])
        await client.notifications.email.send({
            to: ['a@x.co', 'b@x.co'],
            subject: 's',
            markdownText: 'b',
        })
        assert.deepEqual(bodyOf(last()).to, ['a@x.co', 'b@x.co'])
    })

    it('surfaces a service-reported failure without throwing', async () => {
        mockResponse({ body: { success: false, error: 'invalid recipient' } })
        const client = dontcode({ apiKey: 'dc_test' })
        const res = await client.notifications.email.send({
            to: 'bad',
            subject: 's',
            markdownText: 'b',
        })
        assert.equal(res.success, false)
        assert.equal(res.error, 'invalid recipient')
    })
})

describe('payments', () => {
    it('verify posts to /verify and unwraps the receipt', async () => {
        mockResponse({ body: { receipt: { id: 'pay_1', status: 'paid', amount: 9900 } } })
        const client = dontcode({ apiKey: 'dc_test' })
        const receipt = await client.payments.verify({
            paymentId: 'pay_1',
            expectedAmount: 9900,
            currency: 'KRW',
        })
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/payments/verify')
        assert.equal(last().init.method, 'POST')
        assert.deepEqual(bodyOf(last()), {
            paymentId: 'pay_1',
            expectedAmount: 9900,
            currency: 'KRW',
        })
        assert.equal(receipt.id, 'pay_1')
    })

    it('confirmSubscription maps camelCase args to the wire snake_case', async () => {
        mockResponse({ body: { subscription: { id: 'sub_1', status: 'active' } } })
        const client = dontcode({ apiKey: 'dc_test' })
        const sub = await client.payments.confirmSubscription({
            subscriptionId: 'sub_1',
            billingKey: 'bk_1',
        })
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/payments/subscribe-confirm')
        assert.deepEqual(bodyOf(last()), { subscription_id: 'sub_1', billing_key: 'bk_1' })
        assert.equal(sub.status, 'active')
    })

    it('cancelSubscription defaults to a soft cancel', async () => {
        mockResponse({ body: { subscription: { id: 'sub_1', status: 'active' } } })
        const client = dontcode({ apiKey: 'dc_test' })
        await client.payments.cancelSubscription({ id: 'sub_1', status: 'active' })
        assert.equal(bodyOf(last()).atPeriodEnd, true)
    })

    it('getSubscription returns null when the user has none', async () => {
        mockResponse({ body: { subscription: null } })
        const client = dontcode({ apiKey: 'dc_test' })
        assert.equal(await client.payments.getSubscription('u1'), null)
    })

    it('hasActiveSubscription resolves entitlement from the active list', async () => {
        mockResponse({
            body: {
                subscriptions: [
                    { id: 's1', planId: 'pro', status: 'active' },
                    { id: 's2', planId: 'basic', status: 'past_due' },
                ],
            },
        })
        const client = dontcode({ apiKey: 'dc_test' })
        assert.equal(await client.payments.hasActiveSubscription('u1', 'pro'), true)
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/payments/list-active-subscriptions')
    })

    it('hasActiveSubscription is false for a plan with no active sub', async () => {
        mockResponse({ body: { subscriptions: [{ id: 's2', planId: 'basic', status: 'past_due' }] } })
        const client = dontcode({ apiKey: 'dc_test' })
        assert.equal(await client.payments.hasActiveSubscription('u1', 'pro'), false)
    })

    it('hasFeature unwraps { ok }', async () => {
        mockResponse({ body: { ok: true } })
        const client = dontcode({ apiKey: 'dc_test' })
        assert.equal(await client.payments.hasFeature('u1', 'export_pdf'), true)
        assert.deepEqual(bodyOf(last()), { userId: 'u1', featureKey: 'export_pdf' })
    })

    it('listPlans GETs with the includeInactive query and unwraps plans', async () => {
        mockResponse({ body: { plans: [{ planId: 'pro' }] } })
        const client = dontcode({ apiKey: 'dc_test' })
        const plans = await client.payments.listPlans({ includeInactive: true })
        assert.equal(last().init.method, 'GET')
        assert.equal(
            last().url,
            'https://backend.dontcode.co/api/v1/payments/plans?includeInactive=true'
        )
        assert.equal(plans[0].planId, 'pro')
    })

    it('setPlanActive PATCHes /plans', async () => {
        mockResponse({ body: {} })
        const client = dontcode({ apiKey: 'dc_test' })
        await client.payments.setPlanActive('pro', false)
        assert.equal(last().init.method, 'PATCH')
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/payments/plans')
        assert.deepEqual(bodyOf(last()), { planId: 'pro', active: false })
    })

    it('deletePlan DELETEs with the planId query', async () => {
        mockResponse({ body: {} })
        const client = dontcode({ apiKey: 'dc_test' })
        await client.payments.deletePlan('pro')
        assert.equal(last().init.method, 'DELETE')
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/payments/plans?planId=pro')
    })

    it('listSubscriptions posts filters to the admin endpoint', async () => {
        mockResponse({ body: { subscriptions: [{ id: 's1' }], total: 1 } })
        const client = dontcode({ apiKey: 'dc_test' })
        const res = await client.payments.listSubscriptions({ status: 'active', limit: 10 })
        assert.equal(
            last().url,
            'https://backend.dontcode.co/api/v1/payments/admin/list-subscriptions'
        )
        assert.deepEqual(bodyOf(last()), { status: 'active', limit: 10 })
        assert.equal(res.total, 1)
    })
})

describe('errors', () => {
    it('throws DontCodeError carrying status, code, and body on failure', async () => {
        mockResponse({ status: 403, body: { error: 'Email not verified', code: 'EmailNotVerified' } })
        const client = dontcode({ apiKey: 'dc_test' })
        await assert.rejects(
            () => client.auth.login({ email: 'a@b.co', password: 'x' }),
            (err) => {
                assert.ok(isDontCodeError(err))
                assert.ok(err instanceof DontCodeError)
                assert.equal(err.status, 403)
                assert.equal(err.code, 'EmailNotVerified')
                assert.equal(err.message, 'Email not verified')
                return true
            }
        )
    })

    it('flags rate-limit responses', async () => {
        mockResponse({ status: 429, body: { error: 'slow down', rate_limit: true, timeleft: 12 } })
        const client = dontcode({ apiKey: 'dc_test' })
        await assert.rejects(
            () => client.db.maps.find(),
            (err) => {
                assert.equal(err.status, 429)
                assert.equal(err.rateLimited, true)
                assert.equal(err.body.timeleft, 12)
                return true
            }
        )
    })
})
