import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
    detectRepoName,
    login as runLogin,
    openBrowser,
    pollDeviceToken,
    startDeviceAuth,
    type DeviceStartResponse,
} from '../auth-device'
import { dontcode, type DontCodeClient } from '../client'
import {
    clearCredential,
    resolveActiveToken,
    saveCredential,
} from '../credentials'
import { isDontCodeError } from '../errors'

/**
 * DontCode Backend MCP server (stdio).
 *
 * Exposes the v1 gateway to an AI agent (Claude Code and others) as tools:
 * sign in by browser, query and mutate the project database, run migrations,
 * manage storage, and check the current session. Every tool is a thin call
 * onto the public SDK, so the agent can only do what the gateway allows — and,
 * for device-token sessions, only what the signed-in user's project role
 * allows.
 *
 * IMPORTANT: stdout is the MCP transport. All human-facing logging goes to
 * stderr (console.error), never console.log.
 */

const SERVER_NAME = 'dontcode-backend'
const SERVER_VERSION = '0.3.0'

function baseUrl(): string {
    return (process.env.DONTCODE_API_URL || 'https://backend.dontcode.co').replace(/\/+$/, '')
}

/** A login flow waiting to be polled by `auth_wait`, kept off the wire. */
let pendingFlow: DeviceStartResponse | null = null

function text(value: unknown) {
    const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    return { content: [{ type: 'text' as const, text: body }] }
}

function failure(message: string) {
    return { content: [{ type: 'text' as const, text: message }], isError: true }
}

/** Turn SDK errors into agent-friendly guidance without leaking internals. */
function describeError(err: unknown): string {
    if (isDontCodeError(err)) {
        if (err.status === 401) {
            return 'Not signed in or the session expired. Use the `auth_login` tool, approve in the browser, then `auth_wait`.'
        }
        if (err.status === 403) {
            return `Your project role does not allow that. (${err.message})`
        }
        if (err.rateLimited) {
            return `Rate limited. ${err.message}`
        }
        return err.message
    }
    return err instanceof Error ? err.message : 'Unknown error'
}

function requireClient(): DontCodeClient {
    const active = resolveActiveToken(baseUrl())
    if (!active.token) {
        throw new Error(
            'Not signed in. Use the `auth_login` tool first (or set DONTCODE_API_KEY for non-interactive use).'
        )
    }
    return dontcode({ apiKey: active.token, baseUrl: baseUrl() })
}

/** Run a tool body, mapping thrown errors to an MCP error result. */
async function run(fn: () => Promise<unknown>) {
    try {
        return text(await fn())
    } catch (err) {
        return failure(describeError(err))
    }
}

