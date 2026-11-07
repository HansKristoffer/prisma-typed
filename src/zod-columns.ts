import type { z } from 'zod'

/**
 * Zod schemas for JSON columns, keyed by model name as written in the Prisma
 * schema, then by field. A nullable column (`Json?`) needs a schema that
 * accepts `null`.
 */
export type ZodColumnSchemas = {
	readonly [model: string]: { readonly [field: string]: z.ZodType }
}

type ColumnResult<Field extends string, Schema extends z.ZodType> = {
	needs: { [F in Field]: true }
	compute(row: { [F in Field]: unknown }): z.output<Schema>
}

/** The `result` component Prisma reads the column types from. */
export type ZodColumnsResult<Columns extends ZodColumnSchemas> = {
	[Model in keyof Columns & string as Uncapitalize<Model>]: {
		[Field in keyof Columns[Model] & string]: ColumnResult<
			Field,
			Columns[Model][Field]
		>
	}
}

/**
 * What `$extends` infers from: Prisma's internal shape for an extension that
 * only adds result fields.
 */
export type ZodColumnsExtArgs<Columns extends ZodColumnSchemas> = {
	result: {
		[Model in keyof ZodColumnsResult<Columns>]: {
			[Field in keyof ZodColumnsResult<Columns>[Model]]: () => ZodColumnsResult<Columns>[Model][Field]
		}
	}
	model: Record<never, never>
	query: Record<never, never>
	client: Record<never, never>
}

/** A Prisma extension, as `prisma.$extends()` takes it. */
export type ZodColumnsExtension<Columns extends ZodColumnSchemas> = (
	client: unknown
) => { $extends: { extArgs: ZodColumnsExtArgs<Columns> } }

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
		const issues = error.issues
			.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
			.join('; ')
		const row = id === undefined ? '' : ` for id ${JSON.stringify(id)}`
		super(
			`${direction === 'write' ? 'Writing' : 'Reading'} ${model}.${field}${row} failed: ${reason ? `${reason}: ` : ''}${issues}`,
			{ cause: error }
		)
		this.name = 'ZodColumnError'
		this.model = model
		this.field = field
		this.issues = error.issues
	}
}

