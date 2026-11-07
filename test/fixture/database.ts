import { readFileSync } from 'node:fs'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'
import { PrismaClient } from './generated/client'

const ddl = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
	.replace('CREATE SCHEMA IF NOT EXISTS "public";', '')
	.concat(
		// The plan's guard: the `kind` column always mirrors `data.kind`.
		`ALTER TABLE "Product" ADD CONSTRAINT "Product_kind_matches_data" CHECK ("data"->>'kind' = "kind"::text);`
	)

/**
 * Creates the fixture tables in a fresh Postgres schema and returns a client
 * bound to it. `drop` removes the schema.
 */
export async function createFixtureDatabase(url: string) {
	const schema = `prisma_typed_${crypto.randomUUID().replaceAll('-', '')}`
	const admin = new pg.Client({ connectionString: url })
	await admin.connect()
	await admin.query(`CREATE SCHEMA "${schema}"`)
	await admin.query(`SET search_path TO "${schema}"`)
	await admin.query(ddl)

	const prisma = new PrismaClient({
		adapter: new PrismaPg(
			// Raw queries read `search_path`; model queries read `schema`.
			{ connectionString: url, options: `-c search_path=${schema}` },
			{ schema }
		)
	})

	return {
		prisma,
		admin,
		async drop() {
			await prisma.$disconnect()
			await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
			await admin.end()
		}
	}
}
