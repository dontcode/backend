import { DontCodeError, isDontCodeError } from './errors'
import { Transport } from './http'
import {
    RECEIPT_NUMBER_PATTERN,
    RECEIPT_TOKEN_PATTERN,
    RECEIPT_WORDS,
    htmlResponse,
    isReceiptView,
    messagePage,
    receiptNonce,
    renderReceiptPage,
    requestLang,
} from './receipt-page'
import type {
    BillingPlan,
    CheckoutMethods,
    ClientReceiptView,
    Feature,
    FeatureInput,
    PaymentReceipt,
    Plan,
    PlanFeature,
    PlanInput,
    RefundInput,
    RefundResult,
    RequestPaymentInput,
    RequestPaymentResult,
    ReserveSubscriptionResult,
    Subscription,
    SubscriptionFilters,
    SubscriptionMethod,
    SubscriptionStatus,
    UserFeature,
    VerifyPaymentInput,
} from './types'
import type { ForVisitor } from './visitor'

const PAYMENTS_PATH = '/api/v1/payments'

const enc = (value: string) => encodeURIComponent(value)

/**
 * Payments: a typed proxy over `/api/v1/payments`. This is the server control
 * plane. You verify a charge the customer completed in the browser, drive the
 * subscription lifecycle, manage a plan/feature catalog, and check who is
 * entitled to what. Every call is scoped to your project by the API key, and
 * you pass the acting `userId` explicitly, so run these from your server, never
 * the browser.
 *
 * ```ts
 * // after the customer completes the provider popup
 * const receipt = await client.payments.verify({ paymentId, expectedAmount: 9900, currency: 'KRW' })
 *
 * // gate a paid feature
 * if (await client.payments.hasFeature(userId, 'export_pdf')) { … }
 * ```
 */
export class PaymentsApi {
    constructor(private readonly transport: Transport) {}

    // --- one-time payments --------------------------------------------------

    /**
     * What the owner's store takes right now: show only these methods. A
     * method the store has not connected is refused (`CHANNEL_NOT_CONNECTED`).
     */
    methods(): Promise<CheckoutMethods> {
        return this.transport.json<CheckoutMethods>(`${PAYMENTS_PATH}/methods`, {})
    }

    /**
     * One-shot charge, step 1: create a payment intent and get the popup
     * config (paymentId + storeId/channelKey). The browser opens the payment
     * window with it (`pay` from `dontcode/browser`, or `renderPayPal` for
     * PayPal); `verify` it afterwards. The gateway owns the provider
     * relationship, so the app never configures PortOne itself.
     *
     * A currency other than KRW needs the buyer's `customerName` and
     * `customerEmail`, which the card processors require: without both this
     * is refused before anything is asked (`CUSTOMER_DETAILS_REQUIRED`).
     */
    requestPayment(params: RequestPaymentInput): Promise<RequestPaymentResult> {
        const currency = (params.currency ?? 'KRW').trim().toUpperCase()
        if (currency !== 'KRW' && (!params.customerName?.trim() || !params.customerEmail?.trim())) {
            return Promise.reject(
                new DontCodeError(400, {
                    error: "International payments need the buyer's name and email",
                    code: 'CUSTOMER_DETAILS_REQUIRED',
                })
            )
        }
        return this.transport.json<RequestPaymentResult>(`${PAYMENTS_PATH}/request-payment`, {
            ...params,
            ...(params.currency ? { currency } : {}),
        })
    }

    /**
     * Verify and record a charge the customer just completed, and email the
     * buyer their receipt. Grant nothing before it answers `status: 'paid'`.
     */
    async verify(params: VerifyPaymentInput): Promise<PaymentReceipt> {
        const r = await this.transport.json<{ receipt: PaymentReceipt }>(
            `${PAYMENTS_PATH}/verify`,
            params
        )
        return r.receipt
    }

