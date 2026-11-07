import type { z } from 'zod'
import type { ClientTypes } from './client-types.js'
import type {
	CheckedColumns,
	ZodColumnSchemas,
	ZodColumnsClient
} from './zod-column-types.js'

/** Thrown when a JSON column fails its schema, on write or on read. */
export class ZodColumnError extends Error {
	readonly model: string
	readonly field: string
	readonly issues: z.core.$ZodIssue[]

	constructor(
		model: string,
		field: string,
		direction: 'write' | 'read',
		error: z.ZodError,
		{ id, reason }: { id?: unknown; reason?: string } = {}
	) {
		const action = direction === 'write' ? 'Writing' : 'Reading'
		const row = id === undefined ? '' : ` for id ${JSON.stringify(id)}`
		const issues = error.issues
			.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
			.join('; ')
		const detail = reason ? `${reason}: ${issues}` : issues
		super(`${action} ${model}.${field}${row} failed: ${detail}`, {
			cause: error
		})
		this.name = 'ZodColumnError'
		this.model = model
		this.field = field
		this.issues = error.issues
	}
}

/** A configured column: what errors name, and the schema that checks it. */
type Column = { model: string; field: string; schema: z.ZodType }

type RuntimeDataModel = {
	models: Record<
		string,
		{ fields: readonly { name: string; kind: string; type: string }[] }
	>
}

type QueryArgs = Record<string, unknown> | undefined

type QueryHook = {
	model?: string
	operation: string
	args: QueryArgs
	query: (args: QueryArgs) => Promise<unknown>
	// Prisma's own extensions read this; the fluent API's path is in it.
	__internalParams?: { dataPath?: unknown }
}

/**
 * Every model operation of Prisma 7: the arguments a write carries its data
 * in, and whether rows come back. A read's rows parse as the query returns,
 * so a bad row fails it. The rows a write returns parse on first access,
 * because the write has committed by then. Any other operation is refused.
 */
const OPERATIONS = new Map<
	string,
	{ data?: readonly string[]; rows?: 'parse' | 'onAccess' }
>([
	['findUnique', { rows: 'parse' }],
	['findUniqueOrThrow', { rows: 'parse' }],
	['findFirst', { rows: 'parse' }],
	['findFirstOrThrow', { rows: 'parse' }],
	['findMany', { rows: 'parse' }],
	['groupBy', { rows: 'parse' }],
	['aggregate', {}],
	['count', {}],
	['create', { data: ['data'], rows: 'onAccess' }],
	['createMany', { data: ['data'] }],
	['createManyAndReturn', { data: ['data'], rows: 'onAccess' }],
	['update', { data: ['data'], rows: 'onAccess' }],
	['updateMany', { data: ['data'] }],
	['updateManyAndReturn', { data: ['data'], rows: 'onAccess' }],
	['upsert', { data: ['create', 'update'], rows: 'onAccess' }],
	['delete', { rows: 'onAccess' }],
	['deleteMany', {}]
])

/**
 * Types and validates JSON columns with Zod, keyed by model name as written in
 * the Prisma schema. Writes are parsed before they run, nested writes
 * included, and the parsed value is what is stored. Reads are typed as the
 * schema's output and parsed as the query returns, so a bad row fails the
 * query with its id; rows a write returns parse on first access, so a
 * committed write never throws. Write inputs are narrowed to the schema's
 * input type.
 *
 * Call it last: a later `$extends` keeps the checks but drops the narrowed
 * input types.
 *
 * ```ts
 * export const prisma = withZodColumns(new PrismaClient({ adapter }), {
 *   Product: { data: productData }
 * })
 * ```
 */
export function withZodColumns<
	Client extends { $extends: unknown },
	const Columns extends ZodColumnSchemas
>(
	client: Client,
	columns: Columns & CheckedColumns<Columns, ClientTypes<Client>['typeMap']>
) {
	// The two members of a Prisma 7 client this needs.
	const prisma = client as unknown as {
		_runtimeDataModel?: RuntimeDataModel
		$extends: (extension: object) => unknown
	}
	if (!prisma._runtimeDataModel) {
		throw new Error(
			'withZodColumns needs a Prisma 7 client: the runtime data model is missing'
		)
	}
	const walker = createWalker(columns, prisma._runtimeDataModel)

	const extended = prisma.$extends({
		name: 'prisma-typed/withZodColumns',
		query: {
			$allModels: {
				async $allOperations({
					model,
					operation,
					args,
					query,
					__internalParams
				}: QueryHook) {
					if (!model || !walker.reaches(model)) return query(args)

					const handling = OPERATIONS.get(operation)
					if (!handling) {
						throw new Error(
							`withZodColumns cannot check ${model}.${operation}: it does not know this operation`
						)
					}
					if (!handling.rows) {
						return query(walker.checkWrite(model, args, handling.data))
					}

					// The fluent API returns related rows; only this path says which.
					const dataPath = __internalParams?.dataPath
					if (!Array.isArray(dataPath)) {
						throw new Error(
							`withZodColumns cannot check ${model}.${operation}: Prisma passed no query path`
						)
					}
					const checked = walker.checkWrite(model, args, handling.data)
					const result = await query(checked)
					const at = walker.follow(model, checked, dataPath)
					const settle = handling.rows === 'parse' ? parseNow : parseOnAccess
					walker.read(at.model, result, at.args, settle)
					return result
				}
			}
		}
	})
	return extended as ZodColumnsClient<Client, Columns>
}

