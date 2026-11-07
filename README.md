# prisma-typed

Type-safe JSON columns and branded ids for Prisma 7. Give a JSON column a Zod schema, and every write is checked before it runs, nested writes included, while every read comes back parsed and typed. Every `id` and foreign key gets its own `Id<'Model'>` type, so passing an order's id where a product's is expected stops compiling.

```sh
bun add prisma-typed zod
```

ESM only, Node 20.19+ or Bun, TypeScript 5.7+, Prisma 7.8+ with the `prisma-client` generator, Zod 4.

```ts
import { withTypedIds, withZodColumns } from 'prisma-typed'
import { z } from 'zod'
import { PrismaClient } from './generated/client'

const productData = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('klippekort'), klip: z.int().positive(), validityDays: z.int().positive() }),
	z.object({ kind: z.literal('gift_card'), minOre: z.int().positive(), maxOre: z.int().positive() })
])

export const prisma = withZodColumns(
	withTypedIds(new PrismaClient({ adapter })),
	{ Product: { data: productData } }
)

const product = await prisma.product.findFirstOrThrow()
product.id // Id<'Product'>
product.data // the union, parsed: a bad row fails the query

await prisma.product.create({
	data: { kind: 'klippekort', name: '10 klip', data: { kind: 'klippekort', klip: 10 } }
})
// Type error: validityDays is missing. Untyped callers get a ZodColumnError before the write runs.
```

## `withZodColumns(client, columns)`

Columns are keyed by model name as written in the Prisma schema, then by field.

- **Reads** are typed as the schema's output and parsed as the query returns: finds, `groupBy`, nested `include` and `select`, the fluent API and both kinds of transaction. A bad row fails the query and names it: `Reading Product.data for id "p1" failed: klip: Too small`.
- **Rows a write returns** (`create`, `update`, `upsert`, `delete`, `createManyAndReturn`, `updateManyAndReturn`) parse when you first read the column, so a write that committed never throws.
- **Writes** are parsed before they run, nested writes included, and the parsed value is what is stored. Unknown keys are stripped.
- **Write inputs** are typed as the schema's input, nested writes included.
- **Raw queries** (`$queryRaw`, TypedSQL) are not parsed.

A write the extension cannot check is refused, not passed through: an operation or nested write it does not know throws.

### Schemas

The compiler checks each schema against its column:

- Its output must be JSON that parses again as input, because that is what is stored and read back. Transforms, codecs and `Date`s are rejected; brands are fine.
- A `Json?` column needs a schema that accepts `null`, and a required column one that does not. Write SQL `NULL` with `Prisma.DbNull`.

Leave out `.default()` and `.catch()` if old rows should fail loudly instead of being filled in.

### Things to know

- **Call `withZodColumns` last.** A later `$extends` keeps the checks and the read types, but drops the narrowed input types for JSON columns and ids.
- **Prisma's generated input types are not narrowed.** A value typed `Prisma.ProductCreateInput` is rejected by the narrowed client. Type inputs with `Prisma.Args<typeof prisma.product, 'create'>['data']` instead.
- **A column called `data` on a to-one relation.** Prisma cannot tell a nested `update: { data }` from its own `{ where, data }` form, so the column is set only through `update: { where: {}, data: { data: … } }`.
- **A `kind` column next to a union in `data`.** A row is not a union, so check `row.data.kind` to narrow `row.data`. Keep the two equal with a `CHECK` constraint.
- **Errors.** `ZodColumnError` carries `model`, `field` and Zod's `issues`.

## `withTypedIds(client, manual?)`

Brands every `id` column as `Id<'Model'>`, and every relation scalar (`teamId` beside a to-one `team`) as the id of the model it points at. A nullable column stays nullable. Name columns without a relation in `manual`:

```ts
const prisma = withTypedIds(new PrismaClient({ adapter }), {
	Session: { activeOrganizationId: 'Organization' }
})
```

Results come back branded. Inputs take the column's own `Id` or a plain string, so values from URLs and fixtures need no cast, and another model's `Id` is a type error:

```ts
const line = await prisma.orderLine.findFirstOrThrow()
await prisma.order.findUnique({ where: { id: line.orderId } })    // ✓
await prisma.product.findUnique({ where: { id: req.params.id } }) // ✓ a plain string
await prisma.product.findUnique({ where: { id: line.orderId } })  // ✗ an Order id is not a Product id
```

That holds in `where` and its filters, `cursor`, `connect` and the other nested writes, relation filters, nested `include` and `select`, and foreign keys in `data`.

`Id<'User'>` is `string & z.$brand<'User'>`, the same brand as Zod's `.brand<'User'>()` and `Id` from `hanzio/zod`. It is types only, with no runtime cost.

## Cost

On 1,000 rows of a three-kind union, parsing adds about 2 ms to a `findMany`, and checking adds about 1% to a `createMany`.

The narrowed input types cost the type checker once per schema, not per query. On a 47-model schema, JSON columns add about 0.2 s and branded id inputs about 0.3 to 0.4 s, on top of the extended client Prisma already builds.

## Prisma 8

Prisma 8 removes the extension API this package is built on. It supports Prisma 7, which Prisma maintains for 18 months after 8.0.