    /**
     * One buyer's receipt by its number and token, the pair in the link of
     * their receipt email. Null when there is no such receipt for that token.
     * Pass the request you are answering so the read limit counts that buyer.
     */
    async receipt(
        number: string,
        token: string,
        options: ForVisitor = {}
    ): Promise<ClientReceiptView | null> {
        if (!RECEIPT_NUMBER_PATTERN.test(number) || !RECEIPT_TOKEN_PATTERN.test(token)) return null
        try {
            return await this.transport.get<ClientReceiptView>(
                `${PAYMENTS_PATH}/receipts/${enc(number)}?t=${enc(token)}`,
                { request: options.request }
            )
        } catch (err) {
            if (isDontCodeError(err) && err.status === 404) return null
            throw err
        }
    }

    /**
     * The buyer's receipt page. Every receipt email links to
     * `/r/<number>?t=<token>` on your app's primary domain: mount this there
     * (a Next route handler `src/app/r/[number]/route.ts`:
     * `export const GET = (req: Request) => client.payments.handleReceiptRequest(req)`).
     * It answers one printable HTML page in the receipt's language, a 404 page
     * for a wrong number or token, or a page saying it cannot be shown right
     * now. The number is the URL's last segment unless you pass it.
     */
    async handleReceiptRequest(request: Request, number?: string): Promise<Response> {
        const nonce = receiptNonce()
        const url = new URL(request.url)
        let wanted = number
        if (wanted === undefined) {
            try {
                wanted = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '')
            } catch {
                wanted = ''
            }
        }
        const token = url.searchParams.get('t') ?? ''
        const lang = requestLang(request)
        const words = RECEIPT_WORDS[lang]
        const notFound = () =>
            htmlResponse(
                messagePage(lang, nonce, words.notFoundTitle, words.notFoundBody),
                404,
                nonce
            )
        const unavailable = (status: number) =>
            htmlResponse(
                messagePage(lang, nonce, words.unavailableTitle, words.unavailableBody),
                status,
                nonce
            )

