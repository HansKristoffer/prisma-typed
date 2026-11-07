# prisma-typed

Zod-typed, validated JSON columns and branded ids for Prisma 7 clients.

> Work in progress: moved from a hanzio proof of concept. Known issues are being fixed before a first release.

```ts
import { withTypedIds, withZodColumns } from 'prisma-typed'

export const prisma = withZodColumns(
	withTypedIds(new PrismaClient({ adapter })),
	{ Product: { data: productData } }
)
```
