/**
 * Node-only entry: the CLI / MCP building blocks (browser device-auth flow,
 * local credential cache, MCP server). Kept separate from the main entry so the
 * browser bundle never pulls in `node:fs` / `node:child_process`.
 */
export {
    login,
    openBrowser,
    pollDeviceToken,
    startDeviceAuth,
    type DeviceStartResponse,
    type DeviceTokenResponse,
    type LoginOptions,
    type PollOptions,
} from './auth-device'

export {
    clearCredential,
    isExpired,
    loadCredential,
    resolveActiveToken,
    saveCredential,
    type ActiveToken,
    type StoredCredential,
} from './credentials'

export { createMcpServer, startMcpServer } from './mcp/server'
