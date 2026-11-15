# dontcode

The public SDK for the [DontCode](https://www.dontcode.co) backend: a thin, typed
proxy over the v1 HTTP gateway. Auth, database, file storage, a key-value cache,
realtime pub/sub, and transactional notifications for an app you host yourself ("bring
your own code"), behind a single project API key.

It speaks the exact wire protocol of the gateway, so you can move between the SDK and
raw HTTP at any time without platform-side changes.

## Install

```bash
pnpm add dontcode
# or: npm i dontcode
```

Works in Node 18+ and the browser; it uses the global `fetch`, with no extra runtime
dependencies.

## Quick start

```ts
import { dontcode } from 'dontcode'

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
await client.db.migrate({
    sql: 'CREATE TABLE IF NOT EXISTS notes (id serial primary key, body text);',
})
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
import { dontcode } from 'dontcode'
import { startMockServer } from 'dontcode/mock'

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
            "args": ["-y", "dontcode", "mcp"],
        },
    },
}
```

On first use the agent calls the `auth_login` tool, which opens your browser.
You confirm a short code, pick a project, and approve; the browser hands a
short-lived, project-scoped token back to the terminal (cached under
`~/.dontcode`). The token is bound to your user, and the gateway enforces your
project role on every request, so the agent can never do more than you can.

CLI equivalents:

```bash
npx dontcode login    # browser sign-in
npx dontcode status   # project + role + capabilities
npx dontcode logout   # forget the cached token
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

Pass the request your server is answering as `request` on every auth call. The platform
then limits sign-in attempts per visitor, by their own address, device and country,
instead of counting every visitor of your app as one:

```ts
// A Fetch Request: Next route handlers, SvelteKit, Remix, Hono's c.req.raw
const login = await client.auth.login({ email, password, request })

// Node's req (Express, Fastify, Koa), or await headers() in a Next server action
const login = await client.auth.login({ email, password, request: req })
```

Leave it out and the call still works; the per-address limit is skipped for it.

```ts
// Two project settings shape these flows, so handle both states:
//   • email verification: signup may NOT return tokens
//   • MFA: login may be two steps
const signup = await client.auth.signup({ email, password })
if (signup.verification_required) {
    await client.auth.verifyEmail({ email, code }) // 6-digit code from the email
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

Signup checks the address first. Offer the platform's correction when it has one:

```ts
try {
    await client.auth.signup({ email, password })
} catch (err) {
    if (isDontCodeError(err) && err.code === 'EmailTypoSuspected') {
        // 422: the address works but looks like a slip (gmai.com). Show
        // "Did you mean ${err.didYouMean}?"; to keep it as typed:
        await client.auth.signup({ email, password, acceptAsTyped: true })
    } else if (isDontCodeError(err) && err.code === 'UndeliverableEmailException') {
        // 400: cannot receive mail, or a throwaway inbox. err.didYouMean may
        // hold a fix; acceptAsTyped does not get past this one.
    }
}
```

The mock gateway refuses `@mailinator.com` and `@naver.con` (suggesting `naver.com`) and
pauses `@gmai.com` (suggesting `gmail.com`), so both paths run offline.

Also available: `forgotPassword({ email })`, `resetPassword({ code, password })`.

Account deletion (signed-in user, confirmed by an emailed code; delete your own rows for
them first, the platform removes the identity and revokes their sessions):

```ts
await client.auth.requestAccountDeletion({ accessToken }) // emails a 6-digit code
await client.auth.deleteAccount({ accessToken, code }) // `code_wrong` / `code_expired` on failure
```

The mock gateway accepts `123456` as the code.

### Bot protection

The owner's **Bot Protection** switch (Users > Sign-in settings) puts a bot check on
sign-up, sign-in and password reset, and DontCode can ask for one by itself while an app is
under attack. The check is drawn in the visitor's browser and its token rides your server's
call. Tell the client your forms draw it, and the platform starts asking:

```ts
// Browser: draw it, keep the token (dontcode/browser)
import { renderBotCheck } from 'dontcode/browser'

const client = dontcode({ botCheck: true }) // { mfa: true } once your MFA form draws it too

// Server: what the browser needs, and which forms show it while the switch is on
const { enabled, surfaces, widget } = await client.auth.captchaConfig()

const check = await renderBotCheck(document.getElementById('bot-check')!, widget!, {
    onToken: (token) => (form.captchaToken.value = token),
})

// Server: send it along
await client.auth.login({ email, password, captchaToken, request })
```

A call that needs the check fails with `err.captchaRequired` (`CaptchaRequired`, or
`CaptchaFailed` for a rejected token): show the widget (or `check.reset()`) and let the
person try again. Leave `botCheck` off until your forms draw it: the platform never asks a
check of an app that did not say it can show one, so turning it on early locks people out.

### Promotional email consent

While the owner has promotional email turned on, your sign-up form shows one unticked line
asking whether the person wants news and offers. DontCode records the yes, sends the receipt
the law asks for and reminds them every two years. Never keep a consent list of your own:
promotions go out as a `kind: 'promotion'` broadcast, which reaches only the people who said
yes.

```ts
const { promotionsOptIn } = await client.auth.signupForm() // show the line when true
await client.auth.signup({ email, password, promotionsOptIn: ticked, request })
```

### Social sign-in

Kakao, Google, GitHub and Apple, with the provider apps the owner set up under Users >
Sign-in settings; their client secrets stay with DontCode. One callback route serves every
provider: `/api/auth/oauth/callback` on your app's address (`OAUTH_CALLBACK_PATH`), the URL
those settings show the owner to register with each provider.

```ts
import {
    OAUTH_CALLBACK_PATH,
    clearOAuthStateCookie,
    oauthStateMatches,
    readOAuthStateCookie,
    serializeOAuthStateCookie,
} from 'dontcode'

const redirectUri = `https://yourapp.com${OAUTH_CALLBACK_PATH}`

// The buttons
const providers = await client.auth.oauth.providers() // [{ name: 'kakao', clientId }]

// GET /auth/start?provider=kakao: send the visitor to the provider
const { url, state, formPost } = await client.auth.oauth.authorizeUrl({ provider, redirectUri })
headers.append('Set-Cookie', serializeOAuthStateCookie({ provider, state }, { formPost }))
// → 302 to url

// GET /api/auth/oauth/callback?code=…&state=… (Apple: a form POST with code, state and user)
const kept = readOAuthStateCookie(req.headers.get('cookie'))
if (!kept || !oauthStateMatches(params.state, kept.state)) {
    // refuse: the sign-in did not start here
}
headers.append('Set-Cookie', clearOAuthStateCookie({ formPost: kept.provider === 'apple' }))
const result = await client.auth.oauth.callback({
    provider: kept.provider,
    code: params.code,
    redirectUri,
    appleUser: params.user, // Apple's first sign-in only
    request,
})
// result is login's answer: result.tokens, or result.mfa_required with a challenge_token
```

The mock gateway has no provider apps: `providers()` is empty offline.

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

Bring related rows along with `include`, by your foreign keys: one query per relation for all
the rows, never one per row.

```ts
const posts = await client.db.posts.find({
    include: {
        author: true, // posts.author_id → the author row, or null
        comments: {
            // every comments row pointing at the post, per post
            where: { hidden: false },
            orderBy: { createdAt: 'desc' },
            limit: 5, // per post, at most 1,000
            include: { user: true }, // nests five levels deep
        },
    },
})
```

`include` works on `find`, `findMany`, `findFirst` and `findOne`, and a narrow `select` still
resolves (the joining column is read and taken off again). A key with no foreign key behind it
throws a `400` saying what to check.

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

A key-value store for shared, short-lived state: one place every instance of your app
reads and writes, no matter where it runs. Serverless and multi-instance hosting cannot
share process memory, so state that must be visible fleet-wide lives here instead:
rate-limit counters, one-time codes and login nonces, webhook idempotency guards and
run-once locks (`nx`), anonymous carts and multi-step wizard sessions, and cached results
of genuinely expensive work (large aggregates, paid third-party APIs, AI calls). Values
survive your deploys and are shared between your web app and any workers or crons using
the same key. There is nothing to provision: no store to run, no connection string.

Keys are scoped to your project automatically. This is ephemeral state, not a database:
values may be evicted and are not durable, so keep your system of record in `db`. Skip it
for cheap reads, too; a cache round trip costs about as much as a `db` query, so cache
work that is expensive, not queries that are already fast.

```ts
const c = client.cache

await c.set('session:42', { step: 2 }, { ttl: 3600 }) // ttl in seconds
const session = await c.get<{ step: number }>('session:42') // null on miss or expiry
await c.set('webhook:evt_9f2', 1, { ttl: 86400, nx: true }) // false if already seen: dedupe/locks
await c.expire('session:42', 600) // or null to clear the TTL
await c.del('session:42')

// hashes
await c.hset('profile:9', { name: 'Zed', level: 7 })
const profile = await c.hgetAll<{ name: string; level: number }>('profile:9') // null on miss

// sets (string members): presence lists, vote dedupe, fleet-wide flags
await c.sAdd('online', 'u1', 'u2')
const online = await c.sMembers('online') // string[] ([] on miss)
await c.sRem('online', 'u1')
```

A miss (or expiry) reads back as `null` for `get`/`hgetAll` and `[]` for `sMembers`,
not an error. `nx` plus a TTL is the canonical coordination pattern; whichever instance
gets there first wins, everywhere else backs off:

```ts
// run a job at most once per day, across every instance and cron
const won = await c.set(`job:digest:${today}`, 1, { ttl: 86_400, nx: true })
if (won) await sendDailyDigest()
```

## Realtime

Realtime pub/sub over WebSockets for live features (chat, presence, live updates). Your server
mints a channel-scoped token for a visitor it has checked, publishes and reads presence; the
browser connects with that token, so it never holds your API key. Delivery is fire-and-forget
(no history or replay), so persist anything that needs durability to `db`.

```ts
// Server: your token route (POST /api/realtime), after you've authenticated the user
const conn = await client.realtime.mintToken({ channels: [`room:${id}`], identity: userId })
return Response.json(conn) // { token, url }

// Server, anywhere
const delivered = await client.realtime.publish(`room:${id}`, { text: 'hello' })
const members = await client.realtime.presence(`room:${id}`) // [{ id, identity? }]
```

```ts
// Browser
import { connectRealtime } from 'dontcode/browser'

const conn = await connectRealtime({ channels: [`room:${id}`] }) // POSTs /api/realtime for its token
const stop = conn.subscribe(`room:${id}`, ({ payload }) => show(payload))
conn.publish(`room:${id}`, { text: 'hi' }) // to everyone else on the channel
// cleanup: stop(); conn.close()
```

The connection reconnects with backoff when the socket drops, asking your route for a fresh
token each time. Point it elsewhere with `endpoint: '/api/my-token'`, or fetch the token your
own way with `getToken`. A token is good for the channels it was minted for only; to use
another channel, open another connection.

## Notifications

Email as an Insight app sends it: from DontCode in your app's design, each recipient in their
own language, logged on the project's Emails page. Name each recipient by who controls them
and DontCode looks the address up when it goes, so your code never writes the business's
address:

| `to`               | Reaches                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `'owner'`          | the business: the DontCode account that owns the project, even after a sale                       |
| `'contact:<name>'` | an outside inbox the owner saved on Emails > Addresses (a lawyer, a supplier)                     |
| `{ user: id }`     | one of your app's users at their verified address (the signed-in person: their session's user id) |
| an address         | someone in your app's data who is no user (a guest checkout)                                      |

```ts
await client.notifications.email.send({
    to: ['owner', { user: order.buyer_id }], // each gets an email of their own
    subject: 'New order',
    markdownText: `# Order ${order.id}\n\nThanks for your order.`, // Markdown IS the body
    action: { label: 'See the order', href: `https://shop.example/orders/${order.id}` },
    replyTo: order.buyer_email, // optional
})

// One email to everyone with a role, each in their own language, paced within the plan
await client.notifications.email.broadcast({
    to: { role: 'buyer' },
    kind: 'notice', // or 'promotion': only people who said yes on sign-up, held 21:00 to 08:00 KST
    versions: {
        ko: { subject: '이용약관이 바뀝니다', markdownText: '# 이용약관이 바뀝니다' },
        en: { subject: 'Our terms are changing', markdownText: '# Our terms are changing' },
    },
})

// The owner's address to show on a page; null when there is none or the read fails
const ownerAddress = await client.notifications.email.ownerAddress()
```

A recipient DontCode cannot resolve (an unsaved name, an id that is no user) refuses the whole
send with the reason. A broadcast needs a version in every one of the project's languages; its
progress is on the Emails page, where the owner can stop it. Broadcast only from code that
checks the caller may (an admin). `markdownText` is the only content field: there is no
`html`/`text` field and no separate templates; content is sanitized server-side.

> The local mock gateway (`dontcode-mock`) covers auth, database, storage, cache,
> realtime, notifications (sends are checked and logged, never delivered; the owner is
> `owner@example.com`), payments and AI. The MCP server currently covers auth, database,
> and storage.

## Payments

A checkout as an Insight app runs it, on the owner's own PortOne store (connected on Payments >
Connect; until then calls fail with `PAYMENTS_NOT_CONNECTED`). Your server asks for the payment,
the browser opens the window, your server verifies it before granting anything.

```ts
// Server: what the store takes right now (show only these)
const { oneTime, subscription, international } = await client.payments.methods()

// Server: the intent for this order (amounts in the currency's smallest unit)
const intent = await client.payments.requestPayment({
    amount: 9900,
    itemName: 'Monthly box',
    method: 'kakaopay',
})
```

```ts
// Browser
import { PaymentWindowError, pay } from 'dontcode/browser'

try {
    const { paymentId } = await pay(intent, {
        amount: 9900,
        itemName: 'Monthly box',
        method: 'kakaopay',
    })
    await fetch('/api/checkout/verify', { method: 'POST', body: JSON.stringify({ paymentId }) })
} catch (err) {
    if (err instanceof PaymentWindowError) showMessage(err.message) // closed or refused
}
```

```ts
// Server: record it, and the buyer gets their receipt by email
const receipt = await client.payments.verify({
    paymentId,
    expectedAmount: 9900,
    currency: 'KRW',
    userId,
})
if (receipt.status === 'paid') deliver()
```

- **Methods:** `card`, `kakaopay`, `tosspay`, `naverpay`, `transfer`, `samsungpay`, `applepay`,
  `payco` and `paypal`; subscriptions take `card`, `kakaopay`, `tosspay` and `naverpay`.
- **Cards from abroad:** pass `currency: 'USD'` (any ISO code) with method `card`, the amount in
  cents, and the buyer's `customerName` and `customerEmail`, which the card processors require;
  without them `requestPayment` throws `CUSTOMER_DETAILS_REQUIRED` before asking anything.
  One-time only: subscriptions are KRW.
- **PayPal** draws its own button: ask the intent with method `'paypal'`, then
  `renderPayPal(container, intent, order, { onApprove: (paymentId) => verifyOnServer(paymentId) })`.
  PayPal can hold a payment for review: a receipt's `status` is then `'pending'`; record it as
  pending and deliver once a later `verify` reads `'paid'`.
- **Phones:** the payment company's page replaces yours there, so `pay` never answers; the buyer
  comes back to `redirectUrl` (default: the same page) with `?paymentId=…&code=…`. Verify it on
  that page's server, and treat a `code` as a cancelled payment.
- **Test payments:** `receipt.test` is true when one of the owner's test channels took it:
  nothing was charged.
- **The buyer's receipt page:** every completed payment's receipt email links to
  `/r/<number>?t=<token>` on your app's primary domain (`receipt.receiptUrl`). Mount the page
  there, and it draws the receipt with the owner's business and branding, printable, in the
  receipt's language; until you do, those links 404.

    ```ts
    // Next: src/app/r/[number]/route.ts
    export const GET = (request: Request) => client.payments.handleReceiptRequest(request)
    // Hono: app.get('/r/:number', (c) => client.payments.handleReceiptRequest(c.req.raw))
    ```

    It takes a Fetch `Request`; read one receipt's data yourself with
    `client.payments.receipt(number, token)`.

- `locale` (`'ko'`, `'en'`, `'zh'`, `'ja'`) on `requestPayment`, `verify` and `pay` sets the
  window's and the receipt email's language.

`dontcode/browser` loads PortOne's browser SDK from PortOne's own address the first time a
window opens, so there is nothing more to install. Subscriptions (`createSubscription`,
`reserveSubscription` → `confirmSubscription`, `cancelSubscription`), entitlements
(`hasActiveSubscription`, `hasFeature`, `listUserFeatures`) and the plan and feature catalog
(`definePlans`, `defineFeatures`, `setPlanFeatures`) are on `client.payments` as well. The mock
gateway takes every method offline and never charges.

## AI

AI for your server, as an Insight app's server has it: chat, vision, image generation, speech and tool-using
agents. AI is included in the owner's plan, up to the app's daily AI limit: the plan sets it
and it resets at midnight Korean time. Past it a call fails with a `429` DontCodeError whose
`code` is `PAGE_AI_DAILY_LIMIT` (`err.quotaExceeded` is `true`), so tell the person the
feature is back tomorrow rather than retrying; a bigger plan includes more. DontCode picks the
model for the `intent` (`'quick'`, `'balanced'` (default) or `'thorough'`); you never name
one. Server only: a page calls your own route, which checks who is asking first, so one
person cannot use up everyone's day.

```ts
const tagline = await client.ai.generate({
    prompt: 'A tagline for a Seoul bakery',
    intent: 'quick',
})

// Past the app's daily AI limit
try {
    await client.ai.chat.send({ messages })
} catch (err) {
    if (isDontCodeError(err) && err.code === 'PAGE_AI_DAILY_LIMIT') {
        return reply('This feature is unavailable for the rest of today. Please try again tomorrow.')
    }
    throw err
}

const { content } = await client.ai.chat.send({ messages, system: 'Answer in Korean.' })

// As it is written (pipe the tokens into your own streamed response)
await client.ai.chat.stream({ messages }, { onToken: (t) => write(t) })

const { content: fields } = await client.ai.vision.analyze({
    prompt: 'Read the total and the date off this receipt',
    images: [receiptUrl], // http(s) URL, data: URI or base64
})

const { images } = await client.ai.image.generate({
    prompt: 'A cozy cafe at dawn',
    size: '1536x1024',
})
// images[0].url is hosted in the project's storage, permanently

// Speech: a recording (≤ 4 MB) in, text out; text (≤ 2,500 characters) in, an MP3 out
const { text } = await client.ai.speech.transcribe(await file.arrayBuffer(), { language: 'ko' })
const { audio } = await client.ai.speech.speak('주문이 접수되었습니다', {
    language: 'ko',
    voice: 'woman-clear',
})
return new Response(audio, { headers: { 'Content-Type': 'audio/mpeg' } }) // never store it

// Agents: the model calls your tools in a loop; they run on your server
const run = await client.ai.agent.run({
    messages: [{ role: 'user', content: 'Where is order 42?' }],
    tools: [
        {
            name: 'lookupOrder',
            description: 'Find an order by id',
            parameters: {
                type: 'object',
                properties: { id: { type: 'string' } },
                required: ['id'],
            },
            execute: async ({ id }) => db.orders.findFirst({ where: { id } }),
        },
    ],
})
// run.text, run.steps, run.finishReason: 'stop' | 'max-steps' | 'error'
```

Voices are `woman-friendly` (default), `woman-clear`, `man-friendly` and `man-clear` in
Korean, English, Chinese and Japanese. AI calls wait up to two minutes for an answer to
start (pass `timeoutMs` to change it); the `ai` budget is 300 calls a minute and only stops a
runaway loop, while the daily AI limit is the meter. Offline, the mock gateway answers every
call in the same shapes with no model and none of the day's AI used: chat echoes
`Mock answer to: …`, speech is a quarter second of silence.

## Errors

Every non-2xx response throws a `DontCodeError`:

```ts
import { DontCodeError, isDontCodeError } from 'dontcode'

try {
    await client.auth.login({ email, password })
} catch (err) {
    if (isDontCodeError(err)) {
        err.status // 401, 403, 409, 429, …
        err.code // e.g. 'EmailNotVerified', 'ChallengeExpired', 'EmailExistsException'
        err.didYouMean // a corrected email address on a signup refusal, when offered
        err.rateLimited // true when a rate limit refused the call
        err.retryAfter // seconds to wait, when the responder said
        err.quotaExceeded // true when the plan's quota for the period is used up: do not retry
        err.body // the full error envelope
    }
}
```

"One more step" auth states (`verification_required`, `mfa_required`) are **successful**
2xx responses, not errors; branch on the resolved value for those.

### Rate limits

Budgets are per project and per namespace (`db/read`, `db/write`, `auth`, `storage`,
`db/migrate`, …), so a chatty realtime loop cannot starve a migration. The client reports
what it last heard about each one, on **successful** responses as well as refusals, which is
the point: you can ease off before you are refused instead of discovering the ceiling by
hitting it.

```ts
const status = client.rateLimit.status('db/read')
// { namespace: 'db/read', limit: 900, remaining: 214, reset: 37, policy: '900;w=60', exceeded: false }

if (status && status.remaining !== undefined && status.remaining < status.limit * 0.2) {
    await sleep(status.reset * 1000) // let the window roll over before the next batch
}

client.rateLimit.status() // most recent namespace, whichever it was
client.rateLimit.all() // one entry per namespace this client has called
```

Database reads and writes are **separate budgets**, `db/read` and `db/write`, even though
both go to the same endpoint. Queries (`find`, `findMany`, `findFirst`, `findOne`, `count`)
count against the first; `insert`, `update` and `delete` against the second. A read loop
that exhausts its own budget therefore still leaves your writes free, so pace them
independently rather than treating "the database" as one number.

`undefined` means nothing has been counted for that namespace yet, which is different from
"the budget is empty". For long-running work prefer the callback, so pacing is a decision you
make on every response rather than something you remember to poll:

```ts
const client = dontcode({
    onRateLimit: (status) => {
        if (status.exceeded) pause(status.retryAfter ?? 60)
        else if (status.remaining === 0) pause(status.reset ?? 60)
    },
})
```

Throwing from `onRateLimit` cannot fail the request that triggered it.

On a refusal, `err.rateLimited` is `true`, `err.retryAfter` is the wait in seconds, and
`err.scope` names the budget that ran out. `rateLimited` checks the response body as well as
the status, so a refusal that arrives as something other than a `429` is still recognised as
one.

### Plan quotas

A plan also caps each period: a month's database reads and writes, a day's AI
(`PAGE_AI_DAILY_LIMIT`, see [AI](#ai)), and a day's and a month's emails. Once one is used up, those calls are refused with a `429` too, but a quota is not a rate
limit: waiting a few seconds does not clear it, only the period starting over or the owner moving
to a bigger plan does. The SDK tells them apart, so `err.quotaExceeded` is `true`,
`err.rateLimited` is `false` and `err.retryAfter` is `undefined`; the per-minute budget the
response still reports is not marked `exceeded`. Database reads and writes run out separately
(`err.code` is `DB_QUOTA_EXCEEDED`, and `err.message` says which), so the other kind keeps
working. Show the message to the owner rather than retrying:

```ts
try {
    await client.db.orders.insert({ total })
} catch (err) {
    if (isDontCodeError(err) && err.quotaExceeded) {
        return showOwner(err.message) // "This project has used this month's database writes on its plan."
    }
    throw err
}
```

### Payment errors

Payment calls (`client.payments.*`) throw the same `DontCodeError`. Forward
`err.message` to the buyer and branch on `err.code` so they see _why_ a charge
could not start, instead of a generic "something went wrong". Do not collapse a
`402` into a `500`: the status is meaningful, and the message is safe to show.

```ts
try {
    const reservation = await client.payments.reserveSubscription({ plan, userId, method })
} catch (err) {
    if (isDontCodeError(err)) {
        // err.status → 402, err.code → 'PAYMENTS_NOT_CONNECTED', err.message → the reason
        showToBuyer(err.message)
    }
}
```

The most common codes:

| `code`                        | Status | What it means                                                                    | How to resolve                                                                                                                           |
| ----------------------------- | ------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYMENTS_NOT_CONNECTED`      | 402    | The project has not connected its PortOne store, so it cannot take payments yet. | **App owner:** connect the PortOne store on the project's **Payments > Connect** tab; payments open as soon as PortOne accepts the keys. |
| `PAYMENTS_DISABLED`           | 402    | DontCode has switched payments off for this project.                             | Contact support.                                                                                                                         |
| `CHANNEL_NOT_CONNECTED`       | 400    | The owner has not connected a channel for this payment method or currency.       | **App owner:** add the channel under **More payment methods** on **Payments > Connect**, or offer another method.                        |
| `CHARGE_FAILED`               | 402    | The buyer's payment was declined.                                                | **Buyer:** retry or use a different payment method.                                                                                      |
| `PAYMENT_VERIFICATION_FAILED` | 402    | The completed payment could not be verified against the recorded amount.         | Confirm the amount and currency match the plan, then retry.                                                                              |
| `SUBSCRIPTION_NOT_FOUND`      | 404    | No subscription for that id/user, or it has no saved billing method.             | Re-reserve the subscription before confirming or charging.                                                                               |
| `BILLING_KEY_MISSING`         | 400    | The operation needs a saved billing method that is not present.                  | Complete the reserve then confirm flow so a billing method is stored.                                                                    |
| `RATE_LIMITED`                | 429    | Too many payment requests for this project.                                      | Back off and retry after `err.body.timeleft` seconds (`err.rateLimited` is `true`).                                                      |

`PAYMENTS_NOT_CONNECTED` is a setup state, not a bug: a brand-new project
returns it on every charge until its owner connects their own PortOne store on
the project's Payments > Connect tab. Payments then run on that store, so the
buyer's money settles to the owner directly, and your code never handles
PortOne keys. Surface that message so the owner knows to finish setup, rather
than logging it and showing the buyer a dead end.
