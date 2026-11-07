import type { ObjectEnumValue, Types } from '@prisma/client/runtime/client'
import type { z } from 'zod'

// Input types. Prisma's extension API cannot change input types, so the
// client type is rebuilt from a TypeMap whose operation arguments are
// narrowed: each JSON column to its schema's input, and each branded id
// column to `IdInput`, through nested writes, relation filters and nested
// `include` and `select`. A later `$extends` recomputes the TypeMap, which
// drops the narrowing.

type TypeMapDef = Types.Extensions.TypeMapDef

/**
 * What an input accepts where a model's id goes: that model's `Id`, or a
 * plain string. Another model's `Id` is a type error.
 */
export type IdInput<Model extends string> = string & {
	[K in keyof z.$brand<Model>]?: z.$brand<Model>[K]
}

type WriteOperation =
	| 'create'
	| 'createMany'
	| 'createManyAndReturn'
	| 'update'
	| 'updateMany'
	| 'updateManyAndReturn'
	| 'upsert'

/** Keys whose values hold the data a write sets. */
type WriteKey =
	| 'data'
	| 'create'
	| 'update'
	| 'upsert'
	| 'connectOrCreate'
	| 'createMany'
	| 'updateMany'

/** Keys whose values pick rows: walked only when ids are branded. */
type FilterKey =
	| 'where'
	| 'having'
	| 'cursor'
	| 'connect'
	| 'set'
	| 'disconnect'
	| 'delete'
	| 'deleteMany'
	| 'AND'
	| 'OR'
	| 'NOT'
	| 'is'
	| 'isNot'
	| 'some'
	| 'every'
	| 'none'
	| 'select'
	| 'include'

/** Keys of Prisma's string filters and update operations that hold the value. */
type IdValueKey =
	| 'set'
	| 'equals'
	| 'in'
	| 'notIn'
	| 'not'
	| 'lt'
	| 'lte'
	| 'gt'
	| 'gte'
	| 'contains'
	| 'startsWith'
	| 'endsWith'

/** What the walk narrows: JSON columns, branded ids, and the keys it enters. */
type Rules = {
	columns: unknown
	results: unknown
	ids: boolean
	nested: PropertyKey
}

/** The schema configured for `Model.Field`, or `never`. */
type ColumnSchema<Columns, Model, Field> = Model extends keyof Columns
	? Field extends keyof Columns[Model]
		? Extract<Columns[Model][Field], z.ZodType>
		: never
	: never

/** The model a result type is branded with, or `never`. */
type BrandOf<T> =
	NonNullable<T> extends {
		[K in keyof z.$brand]: infer Brands
	}
		? Extract<keyof Brands, string>
		: never

/** The type Prisma reads off a result extension's `compute`. */
type Computed<Entry> = Entry extends () => {
	compute: (...args: never[]) => infer Value
}
	? Value
	: never

/** The model `Model.Field` identifies, read off its branded result type. */
type IdTarget<Results, Model, Field> = Model extends string
	? Uncapitalize<Model> extends keyof Results
		? Field extends keyof Results[Uncapitalize<Model>]
			? BrandOf<Computed<Results[Uncapitalize<Model>][Field]>>
			: never
		: never
	: never

type IdOf<R extends Rules, Model, Field> = R['ids'] extends true
	? IdTarget<R['results'], Model, Field>
	: never

/** Whether any result type is a branded id. */
type BrandsIds<Results> = true extends {
	[Model in keyof Results]: {
		[Field in keyof Results[Model]]: [
			BrandOf<Computed<Results[Model][Field]>>
		] extends [never]
			? false
			: true
	}[keyof Results[Model]]
}[keyof Results]
	? true
	: false

/** A JSON field's input includes Prisma's `JsonNull`; no other input does. */
type IsJsonInput<V> = [Extract<V, ObjectEnumValue>] extends [never]
	? false
	: true

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

/** A branded id column's input: plain values, `{ set }` and string filters. */
type IdValue<V, Target extends string> = V extends string
	? IdInput<Target>
	: V extends readonly (infer Item)[]
		? IdValue<Item, Target>[]
		: V extends object
			? {
					[K in keyof V]: K extends IdValueKey ? IdValue<V[K], Target> : V[K]
				}
			: V

type Narrow<
	T,
	Model,
	TypeMap extends TypeMapDef,
	R extends Rules
> = T extends readonly (infer Item)[]
	? Narrow<Item, Model, TypeMap, R>[]
	: T extends object
		? { [K in keyof T]: NarrowKey<T, K, Model, TypeMap, R> }
		: T

type NarrowKey<
	T,
	K extends keyof T,
	Model,
	TypeMap extends TypeMapDef,
	R extends Rules
> = [IdOf<R, Model, K>] extends [never]
	? [ColumnSchema<R['columns'], Model, K>] extends [never]
		? NarrowNested<T, K, Model, TypeMap, R>
		: // A column's key also names the `data` of `{ where, data }`.
			IsJsonInput<T[K]> extends true
			? ColumnInput<T[K], ColumnSchema<R['columns'], Model, K>>
			: NarrowNested<T, K, Model, TypeMap, R>
	: IdValue<T[K], IdOf<R, Model, K>>

type NarrowNested<
	T,
	K extends keyof T,
	Model,
	TypeMap extends TypeMapDef,
	R extends Rules
> = [RelationTarget<TypeMap, Model, K>] extends [never]
	? K extends R['nested']
		? // A JSON field named like a wrapper key is a leaf.
			IsJsonInput<T[K]> extends true
			? T[K]
			: Narrow<T[K], Model, TypeMap, R>
		: T[K]
	: NarrowRelation<T[K], RelationTarget<TypeMap, Model, K>, TypeMap, R>

/**
 * On a model with a column called `data`, a nested `update` sets it only
 * through `{ where, data }`: without `where`, Prisma could read `data` either
 * way, so the runtime refuses it too.
 */
type NarrowRelation<
	Envelope,
	Target,
	TypeMap extends TypeMapDef,
	R extends Rules
> = [ColumnSchema<R['columns'], Target, 'data'>] extends [never]
	? Narrow<Envelope, Target, TypeMap, R>
	: StrictUpdate<Narrow<Envelope, Target, TypeMap, R>>

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

type ResultsOf<ExtArgs> = ExtArgs extends { result: infer Results }
	? Results
	: Record<never, never>

/**
 * The TypeMap with narrowed inputs. Without branded ids only the data of
 * writes changes, so reads keep Prisma's own types and cost nothing extra.
 */
export type NarrowInputs<
	TypeMap extends TypeMapDef,
	Columns,
	ExtArgs,
	Results = ResultsOf<ExtArgs>,
	Ids extends boolean = BrandsIds<Results>,
	R extends Rules = {
		columns: Columns
		results: Results
		ids: Ids
		nested: Ids extends true ? WriteKey | FilterKey : WriteKey
	}
> = Omit<TypeMap, 'model'> & {
	model: {
		[Model in keyof TypeMap['model']]: Omit<
			TypeMap['model'][Model],
			'operations'
		> & {
			operations: {
				[Op in keyof TypeMap['model'][Model]['operations']]: (
					Op extends WriteOperation
						? true
						: Ids
				) extends true
					? Omit<TypeMap['model'][Model]['operations'][Op], 'args'> & {
							args: Narrow<
								TypeMap['model'][Model]['operations'][Op]['args'],
								Model,
								TypeMap,
								R
							>
						}
					: TypeMap['model'][Model]['operations'][Op]
			}
		}
	}
}
