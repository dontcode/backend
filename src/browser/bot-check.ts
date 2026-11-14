import type { BotCheckWidget } from '../types'

/**
 * The render surface every supported vendor exposes. Turnstile, hCaptcha and
 * reCAPTCHA all take this shape, which is what lets one helper draw any of
 * them without your code naming one. Twin of @dontcode/auth's
 * src/client/components/bot-check.tsx.
 */
interface VendorGlobal {
    render: (
        container: HTMLElement,
        params: {
            sitekey: string
            callback: (token: string) => void
            'expired-callback'?: () => void
            'error-callback'?: () => void
        }
    ) => string | number | undefined
    reset: (widgetId?: string | number) => void
    remove?: (widgetId?: string | number) => void
}

const scriptPromises = new Map<string, Promise<void>>()

function vendorOf(widget: BotCheckWidget): VendorGlobal | undefined {
    return (window as unknown as Record<string, VendorGlobal | undefined>)[widget.globalName]
}

/** Load a vendor script once per page, however many forms ask for it. */
function loadVendorScript(widget: BotCheckWidget): Promise<void> {
    const existing = scriptPromises.get(widget.scriptUrl)
    if (existing) return existing

    const promise = new Promise<void>((resolve, reject) => {
        if (vendorOf(widget)) {
            resolve()
            return
        }
        const script = document.createElement('script')
        script.src = widget.scriptUrl
        script.async = true
        script.defer = true
        script.onload = () => {
            // `render=explicit` installs the global with the script, but a
            // vendor that installs it a tick later must not look like a failure.
            let attempts = 0
            const tick = () => {
                if (vendorOf(widget)) return resolve()
                if (attempts++ > 100)
                    return reject(new Error('Bot check script never became ready'))
                setTimeout(tick, 50)
            }
            tick()
        }
        script.onerror = () => {
            scriptPromises.delete(widget.scriptUrl)
            reject(new Error('Bot check script failed to load'))
        }
        document.head.appendChild(script)
    })

    scriptPromises.set(widget.scriptUrl, promise)
    return promise
}

export interface BotCheckCallbacks {
    /** The person passed the check: send this token as `captchaToken`. */
    onToken: (token: string) => void
    /** The token went stale before it was used: drop it, the widget asks again. */
    onExpire?: () => void
    /** The vendor could not check this person. */
    onError?: () => void
}

export interface BotCheck {
    /** Ask again, after a call came back with `captchaRequired` or the token was spent. */
    reset(): void
    /** Take the widget off the page. */
    remove(): void
}

/**
 * Draw the bot check `client.auth.captchaConfig()` described, into `container`
 * (an empty element on your form). Each token is good for one call: after a
 * submit, `reset()` for the next one.
 */
export async function renderBotCheck(
    container: HTMLElement,
    widget: BotCheckWidget,
    callbacks: BotCheckCallbacks
): Promise<BotCheck> {
    await loadVendorScript(widget)
    const vendor = vendorOf(widget)
    if (!vendor) throw new Error('Bot check script did not install its widget')
    const id = vendor.render(container, {
        sitekey: widget.siteKey,
        callback: (token) => callbacks.onToken(token),
        'expired-callback': () => callbacks.onExpire?.(),
        'error-callback': () => callbacks.onError?.(),
    })
    return {
        reset: () => vendor.reset(id),
        remove: () => {
            if (vendor.remove) vendor.remove(id)
            container.replaceChildren()
        },
    }
}
