import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test
} from 'bun:test'
import { createFixtureDatabase } from '../test/fixture/database'
import { Prisma } from '../test/fixture/generated/client'
import { columns } from '../test/fixture/schemas'
import { withTypedIds } from './typed-ids'
import { withZodColumns, ZodColumnError } from './zod-columns'

const url = process.env.DATABASE_URL

describe.skipIf(!url)('withZodColumns on Postgres', () => {
	let db: Awaited<ReturnType<typeof createFixtureDatabase>>
	const extend = () => withZodColumns(db.prisma, columns)
	let prisma: ReturnType<typeof extend>

	const klippekort = {
		kind: 'klippekort',
		klip: 10,
		validityDays: 365
	} as const
	const ticket = {
		kind: 'ticket',
		version: 1,
		slotId: 's1',
		seats: 2
	} as const

	// Bypasses the extension, like a row written before it existed.
	const insertRaw = async (id: string, data: object) => {
		await db.admin.query(
			`INSERT INTO "Product" (id, kind, name, data) VALUES ($1, 'klippekort', 'raw', $2)`,
			[id, JSON.stringify(data)]
		)
	}
	const storedData = async (id: string) =>
		(await db.admin.query('SELECT data FROM "Product" WHERE id = $1', [id]))
			.rows[0]?.data

	// A PrismaPromise is a thenable; `rejects` wants a real promise.
	const rejects = (query: PromiseLike<unknown>) =>
		expect(Promise.resolve(query)).rejects

	beforeAll(async () => {
		db = await createFixtureDatabase(url!)
		prisma = extend()
	})
	afterAll(() => db.drop())
	beforeEach(async () => {
		await db.admin.query(
			'TRUNCATE "OrderLine", "Order", "Product", "Location", "Notification"'
		)
	})

	test('parses reads wherever Prisma returns rows', async () => {
		// A stored key the schema does not know is dropped by the parse.
		await insertRaw('p1', { ...klippekort, legacy: true })
		await prisma.order.create({
			data: { lines: { create: { productId: 'p1', details: ticket } } }
		})

		const reads = [
			(await prisma.product.findMany())[0]?.data,
			(await prisma.product.findUniqueOrThrow({ where: { id: 'p1' } })).data,
			(await prisma.product.findFirst({ select: { data: true } }))?.data,
			(
				await prisma.order.findFirstOrThrow({
					include: { lines: { include: { product: true } } }
				})
			).lines[0]?.product?.data,
			(await prisma.orderLine.findFirstOrThrow().product())?.data,
			(
				await prisma.product.update({
					where: { id: 'p1' },
					data: { name: 'renamed' }
				})
			).data,
			(
				await prisma.product.updateManyAndReturn({
					where: { id: 'p1' },
					data: { name: 'again' }
				})
			)[0]?.data,
			await prisma.$transaction(
				async (tx) => (await tx.product.findFirstOrThrow()).data
			),
			(await prisma.$transaction([prisma.product.findFirstOrThrow()]))[0].data,
			(await prisma.product.groupBy({ by: ['data'] }))[0]?.data,
			(
				await prisma.orderLine.create({
					data: {
						orderId: (await prisma.order.findFirstOrThrow()).id,
						productId: 'p1',
						details: ticket
					},
					include: { product: true }
				})
			).product?.data,
			(
				await prisma.product.upsert({
					where: { id: 'p1' },
					create: { kind: 'klippekort', name: 'x', data: klippekort },
					update: { name: 'upserted' }
				})
			).data,
			(await prisma.product.delete({ where: { id: 'p1' } })).data
		]
		for (const data of reads) expect(data).toEqual(klippekort)
	})

	test('fails the query that returns a bad row, naming the row', async () => {
		await insertRaw('bad', { kind: 'klippekort', klip: -1, validityDays: 30 })
		await rejects(prisma.product.findMany()).toThrow(ZodColumnError)
		await rejects(prisma.product.findMany()).toThrow(
			'Reading Product.data for id "bad" failed: klip: Too small'
		)
		// Queries that do not return the column still work.
		expect(await prisma.product.findMany({ select: { name: true } })).toEqual([
			{ name: 'raw' }
		])
	})

	test('never throws after a write has committed', async () => {
		await insertRaw('legacy', {
			kind: 'klippekort',
			klip: -1,
			validityDays: 30
		})
		const renamed = await prisma.product.update({
			where: { id: 'legacy' },
			data: { name: 'renamed' }
		})
		expect(renamed.name).toBe('renamed')
		const stored = await db.admin.query(
			`SELECT name FROM "Product" WHERE id = 'legacy'`
		)
		expect(stored.rows[0]?.name).toBe('renamed')
		// The bad value still fails loudly, where it is used.
		expect(() => renamed.data).toThrow(
			'Reading Product.data for id "legacy" failed: klip: Too small'
		)
	})

	test('rows a write returns behave like plain objects', async () => {
		const created = await prisma.product.create({
			data: { kind: 'klippekort', name: 'x', data: klippekort }
		})
		expect(structuredClone(created)).toEqual({ ...created })
		expect(JSON.parse(JSON.stringify(created)).data).toEqual(klippekort)
		created.data = { kind: 'gift_card', minOre: 1, maxOre: 2 }
		expect(created.data).toEqual({ kind: 'gift_card', minOre: 1, maxOre: 2 })
	})

	test('leaves raw queries unparsed', async () => {
		await insertRaw('p1', { ...klippekort, legacy: true })
		const rows = await prisma.$queryRaw<{ data: unknown }[]>`
				SELECT data FROM "Product"`
		expect(rows[0]?.data).toEqual({ ...klippekort, legacy: true })
	})

	test('stores the parsed value and leaves the caller’s arguments alone', async () => {
		const data = { ...klippekort, extra: 'dropped' }
		const args = {
			data: { id: 'p1', kind: 'klippekort', name: '10 klip', data }
		} as const
		const created = await prisma.product.create(args)
		expect(created.data).toEqual(klippekort)
		expect(await storedData('p1')).toEqual(klippekort)
		expect(args.data.data).toEqual({ ...klippekort, extra: 'dropped' })
	})

	test('rejects a bad value on every write before it reaches the database', async () => {
		await insertRaw('p1', klippekort)
		// Fits the types; only the schema knows klip must be positive.
		const bad = { kind: 'klippekort', klip: 0, validityDays: 30 } as const
		const row = { kind: 'klippekort', name: 'x', data: bad } as const
		const writes = [
			() => prisma.product.create({ data: row }),
			() => prisma.product.createMany({ data: [row] }),
			() => prisma.product.createManyAndReturn({ data: row }),
			() => prisma.product.update({ where: { id: 'p1' }, data: { data: bad } }),
			() => prisma.product.updateMany({ data: { data: bad } }),
			() => prisma.product.updateManyAndReturn({ data: { data: bad } }),
			() =>
				prisma.product.upsert({
					where: { id: 'p1' },
					create: { ...row, data: klippekort },
					update: { data: bad }
				}),
			() =>
				prisma.product.upsert({
					where: { id: 'new' },
					create: row,
					update: {}
				})
		]
		for (const write of writes) {
			await rejects(write()).toThrow('Writing Product.data failed')
		}
		expect(await storedData('p1')).toEqual(klippekort)
		expect(await prisma.product.count()).toBe(1)
	})

	test('checks columns written through nested writes', async () => {
		const order = await prisma.order.create({
			data: { lines: { create: [{ details: ticket }] } },
			include: { lines: true }
		})
		const lineId = order.lines[0]!.id
		const badDetails = { ...ticket, seats: 0 }
		const nested = [
			() =>
				prisma.order.create({
					data: {
						lines: { create: [{ details: ticket }, { details: badDetails }] }
					}
				}),
			() =>
				prisma.order.create({
					data: { lines: { createMany: { data: [{ details: badDetails }] } } }
				}),
			() =>
				prisma.order.update({
					where: { id: order.id },
					data: {
						lines: {
							update: { where: { id: lineId }, data: { details: badDetails } }
						}
					}
				}),
			() =>
				prisma.order.update({
					where: { id: order.id },
					data: {
						lines: {
							updateMany: { where: {}, data: { details: badDetails } }
						}
					}
				}),
			() =>
				prisma.order.update({
					where: { id: order.id },
					data: {
						lines: {
							upsert: {
								where: { id: 'missing' },
								create: { details: badDetails },
								update: {}
							}
						}
					}
				}),
			() =>
				prisma.order.update({
					where: { id: order.id },
					data: {
						lines: {
							connectOrCreate: {
								where: { id: 'missing' },
								create: { details: badDetails }
							}
						}
					}
				}),
			// Two levels down: order → line → product.
			() =>
				prisma.order.create({
					data: {
						lines: {
							create: {
								details: ticket,
								product: {
									create: {
										kind: 'klippekort',
										name: 'x',
										data: { kind: 'klippekort', klip: 0, validityDays: 1 }
									}
								}
							}
						}
					}
				})
		]
		for (const write of nested) {
			await rejects(write()).toThrow(ZodColumnError)
		}
		const stored = await prisma.orderLine.findMany()
		expect(stored.map((line) => line.details)).toEqual([ticket])
	})

	test('refuses a nested update that leaves `data` ambiguous', async () => {
		await insertRaw('p1', klippekort)
		const order = await prisma.order.create({
			data: { lines: { create: { productId: 'p1', details: ticket } } },
			include: { lines: true }
		})
		const where = { id: order.lines[0]!.id }
		const updateProduct = (update: object) =>
			prisma.orderLine.update({ where, data: { product: { update } } })

		// Prisma reads the first as `{ where?, data }` and the others as the
		// column, by validating both. The extension refuses all three.
		for (const update of [
			{ data: { name: 'renamed' } },
			{ data: { name: 123 } },
			{ name: 'renamed', data: klippekort }
		]) {
			await rejects(updateProduct(update)).toThrow(
				'Ambiguous nested update of Product'
			)
		}
		await updateProduct({ where: {}, data: { name: 'renamed' } })
		await updateProduct({ name: 'direct' })
		await rejects(
			updateProduct({
				where: {},
				data: { data: { kind: 'klippekort', klip: 0, validityDays: 1 } }
			})
		).toThrow('Writing Product.data failed')
		const stored = await db.admin.query(
			`SELECT name, data FROM "Product" WHERE id = 'p1'`
		)
		expect(stored.rows[0]).toEqual({ name: 'direct', data: klippekort })
	})

	test('passes Prisma.DbNull to a nullable column and reads it as null', async () => {
		const created = await prisma.notification.create({
			data: { type: 'empty', data: Prisma.DbNull }
		})
		expect(created.data).toBeNull()
		const titled = await prisma.notification.create({
			data: { type: 'titled', data: { title: 'Hej' } }
		})
		expect(titled.data).toEqual({ title: 'Hej' })
		// The types refuse this; JavaScript callers get the same answer.
		const jsonNull = Prisma.JsonNull as never
		await rejects(
			prisma.product.create({
				data: { kind: 'klippekort', name: 'x', data: jsonNull }
			})
		).toThrow(ZodColumnError)
	})

	test('checks writes inside an interactive transaction', async () => {
		await rejects(
			prisma.$transaction(async (tx) => {
				await tx.product.create({
					data: { kind: 'klippekort', name: 'ok', data: klippekort }
				})
				await tx.product.create({
					data: {
						kind: 'klippekort',
						name: 'bad',
						data: { kind: 'klippekort', klip: 0, validityDays: 1 }
					}
				})
			})
		).toThrow(ZodColumnError)
		expect(await prisma.product.count()).toBe(0)
	})

	test('withZodColumns over withTypedIds checks and parses the same way', async () => {
		const typed = withZodColumns(withTypedIds(db.prisma), columns)
		const created = await typed.product.create({
			data: { kind: 'klippekort', name: 'x', data: klippekort }
		})
		expect(created.data).toEqual(klippekort)
		const found = await typed.product.findUniqueOrThrow({
			where: { id: created.id }
		})
		expect(found.id).toBe(created.id)
		await rejects(
			typed.product.update({
				where: { id: created.id },
				data: { data: { kind: 'klippekort', klip: 0, validityDays: 1 } }
			})
		).toThrow(ZodColumnError)
	})
})
