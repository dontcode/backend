import { createMcpServer } from '../dist/mcp/index.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

/**
 * What an AI tool learns about the MCP server when it connects: the release it
 * is talking to and the tools it may call. Both have drifted before (the
 * server said 0.3.0 while the package was 0.2.15), so they are pinned to the
 * package's own files here.
 */

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

async function connect() {
    const server = createMcpServer()
    const client = new Client({ name: 'mcp-server-test', version: '0.0.0' })
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverSide), client.connect(clientSide)])
    return client
}

describe('the MCP server as an AI tool sees it', () => {
    it("reports the package's own version", async () => {
        const mcp = await connect()
        assert.deepEqual(mcp.getServerVersion(), { name: 'dontcode-backend', version: pkg.version })
        await mcp.close()
    })

    it("serves exactly the tools the README's MCP section lists", async () => {
        const section = readme.split('## MCP server')[1].split('\n## ')[0]
        const listed = section
            .split('Tools:')[1]
            .split('.')[0]
            .match(/`([a-z_]+)`/g)
            .map((name) => name.slice(1, -1))

        const mcp = await connect()
        const { tools } = await mcp.listTools()
        assert.deepEqual(tools.map((t) => t.name).sort(), [...listed].sort())
        await mcp.close()
    })
})
