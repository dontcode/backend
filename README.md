# @dontcode2/backend

The public SDK for the [DontCode](https://www.dontcode.co) backend: a thin, typed
proxy over the v1 HTTP gateway. Auth, database, file storage, a key-value cache, and
realtime pub/sub for an app you host yourself ("bring your own code"), behind a single
project API key.

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

## Local development (the mock gateway)

You don't need the hosted backend to build against this SDK. Because the SDK is a
thin proxy over a fixed wire protocol, the package ships a local server that speaks
that same protocol — auth, database, and storage — so you can develop fully offline:

```bash
npx dontcode-mock                 # http://localhost:4000, state persisted to ./.dontcode-mock
```

Then point your app at it — no code changes, just config:

```bash
DONTCODE_API_URL=http://localhost:4000
DONTCODE_API_KEY=dc_local_dev     # any dc_… value is accepted by default
```

Apply your schema the same way you would in production, then use the client normally:

```ts
const client = dontcode() // reads the env vars above
await client.db.migrate({ sql: 'CREATE TABLE IF NOT EXISTS notes (id serial primary key, body text);' })
await client.db.notes.insert({ body: 'hello from the mock' })
```

How faithful is it? The database runs your real DDL and the SDK's real structured
queries against in-process Postgres ([PGlite](https://pglite.dev)), including the
`409` conflict signal; auth issues real JWT-shaped tokens that `decodeAccessToken`
and `getSession` read exactly as in production; storage stores real files and serves
them over the same server. It is a **development tool** — passwords are stored in
plaintext, tokens are unsigned, and there is no rate limiting — so never expose it
to an untrusted network.

PGlite ships as an optional dependency, so `npx dontcode-mock` works out of the box.
(If your install skipped optional deps, add it: `pnpm add -D @electric-sql/pglite`.)

**Useful flags:** `--port <n>`, `--data-dir <dir>`, `--ephemeral` (in-memory, starts
empty each run — ideal for tests), `--api-key <key>` (require exactly that key).
Run `dontcode-mock --help` for the full list.

You can also drive it programmatically — handy for integration tests that need a
clean backend per run:

```ts
import { startMockServer } from '@dontcode2/backend/mock'
import { dontcode } from '@dontcode2/backend'

const mock = await startMockServer({ dataDir: null }) // ephemeral
const client = dontcode({ baseUrl: mock.url, apiKey: 'dc_test' })
// … exercise the client …
await mock.close()
```

## MCP server (Claude Code and other AI tools)

This package ships an MCP server so an AI agent can work on a DontCode project
directly: sign in from the terminal, query and update the database, run
migrations, and manage files. It runs over stdio, so the tool launches it for
you.

```jsonc
// .mcp.json (Claude Code)
{
  "mcpServers": {
    "dontcode": {
      "command": "npx",
      "args": ["-y", "-p", "@dontcode2/backend", "dontcode", "mcp"]
    }
  }
}
```

On first use the agent calls the `auth_login` tool, which opens your browser.
You confirm a short code, pick a project, and approve; the browser hands a
short-lived, project-scoped token back to the terminal (cached under
`~/.dontcode`). The token is bound to your user, and the gateway enforces your
project role on every request, so the agent can never do more than you can.

CLI equivalents:

```bash
npx -p @dontcode2/backend dontcode login    # browser sign-in
npx -p @dontcode2/backend dontcode status   # project + role + capabilities
npx -p @dontcode2/backend dontcode logout   # forget the cached token
```

For non-interactive use (CI), set `DONTCODE_API_KEY` to a `dc_` project key and
skip `login`. Set `DONTCODE_API_URL` to target a non-default gateway.

Tools: `auth_login`, `auth_wait`, `auth_status`, `auth_logout`, `db_query`,
`db_insert`, `db_update`, `db_delete`, `db_migrate`, `storage_list`,
`storage_get_url`, `storage_temporary_url`, `storage_upload`, `storage_remove`,
`storage_move`. Writes and deletes are annotated so the agent confirms first.

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

## Cache

A key-value cache for ephemeral, high-churn, or session-scoped state, with optional TTL
expiry. Keys are scoped to your project automatically. This is a cache, not a database:
values may be evicted and are not durable, so keep your system of record in `db`.

```ts
const c = client.cache

await c.set('session:42', { step: 2 }, { ttl: 3600 }) // ttl in seconds
const session = await c.get<{ step: number }>('session:42') // null on miss or expiry
await c.set('lock:job', '1', { nx: true }) // false if it already existed
await c.expire('session:42', 600) // or null to clear the TTL
await c.del('session:42')

// hashes
await c.hset('profile:9', { name: 'Zed', level: 7 })
const profile = await c.hgetAll<{ name: string; level: number }>('profile:9') // null on miss

// sets (string members)
await c.sAdd('online', 'u1', 'u2')
const online = await c.sMembers('online') // string[] ([] on miss)
await c.sRem('online', 'u1')
```

A miss (or expiry) reads back as `null` for `get`/`hgetAll` and `[]` for `sMembers`,
not an error.

## Realtime

Realtime pub/sub over WebSockets for live features (chat, presence, live updates). The
SDK is the **server side**: mint a connection token for a browser, publish messages, and
read presence. The browser opens the socket itself with the scoped token, so it never
holds your API key. Delivery is fire-and-forget (no history/replay), so persist anything
that needs durability to `db`.

```ts
const rt = client.realtime

// In your token endpoint, after you've authenticated the user:
const conn = await rt.mintToken({ channels: [`room:${id}`], identity: userId })
// → send `conn` to the browser; it connects to `${conn.url}?token=${conn.token}`
//   (use @dontcode/realtime's client `connect()` to handle the socket + reconnect)

// From anywhere on your backend:
const delivered = await rt.publish(`room:${id}`, { text: 'hello' })
const members = await rt.presence(`room:${id}`) // [{ id, identity? }]
```

A browser connection may only use the channels named when its token was minted.

> The local mock gateway (`dontcode-mock`) and the MCP server currently cover auth,
> database, and storage. Cache and realtime are available on the hosted gateway; point
> `DONTCODE_API_URL` at it to use them.

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
