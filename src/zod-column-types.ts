import type {
	DbNullClass,
	JsonValue,
	ObjectEnumValue,
	Types
} from '@prisma/client/runtime/client'
import type { z } from 'zod'
import type { ClientTypes, ResultTypes } from './client-types'

type TypeMapDef = Types.Extensions.TypeMapDef

/**
 * Zod schemas for JSON columns, keyed by model name as written in the Prisma
 * schema, then by field.
 */
export type ZodColumnSchemas = {
	readonly [model: string]: { readonly [field: string]: z.ZodType }
}

/** The schema configured for `Model.Field`, or `never`. */
type ColumnSchema<Columns, Model, Field> = Model extends keyof Columns
	? Field extends keyof Columns[Model]
		? Extract<Columns[Model][Field], z.ZodType>
		: never
	: never

// Write inputs. Prisma's extension API cannot change input types, so the
// client type is rebuilt from a TypeMap whose write arguments have each
// column narrowed to its schema's input, nested writes included. A later
// `$extends` recomputes the TypeMap, which drops the narrowing.

type WriteOperation =
	| 'create'
	| 'createMany'
	| 'createManyAndReturn'
	| 'update'
	| 'updateMany'
	| 'updateManyAndReturn'
	| 'upsert'

/** Keys of nested-write envelopes that hold a model's data. */
type NestedKey =
	| 'data'
	| 'create'
	| 'update'
	| 'connectOrCreate'
	| 'upsert'
	| 'createMany'
	| 'updateMany'

type RelationTarget<
	TypeMap extends TypeMapDef,
	Model,
	Key
> = Model extends keyof TypeMap['model']
	? Key extends keyof TypeMap['model'][Model]['payload']['objects']
		? NonNullable<
				TypeMap['model'][Model]['payload']['objects'][Key]
			> extends infer Payload
			? Payload extends readonly (infer Item)[]
				? Item extends { name: infer Name }
					? Name
					: never
				: Payload extends { name: infer Name }
					? Name
					: never
			: never
		: never
	: never

/** A nullable column keeps Prisma's `DbNull` and `JsonNull`. */
type ColumnInput<Original, Schema extends z.ZodType> =
	null extends z.input<Schema>
		? Exclude<z.input<Schema>, null> | Extract<Original, ObjectEnumValue>
		: z.input<Schema>

type Narrow<
	T,
	Model,
	TypeMap extends TypeMapDef,
	Columns
> = T extends readonly (infer Item)[]
	? Narrow<Item, Model, TypeMap, Columns>[]
	: T extends ObjectEnumValue
		? T
		: T extends object
			? { [K in keyof T]: NarrowKey<T, K, Model, TypeMap, Columns> }
			: T

type NarrowKey<
	T,
	K extends keyof T,
	Model,
	TypeMap extends TypeMapDef,
	Columns
> = [ColumnSchema<Columns, Model, K>] extends [never]
	? NarrowNested<T, K, Model, TypeMap, Columns>
	: // A column's input includes Prisma's `JsonNull`; the `data` of
		// `{ where, data }` does not.
		[Extract<T[K], ObjectEnumValue>] extends [never]
		? NarrowNested<T, K, Model, TypeMap, Columns>
		: ColumnInput<T[K], ColumnSchema<Columns, Model, K>>

type NarrowNested<
	T,
	K extends keyof T,
	Model,
	TypeMap extends TypeMapDef,
	Columns
> = [RelationTarget<TypeMap, Model, K>] extends [never]
	? K extends NestedKey
		? Narrow<T[K], Model, TypeMap, Columns>
		: T[K]
	: NarrowRelation<T[K], RelationTarget<TypeMap, Model, K>, TypeMap, Columns>

/**
 * On a model with a column called `data`, a nested `update` sets it only
 * through `{ where, data }`: without `where`, Prisma could read `data` either
 * way, so the runtime refuses it too.
 */
type NarrowRelation<Envelope, Target, TypeMap extends TypeMapDef, Columns> = [
	ColumnSchema<Columns, Target, 'data'>
] extends [never]
	? Narrow<Envelope, Target, TypeMap, Columns>
	: StrictUpdate<Narrow<Envelope, Target, TypeMap, Columns>>

type StrictUpdate<Envelope> = Envelope extends object
	? {
			[K in keyof Envelope]: K extends 'update'
				? StrictUpdateItem<Envelope[K]>
				: Envelope[K]
		}
	: Envelope

