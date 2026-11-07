import type { Types } from '@prisma/client/runtime/client'

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

/** What `client.$extends(extension)` returns for an extension with these args. */
export type ExtendedClient<
	Client,
	Args extends Record<string, unknown>,
	Parts extends ClientTypes<Client> = ClientTypes<Client>,
	Merged extends Record<string, unknown> = Types.Extensions.MergeExtArgs<
		Parts['typeMap'],
		Parts['extArgs'],
		Args
	>
> = Types.Extensions.DynamicClientExtensionThis<
	Types.Utils.Call<Parts['typeMapCb'], { extArgs: Merged }>,
	Parts['typeMapCb'],
	Merged
>

/** Calls `client.$extends`, whose overloads a generic client cannot name. */
export function extend(client: { $extends: unknown }, extension: unknown) {
	return (client.$extends as (extension: unknown) => unknown).call(
		client,
		extension
	)
}
