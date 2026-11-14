import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { renderBotCheck } from '../dist/browser/index.js'

/**
 * `renderBotCheck` draws whatever vendor `captchaConfig()` names, through the
 * render surface Turnstile, hCaptcha and reCAPTCHA share. A fake window and
 * document stand in for the browser: the vendor's script "loads" by
 * installing its global, as the real one does.
 */

function fakeVendor() {
    const rendered = []
    return {
        rendered,
        reset: [],
        removed: [],
        render(container, params) {
            rendered.push({ container, params })
            return `widget-${rendered.length}`
        },
    }
}

function installBrowser({ vendorName, vendor, loads = true }) {
    const appended = []
    globalThis.window = {}
    globalThis.document = {
        createElement: () => ({}),
        head: {
            appendChild(script) {
                appended.push(script)
                setTimeout(() => {
                    if (!loads) return script.onerror()
                    globalThis.window[vendorName] = vendor
                    script.onload()
                }, 0)
            },
        },
    }
    return appended
}

afterEach(() => {
    delete globalThis.window
    delete globalThis.document
})

const WIDGET = {
    provider: 'turnstile',
    siteKey: 'site-key',
    scriptUrl: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
    globalName: 'turnstile',
}

describe('renderBotCheck', () => {
    it("loads the vendor's script once and renders with the site key", async () => {
        const vendor = fakeVendor()
        vendor.reset = (id) => (vendor.resetIds ??= []).push(id)
        const appended = installBrowser({ vendorName: 'turnstile', vendor })
        const container = { replaceChildren() {} }
        const tokens = []

        const check = await renderBotCheck(container, WIDGET, { onToken: (t) => tokens.push(t) })
        await renderBotCheck({ replaceChildren() {} }, WIDGET, { onToken: () => {} })

        assert.equal(appended.length, 1)
        assert.equal(appended[0].src, WIDGET.scriptUrl)
        assert.equal(vendor.rendered[0].container, container)
        assert.equal(vendor.rendered[0].params.sitekey, 'site-key')

        vendor.rendered[0].params.callback('passed-token')
        assert.deepEqual(tokens, ['passed-token'])

        check.reset()
        assert.deepEqual(vendor.resetIds, ['widget-1'])
    })

    it('tells the form when a token expires or the vendor errors', async () => {
        const vendor = fakeVendor()
        globalThis.window = { hcaptcha: vendor }
        globalThis.document = { createElement: () => ({}), head: { appendChild() {} } }
        const seen = []

        await renderBotCheck(
            { replaceChildren() {} },
            {
                ...WIDGET,
                globalName: 'hcaptcha',
                scriptUrl: 'https://js.hcaptcha.com/1/api.js?render=explicit',
            },
            {
                onToken: () => {},
                onExpire: () => seen.push('expired'),
                onError: () => seen.push('error'),
            }
        )
        vendor.rendered[0].params['expired-callback']()
        vendor.rendered[0].params['error-callback']()

        assert.deepEqual(seen, ['expired', 'error'])
    })

    it('fails plainly when the script cannot load, and tries again next time', async () => {
        const widget = {
            ...WIDGET,
            scriptUrl: 'https://example.invalid/blocked.js',
            globalName: 'blocked',
        }
        const vendor = fakeVendor()
        installBrowser({ vendorName: 'blocked', vendor, loads: false })

        await assert.rejects(
            () => renderBotCheck({}, widget, { onToken: () => {} }),
            /failed to load/
        )

        const appended = installBrowser({ vendorName: 'blocked', vendor })
        await renderBotCheck({ replaceChildren() {} }, widget, { onToken: () => {} })
        assert.equal(appended.length, 1)
    })

    it('takes the widget off the page', async () => {
        const vendor = fakeVendor()
        vendor.remove = (id) => vendor.removed.push(id)
        globalThis.window = { turnstile: vendor }
        globalThis.document = { createElement: () => ({}), head: { appendChild() {} } }
        let cleared = false

        const check = await renderBotCheck({ replaceChildren: () => (cleared = true) }, WIDGET, {
            onToken: () => {},
        })
        check.remove()

        assert.deepEqual(vendor.removed, ['widget-1'])
        assert.equal(cleared, true)
    })
})
