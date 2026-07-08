/**
 * Wire shapes for the v1 gateway. These mirror the platform contract; they are
 * intentionally loose where the platform is (claims, tokens) and additive-only.
 */

// ---------------------------------------------------------------------------
// Database: structured-query protocol (raw SQL is never accepted here)
// ---------------------------------------------------------------------------

export interface WhereOperator {
    equals?: unknown
    not?: unknown
    gt?: unknown
    gte?: unknown
    lt?: unknown
    lte?: unknown
    in?: unknown[]
    notIn?: unknown[]
    contains?: string
    startsWith?: string
    endsWith?: string
    mode?: 'default' | 'insensitive'
}

export interface WhereClause {
    [key: string]: unknown
    AND?: WhereClause[]
    OR?: WhereClause[]
    NOT?: WhereClause
}

export type OrderByClause = Record<string, 'asc' | 'desc'>

/** Options accepted by read operations (`find`, `findFirst`, `count`). */
export interface QueryOptions {
    where?: WhereClause
    select?: string[]
    orderBy?: OrderByClause
    limit?: number
    offset?: number
}

export interface UpdateInput {
    where: WhereClause
    data: Record<string, unknown>
}

export interface DeleteInput {
    where: WhereClause
}

export interface MigrateInput {
    sql: string
}

