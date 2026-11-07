// Proof of concept for a `hanzio/prisma` subpath (Prisma 7 client extensions).
// Not exported from package.json.
export {
	type ManualIdTargets,
	type TypedIdsClient,
	withTypedIds
} from './typed-ids'
export {
	ZodColumnError,
	type ZodColumnReads,
	type ZodColumnSchemas,
	zodColumns
} from './zod-columns'
export { withZodColumns, type ZodColumnsClient } from './zod-inputs'
