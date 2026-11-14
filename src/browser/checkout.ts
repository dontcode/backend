import type { PaymentLanguage, PaymentMethod, RequestPaymentResult } from '../types'

/**
 * The browser's half of a checkout: open the payment window for the intent
 * your server got from `client.payments.requestPayment`, then send the
 * paymentId back to your server to `verify`. It loads PortOne's browser SDK
 * from PortOne's own address the first time it is needed (what
 * @portone/browser-sdk does), so your app installs nothing more. The request
 * is the one @dontcode/payments' checkout makes (src/client/use-payment.ts and
 * paypal-button.tsx): change them together.
 */

const PORTONE_SDK_URL = 'https://cdn.portone.io/v2/browser-sdk.js'

interface PortOneResponse {
    code?: string
    message?: string
    paymentId?: string
    txId?: string
}

interface PortOneSdk {
    requestPayment(request: Record<string, unknown>): Promise<PortOneResponse | undefined>
    loadPaymentUI(
        request: Record<string, unknown>,
        callbacks: {
            onPaymentSuccess: (response: PortOneResponse) => void
            onPaymentFail: (error: { code?: string; message?: string }) => void
        }
    ): Promise<void>
    updateLoadPaymentUIRequest(request: Record<string, unknown>): Promise<void>
}

let loading: Promise<PortOneSdk> | null = null

function loadPortOne(): Promise<PortOneSdk> {
    if (loading) return loading
    loading = new Promise<PortOneSdk>((resolve, reject) => {
        const ready = (window as unknown as { PortOne?: PortOneSdk }).PortOne
        if (ready) return resolve(ready)
        const script =
            document.querySelector<HTMLScriptElement>(`script[src="${PORTONE_SDK_URL}"]`) ??
            (() => {
                const el = document.createElement('script')
                el.src = PORTONE_SDK_URL
                ;(document.head ?? document.body).appendChild(el)
                return el
            })()
        script.addEventListener('load', () => {
            const sdk = (window as unknown as { PortOne?: PortOneSdk }).PortOne
            if (sdk) resolve(sdk)
            else reject(new Error('The payment window could not load'))
        })
        script.addEventListener('error', () =>
            reject(new Error('The payment window could not load'))
        )
    }).catch((err) => {
        loading = null
        throw err
    })
    return loading
}

/** A payment that did not go through: the buyer closed the window, or the provider refused. */
export class PaymentWindowError extends Error {
    /** PortOne's code (`FAILURE_TYPE_PG`, a user cancel...), when it gave one. */
    readonly code?: string
    constructor(message: string, code?: string) {
        super(message)
        this.name = 'PaymentWindowError'
        this.code = code
    }
}

export interface CheckoutOrder {
    /** The same amount and item your server asked the intent for. */
    amount: number
    itemName: string
    method: Exclude<PaymentMethod, 'paypal'>
    /** Required for a currency other than KRW. */
    customerName?: string
    customerEmail?: string
    /** The window's language: 'ko' (default), 'en', 'zh' or 'ja'. */
    locale?: PaymentLanguage
    /**
     * Where a phone comes back after paying: the payment company's page
     * replaces yours there, so this promise never answers. PortOne adds
     * `?paymentId=…&code=…`; verify it on that page's server. Default: this page.
     */
    redirectUrl?: string
}

const EASY_PAY: Partial<Record<PaymentMethod, string>> = {
    kakaopay: 'KAKAOPAY',
    tosspay: 'TOSSPAY',
    naverpay: 'NAVERPAY',
    samsungpay: 'SAMSUNGPAY',
    applepay: 'APPLEPAY',
    payco: 'PAYCO',
}

const LOCALES: Partial<Record<PaymentLanguage, string>> = { en: 'EN_US', zh: 'ZH_CN', ja: 'JA_JP' }

function payMethodOf(method: PaymentMethod): Record<string, unknown> {
    if (method === 'card') return { payMethod: 'CARD' }
    if (method === 'transfer') return { payMethod: 'TRANSFER' }
    const provider = EASY_PAY[method]
    if (provider) return { payMethod: 'EASY_PAY', easyPay: { easyPayProvider: provider } }
    throw new Error(`${method} pays through renderPayPal`)
}

function customerOf(order: { customerName?: string; customerEmail?: string }) {
    const customer = {
        ...(order.customerName ? { fullName: order.customerName } : {}),
        ...(order.customerEmail ? { email: order.customerEmail } : {}),
    }
    return Object.keys(customer).length > 0 ? { customer } : {}
}

/**
 * Open the payment window for an intent and wait for the buyer. Answers the
 * paymentId to `verify` on your server; throws PaymentWindowError when the
 * buyer closes it or the provider refuses.
 */
export async function pay(
    intent: RequestPaymentResult,
    order: CheckoutOrder
): Promise<{ paymentId: string }> {
    const sdk = await loadPortOne()
    const response = await sdk.requestPayment({
        storeId: intent.storeId,
        channelKey: intent.channelKey,
        paymentId: intent.paymentId,
        orderName: order.itemName,
        totalAmount: order.amount,
        currency: intent.currency || 'KRW',
        ...payMethodOf(order.method),
        ...(order.locale && LOCALES[order.locale] ? { locale: LOCALES[order.locale] } : {}),
        ...customerOf(order),
        redirectUrl: order.redirectUrl ?? window.location.href,
    })
    if (!response || response.code) {
        throw new PaymentWindowError(
            response?.message ?? 'The payment was cancelled or did not go through',
            response?.code
        )
    }
    return { paymentId: response.paymentId || intent.paymentId }
}

export interface PayPalOrder {
    amount: number
    itemName: string
    customerName?: string
    customerEmail?: string
}

export interface PayPalCallbacks {
    /** PayPal approved it: send the paymentId to your server to `verify`. */
    onApprove: (paymentId: string) => void
    onError?: (error: PaymentWindowError) => void
}

/**
 * Draw PayPal's own button into `container` for an intent your server asked
 * with method 'paypal'. `update` hands PayPal a changed order without
 * redrawing; PayPal can hold a payment for review, so `verify` may answer
 * 'pending'.
 */
export async function renderPayPal(
    container: HTMLElement,
    intent: RequestPaymentResult,
    order: PayPalOrder,
    callbacks: PayPalCallbacks
): Promise<{ update: (order: PayPalOrder) => Promise<void> }> {
    // PortOne draws into the element carrying this class.
    container.classList.add('portone-ui-container')
    const request = (o: PayPalOrder) => ({
        uiType: 'PAYPAL_SPB',
        storeId: intent.storeId,
        channelKey: intent.channelKey,
        paymentId: intent.paymentId,
        orderName: o.itemName,
        totalAmount: o.amount,
        currency: intent.currency,
        ...customerOf(o),
    })
    const sdk = await loadPortOne()
    await sdk.loadPaymentUI(request(order), {
        onPaymentSuccess: (response) => callbacks.onApprove(response.paymentId || intent.paymentId),
        onPaymentFail: (err) =>
            callbacks.onError?.(
                new PaymentWindowError(err.message ?? 'PayPal could not take the payment', err.code)
            ),
    })
    return { update: (next) => sdk.updateLoadPaymentUIRequest(request(next)) }
}
