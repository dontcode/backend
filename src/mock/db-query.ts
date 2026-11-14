/**
 * Structured-query executor for the local mock's /api/v1/db endpoint.
 *
 * This is a faithful port of the platform gateway's executor: it speaks the
 * exact `{ operation, tableName, options }` wire protocol and produces the same
 * `{ data }` envelopes and status codes (notably 409 on unique/FK conflict, the
 * idempotency signal the SDK relies on). Keeping the SQL generation identical to
 * production is the whole point — a query that works against the mock works
 * against the real gateway and vice versa.
 *
 * The only difference from the platform copy is the database handle: instead of
 * a pooled `pg` connection it runs against any `Queryable` (the mock backs this
 * with in-process Postgres via PGlite), so there are no external services.
 */

export type WhereOperator = {
    equals?: unknown
    not?: unknown
    gt?: unknown
    gte?: unknown
    lt?: unknown
    lte?: unknown
    in?: unknown[]
    notIn?: unknown[]
    contains?: string
    startsWith?: string
    endsWith?: string
    mode?: 'default' | 'insensitive'
}

export type WhereClause = {
    [key: string]: unknown
    AND?: WhereClause[]
    OR?: WhereClause[]
    NOT?: WhereClause
}

export type OrderByClause = Record<string, 'asc' | 'desc'>

export interface QueryOptions {
    where?: WhereClause
    select?: string[]
    orderBy?: OrderByClause
    limit?: number
    offset?: number
    include?: unknown
    data?: Record<string, unknown>
}

/** The subset of a Postgres driver this executor needs. PGlite satisfies it. */
export interface Queryable {
    query(
        sql: string,
        params?: unknown[]
    ): Promise<{ rows: Array<Record<string, unknown>>; affectedRows?: number }>
}

export type DbResult =
    | { status: number; body: { data: unknown } }
    | { status: number; body: { error: string } }

class QueryValidationError extends Error {}

/** Identifiers (tables, columns) — never parameterizable, so strictly validated. */
function ident(name: string): string {
    if (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        throw new QueryValidationError(`Invalid identifier: ${JSON.stringify(name)}`)
    }
    return `"${name}"`
}