export interface MigrateResult {
    success: boolean
    executedStatements?: number
    warnings?: string[]
    error?: string
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface SignupInput {
    email: string
    password: string
    name?: string
    role?: string
}

export interface SignupResult {
    success: boolean
    userId?: string
    verified?: boolean
    verification_required?: boolean
    message?: string
}

export interface LoginInput {
    email: string
    password: string
}

export interface AuthTokens {
    AccessToken: string
    ExpiresIn: number
}

export interface LoginResult {
    success: boolean
    userId?: string
    mfa_offered?: boolean
    mfa_enabled?: boolean
    tokens?: AuthTokens
    /** When true the caller holds a challenge, NOT a session; finish via mfa.challenge. */
    mfa_required?: boolean
    challenge_token?: string
    challenge_expires_in?: number
}

export interface VerifyEmailInput {
    code: string
    /** Accepted but ignored; the code alone resolves the user. */
    email?: string
}

export interface ForgotPasswordInput {
    email: string
}

export interface ResetPasswordInput {
    code: string
    password: string
    email?: string
}

export interface CurrentUser {
    id: string
    email: string
    role?: string
    claims?: Record<string, unknown>
}

export interface MeResult {
    user: CurrentUser | null
}

export interface MfaChallengeInput {
    challengeToken: string
    code?: string
    recoveryCode?: string
}

export interface MfaEnrollResult {
    success: boolean
    secret?: string
    otpauth_url?: string
}

export interface MfaEnrollConfirmInput {
    accessToken: string
    code: string
}

export interface MfaDisableInput {
    accessToken: string
    code?: string
    recoveryCode?: string
}

export interface SimpleResult {
    success: boolean
    message?: string
    [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export type StorageBucket = 'public' | 'private'

export interface StorageObject {
    key: string
    name: string
    size: number
    contentType: string
    lastModified: string
    isFolder: boolean
}

export interface ListResult {
    objects: StorageObject[]
    folders: string[]
    prefix: string
    truncated: boolean
    continuationToken: string | null
}

export interface DownloadResult {
    /** base64-encoded file contents (inline downloads are capped at 8 MB). */
    body: string
    contentType: string
    size: number
}

export interface PresignResult {
    url: string
    key: string
    expiresIn: number
}

export interface TemporaryUrlResult {
    url: string
    expiresIn: number
}

/** Bytes the SDK can turn into an upload body. */
export type UploadBody = Blob | ArrayBuffer | ArrayBufferView | string

// ---------------------------------------------------------------------------
// Cache (key-value)
// ---------------------------------------------------------------------------

export interface CacheSetOptions {
    /** Time-to-live in seconds. Omit for no expiry. */
    ttl?: number
    /** Only set if the key does not already exist. */
    nx?: boolean
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

export interface MintConnectionTokenInput {
    /** Channels the connection may subscribe + publish to. */
    channels: string[]
    /** Optional end-user identity surfaced in presence. */
    identity?: string
    /** Token lifetime in seconds (default 3600). */
    ttl?: number
}

export interface ConnectionToken {
    /** Short-lived, channel-scoped token the browser connects with. */
    token: string
    /** WebSocket URL to connect to: `${url}?token=${token}`. */
    url: string
}

export interface RealtimePresenceMember {
    id: string
    identity?: string
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface SendEmailInput {
    /** One recipient email, or several. */
    to: string | string[]
    subject: string
    /** Email body as GitHub-flavored Markdown. There is no `html`/`text` field. */
    markdownText: string
}

export interface SendEmailResult {
    success: boolean
    /** Provider message id when the send was accepted. */
    messageId?: string
    /** Set when `success` is `false`. */
    error?: string
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/** The payment method a charge or subscription is settled with. */
export type PaymentMethod = 'kakaopay' | 'card' | 'tosspay' | 'naverpay'

/** A settled one-time payment. */
export interface PaymentReceipt {
    id: string
    amount: number
    method: PaymentMethod
    /** The user that was charged. */
    userId: string
    status: 'paid' | 'failed' | 'refunded'
    paidAt: string
    currency?: string
}

export interface RefundInput {
    /** The `id` from a prior `PaymentReceipt`. */
    paymentId: string
    /** Amount to refund. Omit for a full refund of the remaining balance. */
    amount?: number
    /** Reason for the refund. Required. */
    reason: string
}

export interface RefundResult {
    paymentId: string
    /** The amount refunded by this call. */
    refundedAmount: number
    /** Cumulative amount refunded across all refunds against this payment. */
    cumulativeRefunded: number
    /** The original payment amount. */
    originalAmount: number
    status: 'refunded' | 'partially_refunded'
    /** True when the payment was already refunded and this call was a no-op. */
    alreadyRefunded?: boolean
    /** True when state was reconciled from the provider. */
    reconciled?: boolean
}

export type BillingInterval = 'monthly' | 'yearly' | 'weekly'

export type SubscriptionStatus = 'trialing' | 'active' | 'paused' | 'cancelled' | 'past_due'

/** The plan shape passed when starting a subscription. */
export interface BillingPlan {
    id: string
    name: string
    amount: number
    interval: BillingInterval
    currency?: string
}

export interface Subscription {
    id: string
    planId: string
    /** The user the subscription belongs to. */
    userId: string
    method: PaymentMethod
    /** Opaque billing key. Empty when a subscription is read back. */
    billingKey: string
    status: SubscriptionStatus
    currentPeriodStart: string
    currentPeriodEnd: string
    nextBillingAt: string
    cancelAtPeriodEnd: boolean
    createdAt: string
    cancelledAt?: string
}

/** Config returned by the split-flow reserve step to open the browser popup. */
export interface ReserveSubscriptionResult {
    subscriptionId: string
    storeId: string
    channelKey: string
    billingKeyMethod: 'CARD' | 'EASY_PAY'
}

/** A priced tier in the project's plan registry. */
export interface Plan {
    id: string
    projectId: string
    /** Stable text identifier referenced by app code. */
    planId: string
    name: string
    description?: string | null
    amount: number
    currency: string
    interval: BillingInterval
    displayOrder: number
    active: boolean
    metadata: Record<string, unknown>
    createdAt: string
    updatedAt: string
}

export interface PlanInput {
    plan_id: string
    name: string
    description?: string | null
    amount: number
    currency?: string
    interval: BillingInterval
    display_order?: number
    active?: boolean
    metadata?: Record<string, unknown>
}

/** A named capability a plan can grant. */
export interface Feature {
    id: string
    projectId: string
    /** Stable lowercase-snake-case identifier passed to `hasFeature`. */
    featureKey: string
    name: string
    description?: string | null
    metadata: Record<string, unknown>
    createdAt: string
    updatedAt: string
}

export interface FeatureInput {
    feature_key: string
    name: string
    description?: string | null
    metadata?: Record<string, unknown>
}

export interface PlanFeature {
    planId: string
    featureId: string
    featureKey: string
    metadata: Record<string, unknown>
}

/** A feature a user is entitled to, unioned across their active subscriptions. */
export interface UserFeature {
    featureKey: string
    name: string
    description?: string | null
    grantedByPlanIds: string[]
    metadata: Record<string, unknown>
}

export interface SubscriptionFilters {
    status?: SubscriptionStatus | 'live' | 'all'
    planId?: string
    userId?: string
    limit?: number
    offset?: number
}
