import { Transport } from './http'
import type {
    DeleteInput,
    MigrateInput,
    MigrateResult,
    QueryOptions,
    UpdateInput,
} from './types'

const DB_PATH = '/api/v1/db'
const MIGRATE_PATH = '/api/v1/db/migrate'

/** The gateway wraps every DB result in `{ data }`; we unwrap it. */
interface DbEnvelope<T> {
    data: T
}

/**
 * A handle to one table. Structured queries only; there is no raw-SQL escape
 * hatch (schema changes go through `db.migrate`). `update` and `delete`
 * require a `where` clause server-side, so the types make it mandatory.
 */
export class TableQuery {
    constructor(
        private readonly transport: Transport,
        private readonly tableName: string
    ) {}

    private async run<T>(operation: string, options: unknown): Promise<T> {
        const res = await this.transport.json<DbEnvelope<T>>(DB_PATH, {
            operation,
            tableName: this.tableName,
            options,
        })
        return res.data
    }

    /** Rows matching the query (max 1000 per call). */
    find<T = Record<string, unknown>>(options: QueryOptions = {}): Promise<T[]> {
        return this.run<T[]>('find', options)
    }

    /** Alias of `find`. */
    findMany<T = Record<string, unknown>>(options: QueryOptions = {}): Promise<T[]> {
        return this.run<T[]>('findMany', options)
    }

    /** The first matching row, or `null`. */
    findFirst<T = Record<string, unknown>>(options: QueryOptions = {}): Promise<T | null> {
        return this.run<T | null>('findFirst', options)
    }

    /** Alias of `findFirst`. */
    findOne<T = Record<string, unknown>>(options: QueryOptions = {}): Promise<T | null> {
        return this.run<T | null>('findOne', options)
    }

    /** Insert one row. Returns `{ id }`. Unique/FK conflicts throw a 409
     *  DontCodeError, the supported idempotency signal. */
    insert(data: Record<string, unknown>): Promise<{ id: unknown }> {
        return this.run<{ id: unknown }>('insert', { data })
    }

    /** Update rows matching `where`. Returns `{ count }`. */
    update(input: UpdateInput): Promise<{ count: number }> {
        return this.run<{ count: number }>('update', { where: input.where, data: input.data })
    }

    /** Delete rows matching `where`. Returns `{ count }`. */
    delete(input: DeleteInput): Promise<{ count: number }> {
        return this.run<{ count: number }>('delete', { where: input.where })
    }

    /** Count matching rows. */
    count(options: Pick<QueryOptions, 'where'> = {}): Promise<number> {
        return this.run<number>('count', options)
    }
}

/**
 * `db.users.find()` and `db('users').find()` both work; the bracket/callable
 * form is there for table names that aren't valid identifiers. `db.migrate()`
 * applies schema DDL (the one place migrations enter from outside).
 */
export type DbClient = {
    readonly [tableName: string]: TableQuery
} & {
    (tableName: string): TableQuery
    migrate(input: MigrateInput): Promise<MigrateResult>
}

export function createDb(transport: Transport): DbClient {
    const table = (tableName: string): TableQuery => new TableQuery(transport, tableName)
    const migrate = (input: MigrateInput): Promise<MigrateResult> =>
        transport.json<MigrateResult>(MIGRATE_PATH, { sql: input.sql })

    return new Proxy(table, {
        get(target, prop, receiver) {
            if (prop === 'migrate') return migrate
            // Don't manufacture a TableQuery for symbols or promise-unwrapping
            // probes (`then`) or the function's own members.
            if (typeof prop !== 'string' || prop === 'then' || prop in target) {
                return Reflect.get(target, prop, receiver)
            }
            return new TableQuery(transport, prop)
        },
        apply(_target, _thisArg, args: [string]) {
            return table(args[0])
        },
    }) as unknown as DbClient
}
