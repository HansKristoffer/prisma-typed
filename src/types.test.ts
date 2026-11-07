import { describe, expect, expectTypeOf, test } from 'bun:test'
import type { JsonValue } from '@prisma/client/runtime/client'
import { z } from 'zod'
import { Prisma, type PrismaClient } from '../test/fixture/generated/client'
import {
	columns,
	type notificationData,
	type orderLineDetails,
	type productData
} from '../test/fixture/schemas'
import type { Id } from './typed-ids'
import { withTypedIds } from './typed-ids'
import { withZodColumns } from './zod-inputs'

// Type-only: nothing below is called, so no client is constructed.
declare const base: PrismaClient

type ProductData = z.output<typeof productData>
type OrderLineDetails = z.output<typeof orderLineDetails>
type NotificationData = z.output<typeof notificationData>

// Uncalled factories, so the type tests never touch `base` at runtime.
const narrowed = () => withZodColumns(base, columns)
const typed = () =>
	withZodColumns(
		withTypedIds(base, { Notification: { orderId: 'Order' } }),
		columns
	)

const klippekort = { kind: 'klippekort', klip: 10, validityDays: 365 } as const
const missingDays = { kind: 'klippekort', klip: 10 } as const
const ticket = { kind: 'ticket', version: 1, slotId: 's1', seats: 2 } as const
const wrongVersion = { ...ticket, version: 2 } as const

describe('withZodColumns: read types', () => {
	test('reads are typed as the schema output wherever Prisma returns rows', () => {
		const reads = async (prisma: ReturnType<typeof narrowed>) => {
			const row = await prisma.product.findFirstOrThrow()
			expectTypeOf(row.data).toEqualTypeOf<ProductData>()
			expectTypeOf(row.name).toEqualTypeOf<string>()

			const selected = await prisma.product.findUniqueOrThrow({
				where: { id: 'p1' },
				select: { data: true }
			})
			expectTypeOf(selected).toEqualTypeOf<{ data: ProductData }>()

			const order = await prisma.order.findFirstOrThrow({
				include: { lines: { include: { product: true } } }
			})
			expectTypeOf(order.lines[0]!.details).toEqualTypeOf<OrderLineDetails>()
			expectTypeOf(order.lines[0]!.product!.data).toEqualTypeOf<ProductData>()

			const created = await prisma.product.createManyAndReturn({ data: [] })
			expectTypeOf(created[0]!.data).toEqualTypeOf<ProductData>()
			const updated = await prisma.product.updateManyAndReturn({ data: {} })
			expectTypeOf(updated[0]!.data).toEqualTypeOf<ProductData>()

			const fromTransaction = await prisma.$transaction((tx) =>
				tx.product.findFirstOrThrow()
			)
			expectTypeOf(fromTransaction.data).toEqualTypeOf<ProductData>()

			const notification = await prisma.notification.findFirstOrThrow()
			expectTypeOf(notification.data).toEqualTypeOf<NotificationData>()
		}
		expect(reads).toBeFunction()
	})

	test('groupBy rows are typed as the schema output, raw rows are not', () => {
		const reads = async (prisma: ReturnType<typeof narrowed>) => {
			const groups = await prisma.product.groupBy({
				by: ['data'],
				orderBy: { data: 'asc' }
			})
			expectTypeOf(groups[0]!.data).toEqualTypeOf<ProductData>()
			const raw = await prisma.$queryRaw<{ data: JsonValue }[]>`SELECT data`
			expectTypeOf(raw[0]!.data).toEqualTypeOf<JsonValue>()
		}
		expect(reads).toBeFunction()
	})

	test('the data column narrows on its own kind, not on the kind column', () => {
		const narrowing = async (prisma: ReturnType<typeof narrowed>) => {
			const row = await prisma.product.findFirstOrThrow()
			if (row.data.kind === 'klippekort') {
				expectTypeOf(row.data.klip).toEqualTypeOf<number>()
			}
			if (row.kind === 'klippekort') {
				// @ts-expect-error the row is not a union, so `kind` cannot narrow `data`
				void row.data.klip
			}
		}
		expect(narrowing).toBeFunction()
	})

	test('a row cast to a union narrows on the kind column too', () => {
		// Sound only while the database keeps `kind` equal to `data.kind`
		// (a CHECK constraint); Prisma cannot type a row as a union itself.
		type KindUnion<Row extends { data: { kind: string } }> =
			Row['data'] extends infer Data
				? Data extends { kind: infer Kind }
					? Omit<Row, 'kind' | 'data'> & { kind: Kind; data: Data }
					: never
				: never
		const narrowing = async (prisma: ReturnType<typeof narrowed>) => {
			const row = await prisma.product.findFirstOrThrow()
			const product = row as KindUnion<typeof row>
			if (product.kind === 'klippekort') {
				expectTypeOf(product.data.klip).toEqualTypeOf<number>()
			}
		}
		expect(narrowing).toBeFunction()
	})
})

