# Cloudflare SaaS Template

A reusable full-stack application foundation for React applications running on Cloudflare Workers.

## Included

- React 19 and React Router 8
- Vite with the Cloudflare Workers plugin
- Hono for `/api/*` endpoints
- Cloudflare D1 with Drizzle ORM and versioned SQL migrations
- Tailwind CSS 4 and shadcn/ui
- Zod, React Hook Form, and Sonner
- Strict TypeScript and ESLint
- Browser and Workers-runtime tests with Vitest
- Workers observability and uploaded source maps
- CI verification with pnpm

Authentication, organizations, billing, email, object storage, queues, and analytics are intentionally opt-in so each application only adopts the services it needs.

## Requirements

- Node.js 22.22 or newer
- pnpm 11.5 or newer

## Development

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

The Vite development server runs the API in the Cloudflare Workers runtime. `pnpm db:migrate` applies pending migrations to the local D1 database stored under `.wrangler/`.

## Database

The `DB` binding is configured in `wrangler.json`, the Drizzle schema lives in `database/schema.ts`, and generated SQL migrations are committed under `drizzle/`. The included `app_metadata` table is a generic starting point for non-secret application metadata; add application-specific tables to the same schema.

After changing the schema, generate and verify a migration, then apply it locally:

```bash
pnpm db:generate
pnpm db:check
pnpm db:migrate
```

The committed database ID is only a local-development placeholder. Before the first remote deployment, create a D1 database and copy the returned `database_id` into `wrangler.json`:

```bash
pnpm exec wrangler d1 create editorium-db
pnpm cf-typegen
pnpm deploy
```

Keep the binding name as `DB`. `pnpm deploy` applies pending remote migrations before it deploys Worker code, preserving the required schema-before-code order.

## Verification

```bash
pnpm typecheck
pnpm db:check
pnpm lint
pnpm test
pnpm build
pnpm check
```

`pnpm check` validates Drizzle migrations, runs linting, browser tests, Worker integration tests against an isolated D1 database, creates the production build, and performs a Wrangler deployment dry-run.

## Cloudflare configuration

Treat `wrangler.json` as the source of truth. After changing bindings, variables, compatibility flags, or environments, regenerate Worker types:

```bash
pnpm cf-typegen
```

Store production secrets with Wrangler or Cloudflare Secrets Store; never put them in `vars` or commit them to the repository.

## Deploy and rollback

```bash
pnpm check
pnpm deploy
pnpm exec wrangler versions list
pnpm exec wrangler rollback
```

Create separate staging and production resources before serving real users or customer data.
