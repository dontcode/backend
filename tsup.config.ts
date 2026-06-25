import { defineConfig } from 'tsup'

export default defineConfig({
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
})