describe('withZodColumns: write types', () => {
	test('top-level writes take the schema input', () => {
		const writes = async (db: ReturnType<typeof narrowed>) => {
			const product = {
				kind: 'klippekort',
				name: '10 klip',
				data: klippekort
			} as const
			const bad = { ...product, data: missingDays }

			await db.product.create({ data: product })
			// @ts-expect-error validityDays is missing
			await db.product.create({ data: bad })

			await db.product.createMany({ data: [product] })
			// @ts-expect-error validityDays is missing
			await db.product.createMany({ data: [bad] })

			await db.product.createManyAndReturn({ data: product })
			// @ts-expect-error validityDays is missing
			await db.product.createManyAndReturn({ data: bad })

			await db.product.update({
				where: { id: 'p1' },
				data: { data: klippekort }
			})
			await db.product.update({
				where: { id: 'p1' },
				// @ts-expect-error validityDays is missing
				data: { data: missingDays }
			})

			await db.product.updateMany({ data: { data: klippekort } })
			// @ts-expect-error validityDays is missing
			await db.product.updateMany({ data: { data: missingDays } })

			await db.product.updateManyAndReturn({ data: { data: klippekort } })
			// @ts-expect-error validityDays is missing
			await db.product.updateManyAndReturn({ data: { data: missingDays } })

			await db.product.upsert({
				where: { id: 'p1' },
				create: product,
				update: { data: klippekort }
			})
			await db.product.upsert({
				where: { id: 'p1' },
				create: product,
				// @ts-expect-error validityDays is missing
				update: { data: missingDays }
			})
		}
		expect(writes).toBeFunction()
	})

	test('nested writes take the schema input', () => {
		const writes = async (db: ReturnType<typeof narrowed>) => {
			const where = { id: 'l1' }

			await db.order.create({
				data: { lines: { create: [{ details: ticket }] } }
			})
			await db.order.create({
				// @ts-expect-error version must be 1
				data: { lines: { create: [{ details: wrongVersion }] } }
			})

			await db.order.create({
				data: { lines: { createMany: { data: [{ details: ticket }] } } }
			})
			await db.order.create({
				// @ts-expect-error version must be 1
				data: { lines: { createMany: { data: [{ details: wrongVersion }] } } }
			})

			await db.order.update({
				where: { id: 'o1' },
				data: { lines: { update: { where, data: { details: ticket } } } }
			})
			await db.order.update({
				where: { id: 'o1' },
				// @ts-expect-error version must be 1
				data: { lines: { update: { where, data: { details: wrongVersion } } } }
			})

			await db.order.update({
				where: { id: 'o1' },
				data: {
					lines: { upsert: { where, create: { details: ticket }, update: {} } }
				}
			})
			await db.order.update({
				where: { id: 'o1' },
				data: {
					lines: {
						// @ts-expect-error version must be 1
						upsert: { where, create: { details: wrongVersion }, update: {} }
					}
				}
			})

			// On a model with a `data` column, a nested update sets it only
			// through `{ where, data }`.
			const line = { id: 'l1' }
			await db.orderLine.update({
				where: line,
				data: { product: { update: { where: {}, data: { data: klippekort } } } }
			})
			await db.orderLine.update({
				where: line,
				data: { product: { update: { name: 'renamed' } } }
			})
			await db.orderLine.update({
				where: line,
				// @ts-expect-error `data` without `where` is ambiguous
				data: { product: { update: { data: klippekort } } }
			})
			await db.orderLine.update({
				where: line,
				// @ts-expect-error `data` without `where` is ambiguous
				data: { product: { update: { data: { name: 'renamed' } } } }
			})

			// Two levels down: order → line → product.
			const product = {
				kind: 'klippekort',
				name: 'x',
				data: klippekort
			} as const
			await db.order.create({
				data: {
					lines: { create: { details: ticket, product: { create: product } } }
				}
			})
			await db.order.create({
				data: {
					lines: {
						// @ts-expect-error validityDays is missing
						create: {
							details: ticket,
							product: { create: { ...product, data: missingDays } }
						}
					}
				}
			})
		}
		expect(writes).toBeFunction()
	})

	test('nullable columns keep Prisma’s null markers, required ones refuse them', () => {
		const writes = async (db: ReturnType<typeof narrowed>) => {
			await db.notification.create({
				data: { type: 'empty', data: Prisma.DbNull }
			})
			await db.notification.create({
				data: { type: 'titled', data: { title: 'Hej' } }
			})
			await db.notification.create({
				// @ts-expect-error title must be a string
				data: { type: 'titled', data: { title: 1 } }
			})

			await db.product.create({
				data: { kind: 'klippekort', name: 'x', data: klippekort }
			})
			await db.product.create({
				// @ts-expect-error Product.data is required
				data: { kind: 'klippekort', name: 'x', data: Prisma.JsonNull }
			})
		}
		expect(writes).toBeFunction()
	})

	test('the transaction client keeps the narrowed inputs', () => {
		const writes = async (db: ReturnType<typeof narrowed>) => {
			await db.$transaction(async (tx) => {
				await tx.product.create({
					data: { kind: 'klippekort', name: 'x', data: klippekort }
				})
				await tx.product.create({
					// @ts-expect-error validityDays is missing
					data: { kind: 'klippekort', name: 'x', data: missingDays }
				})
			})
		}
		expect(writes).toBeFunction()
	})

	test('a later $extends keeps the read types but drops the narrowed inputs', () => {
		const writes = async (db: ReturnType<typeof narrowed>) => {
			const extended = db.$extends({})
			const row = await extended.product.findFirstOrThrow()
			expectTypeOf(row.data).toEqualTypeOf<ProductData>()
			// Compiles: the input is Prisma's JSON type again. The runtime still rejects it.
			await extended.product.create({
				data: { kind: 'klippekort', name: 'x', data: missingDays }
			})
		}
		expect(writes).toBeFunction()
	})

	test('rejects unknown models and fields that are not Json', () => {
		const configs = () => {
			withZodColumns(base, { Product: { data: columns.Product.data } })
			// @ts-expect-error there is no model called Produkt
			withZodColumns(base, { Produkt: { data: columns.Product.data } })

			withZodColumns(base, {
				OrderLine: { details: columns.OrderLine.details }
			})
			withZodColumns(base, {
				// @ts-expect-error OrderLine.orderId is a String column
				OrderLine: { orderId: columns.OrderLine.details }
			})
		}
		expect(configs).toBeFunction()
	})

	test('rejects schemas whose parsed value cannot be stored and read back', () => {
		const configs = () => {
			// JSON in, JSON out; a brand only narrows the output.
			withZodColumns(base, {
				OrderLine: {
					details: z.object({
						at: z.iso.datetime(),
						slotId: z.string().brand<'Slot'>()
					})
				}
			})
			withZodColumns(base, {
				OrderLine: {
					// @ts-expect-error stores the parsed value, which must parse again
					details: z.object({ seats: z.string().transform(Number) })
				}
			})
			withZodColumns(base, {
				// @ts-expect-error a Date is not JSON
				OrderLine: { details: z.object({ at: z.date() }) }
			})
		}
		expect(configs).toBeFunction()
	})

	test('matches each schema’s nullability to its column', () => {
		const configs = () => {
			withZodColumns(base, {
				Notification: { data: columns.Notification.data }
			})
			withZodColumns(base, {
				// @ts-expect-error Notification.data is Json?, so its schema must accept null
				Notification: { data: columns.Notification.data.unwrap() }
			})
			withZodColumns(base, { Product: { data: columns.Product.data } })
			withZodColumns(base, {
				// @ts-expect-error Product.data is required, so its schema must not accept null
				Product: { data: columns.Product.data.nullable() }
			})
		}
		expect(configs).toBeFunction()
	})
})

