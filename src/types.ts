/**
 * Wire shapes for the v1 gateway. These mirror the platform contract; they are
 * intentionally loose where the platform is (claims, tokens) and additive-only.
 */
import type { ForVisitor } from './visitor'

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

/** What one related table brings: `true`, or its own filter, order, limit and includes. */
export interface IncludeOptions {
    where?: WhereClause
    orderBy?: OrderByClause
    /** Per parent row; at most 1,000. */
    limit?: number
    include?: IncludeClause
}

/**
 * Related rows by your foreign keys: `{ author: true }` on posts is the row
 * `posts.author_id` references (one row or null); `{ comments: true }` is every
 * `comments` row whose foreign key references the post (a list). Five levels deep.
 */
export type IncludeClause = Record<string, boolean | IncludeOptions>

/** Options accepted by read operations (`find`, `findFirst`, `count`). */
export interface QueryOptions {
    where?: WhereClause
    select?: string[]
    orderBy?: OrderByClause
    limit?: number
    offset?: number
    /** Related rows on `find`, `findMany`, `findFirst` and `findOne`. */
    include?: IncludeClause
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

export interface SignupInput extends ForVisitor {
    email: string
    password: string
    name?: string
    role?: string
    /** Keep an address the platform paused as a likely typo (a 422
     *  `EmailTypoSuspected` whose `didYouMean` the person declined). Never
     *  overrides an address that cannot receive mail. */
    acceptAsTyped?: boolean
    /** The person ticked "send me news and offers" on your sign-up form. Show
     *  that line only while `auth.signupForm()` says `promotionsOptIn`; the
     *  platform records the yes and sends the receipt the law asks for. */
    promotionsOptIn?: boolean
    /** The bot check's token, from the widget your form shows (`captchaConfig`). */
    captchaToken?: string
}

export interface SignupResult {
    success: boolean
    userId?: string
    verified?: boolean
    verification_required?: boolean
    message?: string
}

export interface LoginInput extends ForVisitor {
    email: string
    password: string
    /** The bot check's token, when your form shows one. */
    captchaToken?: string
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

export interface VerifyEmailInput extends ForVisitor {
    code: string
    /** The account being verified: its code is the only one that counts. */
    email: string
}

export interface ForgotPasswordInput extends ForVisitor {
    email: string
    /** The bot check's token, when your form shows one. */
    captchaToken?: string
}

export interface ResetPasswordInput extends ForVisitor {
    code: string
    password: string
    email?: string
    /** The bot check's token, when your form shows one. */
    captchaToken?: string
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

export interface MfaChallengeInput extends ForVisitor {
    challengeToken: string
    code?: string
    recoveryCode?: string
    /** The bot check's token, when your MFA form shows one (`botCheck: { mfa: true }`). */
    captchaToken?: string
}

export interface MfaEnrollResult {
    success: boolean
    secret?: string
    otpauth_url?: string
}

export interface MfaEnrollConfirmInput extends ForVisitor {
    accessToken: string
    code: string
}

export interface MfaDisableInput extends ForVisitor {
    accessToken: string
    code?: string
    recoveryCode?: string
}

export interface AccountDeletionRequestResult {
    success: boolean
    /** The address the code went to: the account's own. */
    email?: string
    expires_in_minutes?: number
    error?: string
}

export interface DeleteAccountInput extends ForVisitor {
    accessToken: string
    /** The 6-digit code from the email. */
    code: string
}

export interface SimpleResult {
    success: boolean
    message?: string
    [key: string]: unknown
}

/** The forms a bot check can cover. */
export type BotCheckSurface = 'login' | 'signup' | 'password_reset'

/**
 * What the browser loads to draw the bot check: the vendor's script, its
 * global, and the site key. Provider-agnostic: render it with
 * `renderBotCheck` from `dontcode/browser`, never by naming a vendor.
 */
export interface BotCheckWidget {
    provider: string
    siteKey: string
    scriptUrl: string
    globalName: string
}

export interface BotCheckConfig {
    /** The owner's Bot Protection switch. */
    enabled: boolean
    /** The forms it covers while enabled. */
    surfaces: BotCheckSurface[]
    /** Null when the platform has no provider: nothing can be asked then. */
    widget: BotCheckWidget | null
}

export interface SignupFormConfig {
    /** Show the unticked "news and offers" line on your sign-up form. */
    promotionsOptIn: boolean
}

/** A social sign-in the owner turned on: its public client ID, never a secret. */
export interface OAuthProvider {
    name: OAuthProviderName
    clientId: string
}

export type OAuthProviderName = 'kakao' | 'google' | 'github' | 'apple'

export interface OAuthAuthorizeInput {
    provider: OAuthProviderName
    /** Your callback, registered as a redirect URL in the owner's provider app. */
    redirectUri: string
    /** Your own state; one is made for you when left out. */
    state?: string
}

export interface OAuthAuthorizeResult {
    /** Send the visitor here. */
    url: string
    /** Keep it in a short-lived httpOnly cookie (`serializeOAuthStateCookie`)
     *  and check it on the callback. */
    state: string
    /** Apple calls your callback with a cross-site form POST: its state cookie
     *  must be `SameSite=None` (the cookie helper does that when this is true). */
    formPost: boolean
}

export interface OAuthCallbackInput extends ForVisitor {
    provider: OAuthProviderName
    /** The `code` the provider sent back. */
    code: string
    /** The same redirect URI the authorize URL carried. */
    redirectUri: string
    /** The role a brand-new person gets, as on `signup`. */
    role?: string
    /** Apple's `user` form field on a first sign-in, passed as Apple posted it. */
    appleUser?: string | null
}

export interface OAuthCallbackResult extends LoginResult {
    /** The person was created by this sign-in. */
    is_new_user?: boolean
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

/**
 * Who an email is for, named by who controls them; DontCode looks the
 * address up when it goes, so your code never writes the business's address:
 *
 *   'owner'           the business: the DontCode account that owns the project
 *   'contact:<name>'  an outside inbox the owner saved on Emails > Addresses
 *   { user: id }      one of your app's users, at their verified address (the
 *                     person signed in: their session's user id)
 *   an address        someone in your app's data who is no user (a guest)
 */
export type EmailRecipient = 'owner' | `contact:${string}` | { user: string } | (string & {})

/** The languages DontCode writes an email's chrome in. */
export type EmailLanguage = 'ko' | 'en' | 'zh' | 'ja'

/** The email's one button: a short label and a page on your app's own address. */
export interface EmailAction {
    label: string
    href: string
}

export interface SendEmailInput {
    /** One recipient or a list (at most 50); each gets an email of their own. */
    to: EmailRecipient | EmailRecipient[]
    subject: string
    /** Email body as GitHub-flavored Markdown. There is no `html`/`text` field. */
    markdownText: string
    /** Where a Reply goes: the visitor who wrote a contact form. */
    replyTo?: string
    /** The chrome's language for a recipient whose own DontCode does not know. */
    locale?: EmailLanguage
    action?: EmailAction
}

export interface SendEmailResult {
    success: boolean
    /** The first email's id, when the send was accepted. */
    messageId?: string
    /** Each recipient's email id, in the order sent. */
    messageIds?: string[]
    /** Set when `success` is `false`. */
    error?: string
}

export interface BroadcastVersion {
    subject: string
    markdownText: string
}

export interface BroadcastInput {
    /** Everyone who holds this role in your app. */
    to: { role: string }
    /**
     * 'notice' (default): terms, an outage, a change to their account or
     * orders. 'promotion': anything marketing, which reaches only people who
     * said yes on sign-up, once the owner turned promotional email on; DontCode
     * adds the ad marker and unsubscribe link and holds it 21:00 to 08:00 KST.
     */
    kind?: 'notice' | 'promotion'
    /** The words in each of the project's languages; a missing one is refused. */
    versions: Partial<Record<EmailLanguage, BroadcastVersion>>
    action?: EmailAction
    replyTo?: string
}

export interface BroadcastResult {
    success: boolean
    /** Its progress is on the project's Emails page, where the owner can stop it. */
    broadcastId?: string
    /** How many people it reaches. */
    total?: number
    error?: string
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/** The payment method a charge is settled with. */
export type PaymentMethod =
    | 'kakaopay'
    | 'card'
    | 'tosspay'
    | 'naverpay'
    | 'transfer'
    | 'samsungpay'
    | 'applepay'
    | 'payco'
    | 'paypal'

/** What a subscription can be paid with: card and the wallets that issue a billing key. */
export type SubscriptionMethod = 'card' | 'kakaopay' | 'tosspay' | 'naverpay'

/** What the owner's store can take right now, from the channels they connected. */
export interface CheckoutMethods {
    /** One-time methods in KRW (and PayPal in its own currency). */
    oneTime: PaymentMethod[]
    subscription: SubscriptionMethod[]
    /** Cards in another currency (`currency: 'USD'` with method `card`). */
    international: boolean
}

/** The buyer's language: their receipt email and the payment window follow it. */
export type PaymentLanguage = 'ko' | 'en' | 'zh' | 'ja'

export interface RequestPaymentInput {
    /** In the currency's smallest unit (KRW: won; USD: cents). */
    amount: number
    itemName: string
    method: PaymentMethod
    /** ISO 4217, default 'KRW'. Another currency takes method 'card' (or 'paypal'). */
    currency?: string
    /** Required for any currency but KRW: the card processors ask for them. */
    customerName?: string
    customerEmail?: string
    locale?: PaymentLanguage
}

export interface VerifyPaymentInput {
    paymentId: string
    expectedAmount: number
    currency: string
    description?: string
    /** The user who paid, for the receipt and their subscriptions and features. */
    userId?: string
    customerName?: string
    customerEmail?: string
    locale?: PaymentLanguage
}

/** A settled one-time payment. */
export interface PaymentReceipt {
    id: string
    amount: number
    method: PaymentMethod
    /** The user that was charged. */
    userId: string
    /**
     * 'pending' while the provider holds the payment for review (PayPal can):
     * record it as pending and deliver only once a later `verify` reads 'paid'.
     */
    status: 'paid' | 'failed' | 'refunded' | 'pending'
    paidAt: string
    currency?: string
    /** One of the owner's test channels took it: nothing was charged. */
    test?: boolean
    /** The receipt's number, when one was issued (none for a test payment). */
    receiptNumber?: string | null
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
    method: SubscriptionMethod
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

/**
 * Popup config returned by the one-time payment intent step. Hand it to the
 * browser to open the provider popup, then `verify` the completed charge.
 */
export interface RequestPaymentResult {
    paymentId: string
    storeId: string
    channelKey: string
    currency: string
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

// ---------------------------------------------------------------------------
// AI (the same API as @dontcode/ai's server side)
// ---------------------------------------------------------------------------

/** How much reasoning the task needs. DontCode picks the model; you never name one. */
export type AiIntent = 'quick' | 'balanced' | 'thorough'

export interface AiTextPart {
    type: 'text'
    text: string
}

export interface AiImagePart {
    /** An http(s) URL, a `data:` URI, or raw base64. */
    type: 'image'
    image: string
    mediaType?: string
}

export interface AiMessage {
    role: 'user' | 'assistant' | 'system' | 'tool'
    content: string | Array<AiTextPart | AiImagePart>
}

export interface AiUsage {
    inputTokens: number
    outputTokens: number
}

/** Every AI call takes its own timeout: answers take longer than the 10 s default. */
export interface AiCallOptions {
    /** Milliseconds before the call gives up waiting for the answer to start. Default 120 000. */
    timeoutMs?: number
}

export interface AiChatOptions extends AiCallOptions {
    messages: AiMessage[]
    /** Defaults to 'balanced'. */
    intent?: AiIntent
    maxTokens?: number
    system?: string
}

export interface AiChatResponse {
    content: string
    usage: AiUsage
}

export interface AiGenerateOptions extends AiCallOptions {
    prompt: string
    intent?: AiIntent
    maxTokens?: number
    system?: string
}

export interface AiStreamCallbacks {
    onToken?: (token: string) => void
    onDone?: (response: AiChatResponse) => void
    onError?: (error: Error) => void
}

export interface AiVisionOptions extends AiCallOptions {
    prompt: string
    /** http(s) URLs, `data:` URIs or raw base64. */
    images: string[]
    intent?: AiIntent
    system?: string
    maxTokens?: number
}

export type AiImageQuality = 'low' | 'medium' | 'high'

export interface AiImageOptions extends AiCallOptions {
    prompt: string
    /** Defaults to 'medium'. */
    quality?: AiImageQuality
    /** `{width}x{height}`. Defaults to '1024x1024'. */
    size?: `${number}x${number}`
    /** 1 to 4. Defaults to 1. */
    n?: number
}

export interface AiImageResponse {
    /** Hosted in the project's storage: permanent public URLs. */
    images: Array<{ url: string; mediaType: string }>
    model: string
    quality: AiImageQuality
    size: string
}

export type AiSpeechLanguage = 'ko' | 'en' | 'zh' | 'ja'
export type AiSpeechVoice = 'woman-friendly' | 'woman-clear' | 'man-friendly' | 'man-clear'

/** WebM, Ogg, MP4 (M4A), MP3, AAC or WAV, at most 4 MB. */
export type AiSpeechAudio = Blob | ArrayBuffer | Uint8Array

export interface AiTranscribeOptions extends AiCallOptions {
    /** ISO 639-1 or 639-3; detected when left out. */
    language?: string
}

export interface AiTranscribeResponse {
    text: string
    language: string | null
    durationSeconds: number
}

export interface AiSpeakOptions extends AiCallOptions {
    language: AiSpeechLanguage
    /** Defaults to 'woman-friendly'. */
    voice?: AiSpeechVoice
}

export interface AiSpeakResponse {
    /** The MP3. Send it on to the browser; never store it. */
    audio: Uint8Array
    mediaType: 'audio/mpeg'
    characters: number
    voice: AiSpeechVoice
}

export interface AiTool<I = unknown, O = unknown> {
    name: string
    description?: string
    /** JSON Schema of the input. */
    parameters: Record<string, unknown>
    /** Runs on your server; DontCode only ever sees the schema. */
    execute: (input: I) => O | Promise<O>
}

export interface AiToolCall {
    toolCallId: string
    toolName: string
    input: unknown
}

export interface AiToolResult {
    toolCallId: string
    toolName: string
    output: unknown
}

export interface AiAgentOptions extends AiCallOptions {
    messages: AiMessage[]
    tools: AiTool[]
    intent?: AiIntent
    system?: string
    maxTokens?: number
    /** Model calls at most. Defaults to 5. */
    maxSteps?: number
}

export interface AiAgentCallbacks {
    onToken?: (token: string) => void
    onToolCall?: (call: AiToolCall) => void
    onToolResult?: (result: AiToolResult) => void
    onStepFinish?: (info: {
        step: number
        text: string
        toolCalls: AiToolCall[]
        usage: AiUsage
    }) => void
    onError?: (error: Error) => void
}

export interface AiAgentResponse {
    text: string
    messages: AiMessage[]
    finishReason: 'stop' | 'max-steps' | 'error'
    usage: AiUsage
    steps: Array<{
        text: string
        toolCalls: AiToolCall[]
        toolResults: AiToolResult[]
        usage: AiUsage
    }>
}