function buildWhereClause(
    where: WhereClause,
    startParamIndex = 1
): { clause: string; values: unknown[] } {
    const conditions: string[] = []
    const values: unknown[] = []
    let paramIndex = startParamIndex

    for (const [key, value] of Object.entries(where)) {
        if (key === 'AND' && Array.isArray(value)) {
            const subClauses = value.map((subWhere) => {
                const result = buildWhereClause(subWhere, paramIndex)
                paramIndex += result.values.length
                values.push(...result.values)
                return result.clause.replace('WHERE ', '')
            })
            if (subClauses.length > 0) conditions.push(`(${subClauses.join(' AND ')})`)
            continue
        }

        if (key === 'OR' && Array.isArray(value)) {
            const subClauses = value.map((subWhere) => {
                const result = buildWhereClause(subWhere, paramIndex)
                paramIndex += result.values.length
                values.push(...result.values)
                return result.clause.replace('WHERE ', '')
            })
            if (subClauses.length > 0) conditions.push(`(${subClauses.join(' OR ')})`)
            continue
        }

        if (key === 'NOT' && value && typeof value === 'object') {
            const result = buildWhereClause(value as WhereClause, paramIndex)
            paramIndex += result.values.length
            values.push(...result.values)
            const notClause = result.clause.replace('WHERE ', '')
            if (notClause) conditions.push(`NOT (${notClause})`)
            continue
        }

        const column = ident(key)

        if (value === null) {
            conditions.push(`${column} IS NULL`)
            continue
        }

        if (Array.isArray(value)) {
            if (value.length === 0) {
                conditions.push('FALSE')
            } else {
                const placeholders = value.map(() => `$${paramIndex++}`).join(', ')
                conditions.push(`${column} IN (${placeholders})`)
                values.push(...value)
            }
            continue
        }

        if (value && typeof value === 'object' && !(value instanceof Date)) {
            const operators = value as WhereOperator
            const like = operators.mode === 'insensitive' ? 'ILIKE' : 'LIKE'

            for (const [operator, operatorValue] of Object.entries(operators)) {
                if (operator === 'mode') continue

                switch (operator) {
                    case 'equals':
                    case 'eq':
                        if (operatorValue === null) {
                            conditions.push(`${column} IS NULL`)
                        } else {
                            conditions.push(`${column} = $${paramIndex++}`)
                            values.push(operatorValue)
                        }
                        break

                    case 'not':
                        if (operatorValue === null) {
                            conditions.push(`${column} IS NOT NULL`)
                        } else if (Array.isArray(operatorValue)) {
                            if (operatorValue.length === 0) {
                                conditions.push('TRUE')
                            } else {
                                const placeholders = operatorValue
                                    .map(() => `$${paramIndex++}`)
                                    .join(', ')
                                conditions.push(`${column} NOT IN (${placeholders})`)
                                values.push(...operatorValue)
                            }
                        } else {
                            conditions.push(`${column} != $${paramIndex++}`)
                            values.push(operatorValue)
                        }
                        break

                    case 'gt':
                        conditions.push(`${column} > $${paramIndex++}`)
                        values.push(operatorValue)
                        break

                    case 'gte':
                        conditions.push(`${column} >= $${paramIndex++}`)
                        values.push(operatorValue)
                        break

                    case 'lt':
                        conditions.push(`${column} < $${paramIndex++}`)
                        values.push(operatorValue)
                        break

                    case 'lte':
                        conditions.push(`${column} <= $${paramIndex++}`)
                        values.push(operatorValue)
                        break

                    case 'in':
                        if (!Array.isArray(operatorValue) || operatorValue.length === 0) {
                            conditions.push('FALSE')
                        } else {
                            const placeholders = operatorValue
                                .map(() => `$${paramIndex++}`)
                                .join(', ')
                            conditions.push(`${column} IN (${placeholders})`)
                            values.push(...operatorValue)
                        }
                        break

                    case 'notIn':
                        if (!Array.isArray(operatorValue) || operatorValue.length === 0) {
                            conditions.push('TRUE')
                        } else {
                            const placeholders = operatorValue
                                .map(() => `$${paramIndex++}`)
                                .join(', ')
                            conditions.push(`${column} NOT IN (${placeholders})`)
                            values.push(...operatorValue)
                        }
                        break

                    case 'contains':
                        conditions.push(`${column} ${like} $${paramIndex++}`)
                        values.push(`%${operatorValue}%`)
                        break

                    case 'startsWith':
                        conditions.push(`${column} ${like} $${paramIndex++}`)
                        values.push(`${operatorValue}%`)
                        break

                    case 'endsWith':
                        conditions.push(`${column} ${like} $${paramIndex++}`)
                        values.push(`%${operatorValue}`)
                        break

                    default:
                        throw new QueryValidationError(`Unsupported operator: ${operator}`)
                }
            }
            continue
        }

        conditions.push(`${column} = $${paramIndex++}`)
        values.push(value)
    }

    return {
        clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
        values,
    }
}

function buildOrderByClause(orderBy?: OrderByClause): string {
    if (!orderBy) return ''
    const orders = Object.entries(orderBy).map(([col, dir]) => {
        if (dir !== 'asc' && dir !== 'desc') {
            throw new QueryValidationError(`Invalid sort direction: ${JSON.stringify(dir)}`)
        }
        return `${ident(col)} ${dir.toUpperCase()}`
    })
    return `ORDER BY ${orders.join(', ')}`
}

function buildSelectColumns(select?: string[]): string {
    if (!select || select.length === 0) return '*'
    return select.map(ident).join(', ')
}

function clampInt(value: unknown, max: number): number | null {
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) return null
    return Math.min(Math.floor(n), max)
}

const MAX_LIMIT = 1000

