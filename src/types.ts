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
