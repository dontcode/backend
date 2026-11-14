import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
    clearOAuthStateCookie,
    dontcode,
    isDontCodeError,
    oauthStateMatches,
    readOAuthStateCookie,
    serializeOAuthStateCookie,
} from '../dist/index.js'
import { startMockServer } from '../dist/mock/index.js'

/**
 * What an Insight app's sign-in forms have, for a Backend app: the bot check
 * (announced only when the app says its forms draw it), the promotional
 * consent line, and social sign-in with the owner's provider apps. `fetch` is
 * mocked so nothing leaves the process, except the mock gateway block.
 */

let calls = []
let responses = []
const realFetch = globalThis.fetch

function respond(body = {}, status = 200) {
    responses.push({
        ok: status >= 200 && status < 300,
        status,
        statusText: 'mock',
        headers: new Headers(),
        text: async () => JSON.stringify(body),
    })
}

beforeEach(() => {
    calls = []
    responses = []
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init })
        return (
            responses.shift() ?? {
                ok: true,
                status: 200,
                statusText: 'mock',
                headers: new Headers(),
                text: async () => '{}',
            }
        )
    }
})

afterEach(() => {
    globalThis.fetch = realFetch
})

const client = (options = {}) => dontcode({ apiKey: 'dc_test', ...options })
const last = () => calls[calls.length - 1]
const bodyOf = (call) => JSON.parse(call.init.body)
const capabilities = (call) => call.init.headers['X-DontCode-Auth-Capabilities']

const FORM_CALLS = {
    signup: (c, extra) => c.auth.signup({ email: 'a@b.co', password: 'pw', ...extra }),
    login: (c, extra) => c.auth.login({ email: 'a@b.co', password: 'pw', ...extra }),
    forgotPassword: (c, extra) => c.auth.forgotPassword({ email: 'a@b.co', ...extra }),
    resetPassword: (c, extra) =>
        c.auth.resetPassword({ code: '123456', password: 'pw', email: 'a@b.co', ...extra }),
}

describe('bot check: what the app announces', () => {
    it('announces nothing by default, so no check is ever asked of forms without one', async () => {
        for (const run of Object.values(FORM_CALLS)) await run(client(), {})
        await client().auth.mfa.challenge({ challengeToken: 't', code: '1' })

        for (const call of calls) assert.equal(capabilities(call), undefined)
    })

    it('announces captcha on the four form calls with botCheck: true, and not the MFA form', async () => {
        const c = client({ botCheck: true })
        for (const run of Object.values(FORM_CALLS)) await run(c, {})
        assert.deepEqual(calls.map(capabilities), ['captcha', 'captcha', 'captcha', 'captcha'])

        await c.auth.mfa.challenge({ challengeToken: 't', code: '1' })
        assert.equal(capabilities(last()), undefined)
    })

    it('announces the MFA form too with botCheck: { mfa: true }', async () => {
        const c = client({ botCheck: { mfa: true } })
        await c.auth.login({ email: 'a@b.co', password: 'pw' })
        assert.equal(capabilities(last()), 'captcha,mfa-captcha')

        await c.auth.mfa.challenge({ challengeToken: 't', code: '1' })
        assert.equal(capabilities(last()), 'mfa-captcha')
    })

    it('never announces on calls that have no form check', async () => {
        const c = client({ botCheck: { mfa: true } })
        await c.auth.verifyEmail({ code: '1', email: 'a@b.co' })
        await c.auth.me({ accessToken: 'x' })
        await c.auth.requestAccountDeletion({ accessToken: 'x' })

        for (const call of calls) assert.equal(capabilities(call), undefined)
    })
})