interface PgError {
    code?: string
    message?: string
}

function errorResult(err: unknown): DbResult {
    if (err instanceof QueryValidationError) {
        return { status: 400, body: { error: err.message } }
    }

    const pgErr = err as PgError
    const message = pgErr.message ?? 'Database error'

    // Constraint conflicts get 409 so idempotent insert patterns
    // (insert → on 409 fetch existing) work without raw-SQL upserts.
    if (pgErr.code === '23505' || pgErr.code === '23503') {
        return { status: 409, body: { error: message } }
    }
    // Undefined table/column — the caller's own schema mistake.
    if (pgErr.code === '42P01' || pgErr.code === '42703') {
        return { status: 400, body: { error: message } }
    }

    return { status: 500, body: { error: message } }
}

function rowCount(result: { rows: unknown[]; affectedRows?: number }): number {
    // RETURNING * makes rows reflect the affected set; affectedRows is the
    // authoritative driver count when present.
    return result.affectedRows ?? result.rows.length
}

// ── include: related rows (@dontcode/db's include, src/server/include-resolver.ts) ──

/** What one include key asks for: `true`, or the related rows' own filter and shape. */
export interface IncludeOptions {
    where?: WhereClause
    orderBy?: OrderByClause
    limit?: number
    include?: IncludeClause
}

export type IncludeClause = Record<string, boolean | IncludeOptions>

/** How deep includes may nest (posts → comments → author ...), as in @dontcode/db. */
const MAX_INCLUDE_DEPTH = 5

/** Operations that read rows, and so can bring their related rows along. */
const INCLUDE_OPERATIONS: ReadonlySet<string> = new Set([
    'find',
    'findMany',
    'findFirst',
    'findOne',
])

/** A rank column no table of the caller's can collide with. */
const RANK_COLUMN = '__dontcode_include_rank'

interface ForeignKey {
    sourceTable: string
    sourceColumn: string
    targetTable: string
    targetColumn: string
}

interface Relation {
    /** forward: this row's `<key>_id` names one row; reverse: a table named `<key>` points here. */
    type: 'forward' | 'reverse'
    sourceTable: string
    sourceColumn: string
    targetTable: string
    targetColumn: string
}

/** A schema's foreign keys, read from the catalog. They change only with a migration. */
const foreignKeyCache = new Map<string, { at: number; keys: readonly ForeignKey[] }>()
const FOREIGN_KEY_TTL_MS = 5 * 60_000

async function getForeignKeys(db: Queryable, schema: string): Promise<readonly ForeignKey[]> {
    const cached = foreignKeyCache.get(schema)
    if (cached && Date.now() - cached.at < FOREIGN_KEY_TTL_MS) return cached.keys

    const result = await db.query(
        `SELECT kcu.table_name AS source_table, kcu.column_name AS source_column,
                ccu.table_name AS target_table, ccu.column_name AS target_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1`,
        [schema]
    )
    const keys = result.rows.map((row) => ({
        sourceTable: String(row.source_table),
        sourceColumn: String(row.source_column),
        targetTable: String(row.target_table),
        targetColumn: String(row.target_column),
    }))
    foreignKeyCache.set(schema, { at: Date.now(), keys })
    return keys
}

/**
 * The relation an include key names, by @dontcode/db's rule: `author` on posts
 * is the row posts.author_id points at (forward, one row or null); `comments`
 * on posts is every comments row whose foreign key points at the post
 * (reverse, a list).
 */
function resolveRelation(table: string, key: string, keys: readonly ForeignKey[]): Relation {
    const forward = keys.find((fk) => fk.sourceTable === table && fk.sourceColumn === `${key}_id`)
    if (forward) return { type: 'forward', ...forward }
    const reverse = keys.find((fk) => fk.targetTable === table && fk.sourceTable === key)
    if (reverse) return { type: 'reverse', ...reverse }
    throw new QueryValidationError(
        `Cannot resolve include "${key}" on table "${table}". No foreign key relationship found. ` +
            `Check that column "${key}_id" on "${table}" references another table, or that table ` +
            `"${key}" has a foreign key pointing to "${table}".`
    )
}