type RuntimeField = { name: string; kind: string; type: string }
type RuntimeDataModel = {
	models: Record<string, { fields: readonly RuntimeField[] }>
}
type QueryHook = {
	model?: string
	operation: string
	args: Record<string, unknown> | undefined
	query: (args: unknown) => Promise<unknown>
	// Prisma's own extensions read this; the fluent API's path is in it.
	__internalParams?: { dataPath?: unknown[] }
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

/** The arguments each write operation carries its data in. */
const WRITE_KEYS: Record<string, readonly string[]> = {
	create: ['data'],
	createMany: ['data'],
	createManyAndReturn: ['data'],
	update: ['data'],
	updateMany: ['data'],
	updateManyAndReturn: ['data'],
	upsert: ['create', 'update']
}

/** Reads: their rows are parsed as the query returns, so a bad row fails it. */
const READS = new Set([
	'findUnique',
	'findUniqueOrThrow',
	'findFirst',
	'findFirstOrThrow',
	'findMany',
	'groupBy'
])

/**
 * Writes that return rows. Those rows parse on first access instead: the
 * write has committed by then, and throwing would report it as failed.
 */
const WRITES_RETURNING_ROWS = new Set([
	'create',
	'createManyAndReturn',
	'update',
	'updateManyAndReturn',
	'upsert',
	'delete'
])

/** Every other model operation of Prisma 7. Anything else is refused. */
const OTHER_OPERATIONS = new Set([
	'createMany',
	'updateMany',
	'deleteMany',
	'aggregate',
	'count'
])

/** The nested writes Prisma 7 has. Anything else is refused. */
const NESTED_WRITES = new Set([
	'create',
	'connectOrCreate',
	'connect',
	'createMany',
	'set',
	'disconnect',
	'delete',
	'update',
	'updateMany',
	'upsert',
	'deleteMany'
])

/**
 * The extension behind `withZodColumns`: checks writes before they run and
 * parses the rows queries return. See `withZodColumns` for the rules.
 */
export function zodColumns<const Columns extends ZodColumnSchemas>(
	columns: Columns
): ZodColumnsExtension<Columns> {
	return ((client: {
		_runtimeDataModel?: RuntimeDataModel
		$extends: (extension: object) => unknown
	}) => {
		const dataModel = client._runtimeDataModel
		if (!dataModel) {
			throw new Error(
				'withZodColumns needs a Prisma 7 client: the runtime data model is missing'
			)
		}
		const walker = createWalker(columns, dataModel)
		return client.$extends({
			name: 'hanzio/zodColumns',
			// Types only: rows are parsed in the query hook, so Prisma does not
			// wrap them in proxies for computed fields.
			result: {},
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
						const lazy = WRITES_RETURNING_ROWS.has(operation)
						const returnsRows = lazy || READS.has(operation)
						if (!returnsRows && !OTHER_OPERATIONS.has(operation)) {
							throw new Error(
								`withZodColumns cannot check ${model}.${operation}: it does not know this operation`
							)
						}
						// The fluent API returns related rows; only this path says which.
						const dataPath = __internalParams?.dataPath
						if (returnsRows && !Array.isArray(dataPath)) {
							throw new Error(
								`withZodColumns cannot check ${model}.${operation}: Prisma passed no query path`
							)
						}
						let next = args
						for (const key of WRITE_KEYS[operation] ?? []) {
							if (next?.[key] === undefined) continue
							const checked = walker.write(model, next[key])
							if (checked !== next[key]) next = { ...next, [key]: checked }
						}
						const result = await query(next)
						if (returnsRows) {
							const at = walker.follow(model, next, dataPath)
							walker.read(at.model, result, at.args, lazy)
						}
						return result
					}
				}
			}
		})
	}) as ZodColumnsExtension<Columns>
}

function parseColumn(
	model: string,
	field: string,
	schema: z.ZodType,
	value: unknown,
	direction: 'write' | 'read',
	id?: unknown
) {
	const parsed = schema.safeParse(value)
	if (!parsed.success) {
		throw new ZodColumnError(model, field, direction, parsed.error, { id })
	}
	return parsed.data
}

/**
 * Parses a value for a write and checks that it survives being stored: every
 * later read parses the stored JSON, so it must parse again. A schema that
 * transforms, or outputs a `Date`, fails here instead of on every read.
 */
function storable(
	model: string,
	field: string,
	schema: z.ZodType,
	value: unknown
) {
	const parsed = parseColumn(model, field, schema, value, 'write')
	let stored: unknown
	try {
		stored = JSON.parse(JSON.stringify(parsed))
	} catch (error) {
		throw new Error(
			`Writing ${model}.${field} failed: its parsed value is not JSON (${error instanceof Error ? error.message : String(error)})`
		)
	}
	const again = schema.safeParse(stored)
	if (!again.success) {
		throw new ZodColumnError(model, field, 'write', again.error, {
			reason: 'stored as JSON, its parsed value does not parse again'
		})
	}
	return parsed
}

function checkNull(
	model: string,
	field: string,
	schema: z.ZodType,
	value: unknown
) {
	const parsed = schema.safeParse(null)
	if (!parsed.success) {
		throw new ZodColumnError(model, field, 'write', parsed.error)
	}
	return value
}

/**
 * Replaces a column with a getter that parses it once, on first access, and
 * then becomes a plain value. Spreading, `JSON.stringify` and
 * `structuredClone` read it like any other property.
 */
