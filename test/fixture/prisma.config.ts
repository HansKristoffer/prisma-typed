import { defineConfig } from 'prisma/config'

// `prisma generate` never connects; `migrate diff` only needs a valid URL.
export default defineConfig({
	schema: './schema.prisma',
	datasource: {
		url:
			process.env.DATABASE_URL ??
			'postgresql://postgres@127.0.0.1:5432/postgres'
	}
})