const PRISMA_NULL = Symbol.for('prisma.objectEnumValue')

/** `Prisma.DbNull`, `Prisma.JsonNull` and `Prisma.AnyNull`, from any copy of Prisma. */
function isPrismaNull(value: unknown) {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as Record<symbol, unknown>)[PRISMA_NULL] === true
	)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null) return false
	const proto = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

function parse(
	column: Column,
	value: unknown,
	direction: 'write' | 'read',
	id?: unknown
) {
	const parsed = column.schema.safeParse(value)
	if (!parsed.success) {
		throw new ZodColumnError(
			column.model,
			column.field,
			direction,
			parsed.error,
			{ id }
		)
	}
	return parsed.data
}

/**
 * Parses a written value and checks that it survives being stored: every
 * later read parses the stored JSON, so it must parse again. Prisma's
 * `DbNull` and `JsonNull` stand for null and pass when the schema accepts it.
 */
function storable(column: Column, value: unknown) {
	if (isPrismaNull(value)) {
		parse(column, null, 'write')
		return value
	}

	const parsed = parse(column, value, 'write')
	let stored: unknown
	try {
		stored = JSON.parse(JSON.stringify(parsed))
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		throw new Error(
			`Writing ${column.model}.${column.field} failed: its parsed value is not JSON (${reason})`
		)
	}
	const again = column.schema.safeParse(stored)
	if (!again.success) {
		throw new ZodColumnError(column.model, column.field, 'write', again.error, {
			reason: 'stored as JSON, its parsed value does not parse again'
		})
	}
	return parsed
}

function parseNow(row: Record<string, unknown>, column: Column) {
	row[column.field] = parse(column, row[column.field], 'read', row.id)
}

/**
 * Replaces a column with a getter that parses it once, on first access, and
 * then becomes a plain value. Spreading, `JSON.stringify` and
 * `structuredClone` read it like any other property.
 */
function parseOnAccess(row: Record<string, unknown>, column: Column) {
	const raw = row[column.field]
	const settle = (value: unknown) => {
		Object.defineProperty(row, column.field, {
			value,
			writable: true,
			enumerable: true,
			configurable: true
		})
	}
	Object.defineProperty(row, column.field, {
		enumerable: true,
		configurable: true,
		get() {
			const value = parse(column, raw, 'read', row.id)
			settle(value)
			return value
		},
		set: settle
	})
}

/**
 * Walks a query's arguments and rows through relation fields, so a column is
 * checked wherever it appears: in a nested write
 * (`order.create({ data: { lines: { create } } })`) or in an included
 * relation. Writes return new objects along changed paths and leave the
 * caller's arguments alone; reads replace values in the rows Prisma returned.
 */
