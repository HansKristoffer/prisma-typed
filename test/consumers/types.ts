// Type-checked against the packed package by scripts/check-consumers.ts,
// next to a Prisma client generated from test/fixture/schema.prisma.
import {
	type Id,
	withTypedIds,
	withZodColumns,
	ZodColumnError
} from 'prisma-typed'
import { z } from 'zod'
import { Prisma, type PrismaClient } from './generated/client.ts'

const productData = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('klippekort'),
		klip: z.int().positive(),
		validityDays: z.int().positive()
	}),
	z.object({
		kind: z.literal('gift_card'),
		minOre: z.int().positive(),
		maxOre: z.int().positive()
	})
])

declare const base: PrismaClient
const prisma = withZodColumns(withTypedIds(base), {
	Product: { data: productData }
})

export async function consumer() {
	const product = await prisma.product.findFirstOrThrow()
	const id: Id<'Product'> = product.id
	const data: z.output<typeof productData> = product.data

	await prisma.product.update({
		where: { id },
		data: { data: { kind: 'gift_card', minOre: 1, maxOre: 2 } }
	})
	await prisma.product.update({
		where: { id },
		// @ts-expect-error validityDays is missing
		data: { data: { kind: 'klippekort', klip: 1 } }
	})

	const line = await prisma.orderLine.findFirstOrThrow()
	await prisma.order.findUnique({ where: { id: line.orderId } })
	// @ts-expect-error an order id is not a product id
	await prisma.product.findUnique({ where: { id: line.orderId } })

	await prisma.notification.create({ data: { type: 't', data: Prisma.DbNull } })
	return { data, error: ZodColumnError }
}
