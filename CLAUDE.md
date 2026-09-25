# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A STDIO MCP server that exposes the **official App Store Connect API** as read-only tools (plus App Store listing edits) for AI
agents, centered on **TestFlight beta feedback retrieval** (screenshot feedback, crash feedback,
crash logs) and surrounding context (apps, builds, testers/groups, analytics & sales reports,
provisioning, App Store metadata). Published to npm as `@orellbuehler/testflight-mcp` and run via
`npx`; the compiled `dist/index.js` is the `bin` entry. See `README.md` for the tool catalog and
env-var reference.

## Commands

```bash
npm run build         # tsc -p tsconfig.build.json -> dist/
npm test              # vitest run (all tests)
npm run test:watch    # vitest watch
npm run lint          # eslint src
npm run typecheck     # tsc --noEmit
npm run format        # prettier --write .
npm run format:check  # prettier --check . (what CI runs)
```

Run a single test file or pattern:

```bash
npx vitest run src/__tests__/feedback.test.ts
npx vitest run -t "get_crash_log"
```

CI (`.github/workflows/ci.yml`) runs `format:check`, `lint`, `typecheck`, and `test` + `build` on
Node 20 and 22 — all must pass. Run them locally before committing.

## Architecture

Request flow: `index.ts` reads config, builds the server via `server.ts:createServer(client,
vendorNumber)`, and connects it over stdio. Each tool calls the App Store Connect REST `client`.

- **`src/index.ts`** — entry point. Stdio transport only (single-account).
- **`src/config.ts`** — reads env at import time and **exits the process** if `ASC_KEY_ID`,
  `ASC_ISSUER_ID` or a private key (`ASC_PRIVATE_KEY` / `ASC_PRIVATE_KEY_PATH`) is missing. Exports
  `config` and `client`.
- **`src/asc/jwt.ts`** — `createTokenProvider(auth)`: returns a cached ES256 JWT signer (via `jose`)
  for App Store Connect. Tokens are valid 20 min (Apple's max) and cached with a 60 s buffer. The
  `.p8` key is loaded lazily on first use (inline or from a file path).
- **`src/asc/client.ts`** — `AppStoreConnectClient`, a thin `fetch` wrapper over
  `https://api.appstoreconnect.apple.com/v1`. `get`/`getAll` (cursor pagination via `links.next`),
  `getJson` (raw body + optional extra headers, for the non-JSON:API metrics/diagnostics endpoints),
  `post`, `downloadText`/`downloadBinary` (presigned asset URLs — **no** auth header),
  `downloadGzipText` (analytics segments), `getGzippedReport` (gzipped sales/finance CSV). Throws on
  non-2xx with the response body in the message.
- **`src/asc/format.ts`** — shared helpers: `ok`/`err` (MCP content envelopes; `ok` passes strings
  through unquoted), `imageResult`, and JSON:API helpers `singleRef`, `manyRefs`, `findIncluded`,
  `flattenResource`, `shapeResource` (lift `attributes` to top level + resolve named relationships
  from `included`).
- **`src/tools/*.ts`** — each exports a `register*Tools(server, client)` function that `server.ts`
  calls: `feedback`, `apps`, `testflight` (build beta state, "What to Test", TestFlight usage
  metrics), `testers`, `analytics` (also takes the default vendor number), `provisioning`,
  `metadata` (App Store versions + review pipeline), `diagnostics` (perf/power metrics, diagnostic
  signatures and logs), `ci` (Xcode Cloud), `screenshots` (App Store screenshot sets + upload), `listing` (App Information, age rating,
  version text — writes).

## Conventions

- **ESM with Node16 module resolution: all relative imports must end in `.js`** (e.g.
  `import { ok } from "../asc/format.js"`), even though the source is `.ts`.
- **Tool handler shape:** `server.tool(name, description, zodShape, async (args) => { try { return
ok(...); } catch (e) { return err(e); } })`. The third argument is a raw Zod shape object. Match this
  try/catch-`ok`/`err` style exactly.
- **Pass the API through, don't fabricate fields.** Tools resolve `included` and flatten
  `attributes`, but surface whatever Apple returns rather than hand-mapping into a fixed schema — so
  the server stays correct if Apple adds/renames attributes. (An earlier third-party server invented
  field names like `timestamp`/`screenshotAsset`; the real fields are `createdDate`/`screenshots[]`.)
- **Don't add comments, docstrings, or type annotations** unless they already exist in the file
  you're editing (per global preference).
- **Scope is read-only retrieval.** Do not add tools that mutate App Store Connect (no add/remove
  tester, no app-store-version create/update, no app submission). The deliberate exception is the
  App Store listing: `tools/listing.ts` (`update_*`: App Information, categories, age rating, version
  string/copyright/release type, version localization text) and `upload_app_screenshots`
  (`tools/screenshots.ts`). Keep writes confined to listing metadata — still no testers, builds or
  submission. The other `POST` is
  `create_analytics_report_request`, which only requests a report snapshot to _read_ analytics — it
  does not modify the app. **Deliberately excluded** (and must not be re-added from the upstream
  reference projects): Apple-ID-password browser/Playwright scraping of the internal `iris` API, and
  SMTP "respond to tester" email.
- **Secrets:** the repo is public. Never log the `.p8` key or tokens; only read them from env. Tests
  use a locally generated throwaway EC key. Review-detail endpoints expose a `demoAccountPassword`
  field — it is deliberately left out of every `fields[...]` list; don't add it back.

## Tests

Tests live in `src/__tests__/*.test.ts`. Tool tests pass a fake `{ tool: (name, desc, schema,
handler) => ... }` server to the `register*Tools` function to capture handlers, construct a real
`AppStoreConnectClient` with a fake token provider (`async () => "tok"`), then stub global `fetch`
and assert the exact request URL (path + `searchParams`) and the output shaping. `client.test.ts`
covers pagination, gzip and error handling; `jwt.test.ts` signs with a generated P-256 key and
asserts header/claims/caching; `config.ts` reads env at import time and exits if it's missing, so
`config.test.ts` `vi.stubEnv(...)` then dynamically `import()`s it.