describe('withTypedIds', () => {
	test('brands ids and relation scalars, and composes with withZodColumns', () => {
		const reads = async (db: ReturnType<typeof typed>) => {
			const product = await db.product.findFirstOrThrow()
			expectTypeOf(product.id).toEqualTypeOf<Id<'Product'>>()
			expectTypeOf(product.locationId).toEqualTypeOf<Id<'Location'> | null>()
			expectTypeOf(product.data).toEqualTypeOf<ProductData>()

			const order = await db.order.findFirstOrThrow({
				include: { lines: true }
			})
			expectTypeOf(order.lines[0]!.orderId).toEqualTypeOf<Id<'Order'>>()
			expectTypeOf(
				order.lines[0]!.productId
			).toEqualTypeOf<Id<'Product'> | null>()

			const notification = await db.notification.findFirstOrThrow()
			expectTypeOf(notification.orderId).toEqualTypeOf<Id<'Order'> | null>()

			const lineOrder: Id<'Order'> = order.lines[0]!.orderId
			// @ts-expect-error an order id is not a product id
			const lineProduct: Id<'Product'> = order.lines[0]!.orderId
			void [lineOrder, lineProduct]

			await db.product.create({
				data: { kind: 'klippekort', name: 'x', data: klippekort }
			})
			await db.product.create({
				// @ts-expect-error validityDays is missing
				data: { kind: 'klippekort', name: 'x', data: missingDays }
			})
		}
		expect(reads).toBeFunction()
	})

	test('manual targets must name a string column and a model with an id', () => {
		const configs = () => {
			withTypedIds(base, { Notification: { orderId: 'Order' } })
			// @ts-expect-error Notification has no column ordrId
			withTypedIds(base, { Notification: { ordrId: 'Order' } })
			// @ts-expect-error there is no model called Ordr
			withTypedIds(base, { Notification: { orderId: 'Ordr' } })
		}
		expect(configs).toBeFunction()
	})
})
