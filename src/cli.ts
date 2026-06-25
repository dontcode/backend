#!/usr/bin/env node
/**
 * `dontcode` — the developer CLI for DontCode Backend.
 *
 *   dontcode mcp                 # run the MCP server on stdio (for Claude Code etc.)
 *   dontcode login               # sign in via the browser, cache a device token
 *   dontcode logout              # forget the cached token
 *   dontcode status              # show the current session
 *
 * The gateway origin comes from DONTCODE_API_URL (default https://backend.dontcode.co).
 * For non-interactive use, set DONTCODE_API_KEY and skip `login` entirely.
 */
import { login } from './auth-device'
import { clearCredential, resolveActiveToken } from './credentials'
import { dontcode } from './client'
import { isDontCodeError } from './errors'
import { startMcpServer } from './mcp/server'

function baseUrl(): string {
    return (process.env.DONTCODE_API_URL || 'https://backend.dontcode.co').replace(/\/+$/, '')
}

const HELP = `dontcode — developer CLI for DontCode Backend

Usage: dontcode <command>

Commands:
  mcp        Run the MCP server on stdio (configure this in your AI tool)
  login      Sign in through the browser and cache a short-lived token
  logout     Remove the cached token for the current gateway
  status     Show the current session (project, role, capabilities)
  help       Show this help

Environment:
  DONTCODE_API_URL   Gateway origin (default https://backend.dontcode.co)
  DONTCODE_API_KEY   A dc_ project key for non-interactive use (skips login)
  DONTCODE_CONFIG_DIR  Where the cached token lives (default ~/.dontcode)
`

async function cmdLogin(): Promise<void> {
    const cred = await login({
        baseUrl: baseUrl(),
        clientName: 'dontcode CLI',
        log: (m) => process.stderr.write(m),
    })
    process.stderr.write(
        `\nSigned in. Project ${cred.project_id}, token valid until ${cred.expires_at}.\n`
    )
}

async function cmdStatus(): Promise<void> {
    const active = resolveActiveToken(baseUrl())
    if (!active.token) {
        process.stdout.write('Not signed in. Run `dontcode login`.\n')
        return
    }
    try {
        const info = await dontcode({ apiKey: active.token, baseUrl: baseUrl() }).auth.info()
        process.stdout.write(
            JSON.stringify({ source: active.source, ...info }, null, 2) + '\n'
        )
    } catch (err) {
        const message = isDontCodeError(err) ? err.message : String(err)
        process.stdout.write(`Session invalid: ${message}\n`)
    }
}

async function main(): Promise<void> {
    const command = process.argv[2]
    switch (command) {
        case 'mcp':
            await startMcpServer()
            break
        case 'login':
            await cmdLogin()
            break
        case 'logout':
            clearCredential(baseUrl())
            process.stdout.write('Signed out.\n')
            break
        case 'status':
            await cmdStatus()
            break
        case undefined:
        case 'help':
        case '-h':
        case '--help':
            process.stdout.write(HELP)
            break
        default:
            process.stderr.write(`Unknown command: ${command}\n\n${HELP}`)
            process.exit(1)
    }
}

main().catch((err) => {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n')
    process.exit(1)
})