type WhereOf<Item> = 'where' extends keyof Item
	? NonNullable<Item['where' & keyof Item]>
	: never

type StrictUpdateItem<Item> = Item extends readonly unknown[]
	? Item
	: Item extends object
		? [WhereOf<Item>] extends [never]
			? Omit<Item, 'data'>
			: Omit<Item, 'where'> & { where: WhereOf<Item> }
		: Item

type NarrowTypeMap<TypeMap extends TypeMapDef, Columns> = Omit<
	TypeMap,
	'model'
> & {
	model: {
		[Model in keyof TypeMap['model']]: Omit<
			TypeMap['model'][Model],
			'operations'
		> & {
			operations: {
				[Op in keyof TypeMap['model'][Model]['operations']]: Op extends WriteOperation
					? Omit<TypeMap['model'][Model]['operations'][Op], 'args'> & {
							args: Narrow<
								TypeMap['model'][Model]['operations'][Op]['args'],
								Model,
								TypeMap,
								Columns
							>
						}
					: TypeMap['model'][Model]['operations'][Op]
			}
		}
	}
}

// Configuration checks.

type JsonFields<
	TypeMap extends TypeMapDef,
	Model extends keyof TypeMap['model']
> = {
	[Field in keyof TypeMap['model'][Model]['payload']['scalars']]: JsonValue extends TypeMap['model'][Model]['payload']['scalars'][Field]
		? Field
		: never
}[keyof TypeMap['model'][Model]['payload']['scalars']]

/** A column is `Json?` exactly when Prisma accepts `DbNull` for it. */
type IsNullable<
	TypeMap extends TypeMapDef,
	Model extends keyof TypeMap['model'],
	Field
> = TypeMap['model'][Model]['operations']['create']['args']['data'] extends infer Data
	? [
			Extract<
				Data extends unknown ? Data[Field & keyof Data] : never,
				DbNullClass
			>
		] extends [never]
		? false
		: true
	: never

/** Why a schema cannot type its column, or `never` when it can. */
type ColumnProblem<Schema extends z.ZodType, Nullable extends boolean> =
	z.output<Schema> extends JsonValue
		? z.output<Schema> extends z.input<Schema>
			? Nullable extends (null extends z.output<Schema> ? true : false)
				? never
				: Nullable extends true
					? 'is Json?, so its schema must accept null'
					: 'is required, so its schema must not accept null'
			: 'stores the parsed value, which must parse again: no transforms or codecs'
		: 'stores the parsed value, so the schema must output JSON'

/** The schema when it can type its column; otherwise why not, naming the column. */
type Checked<
	Schema,
	Column extends string,
	Nullable extends boolean
> = Schema extends z.ZodType
	? [ColumnProblem<Schema, Nullable>] extends [never]
		? Schema
		: `${Column} ${ColumnProblem<Schema, Nullable>}`
	: never

/**
 * Rejects a model the client does not have, a field that is not `Json`, and a
 * schema that cannot type its column.
 */
export type CheckedColumns<Columns, TypeMap extends TypeMapDef> = {
	[Model in keyof Columns]: Model extends keyof TypeMap['model']
		? {
				[Field in keyof Columns[Model]]: Field extends JsonFields<
					TypeMap,
					Model
				>
					? Checked<
							Columns[Model][Field],
							`${Model & string}.${Field & string}`,
							IsNullable<TypeMap, Model, Field>
						>
					: never
			}
		: never
}

/** Each column typed as its schema's output, for Prisma's result typing. */
type ColumnResults<Columns extends ZodColumnSchemas> = ResultTypes<{
	[Model in keyof Columns & string as Uncapitalize<Model>]: {
		[Field in keyof Columns[Model]]: z.output<Columns[Model][Field]>
	}
}>

/** The client `withZodColumns` returns. */
export type ZodColumnsClient<
	Client,
	Columns extends ZodColumnSchemas,
	Parts extends ClientTypes<Client> = ClientTypes<Client>,
	ExtArgs extends Record<string, unknown> = Types.Extensions.MergeExtArgs<
		Parts['typeMap'],
		Parts['extArgs'],
		ColumnResults<Columns>
	>
> = Types.Extensions.DynamicClientExtensionThis<
	NarrowTypeMap<
		Types.Utils.Call<Parts['typeMapCb'], { extArgs: ExtArgs }>,
		Columns
	>,
	Parts['typeMapCb'],
	ExtArgs
>
