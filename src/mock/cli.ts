#!/usr/bin/env node
/**
 * `dontcode-mock` — start a local DontCode gateway for development.
 *
 *   npx dontcode-mock                       # http://localhost:4000, data in ./.dontcode-mock
 *   npx dontcode-mock --port 5000
 *   npx dontcode-mock --data-dir .dc        # persist elsewhere
 *   npx dontcode-mock --ephemeral           # in-memory, starts empty each run
 *   npx dontcode-mock --api-key dc_my_key   # require exactly this key
 *
 * Env equivalents: DONTCODE_MOCK_PORT, DONTCODE_MOCK_DATA_DIR, DONTCODE_MOCK_API_KEY.
 */
import { startMockServer, type MockServerOptions } from './server'

function parseArgs(argv: string[]): MockServerOptions & { help?: boolean } {
    const opts: MockServerOptions & { help?: boolean } = {}
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        const next = () => argv[++i]
        switch (arg) {
            case '-h':
            case '--help':
                opts.help = true
                break
            case '-p':
            case '--port':
                opts.port = Number(next())
                break
            case '--host':
                opts.host = next()
                break
            case '--data-dir':
                opts.dataDir = next()
                break
            case '--ephemeral':
                opts.dataDir = null
                break
            case '--api-key':
                opts.apiKey = next()
                break
            case '--schema':
                opts.schema = next()
                break
            case '--quiet':
                opts.quiet = true
                break
            default:
                console.error(`Unknown argument: ${arg}`)
                opts.help = true
        }
    }
    return opts
}

const HELP = `dontcode-mock — a local DontCode v1 gateway for development

Usage: dontcode-mock [options]

Options:
  -p, --port <n>       Port to listen on (default 4000)
      --host <host>    Interface to bind (default 127.0.0.1)
      --data-dir <dir> Where to persist state (default ./.dontcode-mock)
      --ephemeral      In-memory; start empty every run (good for tests)
      --api-key <key>  Require exactly this dc_ key (default: accept any dc_…)
      --schema <name>  Postgres schema for queries (default public)
      --quiet          No banner or request logging
  -h, --help           Show this help

Then point your app at it:
  DONTCODE_API_URL=http://localhost:4000
  DONTCODE_API_KEY=dc_local_dev
`

async function main() {
    const cli = parseArgs(process.argv.slice(2))
    if (cli.help) {
        console.log(HELP)
        process.exit(0)
    }

    const env = process.env
    const options: MockServerOptions = {
        port: cli.port ?? (env.DONTCODE_MOCK_PORT ? Number(env.DONTCODE_MOCK_PORT) : undefined),
        host: cli.host,
        dataDir: cli.dataDir !== undefined ? cli.dataDir : env.DONTCODE_MOCK_DATA_DIR,
        apiKey: cli.apiKey ?? env.DONTCODE_MOCK_API_KEY,
        schema: cli.schema,
        quiet: cli.quiet,
    }

    const server = await startMockServer(options)

    const shutdown = () => {
        server.close().finally(() => process.exit(0))
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
})
