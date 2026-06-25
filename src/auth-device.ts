import { saveCredential, type StoredCredential } from './credentials'
import { DontCodeError } from './errors'
import { Transport } from './http'

/**
 * Client side of the browser device-authorization flow.
 *
 * The tool starts a flow, shows the user a short code and a URL, the user
 * approves in the browser while signed in, and the tool polls until it
 * receives a short-lived `dct_` access token. No long-lived secret ever
 * touches the terminal until the human has explicitly approved.
 */

const START_PATH = '/api/v1/auth/device/start'
const TOKEN_PATH = '/api/v1/auth/device/token'

export interface DeviceStartResponse {
    device_code: string
    user_code: string
    verification_uri: string
    verification_uri_complete: string
    interval: number
    expires_in: number
}

export interface DeviceTokenResponse {
    access_token: string
    token_type: string
    expires_in: number
    project_id: string
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function startDeviceAuth(
    baseUrl: string,
    clientName?: string
): Promise<DeviceStartResponse> {
    // No credential yet — this is the bootstrap step.
    const transport = new Transport({ baseUrl })
    return transport.json<DeviceStartResponse>(START_PATH, { client_name: clientName })
}

export interface PollOptions {
    onPending?: () => void
    /** Stop polling after this many ms (throws code `WaitTimeout`), so a caller
     *  like an MCP tool can poll in bounded slices instead of blocking for the
     *  full 10-minute window. Defaults to the request's own expiry. */
    maxWaitMs?: number
}

/**
 * Poll until the request is approved (token), denied/expired (throws), or the
 * wait budget closes (throws 408). Honors the server's interval and `slow_down`.
 */
export async function pollDeviceToken(
    baseUrl: string,
    start: DeviceStartResponse,
    opts: PollOptions = {}
): Promise<DeviceTokenResponse> {
    const transport = new Transport({ baseUrl })
    let intervalMs = Math.max(1, start.interval) * 1000
    const expiry = Date.now() + start.expires_in * 1000
    const deadline =
        opts.maxWaitMs && opts.maxWaitMs > 0
            ? Math.min(expiry, Date.now() + opts.maxWaitMs)
            : expiry

    while (Date.now() < deadline) {
        await sleep(intervalMs)
        try {
            return await transport.json<DeviceTokenResponse>(TOKEN_PATH, {
                device_code: start.device_code,
            })
        } catch (err) {
            if (err instanceof DontCodeError) {
                const message = err.body?.error ?? err.message
                if (err.status === 428 || message.includes('authorization_pending')) {
                    opts.onPending?.()
                    continue
                }
                if (message.includes('slow_down')) {
                    intervalMs += 2_000
                    continue
                }
            }
            throw err
        }
    }
    // Distinguish "your slice ended, keep waiting" from "the whole window closed".
    const stillOpen = Date.now() < expiry
    throw new DontCodeError(408, {
        error: stillOpen
            ? 'Still waiting for browser approval.'
            : 'Device login timed out before approval. Start again.',
        code: stillOpen ? 'WaitTimeout' : 'Timeout',
    })
}

/** Best-effort: open the verification URL in the user's browser. */
export async function openBrowser(url: string): Promise<void> {
    try {
        const { spawn } = await import('node:child_process')
        const platform = process.platform
        const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
        const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
        spawn(command, args, { stdio: 'ignore', detached: true }).unref()
    } catch {
        // Opening the browser is a convenience; the URL is also printed.
    }
}

export interface LoginOptions {
    baseUrl: string
    clientName?: string
    /** Open the browser automatically. Default true. */
    open?: boolean
    /** Where human-facing prompts go. Default: no-op. */
    log?: (message: string) => void
}

/**
 * Run the full device flow and cache the resulting credential. Returns the
 * stored credential (token, project, expiry).
 */
export async function login(options: LoginOptions): Promise<StoredCredential> {
    const log = options.log ?? (() => {})

    const start = await startDeviceAuth(options.baseUrl, options.clientName)
    log(
        `\nOpen this URL to connect:\n  ${start.verification_uri_complete}\n\n` +
            `Confirm this code matches:\n  ${start.user_code}\n\nWaiting for approval...\n`
    )
    if (options.open !== false) await openBrowser(start.verification_uri_complete)

    const token = await pollDeviceToken(options.baseUrl, start)
    const cred: StoredCredential = {
        access_token: token.access_token,
        project_id: token.project_id,
        expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
        base_url: options.baseUrl,
    }
    saveCredential(cred)
    return cred
}
