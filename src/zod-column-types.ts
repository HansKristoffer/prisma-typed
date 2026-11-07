import type {
	DbNullClass,
	JsonValue,
	Types
} from '@prisma/client/runtime/client'
import type { z } from 'zod'
import type { ResultTypes, TypedClient } from './client-types'

type TypeMapDef = Types.Extensions.TypeMapDef

/**
 * Zod schemas for JSON columns, keyed by model name as written in the Prisma
 * schema, then by field.
 */
export type ZodColumnSchemas = {
	readonly [model: string]: { readonly [field: string]: z.ZodType }
}

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
	Columns extends ZodColumnSchemas
> = TypedClient<Client, ColumnResults<Columns>, Columns>