        let view: ClientReceiptView | null
        try {
            view = await this.receipt(wanted, token, { request })
        } catch (err) {
            console.error('[dontcode] receipt read failed:', err)
            return unavailable(isDontCodeError(err) && err.status === 503 ? 503 : 502)
        }
        if (!view) return notFound()
        if (!isReceiptView(view)) return unavailable(502)
        return htmlResponse(renderReceiptPage(view, nonce), 200, nonce)
    }

    /** Refund a payment, fully (omit `amount`) or partially. Idempotent. */
    async refund(params: RefundInput): Promise<RefundResult> {
        // The wire uses snake_case `already_refunded`; normalize to the SDK's shape.
        const d = await this.transport.json<Record<string, unknown>>(
            `${PAYMENTS_PATH}/refund`,
            params
        )
        return {
            paymentId: d.paymentId as string,
            refundedAmount: d.refundedAmount as number,
            cumulativeRefunded: (d.cumulativeRefunded as number) ?? (d.refundedAmount as number),
            originalAmount: (d.originalAmount as number) ?? (d.refundedAmount as number),
            status: d.status as RefundResult['status'],
            alreadyRefunded: (d.already_refunded as boolean | undefined) ?? false,
            reconciled: (d.reconciled as boolean | undefined) ?? false,
        }
    }

    // --- subscriptions: starting -------------------------------------------

    /** Create and activate a subscription in one call (you hold a billing key). */
    async createSubscription(params: {
        plan: BillingPlan
        userId: string
        method: SubscriptionMethod
        billingKey: string
    }): Promise<Subscription> {
        const r = await this.transport.json<{ subscription: Subscription }>(
            `${PAYMENTS_PATH}/subscribe`,
            params
        )
        return r.subscription
    }

    /** Split flow, step 1: reserve a subscription and get the popup config. */
    reserveSubscription(params: {
        plan: BillingPlan
        userId: string
        method: SubscriptionMethod
    }): Promise<ReserveSubscriptionResult> {
        return this.transport
            .json<{
                subscription_id: string
                storeId: string
                channelKey: string
                billingKeyMethod: 'CARD' | 'EASY_PAY'
            }>(`${PAYMENTS_PATH}/subscribe-reserve`, params)
            .then((r) => ({
                subscriptionId: r.subscription_id,
                storeId: r.storeId,
                channelKey: r.channelKey,
                billingKeyMethod: r.billingKeyMethod,
            }))
    }

    /** Split flow, step 2: persist the billing key and activate. Idempotent. */
    async confirmSubscription(params: {
        subscriptionId: string
        billingKey: string
    }): Promise<Subscription> {
        const r = await this.transport.json<{ subscription: Subscription }>(
            `${PAYMENTS_PATH}/subscribe-confirm`,
            { subscription_id: params.subscriptionId, billing_key: params.billingKey }
        )
        return r.subscription
    }

    /** Split flow: cancel a reserved subscription whose popup was dismissed. */
    async abortSubscription(params: { subscriptionId: string }): Promise<void> {
        await this.transport.json<unknown>(`${PAYMENTS_PATH}/subscribe-abort`, {
            subscription_id: params.subscriptionId,
        })
    }

    // --- subscriptions: lifecycle ------------------------------------------

    /** Cancel a subscription. Soft cancel by default (access through period end). */
    async cancelSubscription(
        subscription: Subscription,
        options: { atPeriodEnd?: boolean } = {}
    ): Promise<Subscription> {
        const r = await this.transport.json<{ subscription: Subscription }>(
            `${PAYMENTS_PATH}/cancel-subscription`,
            { subscription, atPeriodEnd: options.atPeriodEnd ?? true }
        )
        return r.subscription
    }

    /** Manually transition a subscription's status. */
    async updateSubscriptionStatus(
        subscription: Subscription,
        status: SubscriptionStatus
    ): Promise<Subscription> {
        const r = await this.transport.json<{ subscription: Subscription }>(
            `${PAYMENTS_PATH}/update-subscription-status`,
            { subscription, status }
        )
        return r.subscription
    }

    /** Trigger an off-cycle charge. Renewals run automatically; you rarely need this. */
    async chargeSubscription(params: {
        subscription: Subscription
        plan: BillingPlan
    }): Promise<PaymentReceipt> {
        const r = await this.transport.json<{ receipt: PaymentReceipt }>(
            `${PAYMENTS_PATH}/charge-subscription`,
            params
        )
        return r.receipt
    }

    // --- subscriptions: reads ----------------------------------------------

    /** The first live subscription for a user, or `null`. */
    async getSubscription(userId: string): Promise<Subscription | null> {
        const r = await this.transport.json<{ subscription: Subscription | null }>(
            `${PAYMENTS_PATH}/get-subscription`,
            { userId }
        )
        return r.subscription ?? null
    }

    /** A subscription by id, or `null`. */
    async getSubscriptionById(subscriptionId: string): Promise<Subscription | null> {
        const r = await this.transport.json<{ subscription: Subscription | null }>(
            `${PAYMENTS_PATH}/get-subscription`,
            { subscriptionId }
        )
        return r.subscription ?? null
    }

    /** Every live subscription a user holds (multi-subscription is supported). */
    async listActiveSubscriptions(userId: string): Promise<Subscription[]> {
        const r = await this.transport.json<{ subscriptions: Subscription[] | null }>(
            `${PAYMENTS_PATH}/list-active-subscriptions`,
            { userId }
        )
        return r.subscriptions ?? []
    }

    /** Whether a user has an active subscription, optionally scoped to a plan. */
    async hasActiveSubscription(userId: string, planId?: string): Promise<boolean> {
        const active = (await this.listActiveSubscriptions(userId)).filter(
            (s) => s.status === 'active'
        )
        return planId ? active.some((s) => s.planId === planId) : active.length > 0
    }

    // --- entitlements -------------------------------------------------------

    /** Whether a user's active subscriptions grant `featureKey`. */
    async hasFeature(userId: string, featureKey: string): Promise<boolean> {
        const r = await this.transport.json<{ ok: boolean }>(`${PAYMENTS_PATH}/has-feature`, {
            userId,
            featureKey,
        })
        return r.ok ?? false
    }

    /** Every feature a user is entitled to via their active subscriptions. */
    async listUserFeatures(userId: string): Promise<UserFeature[]> {
        const r = await this.transport.json<{ features: UserFeature[] | null }>(
            `${PAYMENTS_PATH}/list-user-features`,
            { userId }
        )
        return r.features ?? []
    }

    // --- plan + feature catalog --------------------------------------------

    /** List the project's plans. Pass `includeInactive` to see disabled ones. */
    async listPlans(options: { includeInactive?: boolean } = {}): Promise<Plan[]> {
        const qs = options.includeInactive ? '?includeInactive=true' : ''
        const r = await this.transport.get<{ plans: Plan[] | null }>(`${PAYMENTS_PATH}/plans${qs}`)
        return r.plans ?? []
    }

    /** A single plan by its stable `planId`, or `null`. */
    async getPlan(planId: string): Promise<Plan | null> {
        const plans = await this.listPlans({ includeInactive: true })
        return plans.find((p) => p.planId === planId) ?? null
    }

    /** Create or upsert plans. */
    async definePlans(plans: PlanInput[]): Promise<Plan[]> {
        const r = await this.transport.json<{ plans: Plan[] | null }>(`${PAYMENTS_PATH}/plans`, {
            plans,
        })
        return r.plans ?? []
    }

    /** Enable or disable a plan. */
    async setPlanActive(planId: string, active: boolean): Promise<void> {
        await this.transport.patch<unknown>(`${PAYMENTS_PATH}/plans`, { planId, active })
    }

    /** Delete a plan. */
    async deletePlan(planId: string): Promise<void> {
        await this.transport.del<unknown>(`${PAYMENTS_PATH}/plans?planId=${enc(planId)}`)
    }

    /** List the project's feature catalog. */
    async listFeatures(): Promise<Feature[]> {
        const r = await this.transport.get<{ features: Feature[] | null }>(
            `${PAYMENTS_PATH}/features`
        )
        return r.features ?? []
    }

    /** Create or upsert features. */
    async defineFeatures(features: FeatureInput[]): Promise<Feature[]> {
        const r = await this.transport.json<{ features: Feature[] | null }>(
            `${PAYMENTS_PATH}/features`,
            { features }
        )
        return r.features ?? []
    }

    /** Delete a feature. */
    async deleteFeature(featureKey: string): Promise<void> {
        await this.transport.del<unknown>(`${PAYMENTS_PATH}/features?featureKey=${enc(featureKey)}`)
    }

    /** Features assigned to a plan, with per-plan metadata/limits. */
    async listPlanFeatures(planId: string): Promise<PlanFeature[]> {
        const r = await this.transport.get<{ planFeatures: PlanFeature[] | null }>(
            `${PAYMENTS_PATH}/plan-features?planId=${enc(planId)}`
        )
        return r.planFeatures ?? []
    }

    /** Replace the entire feature set assigned to a plan. Pass `[]` to clear. */
    async setPlanFeatures(
        planId: string,
        features: { feature_key: string; metadata?: Record<string, unknown> }[]
    ): Promise<void> {
        await this.transport.put<unknown>(`${PAYMENTS_PATH}/plan-features`, { planId, features })
    }

    // --- admin --------------------------------------------------------------

    /** List subscriptions across all users in the project, with filters. */
    async listSubscriptions(
        filters: SubscriptionFilters = {}
    ): Promise<{ subscriptions: Subscription[]; total: number }> {
        const r = await this.transport.json<{
            subscriptions: Subscription[] | null
            total: number
        }>(`${PAYMENTS_PATH}/admin/list-subscriptions`, filters)
        return { subscriptions: r.subscriptions ?? [], total: r.total ?? 0 }
    }

    /** Comp a subscription without a payment (no auto-renewal). */
    async grantSubscription(params: {
        userId: string
        planId: string
        periodStart?: string
        periodEnd?: string
    }): Promise<Subscription> {
        const r = await this.transport.json<{ subscription: Subscription }>(
            `${PAYMENTS_PATH}/admin/grant-subscription`,
            params
        )
        return r.subscription
    }
}

export function createPayments(transport: Transport): PaymentsApi {
    return new PaymentsApi(transport)
}
