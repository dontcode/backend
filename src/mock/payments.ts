/**
 * Payments for the mock gateway — the server half of `client.payments`.
 *
 * Production settles real money through a payment provider and a hosted
 * payments service; none of that can (or should) run offline. So the mock is a
 * faithful *behavioural* stand-in: an in-memory plan/feature catalog, a
 * subscription store, and recorded charges, wired so the exact `/api/v1/payments`
 * wire shapes the SDK expects come back. It lets you build and test subscription
 * gating, entitlement checks, and the catalog locally without a provider.
 *
 * What it does NOT do: talk to a real PG, open a real billing popup, or verify a
 * real charge. `verify` trusts the `paymentId` you hand it and records a paid
 * receipt; `subscribe-reserve` returns placeholder `storeId`/`channelKey`. The
 * split flow still round-trips (reserve → confirm), it just never leaves memory.
 *
 * Entitlement resolves a user's active subscriptions to feature keys via the
 * plan/feature map, matching `subscription.planId` against the catalog `planId`.
 * Seed the catalog with `definePlans` / `defineFeatures` / `setPlanFeatures` (or
 * grant a comp subscription with `admin/grant-subscription`) and the gates work.
 *
 * The wire protocol is `/api/v1/payments/...` (see src/payments.ts for the
 * client); every operation is the last path segment(s), e.g. `verify`,
 * `admin/grant-subscription`, `plans`.
 */
import type {
    BillingInterval,
    Feature,
    FeatureInput,
    PaymentMethod,
    PaymentReceipt,
    Plan,
    PlanInput,
    Subscription,
    SubscriptionStatus,
    UserFeature,
} from '../types'
import { randomUUID } from 'node:crypto'

/** Subscription statuses that count as "live" (exist + not cancelled). */
const LIVE_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
    'trialing',
    'active',
    'past_due',
    'paused',
])

const MOCK_PROJECT_ID = 'mock-project'

interface PlanFeatureLink {
    feature_key: string
    metadata?: Record<string, unknown>
}

interface PaymentRecord {
    id: string
    amount: number
    currency: string
    method: PaymentMethod
    userId: string
    status: 'paid' | 'refunded' | 'partially_refunded'
    refundedAmount: number
    paidAt: string
}

/** The full mock payments state, for optional disk persistence. */
export interface PaymentsSnapshot {
    plans: Plan[]
    features: Feature[]
    planFeatures: Record<string, PlanFeatureLink[]>
    subscriptions: Subscription[]
    payments: PaymentRecord[]
}

export interface MockPayments {
    /** Route a `/api/v1/payments/...` request. */
    handle(method: string, url: URL, raw: Buffer): { status: number; body: unknown }
}

type Result = { status: number; body: unknown }