function parseOnAccess(
	row: Record<string, unknown>,
	model: string,
	field: string,
	schema: z.ZodType
) {
	const raw = row[field]
	const settle = (value: unknown) => {
		Object.defineProperty(row, field, {
			value,
			writable: true,
			enumerable: true,
			configurable: true
		})
	}
	Object.defineProperty(row, field, {
		enumerable: true,
		configurable: true,
		get() {
			const value = parseColumn(model, field, schema, raw, 'read', row.id)
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
	const relations = new Map<string, Map<string, string>>()
	for (const [model, { fields }] of Object.entries(dataModel.models)) {
		const byField = new Map<string, string>()
		for (const field of fields) {
			if (field.kind === 'object') byField.set(field.name, field.type)
		}
		relations.set(model, byField)
	}

	for (const [model, fields] of Object.entries(columns)) {
		const known = dataModel.models[model]
		if (!known) throw new Error(`withZodColumns: unknown model "${model}"`)
		for (const field of Object.keys(fields)) {
			const column = known.fields.find((f) => f.name === field)
			if (column?.type !== 'Json') {
				throw new Error(
					`withZodColumns: "${model}.${field}" is not a Json column`
				)
			}
		}
	}

	// Models from which a query can reach a column, directly or nested.
	const reaching = new Set(Object.keys(columns))
	for (let grew = true; grew; ) {
		grew = false
		for (const [model, byField] of relations) {
			if (reaching.has(model)) continue
			if ([...byField.values()].some((target) => reaching.has(target))) {
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

	function write(model: string, input: unknown): unknown {
		return each(input, (item) => {
			if (!isPlainObject(item)) return item
			let out: Record<string, unknown> | undefined
			for (const [key, value] of Object.entries(item)) {
				if (value === undefined) continue
				let next: unknown = value
				const schema = columns[model]?.[key]
				if (schema) {
					next = isPrismaNull(value)
						? checkNull(model, key, schema, value)
						: storable(model, key, schema, value)
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
			if (!NESTED_WRITES.has(op)) {
				throw new Error(
					`withZodColumns cannot check the nested write "${op}" on ${target}`
				)
			}
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
		if (columns[target]?.data) {
			throw new Error(
				`Ambiguous nested update of ${target}: \`data\` can mean the ${target}.data column or the data of \`{ where, data }\`. Write \`update: { where: {}, data: { … } }\`.`
			)
		}
		return Object.keys(item).length === 1
			? withKey(item, 'data', (v) => write(target, v))
			: write(target, item)
	}

	function read(model: string, result: unknown, args: unknown, lazy: boolean) {
		if (Array.isArray(result)) {
			for (const row of result) read(model, row, args, lazy)
			return
		}
		if (!isPlainObject(result)) return
		const modelColumns = columns[model]
		if (modelColumns) {
			for (const [field, schema] of Object.entries(modelColumns)) {
				if (!(field in result)) continue
				if (lazy) {
					parseOnAccess(result, model, field, schema)
				} else {
					result[field] = parseColumn(
						model,
						field,
						schema,
						result[field],
						'read',
						result.id
					)
				}
			}
		}
		if (!isPlainObject(args)) return
		for (const key of ['include', 'select'] as const) {
			const nested = args[key]
			if (!isPlainObject(nested)) continue
			for (const [field, sub] of Object.entries(nested)) {
				const target = sub ? targetOf(model, field) : undefined
				if (target) read(target, result[field], sub, lazy)
			}
		}
	}

	// The fluent API (`orderLine.findFirst().product()`) returns the related
	// rows, not the row the arguments describe. Its path says which relation.
	function follow(model: string, args: unknown, dataPath: unknown) {
		let at = { model, args }
		if (!Array.isArray(dataPath)) return at
		for (let i = 0; i < dataPath.length; i += 2) {
			const [key, field] = [dataPath[i], dataPath[i + 1]]
			if (
				(key !== 'select' && key !== 'include') ||
				typeof field !== 'string'
			) {
				return at
			}
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
		write,
		read,
		follow,
		reaches: (model: string) => reaching.has(model)
	}
}
