import { migrateFiles } from '../dist/node.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

/** Files as a map, a gateway that records what it was sent and fails on demand. */
function deps(files, { failOn, throwOn } = {}) {
    const sent = []
    return {
        sent,
        read: async (file) => {
            if (!(file in files)) throw new Error(`ENOENT: ${file}`)
            return files[file]
        },
        migrate: async (sql) => {
            sent.push(sql)
            if (sql === throwOn) throw new Error('network down')
            if (sql === failOn)
                return { success: false, error: 'Statement 1: The database only grows' }
            return { success: true, executedStatements: sql.split(';').length - 1, warnings: [] }
        },
        describe: (err) => (err instanceof Error ? err.message : String(err)),
    }
}

describe('migrateFiles (db_migrate files)', () => {
    it('sends each file as one migration, in the order given', async () => {
        const d = deps({ 'b.sql': 'B1;B2;', 'a.sql': 'A1;' })
        const result = await migrateFiles(['b.sql', 'a.sql'], d)
        assert.deepEqual(d.sent, ['B1;B2;', 'A1;'])
        assert.deepEqual(result, {
            ok: true,
            applied: [
                { file: 'b.sql', executedStatements: 2, warnings: [] },
                { file: 'a.sql', executedStatements: 1, warnings: [] },
            ],
        })
    })

    it('stops at the first refused file and names what was skipped', async () => {
        const d = deps(
            { '1.sql': 'ok;', '2.sql': 'DROP TABLE t;', '3.sql': 'later;' },
            { failOn: 'DROP TABLE t;' }
        )
        const result = await migrateFiles(['1.sql', '2.sql', '3.sql'], d)
        assert.equal(result.ok, false)
        assert.deepEqual(
            result.applied.map((a) => a.file),
            ['1.sql']
        )
        assert.deepEqual(result.failed, {
            file: '2.sql',
            error: 'Statement 1: The database only grows',
        })
        assert.deepEqual(result.skipped, ['3.sql'])
        assert.deepEqual(d.sent, ['ok;', 'DROP TABLE t;'])
    })

    it('stops when the gateway call throws', async () => {
        const d = deps({ '1.sql': 'boom;', '2.sql': 'later;' }, { throwOn: 'boom;' })
        const result = await migrateFiles(['1.sql', '2.sql'], d)
        assert.deepEqual(result.failed, { file: '1.sql', error: 'network down' })
        assert.deepEqual(result.skipped, ['2.sql'])
    })

    it('stops on a file it cannot read, before sending it', async () => {
        const d = deps({ '1.sql': 'ok;' })
        const result = await migrateFiles(['1.sql', 'missing.sql', '1.sql'], d)
        assert.equal(result.failed.file, 'missing.sql')
        assert.match(result.failed.error, /Could not read the file: ENOENT/)
        assert.deepEqual(d.sent, ['ok;'])
    })

    it('refuses an empty file rather than sending nothing', async () => {
        const d = deps({ 'empty.sql': '  \n ' })
        const result = await migrateFiles(['empty.sql'], d)
        assert.deepEqual(result.failed, { file: 'empty.sql', error: 'The file is empty.' })
        assert.deepEqual(d.sent, [])
    })
})