describe("bot check: the widget's token", () => {
    for (const [name, run] of Object.entries(FORM_CALLS)) {
        it(`sends captcha_token on ${name}, and only when there is one`, async () => {
            await run(client(), { captchaToken: 'tok' })
            assert.equal(bodyOf(last()).captcha_token, 'tok')

            await run(client(), {})
            assert.equal('captcha_token' in bodyOf(last()), false)
        })
    }

    it('sends captcha_token on the MFA challenge', async () => {
        await client().auth.mfa.challenge({ challengeToken: 't', code: '1', captchaToken: 'tok' })
        assert.equal(bodyOf(last()).captcha_token, 'tok')
    })

    it('reads the widget config with a GET', async () => {
        const widget = {
            provider: 'turnstile',
            siteKey: 'site',
            scriptUrl: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
            globalName: 'turnstile',
        }
        respond({ enabled: true, surfaces: ['login', 'signup', 'password_reset'], widget })

        const config = await client().auth.captchaConfig()

        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/auth/captcha/config')
        assert.equal(last().init.method, 'GET')
        assert.deepEqual(config.widget, widget)
    })

    it('marks a refusal that wants the check as captchaRequired', async () => {
        respond(
            {
                success: false,
                error: 'Please complete the bot check and try again.',
                code: 'CaptchaRequired',
                captcha_required: true,
            },
            403
        )

        await assert.rejects(
            () => client({ botCheck: true }).auth.login({ email: 'a@b.co', password: 'pw' }),
            (err) => isDontCodeError(err) && err.captchaRequired && err.code === 'CaptchaRequired'
        )
    })

    it('does not mark an ordinary refusal as captchaRequired', async () => {
        respond({ error: 'Invalid email or password' }, 401)

        await assert.rejects(
            () => client().auth.login({ email: 'a@b.co', password: 'x' }),
            (err) => isDontCodeError(err) && err.captchaRequired === false
        )
    })
})

describe('promotional consent', () => {
    it('reads whether the sign-up form asks', async () => {
        respond({ promotionsOptIn: true })

        assert.deepEqual(await client().auth.signupForm(), { promotionsOptIn: true })
        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/auth/signup/form')
        assert.equal(last().init.method, 'GET')
    })

    it("sends the person's yes, and nothing for a no or no answer", async () => {
        await client().auth.signup({ email: 'a@b.co', password: 'pw', promotionsOptIn: true })
        assert.equal(bodyOf(last()).promotions_opt_in, true)

        await client().auth.signup({ email: 'a@b.co', password: 'pw', promotionsOptIn: false })
        assert.equal('promotions_opt_in' in bodyOf(last()), false)

        await client().auth.signup({ email: 'a@b.co', password: 'pw' })
        assert.equal('promotions_opt_in' in bodyOf(last()), false)
    })
})

