export { dontcode } from './client'
export type { DontCodeClient, DontCodeClientOptions } from './client'

export { DontCodeError, isDontCodeError } from './errors'
export type { DontCodeErrorBody } from './errors'

export { AuthApi, MfaApi } from './auth'
export type { InfoResult } from './auth'
export { TableQuery, type DbClient } from './db'
export { BucketClient, PublicBucketClient, createStorage, type StorageClient } from './storage'

export {
    decodeAccessToken,
    isSessionExpired,
    InMemorySessionCache,
} from './session'
export type {
    DecodedSession,
    GetSessionInput,
    SessionCache,
    SessionOptions,
    SessionResult,
    SessionStatus,
} from './session'

export {
    DEFAULT_SESSION_COOKIE_NAME,
    clearSessionCookie,
    readSessionToken,
    serializeSessionCookie,
} from './cookies'
export type { SessionCookieOptions } from './cookies'

export type * from './types'
