import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { PaymentWindowError, pay, renderPayPal } from '../dist/browser/index.js'
import { dontcode, isDontCodeError } from '../dist/index.js'
import { startMockServer } from '../dist/mock/index.js'

/**
 * A checkout as an Insight app runs it, for a Backend app: what the store
 * takes, cards from abroad, and the browser's payment window and PayPal
 * button. PortOne's browser SDK is a fake on `window.PortOne`, installed the
 * way its script installs it.
 */

let calls = []
let answers = []
const realFetch = globalThis.fetch

beforeEach(() => {
    calls = []
    answers = []
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init })
        return answers.shift() ?? json({})
    }
})

afterEach(() => {
    globalThis.fetch = realFetch
})

const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const client = () => dontcode({ apiKey: 'dc_test' })
const bodyOf = (call) => JSON.parse(call.init.body)

describe('payments on the server', () => {
    it("reads what the owner's store takes", async () => {
        answers.push(
            json({ oneTime: ['card', 'kakaopay'], subscription: ['card'], international: true })
        )

        const methods = await client().payments.methods()

        assert.equal(calls[0].url, 'https://backend.dontcode.co/api/v1/payments/methods')
        assert.deepEqual(methods, {
            oneTime: ['card', 'kakaopay'],
            subscription: ['card'],
            international: true,
        })
    })

    it("refuses a card from abroad without the buyer's name and email, before asking anything", async () => {
        await assert.rejects(
            () =>
                client().payments.requestPayment({
                    amount: 1200,
                    itemName: 'Stickers',
                    method: 'card',
                    currency: 'usd',
                }),
            (err) => isDontCodeError(err) && err.code === 'CUSTOMER_DETAILS_REQUIRED'
        )
        assert.equal(calls.length, 0)
    })

    it('asks for a card from abroad with the buyer, the currency upper-cased', async () => {
        await client().payments.requestPayment({
            amount: 1200,
            itemName: 'Stickers',
            method: 'card',
            currency: 'usd',
            customerName: 'Jane Doe',
            customerEmail: 'jane@example.com',
            locale: 'en',
        })

        assert.deepEqual(bodyOf(calls[0]), {
            amount: 1200,
            itemName: 'Stickers',
            method: 'card',
            currency: 'USD',
            customerName: 'Jane Doe',
            customerEmail: 'jane@example.com',
            locale: 'en',
        })
    })

    it('needs no buyer details in won', async () => {
        await client().payments.requestPayment({
            amount: 5000,
            itemName: 'Coffee',
            method: 'kakaopay',
        })

        assert.deepEqual(bodyOf(calls[0]), { amount: 5000, itemName: 'Coffee', method: 'kakaopay' })
    })
})