describe('social sign-in', () => {
    const PROVIDERS = {
        providers: [
            { name: 'kakao', clientId: 'kakao-public' },
            { name: 'apple', clientId: 'com.shop.signin' },
        ],
    }

    it('reads the providers the owner turned on, and keeps them a minute', async () => {
        respond(PROVIDERS)
        const c = client()

        assert.deepEqual(await c.auth.oauth.providers(), PROVIDERS.providers)
        assert.deepEqual(await c.auth.oauth.providers(), PROVIDERS.providers)

        assert.equal(calls.length, 1)
        assert.equal(calls[0].url, 'https://backend.dontcode.co/api/v1/auth/oauth/providers')
    })

    it("builds Kakao's authorize URL with the owner's client id and the scopes DontCode needs", async () => {
        respond(PROVIDERS)

        const { url, state, formPost } = await client().auth.oauth.authorizeUrl({
            provider: 'kakao',
            redirectUri: 'https://shop.example/auth/callback/kakao',
        })

        const parsed = new URL(url)
        assert.equal(parsed.origin + parsed.pathname, 'https://kauth.kakao.com/oauth/authorize')
        assert.equal(parsed.searchParams.get('client_id'), 'kakao-public')
        assert.equal(
            parsed.searchParams.get('redirect_uri'),
            'https://shop.example/auth/callback/kakao'
        )
        assert.equal(parsed.searchParams.get('response_type'), 'code')
        assert.equal(parsed.searchParams.get('scope'), 'profile_nickname account_email')
        assert.equal(parsed.searchParams.get('state'), state)
        assert.match(state, /^[A-Za-z0-9_-]{43}$/)
        assert.equal(formPost, false)
    })

    it('asks Apple for a form POST, and says so', async () => {
        respond(PROVIDERS)

        const { url, formPost } = await client().auth.oauth.authorizeUrl({
            provider: 'apple',
            redirectUri: 'https://shop.example/auth/callback/apple',
            state: 'mine',
        })

        const parsed = new URL(url)
        assert.equal(parsed.searchParams.get('response_mode'), 'form_post')
        assert.equal(parsed.searchParams.get('state'), 'mine')
        assert.equal(formPost, true)
    })

    it('makes a fresh state every time', async () => {
        respond(PROVIDERS)
        const c = client()
        const a = await c.auth.oauth.authorizeUrl({
            provider: 'kakao',
            redirectUri: 'https://s.example/cb',
        })
        const b = await c.auth.oauth.authorizeUrl({
            provider: 'kakao',
            redirectUri: 'https://s.example/cb',
        })
        assert.notEqual(a.state, b.state)
    })

    it('refuses a provider the owner has not turned on', async () => {
        respond(PROVIDERS)

        await assert.rejects(
            () =>
                client().auth.oauth.authorizeUrl({
                    provider: 'google',
                    redirectUri: 'https://shop.example/cb',
                }),
            /google sign-in is not turned on/
        )
    })

    it("hands the code back with the redirect URI, the role and Apple's user field", async () => {
        respond({
            success: true,
            is_new_user: true,
            tokens: { AccessToken: 'jwt', ExpiresIn: 3600 },
        })

        const result = await client().auth.oauth.callback({
            provider: 'apple',
            code: 'c0de',
            redirectUri: 'https://shop.example/auth/callback/apple',
            role: 'buyer',
            appleUser: '{"name":{"firstName":"Ji"}}',
        })

        assert.equal(last().url, 'https://backend.dontcode.co/api/v1/auth/oauth/callback')
        assert.deepEqual(bodyOf(last()), {
            provider: 'apple',
            code: 'c0de',
            redirect_uri: 'https://shop.example/auth/callback/apple',
            role: 'buyer',
            user: '{"name":{"firstName":"Ji"}}',
        })
        assert.equal(result.tokens.AccessToken, 'jwt')
        assert.equal(result.is_new_user, true)
    })
})

describe('social sign-in: the state cookie', () => {
    it('keeps the state httpOnly for ten minutes, SameSite=Lax', () => {
        const cookie = serializeOAuthStateCookie('abc')
        assert.match(cookie, /^dc_oauth_state=abc; /)
        assert.match(cookie, /Max-Age=600/)
        assert.match(cookie, /SameSite=Lax/)
        assert.match(cookie, /HttpOnly/)
        assert.match(cookie, /Secure/)
    })

    it("lets Apple's cross-site form POST carry it back (SameSite=None; Secure)", () => {
        const cookie = serializeOAuthStateCookie('abc', { formPost: true })
        assert.match(cookie, /SameSite=None/)
        assert.match(cookie, /Secure/)
    })

    it('reads it back, clears it, and compares it', () => {
        assert.equal(readOAuthStateCookie('a=1; dc_oauth_state=xyz; b=2'), 'xyz')
        assert.match(clearOAuthStateCookie(), /Max-Age=0/)
        assert.equal(oauthStateMatches('xyz', 'xyz'), true)
        assert.equal(oauthStateMatches('xyz', 'xyw'), false)
        assert.equal(oauthStateMatches('xyz', null), false)
        assert.equal(oauthStateMatches('', ''), false)
    })
})

describe('mock gateway: auth reads', () => {
    it('answers "off" for the bot check, the consent line and social sign-in', async () => {
        globalThis.fetch = realFetch
        const mock = await startMockServer({ dataDir: null, quiet: true, port: 0 })
        try {
            const c = dontcode({ baseUrl: mock.url, apiKey: 'dc_test' })
            assert.deepEqual(await c.auth.captchaConfig(), {
                enabled: false,
                surfaces: [],
                widget: null,
            })
            assert.deepEqual(await c.auth.signupForm(), { promotionsOptIn: false })
            assert.deepEqual(await c.auth.oauth.providers(), [])
            await assert.rejects(
                () =>
                    c.auth.oauth.callback({
                        provider: 'kakao',
                        code: 'x',
                        redirectUri: 'http://localhost:3000/cb',
                    }),
                (err) => isDontCodeError(err) && err.status === 400
            )
        } finally {
            await mock.close()
        }
    })
})