export function createMockPayments(opts?: {
    /** Load the persisted snapshot on boot (returns `null` for a fresh start). */
    load?: () => PaymentsSnapshot | null
    /** Persist the snapshot after every mutation. */
    save?: (snapshot: PaymentsSnapshot) => void
}): MockPayments {
    const plans = new Map<string, Plan>() // keyed by planId
    const features = new Map<string, Feature>() // keyed by featureKey
    const planFeatures = new Map<string, PlanFeatureLink[]>() // keyed by planId
    const subscriptions = new Map<string, Subscription>() // keyed by id
    const payments = new Map<string, PaymentRecord>() // keyed by paymentId

    // ── hydrate from disk ───────────────────────────────────────────────────
    const initial = opts?.load?.() ?? null
    if (initial) {
        for (const p of initial.plans ?? []) plans.set(p.planId, p)
        for (const f of initial.features ?? []) features.set(f.featureKey, f)
        for (const [k, v] of Object.entries(initial.planFeatures ?? {})) planFeatures.set(k, v)
        for (const s of initial.subscriptions ?? []) subscriptions.set(s.id, s)
        for (const r of initial.payments ?? []) payments.set(r.id, r)
    }

    const persist = () => {
        opts?.save?.({
            plans: [...plans.values()],
            features: [...features.values()],
            planFeatures: Object.fromEntries(planFeatures),
            subscriptions: [...subscriptions.values()],
            payments: [...payments.values()],
        })
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    const now = () => new Date().toISOString()

    function addInterval(fromIso: string, interval: BillingInterval): string {
        const d = new Date(fromIso)
        if (interval === 'weekly') d.setDate(d.getDate() + 7)
        else if (interval === 'yearly') d.setFullYear(d.getFullYear() + 1)
        else d.setMonth(d.getMonth() + 1)
        return d.toISOString()
    }

    /** The billing key is a secret; blank it on every read, as production does. */
    const readSub = (s: Subscription): Subscription => ({ ...s, billingKey: '' })

    function makeSubscription(input: {
        userId: string
        planId: string
        method?: PaymentMethod
        billingKey?: string
        status: SubscriptionStatus
        interval?: BillingInterval
    }): Subscription {
        const start = now()
        const end = addInterval(start, input.interval ?? 'monthly')
        return {
            id: `sub_${randomUUID()}`,
            planId: input.planId,
            userId: input.userId,
            method: input.method ?? 'card',
            billingKey: input.billingKey ?? '',
            status: input.status,
            currentPeriodStart: start,
            currentPeriodEnd: end,
            nextBillingAt: end,
            cancelAtPeriodEnd: false,
            createdAt: start,
        }
    }

    const activeSubs = (userId: string): Subscription[] =>
        [...subscriptions.values()].filter((s) => s.userId === userId && s.status === 'active')

    const liveSubs = (userId: string): Subscription[] =>
        [...subscriptions.values()].filter((s) => s.userId === userId && LIVE_STATUSES.has(s.status))

    function userFeatures(userId: string): UserFeature[] {
        const byKey = new Map<
            string,
            { grantedByPlanIds: Set<string>; metadata: Record<string, unknown> }
        >()
        for (const sub of activeSubs(userId)) {
            for (const link of planFeatures.get(sub.planId) ?? []) {
                const entry = byKey.get(link.feature_key) ?? {
                    grantedByPlanIds: new Set<string>(),
                    metadata: link.metadata ?? {},
                }
                entry.grantedByPlanIds.add(sub.planId)
                byKey.set(link.feature_key, entry)
            }
        }
        return [...byKey.entries()].map(([featureKey, e]) => {
            const feat = features.get(featureKey)
            return {
                featureKey,
                name: feat?.name ?? featureKey,
                description: feat?.description ?? null,
                grantedByPlanIds: [...e.grantedByPlanIds],
                metadata: e.metadata,
            }
        })
    }

    function makeReceipt(r: PaymentRecord): PaymentReceipt {
        return {
            id: r.id,
            amount: r.amount,
            method: r.method,
            userId: r.userId,
            status: r.status === 'paid' ? 'paid' : 'refunded',
            paidAt: r.paidAt,
            currency: r.currency,
        }
    }

    function toPlan(input: PlanInput, existing: Plan | undefined, order: number): Plan {
        return {
            id: existing?.id ?? `plan_${input.plan_id}`,
            projectId: MOCK_PROJECT_ID,
            planId: input.plan_id,
            name: input.name,
            description: input.description ?? null,
            amount: input.amount,
            currency: input.currency ?? 'KRW',
            interval: input.interval,
            displayOrder: input.display_order ?? existing?.displayOrder ?? order,
            active: input.active ?? existing?.active ?? true,
            metadata: input.metadata ?? existing?.metadata ?? {},
            createdAt: existing?.createdAt ?? now(),
            updatedAt: now(),
        }
    }

    function toFeature(input: FeatureInput, existing: Feature | undefined): Feature {
        return {
            id: existing?.id ?? `feat_${input.feature_key}`,
            projectId: MOCK_PROJECT_ID,
            featureKey: input.feature_key,
            name: input.name,
            description: input.description ?? null,
            metadata: input.metadata ?? existing?.metadata ?? {},
            createdAt: existing?.createdAt ?? now(),
            updatedAt: now(),
        }
    }

    const ok = (body: unknown): Result => ({ status: 200, body })
    const bad = (error: string): Result => ({ status: 400, body: { error } })
    const notFound = (error = 'Not found'): Result => ({ status: 404, body: { error } })

    // ── operations ────────────────────────────────────────────────────────────

    function handle(method: string, url: URL, raw: Buffer): Result {
        // op = everything after `/api/v1/payments`, e.g. `verify`, `admin/grant-subscription`.
        const op = url.pathname.slice('/api/v1/payments'.length).replace(/^\/+/, '')
        const body = parseJson(raw)

        switch (`${method} ${op}`) {
            // ── one-time payments ──────────────────────────────────────────
            case 'POST verify': {
                const paymentId = String(body.paymentId ?? '')
                if (!paymentId) return bad('paymentId is required')
                const existing = payments.get(paymentId)
                if (existing) return ok({ receipt: makeReceipt(existing) }) // idempotent
                const record: PaymentRecord = {
                    id: paymentId,
                    amount: Number(body.expectedAmount ?? 0),
                    currency: typeof body.currency === 'string' ? body.currency : 'KRW',
                    method: 'card',
                    userId: typeof body.userId === 'string' ? body.userId : '',
                    status: 'paid',
                    refundedAmount: 0,
                    paidAt: now(),
                }
                payments.set(paymentId, record)
                persist()
                return ok({ receipt: makeReceipt(record) })
            }

            case 'POST refund': {
                const paymentId = String(body.paymentId ?? '')
                const record = payments.get(paymentId)
                if (!record) return notFound('Payment not found')
                if (record.status === 'refunded') {
                    return ok({
                        paymentId,
                        refundedAmount: record.refundedAmount,
                        cumulativeRefunded: record.refundedAmount,
                        originalAmount: record.amount,
                        status: 'refunded',
                        already_refunded: true,
                    })
                }
                const remaining = record.amount - record.refundedAmount
                const amount =
                    typeof body.amount === 'number' && body.amount > 0
                        ? Math.min(body.amount, remaining)
                        : remaining
                record.refundedAmount += amount
                record.status = record.refundedAmount >= record.amount ? 'refunded' : 'partially_refunded'
                persist()
                return ok({
                    paymentId,
                    refundedAmount: amount,
                    cumulativeRefunded: record.refundedAmount,
                    originalAmount: record.amount,
                    status: record.status,
                    already_refunded: false,
                })
            }

            // ── subscriptions: starting ────────────────────────────────────
            case 'POST subscribe': {
                const plan = body.plan as { id?: string; interval?: BillingInterval } | undefined
                if (!plan?.id) return bad('plan is required')
                const sub = makeSubscription({
                    userId: String(body.userId ?? ''),
                    planId: plan.id,
                    method: body.method as PaymentMethod,
                    billingKey: typeof body.billingKey === 'string' ? body.billingKey : '',
                    status: 'active',
                    interval: plan.interval,
                })
                subscriptions.set(sub.id, sub)
                persist()
                return ok({ subscription: readSub(sub) })
            }

            case 'POST subscribe-reserve': {
                const plan = body.plan as { id?: string; interval?: BillingInterval } | undefined
                if (!plan?.id) return bad('plan is required')
                const method = body.method as PaymentMethod
                const sub = makeSubscription({
                    userId: String(body.userId ?? ''),
                    planId: plan.id,
                    method,
                    status: 'trialing',
                    interval: plan.interval,
                })
                subscriptions.set(sub.id, sub)
                persist()
                return ok({
                    subscription_id: sub.id,
                    storeId: 'store-mock',
                    channelKey: 'channel-mock',
                    billingKeyMethod: method === 'card' ? 'CARD' : 'EASY_PAY',
                })
            }

            case 'POST subscribe-confirm': {
                const sub = subscriptions.get(String(body.subscription_id ?? ''))
                if (!sub) return notFound('Subscription not found')
                if (sub.status === 'active') return ok({ subscription: readSub(sub) }) // idempotent
                sub.billingKey =
                    typeof body.billing_key === 'string' ? body.billing_key : sub.billingKey
                sub.status = 'active'
                persist()
                return ok({ subscription: readSub(sub) })
            }

            case 'POST subscribe-abort': {
                const sub = subscriptions.get(String(body.subscription_id ?? ''))
                if (sub && sub.status === 'trialing' && !sub.billingKey) {
                    subscriptions.delete(sub.id)
                    persist()
                }
                return ok({})
            }

            // ── subscriptions: lifecycle ───────────────────────────────────
            case 'POST cancel-subscription': {
                const target = body.subscription as { id?: string } | undefined
                const sub = target?.id ? subscriptions.get(target.id) : undefined
                if (!sub) return notFound('Subscription not found')
                if (body.atPeriodEnd === false) {
                    sub.status = 'cancelled'
                    sub.cancelledAt = now()
                    sub.billingKey = ''
                } else {
                    sub.cancelAtPeriodEnd = true
                }
                persist()
                return ok({ subscription: readSub(sub) })
            }

            case 'POST update-subscription-status': {
                const target = body.subscription as { id?: string } | undefined
                const sub = target?.id ? subscriptions.get(target.id) : undefined
                if (!sub) return notFound('Subscription not found')
                if (sub.status === 'cancelled') return bad('Cannot change a cancelled subscription')
                sub.status = body.status as SubscriptionStatus
                persist()
                return ok({ subscription: readSub(sub) })
            }

            case 'POST charge-subscription': {
                const target = body.subscription as { id?: string } | undefined
                const plan = body.plan as
                    | { amount?: number; currency?: string; interval?: BillingInterval }
                    | undefined
                const sub = target?.id ? subscriptions.get(target.id) : undefined
                const record: PaymentRecord = {
                    id: `sub_${target?.id ?? randomUUID()}_${Date.parse(now())}`,
                    amount: Number(plan?.amount ?? 0),
                    currency: plan?.currency ?? 'KRW',
                    method: sub?.method ?? 'card',
                    userId: sub?.userId ?? '',
                    status: 'paid',
                    refundedAmount: 0,
                    paidAt: now(),
                }
                payments.set(record.id, record)
                if (sub) {
                    sub.currentPeriodStart = sub.currentPeriodEnd
                    sub.currentPeriodEnd = addInterval(sub.currentPeriodStart, plan?.interval ?? 'monthly')
                    sub.nextBillingAt = sub.currentPeriodEnd
                }
                persist()
                return ok({ receipt: makeReceipt(record) })
            }

            // ── subscriptions: reads ───────────────────────────────────────
            case 'POST get-subscription': {
                if (typeof body.subscriptionId === 'string') {
                    const sub = subscriptions.get(body.subscriptionId)
                    return ok({ subscription: sub ? readSub(sub) : null })
                }
                const first = liveSubs(String(body.userId ?? ''))[0]
                return ok({ subscription: first ? readSub(first) : null })
            }

            case 'POST list-active-subscriptions': {
                const subs = liveSubs(String(body.userId ?? '')).map(readSub)
                return ok({ subscriptions: subs })
            }

            // ── entitlements ───────────────────────────────────────────────
            case 'POST has-feature': {
                const userId = String(body.userId ?? '')
                const featureKey = String(body.featureKey ?? '')
                const granted = userFeatures(userId).some((f) => f.featureKey === featureKey)
                return ok({ ok: granted })
            }

            case 'POST list-user-features':
                return ok({ features: userFeatures(String(body.userId ?? '')) })

            // ── plan catalog ───────────────────────────────────────────────
            case 'GET plans': {
                const includeInactive = url.searchParams.get('includeInactive') === 'true'
                const list = [...plans.values()]
                    .filter((p) => includeInactive || p.active)
                    .sort((a, b) => a.displayOrder - b.displayOrder)
                return ok({ plans: list })
            }

            case 'POST plans': {
                const inputs = Array.isArray(body.plans) ? (body.plans as PlanInput[]) : []
                const out = inputs.map((input) => {
                    const plan = toPlan(input, plans.get(input.plan_id), plans.size)
                    plans.set(plan.planId, plan)
                    return plan
                })
                persist()
                return ok({ plans: out })
            }

            case 'PATCH plans': {
                const plan = plans.get(String(body.planId ?? ''))
                if (plan) {
                    plan.active = Boolean(body.active)
                    plan.updatedAt = now()
                    persist()
                }
                return ok({})
            }

            case 'DELETE plans': {
                const planId = url.searchParams.get('planId') ?? ''
                plans.delete(planId)
                planFeatures.delete(planId)
                persist()
                return ok({})
            }

            // ── feature catalog ────────────────────────────────────────────
            case 'GET features':
                return ok({ features: [...features.values()] })

            case 'POST features': {
                const inputs = Array.isArray(body.features) ? (body.features as FeatureInput[]) : []
                const out = inputs.map((input) => {
                    const feature = toFeature(input, features.get(input.feature_key))
                    features.set(feature.featureKey, feature)
                    return feature
                })
                persist()
                return ok({ features: out })
            }

            case 'DELETE features': {
                const featureKey = url.searchParams.get('featureKey') ?? ''
                features.delete(featureKey)
                for (const [planId, links] of planFeatures) {
                    planFeatures.set(
                        planId,
                        links.filter((l) => l.feature_key !== featureKey)
                    )
                }
                persist()
                return ok({})
            }

            // ── plan ↔ feature map ─────────────────────────────────────────
            case 'GET plan-features': {
                const planId = url.searchParams.get('planId') ?? ''
                const links = planFeatures.get(planId) ?? []
                return ok({
                    planFeatures: links.map((l) => ({
                        planId,
                        featureId: features.get(l.feature_key)?.id ?? l.feature_key,
                        featureKey: l.feature_key,
                        metadata: l.metadata ?? {},
                    })),
                })
            }

            case 'PUT plan-features': {
                const planId = String(body.planId ?? '')
                if (!planId) return bad('planId is required')
                const links = Array.isArray(body.features) ? (body.features as PlanFeatureLink[]) : []
                planFeatures.set(planId, links)
                persist()
                return ok({})
            }

            // ── admin ──────────────────────────────────────────────────────
            case 'POST admin/list-subscriptions': {
                let list = [...subscriptions.values()]
                const status = body.status as SubscriptionStatus | 'live' | 'all' | undefined
                if (status && status !== 'all') {
                    list =
                        status === 'live'
                            ? list.filter((s) => LIVE_STATUSES.has(s.status))
                            : list.filter((s) => s.status === status)
                }
                if (typeof body.planId === 'string') list = list.filter((s) => s.planId === body.planId)
                if (typeof body.userId === 'string') list = list.filter((s) => s.userId === body.userId)
                const total = list.length
                const offset = Number.isFinite(Number(body.offset)) ? Number(body.offset) : 0
                const limit = Number.isFinite(Number(body.limit)) ? Number(body.limit) : total
                const page = list.slice(offset, offset + limit).map(readSub)
                return ok({ subscriptions: page, total })
            }

            case 'POST admin/grant-subscription': {
                const sub = makeSubscription({
                    userId: String(body.userId ?? ''),
                    planId: String(body.planId ?? ''),
                    status: 'active',
                    billingKey: '',
                })
                if (typeof body.periodStart === 'string') sub.currentPeriodStart = body.periodStart
                if (typeof body.periodEnd === 'string') {
                    sub.currentPeriodEnd = body.periodEnd
                    sub.nextBillingAt = body.periodEnd
                }
                subscriptions.set(sub.id, sub)
                persist()
                return ok({ subscription: readSub(sub) })
            }

            default:
                return notFound('Unknown payments endpoint')
        }
    }

    return { handle }
}

function parseJson(raw: Buffer): Record<string, unknown> {
    if (raw.length === 0) return {}
    try {
        const parsed = JSON.parse(raw.toString('utf8'))
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
        return {}
    }
}
