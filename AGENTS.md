# prisma-typed

prisma-typed types and validates Prisma 7 JSON columns with Zod, and brands id columns, through two functions: `withZodColumns(client, columns)` and `withTypedIds(client, manual?)`. It is published to npm as `prisma-typed`, `0.x`. Its first consumers are the Brain template and the La Sauna platform built on it.

## What we never compromise on

1. **Types are the product.** Read types, write inputs and ids infer from the config map, with no casts and no explicit type arguments.
2. **Fail closed.** A write the library cannot check is refused, never passed through: unknown operations, unknown nested-write keys and ambiguous shapes throw. A rule the types enforce also needs a runtime check, and the other way round.
3. **A write that throws did not commit.** Nothing is thrown after the database has accepted a write.
4. **No runtime dependencies.** `@prisma/client` (types only) and `zod` are peers.

## A note from the maintainer

Small APIs, boring code. Fight scope creep: a feature earns its place when an app needs it. Do not keep complexity just because it already exists.

These are good defaults, not hard rules. My preferences in the conversation override anything here. If a rule fights the task in front of you, say so loudly and ask before breaking it.

## Words we use

- **you** means the agent reading this file. **we** and **the maintainer** mean Kristoffer.
- **consumer** means an app that installs prisma-typed.
- **column** means a JSON column configured in `withZodColumns`. **reaching model** means a model whose writes or reads can touch a column, directly or through relations.
- **walker** means the runtime code in `src/zod-columns.ts` that follows writes and rows through relations. **narrowing** means the types in `src/input-types.ts` that do the same for inputs: JSON columns in writes, and branded ids everywhere a model's rows are picked or set.

## The ways to hurt yourself

1. **Prisma internals.** The walker relies on three: `client._runtimeDataModel` (relations), `__internalParams.dataPath` (the fluent API) and `Symbol.for('prisma.objectEnumValue')` (`DbNull`, `JsonNull`). Keep every access in `src/zod-columns.ts`, and keep each one covered by an integration test.
2. **Prisma's types change between minors.** The narrowing reads Prisma's TypeMap and its exported extension types. The generated `XOR` changed between 7.8 and 7.10 and broke it once. CI runs the tests on 7.8.0 and the latest 7.x; a change that passes on one only is not done.
3. **Editing release state by hand.** Release Please owns `version`, `CHANGELOG.md` and `.release-please-manifest.json`; the PR title decides the release. Never add `NPM_TOKEN`, `NODE_AUTH_TOKEN` or a `registry-url` to `release.yml`: it breaks trusted publishing. See [releasing](docs/releasing.md).
4. **Prisma 8.** It is a rewrite without `$extends` result components. This package is Prisma 7 only; do not add machinery for Prisma 8 here.

## Hit every surface

- **Walker and narrowing.** They encode the same nested-write grammar. A change to one is a change to the other, with a test on each side.
- **Reads.** Read operations parse rows as the query returns. Rows returned by writes parse on first access. Raw queries are never parsed.
- **Tests.** A type rule gets a `@ts-expect-error` inside an uncalled function, next to a positive twin that compiles. A runtime rule gets an integration test on Postgres.
- **Package.** A change to exports, peers, `files` or the build also needs `bun run build`, `attw`, `publint`, `verify:package` and `test:consumers`. A change to the public API also updates `test/consumers/types.ts`, which compiles against the packed package.
- **Docs.** `README.md` is the consumer reference. Rewrite the affected section; do not append a second account.

## Commands

- `bun install`, then `bun run lint` (generates the fixture client, typechecks, runs Biome) and `bun run test`.
- Integration tests skip without `DATABASE_URL`. Locally:
  ```sh
  docker run -d --rm --name prisma-typed-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:25433:5432 postgres:17-alpine
  DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:25433/postgres bun run test
  ```
- After changing `test/fixture/schema.prisma`, run `bun run fixture:sql`.
- To check the oldest supported Prisma: `bun add -d prisma@7.8.0 @prisma/client@7.8.0 @prisma/adapter-pg@7.8.0`, run the tests, then restore `package.json` and `bun.lock`.
- Packaging: `bun run build`, then `bun run attw`, `bun run publint`, `bun run verify:package` (packs, checks the files, imports the installed tarball) and `PEER_PROFILE=minimum bun run test:consumers` (type-checks a consumer of the packed package under NodeNext and Bundler; `latest` is the other profile).

## Commits and pull requests

- Never open a PR unless we ask.
- Conventional titles in plain language, for example `fix: refuse ambiguous nested updates`. Use `!` for a breaking change.
- Body: the problem in a sentence or two, how you fixed it, and how you verified it. End with the model and harness that did the work.

## Taste

- Inferred types over annotations; no `any`.
- Invalid arguments throw with a message that names the model, the field and the bad value.
- Do not mutate the caller's arguments.
- Comments say how a function is used and why. Formatting follows Biome: tabs, single quotes, no semicolons, no trailing commas.
- Do not commit plans or scratch notes. `.plans/` is gitignored.
