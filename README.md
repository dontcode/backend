# @dontcode2/backend

The public SDK for the [DontCode](https://www.dontcode.co) backend: a thin, typed
proxy over the v1 HTTP gateway. Auth, database, and file storage for an app you host
yourself ("bring your own code"), behind a single project API key.

It speaks the exact wire protocol of the gateway, so you can move between the SDK and
raw HTTP at any time without platform-side changes.

## Install

```bash
pnpm add @dontcode2/backend
# or: npm i @dontcode2/backend
```

Works in Node 18+ and the browser; it uses the global `fetch`, with no extra runtime
dependencies.

## Quick start

```ts
import { dontcode } from '@dontcode2/backend'

// apiKey defaults to process.env.DONTCODE_API_KEY,
// baseUrl  defaults to process.env.DONTCODE_API_URL (then backend.dontcode.co).
const client = dontcode()

await client.auth.signup({
    email: 'tester@example.com',
    password: 'a-strong-password',
    role: 'editor',
})
```

You can also pass them explicitly:

```ts
const client = dontcode({
    apiKey: 'dc_…',
    baseUrl: 'https://backend.dontcode.co',
})
```

If no key is set in either place, requests fail naturally with the gateway's
`401 Missing API key`.

## Auth

The API key (`Authorization: Bearer dc_…`) identifies your **project** and is sent on
every call. The **end-user** access token is separate; pass it as `accessToken` to any
signed-in call and it travels in the `X-Access-Token` header. Your app owns the session.

```ts
// Two project settings shape these flows, so handle both states:
//   • email verification: signup may NOT return tokens
//   • MFA: login may be two steps
const signup = await client.auth.signup({ email, password })
if (signup.verification_required) {
    await client.auth.verifyEmail({ code }) // 6-digit code from the email
}

const login = await client.auth.login({ email, password })
if (login.mfa_required) {
    const done = await client.auth.mfa.challenge({
        challengeToken: login.challenge_token!,
        code, // from the authenticator app
    })
    // done.tokens is your session
} else {
    // login.tokens is your session
}

const { user } = await client.auth.me({ accessToken })
```

MFA enrollment (signed-in user):

```ts
const { otpauth_url } = await client.auth.mfa.enroll({ accessToken }) // render as QR
const { recovery_codes } = await client.auth.mfa.enrollConfirm({ accessToken, code })
await client.auth.mfa.disable({ accessToken, code })
```

Also available: `forgotPassword({ email })`, `resetPassword({ code, password })`.

## Database

Structured queries only; there is no raw-SQL escape hatch. Schema changes go through
`migrate`.

```ts
// db.<table> and db('<table>') are equivalent.
const rows = await client.db.maps.find({
    where: { ownerId: 'u1', name: { contains: 'demo', mode: 'insensitive' } },
    orderBy: { createdAt: 'desc' },
    limit: 20,
})

const one = await client.db.maps.findFirst({ where: { id: 1 } }) // row | null
const { id } = await client.db.maps.insert({ name: 'My map' }) // 409 on conflict
const { count } = await client.db.maps.update({ where: { id }, data: { name: 'Renamed' } })
await client.db.maps.delete({ where: { id } }) // where is required
const total = await client.db.maps.count({ where: { ownerId: 'u1' } })
```

`where` supports direct equality, `null` (IS NULL), arrays (IN), operator objects
(`equals, not, gt, gte, lt, lte, in, notIn, contains, startsWith, endsWith`, plus
`mode: 'insensitive'`) and `AND` / `OR` / `NOT` compounds. Unique/foreign-key conflicts
throw a `409`, the supported idempotency signal (insert, and on 409 treat the row as
existing).

```ts
// The one place DDL enters from outside.
await client.db.migrate({ sql: 'CREATE TABLE IF NOT EXISTS profiles (id uuid primary key);' })
```

## Storage

```ts
const pub = client.storage.public
const priv = client.storage.private

await pub.upload('img/logo.png', fileBlob, 'image/png') // ≤ 100 MB
pub.getUrl('img/logo.png') // permanent public URL (public bucket only)

await priv.list('invoices')
const { url } = await priv.getTemporaryUrl('invoices/2026.pdf', 600) // signed, expiring
const { body, contentType } = await priv.download('invoices/2026.pdf') // base64, ≤ 8 MB
await priv.remove(['invoices/old.pdf'])
await priv.move('a.pdf', 'archive/a.pdf')

// Large files: presign, then PUT the bytes to the returned URL yourself.
const { url: putUrl } = await priv.presignUpload('big.zip', 'application/zip')
```

## Errors

Every non-2xx response throws a `DontCodeError`:

```ts
import { DontCodeError, isDontCodeError } from '@dontcode2/backend'

try {
    await client.auth.login({ email, password })
} catch (err) {
    if (isDontCodeError(err)) {
        err.status // 401, 403, 409, 429, …
        err.code // e.g. 'EmailNotVerified', 'ChallengeExpired'
        err.rateLimited // true on 429
        err.body // the full error envelope
    }
}
```

"One more step" auth states (`verification_required`, `mfa_required`) are **successful**
2xx responses, not errors; branch on the resolved value for those.
