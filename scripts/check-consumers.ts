import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Packs the package, installs it with its peers in a scratch project,
// generates the test fixture's Prisma client there, and type-checks
// test/consumers/types.ts under NodeNext and Bundler resolution.
// PEER_PROFILE picks the peers: `minimum` (the oldest supported), `latest`,
// or the locked development versions by default.

const root = new URL('../', import.meta.url).pathname
const fixture = await mkdtemp(join(tmpdir(), 'prisma-typed-consumer-'))

async function run(args: string[], cwd = fixture) {
	const child = Bun.spawn(args, { cwd, stdout: 'inherit', stderr: 'inherit' })
	const code = await child.exited
	if (code) {
		throw new Error(`Consumer check failed (${code}): ${args.join(' ')}`)
	}
}

async function installedVersion(name: string, from = root) {
	const manifest = join(from, 'node_modules', name, 'package.json')
	return JSON.parse(await readFile(manifest, 'utf8')).version as string
}

try {
	await run(
		[
			'npm',
			'pack',
			'--ignore-scripts',
			'--silent',
			'--pack-destination',
			fixture
		],
		root
	)
	const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
	await writeFile(
		join(fixture, 'package.json'),
		JSON.stringify({ private: true, type: 'module' })
	)

	const profile = process.env.PEER_PROFILE ?? 'locked'
	const peers =
		profile === 'minimum'
			? { prisma: '7.8.0', zod: '4.0.0', typescript: '5.7.3' }
			: profile === 'latest'
				? { prisma: '^7', zod: '^4', typescript: 'latest' }
				: {
						prisma: await installedVersion('prisma'),
						zod: await installedVersion('zod'),
						typescript: 'latest'
					}
	await run([
		'npm',
		'install',
		'--ignore-scripts',
		'--no-package-lock',
		'--no-audit',
		'--no-fund',
		`${pkg.name}-${pkg.version}.tgz`,
		`prisma@${peers.prisma}`,
		`@prisma/client@${peers.prisma}`,
		`zod@${peers.zod}`,
		'@types/node@22',
		`typescript@${process.env.TYPESCRIPT_VERSION ?? peers.typescript}`
	])

	await cp(
		join(root, 'test/fixture/schema.prisma'),
		join(fixture, 'schema.prisma')
	)
	await run([
		'npx',
		'--no-install',
		'prisma',
		'generate',
		'--schema',
		'schema.prisma'
	])
	await cp(join(root, 'test/consumers/types.ts'), join(fixture, 'types.ts'))

	for (const resolution of ['NodeNext', 'Bundler']) {
		await writeFile(
			join(fixture, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					target: 'ES2022',
					module: resolution === 'NodeNext' ? 'NodeNext' : 'ESNext',
					moduleResolution: resolution,
					strict: true,
					exactOptionalPropertyTypes: true,
					noUncheckedIndexedAccess: true,
					allowImportingTsExtensions: true,
					skipLibCheck: false,
					noEmit: true,
					types: ['node']
				},
				include: ['types.ts']
			})
		)
		await run([
			'node',
			'node_modules/typescript/bin/tsc',
			'-p',
			'tsconfig.json'
		])
	}

	const prisma = await installedVersion('@prisma/client', fixture)
	const typescript = await installedVersion('typescript', fixture)
	console.log(
		`Packed consumer passed (${profile}: Prisma ${prisma}, TypeScript ${typescript})`
	)
} finally {
	await rm(fixture, { recursive: true, force: true })
}
