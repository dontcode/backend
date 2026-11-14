import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { dontcode } from '../dist/index.js'
import { startMockServer } from '../dist/mock/index.js'

/**
 * The buyer's receipt page a Backend app mounts at /r/<number>: read through
 * the gateway by number and token, drawn as the Insight page draws it, every
 * value escaped, under a nonce CSP.
 */

let calls = []
let answers = []
const realFetch = globalThis.fetch

beforeEach(() => {
    calls = []
    answers = []
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init })
        return answers.shift() ?? json({ error: 'Not found' }, 404)
    }
})

afterEach(() => {
    globalThis.fetch = realFetch
})

const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const client = () => dontcode({ apiKey: 'dc_test' })

const VIEW = {
    number: '2292-7165-6932',
    kind: 'one_time',
    status: 'paid',
    currency: 'KRW',
    amount: 15000,
    paidAt: '2026-11-15T03:00:00.000Z',
    refundedAt: null,
    paymentMethod: 'kakaopay',
    paymentDetail: null,
    lineItems: [{ name: '<script>alert(1)</script> Latte', amount: 15000, quantity: 1 }],
    issuer: {
        appName: 'Seoul Beans',
        businessName: '서울빈스',
        registrationNumber: '123-45-67890',
        representative: null,
        address: null,
        phone: null,
        mailOrderNumber: null,
        email: 'owner@seoulbeans.example',
        logoUrl: 'javascript:alert(1)',
        color: 'red;}body{display:none',
        footer: null,
    },
    customer: { name: 'Ji', email: 'ji@example.com' },
    locale: 'ko',
}

const pageRequest = (path, headers = {}) =>
    new Request(`https://seoulbeans.example${path}`, { headers })

describe('payments.receipt', () => {
    it('reads by number and token, naming the buyer', async () => {
        answers.push(json(VIEW))

        const view = await client().payments.receipt('2292-7165-6932', 'tok_abc', {
            request: pageRequest('/r/2292-7165-6932?t=tok_abc', {
                'x-forwarded-for': '203.0.113.9',
            }),
        })

        assert.equal(
            calls[0].url,
            'https://backend.dontcode.co/api/v1/payments/receipts/2292-7165-6932?t=tok_abc'
        )
        const sent = Object.fromEntries(
            Object.entries(calls[0].init.headers).map(([k, v]) => [k.toLowerCase(), v])
        )
        assert.equal(sent['x-dontcode-client-ip'], '203.0.113.9')
        assert.equal(view.number, '2292-7165-6932')
    })

    it('is null for a wrong token, and asks nothing for a number that is a path', async () => {
        assert.equal(await client().payments.receipt('2292-7165-6932', 'wrong'), null)
        assert.equal(await client().payments.receipt('../admin', 'tok'), null)
        assert.equal(calls.length, 1)
    })
})

describe('payments.handleReceiptRequest', () => {
    it('draws the receipt in its language, every value escaped, under a nonce CSP', async () => {
        answers.push(json(VIEW))

        const res = await client().payments.handleReceiptRequest(
            pageRequest('/r/2292-7165-6932?t=tok_abc')
        )
        const html = await res.text()

        assert.equal(res.status, 200)
        assert.match(res.headers.get('content-type'), /text\/html/)
        assert.match(html, /<html lang="ko">/)
        assert.match(html, /15,000원/)
        assert.match(html, /서울빈스/)
        assert.ok(!html.includes('<script>alert(1)</script>'), 'item names are escaped')
        assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; Latte'))
        assert.ok(!html.includes('javascript:alert'), 'only an https logo loads')
        assert.ok(!html.includes('red;}body'), 'only a hex color reaches the CSS')
        assert.match(html, /--brand:#111827/)
        const csp = res.headers.get('content-security-policy')
        const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1]
        assert.ok(html.includes(`<script nonce="${nonce}">`))
        assert.equal(res.headers.get('cache-control'), 'private, no-store')
        assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
        assert.match(res.headers.get('x-robots-tag'), /noindex/)
    })

    it("answers a 404 page for a wrong token, in the buyer's browser language", async () => {
        const res = await client().payments.handleReceiptRequest(
            pageRequest('/r/2292-7165-6932?t=wrong', { 'accept-language': 'ja-JP,ja;q=0.9' })
        )

        assert.equal(res.status, 404)
        assert.match(await res.text(), /<html lang="ja">/)
    })

    it('answers a page saying it cannot be shown when the read fails', async () => {
        answers.push(json({ error: 'down' }, 500))

        const res = await client().payments.handleReceiptRequest(
            pageRequest('/r/2292-7165-6932?t=tok')
        )

        assert.equal(res.status, 502)
    })

    it('takes the number you pass over the path', async () => {
        answers.push(json(VIEW))

        await client().payments.handleReceiptRequest(
            pageRequest('/receipt?t=tok'),
            '2292-7165-6932'
        )

        assert.match(calls[0].url, /receipts\/2292-7165-6932\?t=tok$/)
    })
})

describe('mock gateway: receipts offline', () => {
    it('gives a verified payment a receipt link that the page serves', async () => {
        globalThis.fetch = realFetch
        const mock = await startMockServer({ dataDir: null, quiet: true, port: 0 })
        try {
            const c = dontcode({ baseUrl: mock.url, apiKey: 'dc_test' })
            const intent = await c.payments.requestPayment({
                amount: 9900,
                itemName: 'Box',
                method: 'card',
            })
            const receipt = await c.payments.verify({
                paymentId: intent.paymentId,
                expectedAmount: 9900,
                currency: 'KRW',
                description: 'Monthly box',
            })
            assert.match(receipt.receiptUrl, /^\/r\/\d{4}-\d{4}-\d{4}\?t=\w+$/)

            const res = await c.payments.handleReceiptRequest(
                new Request(`http://localhost:3000${receipt.receiptUrl}`)
            )
            const html = await res.text()
            assert.equal(res.status, 200)
            assert.match(html, /Monthly box/)
            assert.match(html, /₩9,900/)

            const wrong = await c.payments.handleReceiptRequest(
                new Request(`http://localhost:3000/r/${receipt.receiptNumber}?t=nope`)
            )
            assert.equal(wrong.status, 404)
        } finally {
            await mock.close()
        }
    })
})
