/**
 * Local mock of the DontCode v1 gateway, for offline development and tests.
 *
 * Import it programmatically:
 *
 * ```ts
 * import { startMockServer } from '@dontcode2/backend/mock'
 * import { dontcode } from '@dontcode2/backend'
 *
 * const mock = await startMockServer({ dataDir: null }) // ephemeral
 * const client = dontcode({ baseUrl: mock.url, apiKey: 'dc_test' })
 * // … exercise client …
 * await mock.close()
 * ```
 *
 * Or run it as a server from the CLI: `npx dontcode-mock` (see `./cli`).
 */
export { startMockServer } from './server'
export type { MockServer, MockServerOptions } from './server'
