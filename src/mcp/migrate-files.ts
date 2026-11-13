import type { MigrateResult } from '../types'

/**
 * Applies migration files one by one, in the order given, and stops at the
 * first that fails: the db_migrate tool's `files` form. A file is one
 * migration (one transaction on the gateway), so a project's schema and seed
 * files reach its database without the agent pasting their SQL into a tool
 * call. Reading and sending are passed in so this stays testable and the MCP
 * server keeps its file access in one place.
 */

export type MigrateFilesDeps = {
    read(file: string): Promise<string>
    migrate(sql: string): Promise<MigrateResult>
    describe(err: unknown): string
}

export type MigratedFile = { file: string; executedStatements: number; warnings: string[] }

export type MigrateFilesResult =
    | { ok: true; applied: MigratedFile[] }
    | {
          ok: false
          applied: MigratedFile[]
          failed: { file: string; error: string }
          /** The files after the one that failed, not sent. */
          skipped: string[]
      }

export async function migrateFiles(
    files: readonly string[],
    deps: MigrateFilesDeps
): Promise<MigrateFilesResult> {
    const applied: MigratedFile[] = []
    for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const stop = (error: string): MigrateFilesResult => ({
            ok: false,
            applied,
            failed: { file, error },
            skipped: files.slice(i + 1),
        })
        let sql: string
        try {
            sql = await deps.read(file)
        } catch (err) {
            return stop(`Could not read the file: ${deps.describe(err)}`)
        }
        if (!sql.trim()) return stop('The file is empty.')
        try {
            const result = await deps.migrate(sql)
            if (result.success === false) return stop(result.error ?? 'Migration failed')
            applied.push({
                file,
                executedStatements: result.executedStatements ?? 0,
                warnings: result.warnings ?? [],
            })
        } catch (err) {
            return stop(deps.describe(err))
        }
    }
    return { ok: true, applied }
}
