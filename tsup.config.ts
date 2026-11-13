import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
    // The MCP server reports the release it ships in (src/mcp/server.ts).
    define: { __DONTCODE_VERSION__: JSON.stringify(version) },
    entry: {
        index: 'src/index.ts',
        node: 'src/node.ts',
        cli: 'src/cli.ts',
        'mcp/index': 'src/mcp/index.ts',
        'mock/index': 'src/mock/index.ts',
        'mock/cli': 'src/mock/cli.ts',
    },
    format: ['esm', 'cjs'],
    // Declarations are emitted by `tsc --emitDeclarationOnly` (see build script).
    // tsup's rollup-based dts bundler loads the full type graph into a single
    // worker thread and exhausts its heap on this project's type surface.
    dts: false,
    outDir: 'dist',
    sourcemap: true,
    clean: true,
    // Loaded lazily at runtime and shipped as an optional dependency; never bundle it.
    external: ['@electric-sql/pglite'],
    // Only the MCP server uses these, so they are bundled into it (dist/cli and
    // dist/mcp) and kept out of `dependencies`: an app that installs `dontcode`
    // for its client never installs the MCP SDK's HTTP stack (express, hono,
    // cors, …), and `npx -y dontcode mcp` still runs as it did.
    noExternal: ['@modelcontextprotocol/sdk', 'zod'],
})