/** The caller's include, checked: an object of keys, each `true`, `false` or options. */
function parseInclude(raw: unknown): IncludeClause | null {
    if (raw === undefined || raw === null) return null
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        if (Array.isArray(raw) && raw.length === 0) return null
        throw new QueryValidationError(
            'include is { relation: true } or { relation: { where, orderBy, limit, include } }'
        )
    }
    const clause: IncludeClause = {}
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        ident(key)
        if (typeof value === 'boolean') {
            clause[key] = value
            continue
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new QueryValidationError(
                `include.${key} is true or { where, orderBy, limit, include }`
            )
        }
        const options = value as Record<string, unknown>
        for (const option of Object.keys(options)) {
            if (!['where', 'orderBy', 'limit', 'include'].includes(option)) {
                throw new QueryValidationError(
                    `include.${key} takes where, orderBy, limit and include, not ${option}`
                )
            }
        }
        clause[key] = {
            where: options.where as WhereClause | undefined,
            orderBy: options.orderBy as OrderByClause | undefined,
            limit: options.limit as number | undefined,
            include: (parseInclude(options.include) ?? undefined) as IncludeClause | undefined,
        }
    }
    return Object.values(clause).some(Boolean) ? clause : null
}

/** The columns this level's includes join on, so a `select` that leaves them out still resolves. */
async function includeJoinColumns(
    db: Queryable,
    schema: string,
    table: string,
    include: IncludeClause
): Promise<string[]> {
    const keys = await getForeignKeys(db, schema)
    const columns = new Set<string>()
    for (const [key, value] of Object.entries(include)) {
        if (!value) continue
        const relation = resolveRelation(table, key, keys)
        columns.add(relation.type === 'forward' ? relation.sourceColumn : relation.targetColumn)
    }
    return [...columns]
}

/** The include's own where, ANDed after the join's IN list (params continue from it). */
function extraConditions(where: WhereClause | undefined, startIndex: number) {
    if (!where || Object.keys(where).length === 0) return { sql: '', values: [] as unknown[] }
    const built = buildWhereClause(where, startIndex)
    const condition = built.clause.replace(/^WHERE /, '')
    return { sql: condition ? ` AND (${condition})` : '', values: built.values }
}

/**
 * Bring each include's related rows onto `rows`, in place: two queries per
 * key whatever the number of rows (an IN list, never one per row), and per
 * parent at most `limit` related rows (and never more than a find returns).
 */
