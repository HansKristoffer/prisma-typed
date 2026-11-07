import type { Types } from '@prisma/client/runtime/client'
import type { NarrowInputs } from './input-types.js'

/**
 * The type parameters a Prisma 7 client carries, read off its `$extends`
 * hook. Every generated client, extended or not, has one.
 */
export type ClientTypes<Client> = Client extends {
	$extends: Types.Extensions.ExtendsHook<
		'extends',
		infer TypeMapCb extends Types.Extensions.TypeMapCbDef,
		infer ExtArgs extends Record<string, unknown>,
		infer TypeMap extends Types.Extensions.TypeMapDef
	>
}
	? { typeMapCb: TypeMapCb; extArgs: ExtArgs; typeMap: TypeMap }
	: never

/**
 * Extension args that only type results: per model, per field, the type
 * Prisma reads off `compute`. Nothing is computed at runtime.
 */
export type ResultTypes<Result> = {
	result: {
		[Model in keyof Result]: {
			[Field in keyof Result[Model]]: () => {
				compute: () => Result[Model][Field]
			}
		}
	}
	model: Record<never, never>
	query: Record<never, never>
	client: Record<never, never>
}

/**
 * What `client.$extends(extension)` returns for an extension that adds these
 * result types, with JSON column and id inputs narrowed.
 */
export type TypedClient<
	Client,
	Args extends Record<string, unknown>,
	Columns,
	Parts extends ClientTypes<Client> = ClientTypes<Client>,
	ExtArgs extends Record<string, unknown> = Types.Extensions.MergeExtArgs<
		Parts['typeMap'],
		Parts['extArgs'],
		Args
	>
> = Types.Extensions.DynamicClientExtensionThis<
	NarrowInputs<
		Types.Utils.Call<Parts['typeMapCb'], { extArgs: ExtArgs }>,
		Columns,
		ExtArgs
	>,
	Parts['typeMapCb'],
	ExtArgs
>
