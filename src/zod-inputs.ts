import type {
	JsonValue,
	ObjectEnumValue,
	Types
} from '@prisma/client/runtime/client'
import type { z } from 'zod'
import { type ClientTypes, extend } from './client-types'
import {
	type ZodColumnReads,
	type ZodColumnSchemas,
	type ZodColumnsExtArgs,
	zodColumns
} from './zod-columns'

// Experimental: narrows the write inputs of an extended client's JSON columns
// to `z.input` of their schemas, nested writes included. Prisma's extension
// API cannot change input types, so this rebuilds the client type from its
// TypeMap. Apply it last: a later `$extends` recomputes the TypeMap and drops
// the narrowing.

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
	TypeMap extends Types.Extensions.TypeMapDef,
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
	TypeMap extends Types.Extensions.TypeMapDef,
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
	TypeMap extends Types.Extensions.TypeMapDef,
	Columns
> =
	// A JSON column's input always includes Prisma's `JsonNull`; the `data`
	// of `{ where, data }` and other envelopes never does.
	Model extends keyof Columns
		? K extends keyof Columns[Model]
			? [Extract<T[K], ObjectEnumValue>] extends [never]
				? NarrowNested<T, K, Model, TypeMap, Columns>
				: Columns[Model][K] extends z.ZodType
					? ColumnInput<T[K], Columns[Model][K]>
					: T[K]
			: NarrowNested<T, K, Model, TypeMap, Columns>
		: NarrowNested<T, K, Model, TypeMap, Columns>

type NarrowNested<
	T,
	K extends keyof T,
	Model,
	TypeMap extends Types.Extensions.TypeMapDef,
	Columns
> = [RelationTarget<TypeMap, Model, K>] extends [never]
	? K extends NestedKey
		? Narrow<T[K], Model, TypeMap, Columns>
		: T[K]
	: Narrow<T[K], RelationTarget<TypeMap, Model, K>, TypeMap, Columns>

type NarrowTypeMap<TypeMap extends Types.Extensions.TypeMapDef, Columns> = Omit<
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

type JsonFields<
	TypeMap extends Types.Extensions.TypeMapDef,
	Model extends keyof TypeMap['model']
> = {
	[Field in keyof TypeMap['model'][Model]['payload']['scalars']]: JsonValue extends TypeMap['model'][Model]['payload']['scalars'][Field]
		? Field
		: never
}[keyof TypeMap['model'][Model]['payload']['scalars']]

/** Rejects a model the client does not have, or a field that is not `Json`. */
type KnownColumns<Columns, TypeMap extends Types.Extensions.TypeMapDef> = {
	[Model in keyof Columns]: Model extends keyof TypeMap['model']
		? {
				[Field in keyof Columns[Model]]: Field extends JsonFields<
					TypeMap,
					Model
				>
					? Columns[Model][Field]
					: never
			}
		: never
}

/** What `client.$extends(zodColumns(columns))` returns, with narrowed writes. */
export type ZodColumnsClient<
	Client,
	Columns extends ZodColumnSchemas,
	Parts extends ClientTypes<Client> = ClientTypes<Client>,
	Merged extends Record<string, unknown> = Types.Extensions.MergeExtArgs<
		Parts['typeMap'],
		Parts['extArgs'],
		ZodColumnsExtArgs<Columns>
	>
> = Types.Extensions.DynamicClientExtensionThis<
	NarrowTypeMap<
		Types.Utils.Call<Parts['typeMapCb'], { extArgs: Merged }>,
		Columns
	>,
	Parts['typeMapCb'],
	Merged
>

/**
 * `client.$extends(zodColumns(columns))`, with each JSON column's write input
 * narrowed to its schema's input type, nested writes included. Call it last:
 * a later `$extends` keeps the parsing but drops the narrowed inputs.
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
	columns: Columns & KnownColumns<Columns, ClientTypes<Client>['typeMap']>,
	options?: { reads?: ZodColumnReads }
): ZodColumnsClient<Client, Columns> {
	return extend(client, zodColumns(columns, options)) as ZodColumnsClient<
		Client,
		Columns
	>
}
