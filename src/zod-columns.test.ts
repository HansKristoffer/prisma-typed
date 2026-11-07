import { describe, expect, test } from 'bun:test'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../test/fixture/generated/client'
import { columns, productData } from '../test/fixture/schemas'
import { zodColumns } from './zod-columns'
import { withZodColumns } from './zod-inputs'

// Never connects: every case here is refused before a query runs.
const client = () =>
	new PrismaClient({
		adapter: new PrismaPg({ connectionString: 'postgresql://localhost:1/x' })
	})

type Hook = (params: object) => Promise<unknown>

// The hook as Prisma calls it, for operations the client cannot produce.
const hookFor = () => {
	const extension = zodColumns({ Product: { data: productData } })({
		_runtimeDataModel: {
			models: {
				Product: { fields: [{ name: 'data', kind: 'scalar', type: 'Json' }] }
			}
		},
		$extends: (args: unknown) => args
	}) as unknown as { query: { $allModels: { $allOperations: Hook } } }
	return extension.query.$allModels.$allOperations
}

describe('withZodColumns refuses what it cannot check', () => {
	test('a model it does not know, or a field that is not Json', () => {
		expect(() =>
			withZodColumns(client(), { Produkt: { data: productData } } as never)
		).toThrow('unknown model "Produkt"')
		expect(() =>
			withZodColumns(client(), {
				OrderLine: { orderId: columns.OrderLine.details }
			} as never)
		).toThrow('"OrderLine.orderId" is not a Json column')
	})

	test('a nested write it does not know', async () => {
		const prisma = withZodColumns(client(), columns)
		const write = prisma.order.create({
			data: { lines: { createManyAndReturn: { data: [] } } } as never
		})
		await expect(Promise.resolve(write)).rejects.toThrow(
			'cannot check the nested write "createManyAndReturn" on OrderLine'
		)
	})

	test('an operation it does not know, or rows without a query path', async () => {
		const hook = hookFor()
		const query = async () => []
		await expect(
			hook({ model: 'Product', operation: 'upsertMany', args: {}, query })
		).rejects.toThrow('cannot check Product.upsertMany')
		await expect(
			hook({ model: 'Product', operation: 'findMany', args: {}, query })
		).rejects.toThrow('Prisma passed no query path')
		await expect(
			hook({
				model: 'Product',
				operation: 'findMany',
				args: {},
				query,
				__internalParams: { dataPath: [] }
			})
		).resolves.toEqual([])
	})
})