async function resolveIncludes(
    db: Queryable,
    schema: string,
    table: string,
    rows: Record<string, unknown>[],
    include: IncludeClause,
    depth = 0
): Promise<void> {
    if (rows.length === 0) return
    if (depth >= MAX_INCLUDE_DEPTH) {
        throw new QueryValidationError(`include nests at most ${MAX_INCLUDE_DEPTH} levels deep`)
    }
    const keys = await getForeignKeys(db, schema)

    for (const [key, value] of Object.entries(include)) {
        if (!value) continue
        const options: IncludeOptions = value === true ? {} : value
        const relation = resolveRelation(table, key, keys)

        if (relation.type === 'forward') {
            const ids = [
                ...new Set(rows.map((r) => r[relation.sourceColumn]).filter((v) => v != null)),
            ]
            if (ids.length === 0) {
                for (const row of rows) row[key] = null
                continue
            }
            const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')
            const extra = extraConditions(options.where, ids.length + 1)
            const result = await db.query(
                `SELECT * FROM ${ident(schema)}.${ident(relation.targetTable)} WHERE ${ident(relation.targetColumn)} IN (${placeholders})${extra.sql}`,
                [...ids, ...extra.values]
            )
            const related = result.rows as Record<string, unknown>[]
            if (options.include) {
                await resolveIncludes(
                    db,
                    schema,
                    relation.targetTable,
                    related,
                    options.include,
                    depth + 1
                )
            }
            const byId = new Map(related.map((r) => [String(r[relation.targetColumn]), r]))
            for (const row of rows) {
                const id = row[relation.sourceColumn]
                row[key] = id == null ? null : (byId.get(String(id)) ?? null)
            }
            continue
        }

        const ids = [...new Set(rows.map((r) => r[relation.targetColumn]).filter((v) => v != null))]
        if (ids.length === 0) {
            for (const row of rows) row[key] = []
            continue
        }
        const perParent =
            options.limit !== undefined
                ? (clampInt(options.limit, MAX_LIMIT) ?? MAX_LIMIT)
                : MAX_LIMIT
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')
        const extra = extraConditions(options.where, ids.length + 1)
        const order =
            buildOrderByClause(options.orderBy) || `ORDER BY ${ident(relation.sourceColumn)}`
        const fk = ident(relation.sourceColumn)
        const result = await db.query(
            `SELECT * FROM (SELECT related.*, row_number() OVER (PARTITION BY ${fk} ${order}) AS ${ident(RANK_COLUMN)} ` +
                `FROM ${ident(schema)}.${ident(relation.sourceTable)} related WHERE ${fk} IN (${placeholders})${extra.sql}) ranked ` +
                `WHERE ${ident(RANK_COLUMN)} <= ${perParent} ORDER BY ${ident(RANK_COLUMN)}`,
            [...ids, ...extra.values]
        )
        const related = (result.rows as Record<string, unknown>[]).map((r) => {
            const { [RANK_COLUMN]: _rank, ...rest } = r
            return rest
        })
        if (options.include) {
            await resolveIncludes(
                db,
                schema,
                relation.sourceTable,
                related,
                options.include,
                depth + 1
            )
        }
        const byParent = new Map<string, Record<string, unknown>[]>()
        for (const r of related) {
            const parent = String(r[relation.sourceColumn])
            const list = byParent.get(parent)
            if (list) list.push(r)
            else byParent.set(parent, [r])
        }
        for (const row of rows) {
            const id = row[relation.targetColumn]
            row[key] = id == null ? [] : (byParent.get(String(id)) ?? [])
        }
    }
}

/**
 * Run a read with its includes: the join columns a narrow `select` left out
 * are read too and taken off again, so `select: ['id', 'title']` with
 * `include: { author: true }` still finds the author.
 */
async function readWithIncludes(
    db: Queryable,
    schema: string,
    tableName: string,
    select: string[] | undefined,
    include: IncludeClause | null,
    run: (columns: string) => Promise<Record<string, unknown>[]>
): Promise<Record<string, unknown>[]> {
    if (!include) return run(buildSelectColumns(select))
    let added: string[] = []
    let columns = select
    if (select && select.length > 0) {
        const needed = await includeJoinColumns(db, schema, tableName, include)
        added = needed.filter((column) => !select.includes(column))
        columns = [...select, ...added]
    }
    const rows = await run(buildSelectColumns(columns))
    await resolveIncludes(db, schema, tableName, rows, include)
    if (added.length > 0) {
        for (const row of rows) for (const column of added) delete row[column]
    }
    return rows
}

/**
 * Execute one structured-protocol operation against the mock's schema. Returns
 * a status + JSON body; never throws on user-caused failures.
 */