function createWalker(columns: ZodColumnSchemas, dataModel: RuntimeDataModel) {
	const columnsByModel = new Map<string, Map<string, Column>>()
	for (const [model, fields] of Object.entries(columns)) {
		const known = dataModel.models[model]
		if (!known) throw new Error(`withZodColumns: unknown model "${model}"`)

		const byField = new Map<string, Column>()
		for (const [field, schema] of Object.entries(fields)) {
			const isJson = known.fields.some(
				(f) => f.name === field && f.type === 'Json'
			)
			if (!isJson) {
				throw new Error(
					`withZodColumns: "${model}.${field}" is not a Json column`
				)
			}
			byField.set(field, { model, field, schema })
		}
		columnsByModel.set(model, byField)
	}

	const relations = new Map<string, Map<string, string>>()
	for (const [model, { fields }] of Object.entries(dataModel.models)) {
		const targets = new Map<string, string>()
		for (const field of fields) {
			if (field.kind === 'object') targets.set(field.name, field.type)
		}
		relations.set(model, targets)
	}

	// Models from which a query can reach a column, directly or nested.
	const reaching = new Set(columnsByModel.keys())
	let grew = true
	while (grew) {
		grew = false
		for (const [model, targets] of relations) {
			if (reaching.has(model)) continue
			if ([...targets.values()].some((target) => reaching.has(target))) {
				reaching.add(model)
				grew = true
			}
		}
	}

	const targetOf = (model: string, field: string) => {
		const target = relations.get(model)?.get(field)
		return target && reaching.has(target) ? target : undefined
	}

	const each = (value: unknown, check: (item: unknown) => unknown) => {
		if (!Array.isArray(value)) return check(value)
		let out: unknown[] | undefined
		value.forEach((item, index) => {
			const next = check(item)
			if (next !== item) {
				out ??= [...value]
				out[index] = next
			}
		})
		return out ?? value
	}

	const withKey = (
		object: unknown,
		key: string,
		check: (value: unknown) => unknown
	) => {
		if (!isPlainObject(object) || object[key] === undefined) return object
		const next = check(object[key])
		return next === object[key] ? object : { ...object, [key]: next }
	}

	/** Checks the arguments a write carries its data in. */
	function checkWrite(
		model: string,
		args: QueryArgs,
		keys: readonly string[] = []
	) {
		let next = args
		for (const key of keys) {
			if (next?.[key] === undefined) continue
			const checked = write(model, next[key])
			if (checked !== next[key]) next = { ...next, [key]: checked }
		}
		return next
	}

	function write(model: string, input: unknown): unknown {
		return each(input, (item) => {
			if (!isPlainObject(item)) return item
			let out: Record<string, unknown> | undefined
			for (const [key, value] of Object.entries(item)) {
				if (value === undefined) continue
				let next: unknown = value
				const column = columnsByModel.get(model)?.get(key)
				if (column) {
					next = storable(column, value)
				} else {
					const target = targetOf(model, key)
					if (target) next = writeNested(target, value)
				}
				if (next !== value) {
					out ??= { ...item }
					out[key] = next
				}
			}
			return out ?? item
		})
	}

	function writeNested(target: string, envelope: unknown): unknown {
		if (!isPlainObject(envelope)) return envelope
		const data = (value: unknown) => write(target, value)
		let out: Record<string, unknown> | undefined
		for (const [op, value] of Object.entries(envelope)) {
			if (value === undefined) continue
			let next: unknown = value
			switch (op) {
				case 'create':
					next = data(value)
					break
				case 'connectOrCreate':
					next = each(value, (item) => withKey(item, 'create', data))
					break
				case 'createMany':
				case 'updateMany':
					next = each(value, (item) => withKey(item, 'data', data))
					break
				case 'upsert':
					next = each(value, (item) =>
						withKey(withKey(item, 'create', data), 'update', data)
					)
					break
				case 'update':
					next = each(value, (item) => updateItem(target, item))
					break
				case 'connect':
				case 'set':
				case 'disconnect':
				case 'delete':
				case 'deleteMany':
					break
				default:
					throw new Error(
						`withZodColumns cannot check the nested write "${op}" on ${target}`
					)
			}
			if (next !== value) {
				out ??= { ...envelope }
				out[op] = next
			}
		}
		return out ?? envelope
	}

	// A nested `update` is `{ where, data }` or, on a to-one relation, the
	// update itself. On a model with a column called `data`, a `data` key
	// without `where` could be either; Prisma picks one by validating both, so
	// that form is refused rather than guessed.
	function updateItem(target: string, item: unknown) {
		if (!isPlainObject(item) || item.data === undefined) {
			return write(target, item)
		}
		if ('where' in item) return withKey(item, 'data', (v) => write(target, v))
		if (columnsByModel.get(target)?.has('data')) {
			throw new Error(
				`Ambiguous nested update of ${target}: \`data\` can mean the ${target}.data column or the data of \`{ where, data }\`. Write \`update: { where: {}, data: { … } }\`.`
			)
		}
		return Object.keys(item).length === 1
			? withKey(item, 'data', (v) => write(target, v))
			: write(target, item)
	}

	function read(
		model: string,
		result: unknown,
		args: unknown,
		settle: typeof parseNow
	) {
		if (Array.isArray(result)) {
			for (const row of result) read(model, row, args, settle)
			return
		}
		if (!isPlainObject(result)) return

		for (const column of columnsByModel.get(model)?.values() ?? []) {
			if (column.field in result) settle(result, column)
		}

		if (!isPlainObject(args)) return
		for (const key of ['include', 'select'] as const) {
			const nested = args[key]
			if (!isPlainObject(nested)) continue
			for (const [field, sub] of Object.entries(nested)) {
				const target = sub ? targetOf(model, field) : undefined
				if (target) read(target, result[field], sub, settle)
			}
		}
	}

	// The fluent API (`orderLine.findFirst().product()`) returns the related
	// rows, not the row the arguments describe. Its path says which relation.
	function follow(model: string, args: unknown, dataPath: unknown[]) {
		let at = { model, args }
		for (let i = 0; i < dataPath.length; i += 2) {
			const key = dataPath[i]
			const field = dataPath[i + 1]
			const isRelationStep =
				(key === 'select' || key === 'include') && typeof field === 'string'
			if (!isRelationStep) return at

			const target = relations.get(at.model)?.get(field)
			if (!target) return at
			const nested = isPlainObject(at.args) ? at.args[key] : undefined
			at = {
				model: target,
				args: isPlainObject(nested) ? nested[field] : undefined
			}
		}
		return at
	}

	return {
		checkWrite,
		read,
		follow,
		reaches: (model: string) => reaching.has(model)
	}
}
