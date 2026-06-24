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

        if (
            options.include &&
            (!Array.isArray(options.include) || options.include.length > 0) &&
            Object.keys(options.include).length > 0
        ) {
            return {
                status: 400,
                body: { error: 'include is not yet supported on the public API' },
            }
        }

        switch (operation) {
            case 'find':
            case 'findMany': {
                const { where, select, orderBy, limit, offset } = options
                const whereClause = where ? buildWhereClause(where) : { clause: '', values: [] }
                const limitValue = limit !== undefined ? clampInt(limit, MAX_LIMIT) : MAX_LIMIT
                const offsetValue = offset !== undefined ? clampInt(offset, 1e9) : null

                const query = [
                    `SELECT ${buildSelectColumns(select)} FROM ${table}`,
                    whereClause.clause,
                    buildOrderByClause(orderBy),
                    limitValue !== null ? `LIMIT ${limitValue}` : '',
                    offsetValue !== null && offsetValue > 0 ? `OFFSET ${offsetValue}` : '',
                ]
                    .filter(Boolean)
                    .join(' ')

                const result = await db.query(query, whereClause.values)
                return { status: 200, body: { data: result.rows } }
            }

            case 'findFirst':
            case 'findOne': {
                const { where, select, orderBy } = options
                const whereClause = where ? buildWhereClause(where) : { clause: '', values: [] }

                const query = [
                    `SELECT ${buildSelectColumns(select)} FROM ${table}`,
                    whereClause.clause,
                    buildOrderByClause(orderBy),
                    'LIMIT 1',
                ]
                    .filter(Boolean)
                    .join(' ')

                const result = await db.query(query, whereClause.values)
                return { status: 200, body: { data: result.rows[0] ?? null } }
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
