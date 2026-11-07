import type { Types } from '@prisma/client/runtime/client'
import type { z } from 'zod'
import { type ClientTypes, type ExtendedClient, extend } from './client-types'

/**
 * A branded string id: `Id<'User'>` is not assignable to `Id<'Team'>`. The
 * same brand as `Id` from `hanzio/zod` and Zod's `.brand<'User'>()`, so the
 * types are interchangeable.
 */
export type Id<Model extends string> = string & z.$brand<Model>

// Brands `id` and relation scalar columns as `Id<'Model'>`. Types only; the
// column values are already right at runtime.

type TypeMapDef = Types.Extensions.TypeMapDef
type Scalars<
	TypeMap extends TypeMapDef,
	Model extends keyof TypeMap['model']
> = TypeMap['model'][Model]['payload']['scalars']
type Objects<
	TypeMap extends TypeMapDef,
	Model extends keyof TypeMap['model']
> = TypeMap['model'][Model]['payload']['objects']

/** Models with a string `id` column. */
export type ModelsWithStringId<TypeMap extends TypeMapDef> = {
	[Model in keyof TypeMap['model']]: 'id' extends keyof Scalars<TypeMap, Model>
		? Exclude<Scalars<TypeMap, Model>['id'], null> extends string
			? Model
			: never
		: never
}[keyof TypeMap['model']]

type StringFields<
	TypeMap extends TypeMapDef,
	Model extends keyof TypeMap['model']
> = {
	[Field in keyof Scalars<TypeMap, Model>]: Exclude<
		Scalars<TypeMap, Model>[Field],
		null
	> extends string
		? Field
		: never
}[keyof Scalars<TypeMap, Model>]

/**
 * String columns with no Prisma relation, mapped to the model they identify,
 * such as a column another library manages without a foreign key.
 */
export type ManualIdTargets<TypeMap extends TypeMapDef> = {
	[Model in keyof TypeMap['model']]?: {
		[Field in StringFields<TypeMap, Model>]?: ModelsWithStringId<TypeMap>
	}
}

/** A to-one relation's target; list relations resolve to `never`. */
type ToOneTarget<TypeMap extends TypeMapDef, Value> = [
	NonNullable<Value>
] extends [{ name: infer Target extends ModelsWithStringId<TypeMap> }]
	? Target
	: never

/** `fooId` next to a to-one relation `foo` identifies foo's model. */
type RelationIdTargets<
	TypeMap extends TypeMapDef,
	Model extends keyof TypeMap['model']
> = {
	[Relation in keyof Objects<TypeMap, Model> &
		string as `${Relation}Id` extends keyof Scalars<TypeMap, Model>
		? [ToOneTarget<TypeMap, Objects<TypeMap, Model>[Relation]>] extends [never]
			? never
			: `${Relation}Id`
		: never]: ToOneTarget<TypeMap, Objects<TypeMap, Model>[Relation]>
}

type IdTargets<
	TypeMap extends TypeMapDef,
	Model extends keyof TypeMap['model'],
	Manual
> = (Model extends ModelsWithStringId<TypeMap>
	? { id: Model }
	: Record<never, never>) &
	RelationIdTargets<TypeMap, Model> &
	(Model extends keyof Manual ? Manual[Model] : Record<never, never>)

type Branded<Target, Value> = Target extends string
	? null extends Value
		? Id<Target> | null
		: Id<Target>
	: never

type TypedIdsExtArgs<TypeMap extends TypeMapDef, Manual> = {
	result: {
		[Model in keyof TypeMap['model'] & string as Uncapitalize<Model>]: {
			[Field in keyof IdTargets<TypeMap, Model, Manual> &
				keyof Scalars<TypeMap, Model> &
				string]: () => {
				needs: { [F in Field]: true }
				compute(
					row: {
						[F in Field]: Scalars<TypeMap, Model>[F]
					}
				): Branded<
					IdTargets<TypeMap, Model, Manual>[Field],
					Scalars<TypeMap, Model>[Field]
				>
			}
		}
	}
	model: Record<never, never>
	query: Record<never, never>
	client: Record<never, never>
}

/** The client with branded ids. */
export type TypedIdsClient<
	Client,
	Manual = Record<never, never>
> = ExtendedClient<
	Client,
	TypedIdsExtArgs<ClientTypes<Client>['typeMap'], Manual>
>

/**
 * Brands every `id` column as `Id<'Model'>` and every relation scalar
 * (`teamId` beside `team`) as the id of the model it points at. Columns with
 * no relation can be named in `manual`.
 *
 * ```ts
 * const prisma = withTypedIds(new PrismaClient({ adapter }), {
 *   Session: { activeOrganizationId: 'Organization' }
 * })
 * const member = await prisma.teamMember.findFirstOrThrow()
 * member.teamId // Id<'Team'>
 * ```
 */
export function withTypedIds<
	Client extends { $extends: unknown },
	const Manual extends ManualIdTargets<ClientTypes<Client>['typeMap']> = Record<
		never,
		never
	>
>(client: Client, manual?: Manual): TypedIdsClient<Client, Manual> {
	void manual
	return extend(client, {
		name: 'hanzio/typedIds',
		result: {}
	}) as TypedIdsClient<Client, Manual>
}
