# backend-saudade

Express + Mongoose API of Picture me around (module `src/around/`) sharing its
process with the frozen Saudade t-shirt API (`src/routes.ts`, do not touch).

Start here, in this order:

1. [`../README.md`](../README.md) — product, flow, security posture, env variables.
2. [`../docs/RADAR.md`](../docs/RADAR.md) — how the radar works end to end
   (presence, fan-out, nearby, join, jobs on Vercel), the thresholds, the
   invariants, and the runbook for "the radar did not ring".
3. [`../docs/AUDIT-RADAR-2026-09.md`](../docs/AUDIT-RADAR-2026-09.md) — what is
   known to be wrong and the roadmap.
4. [`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) §0 — what is actually
   deployed (Vercel, CLI deploys, required env variables) and why a dev server
   must never point at the production database.

Commands (from this folder):

```bash
npm run build        # tsc, strict ESM
npm test             # vitest + supertest + mongodb-memory-server (212 tests on 2026-09-04)
npm run dev          # tsx watch — check MONGODB_URI in .env is LOCAL first
npm run seed:review  # App Review demo around — pass MONGODB_URI explicitly, one-off
```

This folder is its own git repository (`thehnh-tech/backend-saudade`); the root
monorepo only records a pointer to a commit.