export async function executeDbOperation(
    db: Queryable,
    schema: string,
    operation: string,
    tableName: string,
    options: QueryOptions
): Promise<DbResult> {
    try {
        const table = `${ident(schema)}.${ident(tableName)}`

        const include = parseInclude(options.include)
        if (include && !INCLUDE_OPERATIONS.has(operation)) {
            return {
                status: 400,
                body: { error: 'include works on find, findMany, findFirst and findOne' },
            }
        }

        switch (operation) {
            case 'find':
            case 'findMany': {
                const { where, select, orderBy, limit, offset } = options
                const whereClause = where ? buildWhereClause(where) : { clause: '', values: [] }
                const limitValue = limit !== undefined ? clampInt(limit, MAX_LIMIT) : MAX_LIMIT
                const offsetValue = offset !== undefined ? clampInt(offset, 1e9) : null

                const rows = await readWithIncludes(
                    db,
                    schema,
                    tableName,
                    select,
                    include,
                    async (columns) => {
                        const query = [
                            `SELECT ${columns} FROM ${table}`,
                            whereClause.clause,
                            buildOrderByClause(orderBy),
                            limitValue !== null ? `LIMIT ${limitValue}` : '',
                            offsetValue !== null && offsetValue > 0 ? `OFFSET ${offsetValue}` : '',
                        ]
                            .filter(Boolean)
                            .join(' ')
                        return (await db.query(query, whereClause.values)).rows
                    }
                )
                return { status: 200, body: { data: rows } }
            }

            case 'findFirst':
            case 'findOne': {
                const { where, select, orderBy } = options
                const whereClause = where ? buildWhereClause(where) : { clause: '', values: [] }

                const rows = await readWithIncludes(
                    db,
                    schema,
                    tableName,
                    select,
                    include,
                    async (columns) => {
                        const query = [
                            `SELECT ${columns} FROM ${table}`,
                            whereClause.clause,
                            buildOrderByClause(orderBy),
                            'LIMIT 1',
                        ]
                            .filter(Boolean)
                            .join(' ')
                        return (await db.query(query, whereClause.values)).rows
                    }
                )
                return { status: 200, body: { data: rows[0] ?? null } }
            }

            case 'insert': {
                const { data } = options
                if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
                    return { status: 400, body: { error: 'Insert requires a data object' } }
                }

                const columns = Object.keys(data).map(ident)
                const values = Object.values(data)
                const placeholders = values.map((_, i) => `$${i + 1}`).join(', ')

                const query = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`
                const result = await db.query(query, values)
                const row = result.rows[0]
                return { status: 200, body: { data: { id: row?.id ?? row } } }
            }

            case 'update': {
                const { where, data } = options
                if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
                    return { status: 400, body: { error: 'Update requires a data object' } }
                }
                if (!where || Object.keys(where).length === 0) {
                    return {
                        status: 400,
                        body: {
                            error: 'Update requires a WHERE clause to prevent accidental updates of all records',
                        },
                    }
                }

                const setClauses: string[] = []
                const values: unknown[] = []
                let paramIndex = 1
                for (const [key, value] of Object.entries(data)) {
                    setClauses.push(`${ident(key)} = $${paramIndex++}`)
                    values.push(value)
                }

                const whereClause = buildWhereClause(where, paramIndex)
                values.push(...whereClause.values)

                const query = `UPDATE ${table} SET ${setClauses.join(', ')} ${whereClause.clause} RETURNING *`
                const result = await db.query(query, values)
                return { status: 200, body: { data: { count: rowCount(result) } } }
            }

            case 'delete': {
                const { where } = options
                const whereClause = where ? buildWhereClause(where) : { clause: '', values: [] }
                if (!whereClause.clause) {
                    return {
                        status: 400,
                        body: {
                            error: 'Delete requires a WHERE clause to prevent accidental deletion of all records',
                        },
                    }
                }

                const query = `DELETE FROM ${table} ${whereClause.clause} RETURNING *`
                const result = await db.query(query, whereClause.values)
                return { status: 200, body: { data: { count: rowCount(result) } } }
            }

            case 'count': {
                const { where } = options
                const whereClause = where ? buildWhereClause(where) : { clause: '', values: [] }
                const query = [`SELECT COUNT(*) as count FROM ${table}`, whereClause.clause]
                    .filter(Boolean)
                    .join(' ')

                const result = await db.query(query, whereClause.values)
                return { status: 200, body: { data: parseInt(String(result.rows[0].count), 10) } }
            }

            default:
                return { status: 400, body: { error: 'Invalid operation' } }
        }
    } catch (err) {
        return errorResult(err)
    }
}