export function createMcpServer(): McpServer {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })

    // The MCP SDK infers each tool's argument type from its `inputSchema`
    // through deep conditional types. Across this many tools that inference
    // exhausts tsc's heap during declaration emit (TS2589). The gateway
    // re-validates every call, so these handlers never rely on the inferred
    // types — register through a thin wrapper that keeps inference shallow.
    const tool = (
        name: string,
        config: {
            title: string
            description: string
            inputSchema?: z.ZodRawShape
            annotations?: Record<string, boolean>
        },
        handler: (args: Record<string, any>) => Promise<unknown>
    ) => server.registerTool(name, config as never, handler as never)

    // --- Authentication ----------------------------------------------------

    tool(
        'auth_login',
        {
            title: 'Sign in to DontCode',
            description:
                'Start a browser sign-in. Returns a URL and a short code; tell the user to open the URL, confirm the code matches, pick a project, and approve. Then call `auth_wait`. Not needed if DONTCODE_API_KEY is set.',
            inputSchema: {
                client_name: z
                    .string()
                    .optional()
                    .describe('Label shown to the user on the approval screen, e.g. "Claude Code".'),
            },
            annotations: { readOnlyHint: false, openWorldHint: true },
        },
        async ({ client_name }) =>
            run(async () => {
                const start = await startDeviceAuth(
                    baseUrl(),
                    client_name ?? 'Claude Code (MCP)',
                    await detectRepoName()
                )
                pendingFlow = start
                await openBrowser(start.verification_uri_complete)
                return {
                    message:
                        'Ask the user to open this URL, confirm the code, choose a project, and approve. Then call auth_wait.',
                    verification_uri: start.verification_uri_complete,
                    user_code: start.user_code,
                    expires_in_seconds: start.expires_in,
                }
            })
    )

    tool(
        'auth_wait',
        {
            title: 'Wait for sign-in approval',
            description:
                'Poll for the result of `auth_login`. Returns connected once the user approves in the browser, or asks you to call it again if still pending. Safe to call repeatedly.',
            inputSchema: {},
            annotations: { readOnlyHint: false, openWorldHint: true },
        },
        async () =>
            run(async () => {
                if (!pendingFlow) {
                    return { status: 'no_login_in_progress', hint: 'Call auth_login first.' }
                }
                try {
                    const token = await pollDeviceToken(baseUrl(), pendingFlow, {
                        maxWaitMs: 50_000,
                    })
                    saveCredential({
                        access_token: token.access_token,
                        project_id: token.project_id,
                        expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
                        base_url: baseUrl(),
                    })
                    pendingFlow = null
                    return { status: 'connected', project_id: token.project_id }
                } catch (err) {
                    if (isDontCodeError(err) && err.code === 'WaitTimeout') {
                        return {
                            status: 'pending',
                            hint: 'Still waiting for approval. Ask the user to approve, then call auth_wait again.',
                        }
                    }
                    pendingFlow = null
                    throw err
                }
            })
    )

    tool(
        'auth_status',
        {
            title: 'Check the current session',
            description:
                'Validate the current credential and report the project, your role, and what you are allowed to do.',
            inputSchema: {},
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async () =>
            run(async () => {
                const active = resolveActiveToken(baseUrl())
                if (!active.token) {
                    return { signed_in: false, hint: 'Use auth_login to sign in.' }
                }
                const client = dontcode({ apiKey: active.token, baseUrl: baseUrl() })
                // /api/v1/info is a thin GET; reuse the transport via a raw call.
                const info = await client.auth.info()
                return { signed_in: true, source: active.source, ...info }
            })
    )

    tool(
        'auth_logout',
        {
            title: 'Forget the cached session',
            description: 'Remove the locally cached device token for this gateway.',
            inputSchema: {},
            annotations: { readOnlyHint: false, destructiveHint: true },
        },
        async () =>
            run(async () => {
                clearCredential(baseUrl())
                pendingFlow = null
                return { ok: true }
            })
    )

    // --- Database ----------------------------------------------------------

    tool(
        'db_query',
        {
            title: 'Query the database',
            description:
                'Read rows from a table with a structured query (no raw SQL). Supports where/select/orderBy/limit/offset and count.',
            inputSchema: {
                table: z.string(),
                operation: z
                    .enum(['find', 'findMany', 'findFirst', 'findOne', 'count'])
                    .default('find'),
                where: z.record(z.string(), z.any()).optional(),
                select: z.array(z.string()).optional(),
                orderBy: z.record(z.string(), z.enum(['asc', 'desc'])).optional(),
                limit: z.number().int().positive().max(1000).optional(),
                offset: z.number().int().nonnegative().optional(),
            },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async ({ table, operation, where, select, orderBy, limit, offset }) =>
            run(async () => {
                const t = requireClient().db(table)
                if (operation === 'count') return { count: await t.count({ where }) }
                const options = { where, select, orderBy, limit, offset }
                if (operation === 'findFirst' || operation === 'findOne') {
                    return { row: await t.findFirst(options) }
                }
                return { rows: await t.find(options) }
            })
    )

    tool(
        'db_insert',
        {
            title: 'Insert a row',
            description: 'Insert one row into a table. Returns the new row id.',
            inputSchema: { table: z.string(), data: z.record(z.string(), z.any()) },
            annotations: { readOnlyHint: false, openWorldHint: true },
        },
        async ({ table, data }) => run(async () => requireClient().db(table).insert(data))
    )

    tool(
        'db_update',
        {
            title: 'Update rows',
            description: 'Update rows matching a where clause. Returns the number of rows changed.',
            inputSchema: {
                table: z.string(),
                where: z.record(z.string(), z.any()),
                data: z.record(z.string(), z.any()),
            },
            annotations: { readOnlyHint: false, openWorldHint: true },
        },
        async ({ table, where, data }) =>
            run(async () => requireClient().db(table).update({ where, data }))
    )

    tool(
        'db_delete',
        {
            title: 'Delete rows',
            description:
                'Delete rows matching a where clause. Destructive: confirm with the user before calling. Returns the number of rows deleted.',
            inputSchema: { table: z.string(), where: z.record(z.string(), z.any()) },
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        },
        async ({ table, where }) => run(async () => requireClient().db(table).delete({ where }))
    )

    tool(
        'db_migrate',
        {
            title: 'Run a schema migration',
            description:
                'Apply DDL (CREATE/ALTER/DROP TABLE, indexes, etc.) to the project database. Destructive and schema-shaping: confirm with the user, and note it needs an admin/owner role on device-token sessions.',
            inputSchema: { sql: z.string() },
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        },
        async ({ sql }) => run(async () => requireClient().db.migrate({ sql }))
    )

    // --- Storage -----------------------------------------------------------

    const bucketArg = z.enum(['public', 'private']).default('private')
    const bucketOf = (client: DontCodeClient, bucket: 'public' | 'private') =>
        bucket === 'public' ? client.storage.public : client.storage.private

    tool(
        'storage_list',
        {
            title: 'List files',
            description: 'List objects in a storage bucket, optionally under a prefix.',
            inputSchema: { bucket: bucketArg, prefix: z.string().optional() },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async ({ bucket, prefix }) =>
            run(async () => bucketOf(requireClient(), bucket).list(prefix))
    )

    tool(
        'storage_get_url',
        {
            title: 'Get a public URL',
            description: 'Get the permanent public URL for an object in the public bucket.',
            inputSchema: { path: z.string() },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async ({ path }) => run(async () => requireClient().storage.public.getUrl(path))
    )

    tool(
        'storage_temporary_url',
        {
            title: 'Get a temporary URL',
            description: 'Get a short-lived signed URL for an object (default 300s, max 7 days).',
            inputSchema: {
                bucket: bucketArg,
                path: z.string(),
                expires_in: z.number().int().positive().optional(),
            },
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async ({ bucket, path, expires_in }) =>
            run(async () => bucketOf(requireClient(), bucket).getTemporaryUrl(path, expires_in))
    )

    tool(
        'storage_upload',
        {
            title: 'Upload a text file',
            description:
                'Upload UTF-8 text content to a path. For binary or large files, use storage_temporary_url + a direct PUT instead.',
            inputSchema: {
                bucket: bucketArg,
                path: z.string(),
                content: z.string(),
                content_type: z.string().optional(),
            },
            annotations: { readOnlyHint: false, openWorldHint: true },
        },
        async ({ bucket, path, content, content_type }) =>
            run(async () =>
                bucketOf(requireClient(), bucket).upload(
                    path,
                    content,
                    content_type ?? 'text/plain'
                )
            )
    )

    tool(
        'storage_remove',
        {
            title: 'Delete files',
            description: 'Delete one or more objects. Destructive: confirm with the user.',
            inputSchema: { bucket: bucketArg, paths: z.array(z.string()).min(1) },
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        },
        async ({ bucket, paths }) => run(async () => bucketOf(requireClient(), bucket).remove(paths))
    )

    tool(
        'storage_move',
        {
            title: 'Move or rename a file',
            description: 'Move/rename an object within a bucket.',
            inputSchema: { bucket: bucketArg, from: z.string(), to: z.string() },
            annotations: { readOnlyHint: false, openWorldHint: true },
        },
        async ({ bucket, from, to }) =>
            run(async () => bucketOf(requireClient(), bucket).move(from, to))
    )

    return server
}

/** Entry point used by the `dontcode mcp` CLI command. */
export async function startMcpServer(): Promise<void> {
    const server = createMcpServer()
    const transport = new StdioServerTransport()
    await server.connect(transport)
    console.error(`[${SERVER_NAME}] MCP server ready on stdio (gateway: ${baseUrl()})`)
}

// Re-export so a programmatic caller can drive the device flow too.
export { runLogin as login }