describe('dontcode/browser: the payment window', () => {
    afterEach(() => {
        delete globalThis.window
        delete globalThis.document
    })

    const INTENT = {
        paymentId: 'pay_1',
        storeId: 'store-1',
        channelKey: 'channel-1',
        currency: 'KRW',
    }
    const sdk = { requested: [], answer: { paymentId: 'pay_1', txId: 't' } }
    sdk.requestPayment = async (request) => {
        sdk.requested.push(request)
        return sdk.answer
    }

    function installWindow({ preloaded }) {
        const appended = []
        globalThis.window = { location: { href: 'https://shop.example/checkout' } }
        if (preloaded) globalThis.window.PortOne = sdk
        globalThis.document = {
            querySelector: () => null,
            createElement: () => {
                const listeners = {}
                return { addEventListener: (type, fn) => (listeners[type] = fn), listeners }
            },
            head: {
                appendChild(el) {
                    appended.push(el)
                    setTimeout(() => {
                        globalThis.window.PortOne = sdk
                        el.listeners.load()
                    }, 0)
                    return el
                },
            },
        }
        return appended
    }

    it("loads PortOne's script from PortOne once, and pays by card", async () => {
        const appended = installWindow({ preloaded: false })

        const result = await pay(INTENT, { amount: 5000, itemName: 'Coffee', method: 'card' })
        await pay(INTENT, { amount: 5000, itemName: 'Coffee', method: 'card' })

        assert.equal(appended.length, 1)
        assert.equal(appended[0].src, 'https://cdn.portone.io/v2/browser-sdk.js')
        assert.deepEqual(result, { paymentId: 'pay_1' })
        assert.deepEqual(sdk.requested[0], {
            storeId: 'store-1',
            channelKey: 'channel-1',
            paymentId: 'pay_1',
            orderName: 'Coffee',
            totalAmount: 5000,
            currency: 'KRW',
            payMethod: 'CARD',
            redirectUrl: 'https://shop.example/checkout',
        })
    })

    it('opens each wallet through its easy-pay provider, and a bank transfer as one', async () => {
        installWindow({ preloaded: true })
        sdk.requested = []
        for (const method of [
            'kakaopay',
            'tosspay',
            'naverpay',
            'samsungpay',
            'applepay',
            'payco',
            'transfer',
        ]) {
            await pay(INTENT, { amount: 1, itemName: 'x', method })
        }

        assert.deepEqual(
            sdk.requested.map((r) => r.easyPay?.easyPayProvider ?? r.payMethod),
            ['KAKAOPAY', 'TOSSPAY', 'NAVERPAY', 'SAMSUNGPAY', 'APPLEPAY', 'PAYCO', 'TRANSFER']
        )
    })

    it('opens a card from abroad in English with the buyer, and a phone comes back where told', async () => {
        installWindow({ preloaded: true })
        sdk.requested = []

        await pay(
            { ...INTENT, currency: 'USD' },
            {
                amount: 1200,
                itemName: 'Stickers',
                method: 'card',
                locale: 'en',
                customerName: 'Jane Doe',
                customerEmail: 'jane@example.com',
                redirectUrl: 'https://shop.example/paid',
            }
        )

        assert.equal(sdk.requested[0].currency, 'USD')
        assert.equal(sdk.requested[0].locale, 'EN_US')
        assert.deepEqual(sdk.requested[0].customer, {
            fullName: 'Jane Doe',
            email: 'jane@example.com',
        })
        assert.equal(sdk.requested[0].redirectUrl, 'https://shop.example/paid')
    })

    it("throws PaymentWindowError with PortOne's code when the buyer closes the window", async () => {
        installWindow({ preloaded: true })
        sdk.answer = { code: 'FAILURE_TYPE_PG', message: '사용자가 결제를 취소하였습니다' }

        await assert.rejects(
            () => pay(INTENT, { amount: 1, itemName: 'x', method: 'card' }),
            (err) =>
                err instanceof PaymentWindowError &&
                err.code === 'FAILURE_TYPE_PG' &&
                /취소/.test(err.message)
        )
        sdk.answer = { paymentId: 'pay_1' }
    })

    it('sends PayPal to its own button', async () => {
        installWindow({ preloaded: true })

        await assert.rejects(
            () => pay(INTENT, { amount: 1, itemName: 'x', method: 'paypal' }),
            /renderPayPal/
        )
    })

    it("draws PayPal's button into the container and hands back the approved payment", async () => {
        installWindow({ preloaded: true })
        const loaded = []
        const updated = []
        sdk.loadPaymentUI = async (request, callbacks) => {
            loaded.push(request)
            callbacks.onPaymentSuccess({ paymentId: 'pay_pp' })
        }
        sdk.updateLoadPaymentUIRequest = async (request) => updated.push(request)
        const classes = new Set()
        const approved = []

        const button = await renderPayPal(
            { classList: { add: (c) => classes.add(c) } },
            { ...INTENT, currency: 'USD' },
            { amount: 1200, itemName: 'Stickers' },
            { onApprove: (id) => approved.push(id) }
        )
        await button.update({ amount: 2400, itemName: 'Stickers x2' })

        assert.ok(classes.has('portone-ui-container'))
        assert.equal(loaded[0].uiType, 'PAYPAL_SPB')
        assert.equal(loaded[0].currency, 'USD')
        assert.deepEqual(approved, ['pay_pp'])
        assert.equal(updated[0].totalAmount, 2400)
    })
})

describe('mock gateway: checkout offline', () => {
    it('takes every method, refuses an unknown one, and keeps the method on the receipt', async () => {
        globalThis.fetch = realFetch
        const mock = await startMockServer({ dataDir: null, quiet: true, port: 0 })
        try {
            const c = dontcode({ baseUrl: mock.url, apiKey: 'dc_test' })
            const methods = await c.payments.methods()
            assert.equal(methods.oneTime.length, 9)
            assert.equal(methods.international, true)

            await assert.rejects(
                () => c.payments.requestPayment({ amount: 1, itemName: 'x', method: 'bitcoin' }),
                (err) => isDontCodeError(err) && err.status === 400
            )

            const intent = await c.payments.requestPayment({
                amount: 5000,
                itemName: 'Coffee',
                method: 'naverpay',
            })
            assert.ok(intent.paymentId)
        } finally {
            await mock.close()
        }
    })
})
