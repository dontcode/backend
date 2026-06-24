import { defineConfig } from 'tsup'

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        'mock/index': 'src/mock/index.ts',
        'mock/cli': 'src/mock/cli.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    outDir: 'dist',
    sourcemap: true,
    clean: true,
    // Loaded lazily at runtime and shipped as an optional dependency; never bundle it.
    external: ['@electric-sql/pglite'],
})
