# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A STDIO MCP server that exposes the **official App Store Connect API** as read-only tools (plus opt-in write tools for the App Store listing, signing/provisioning, TestFlight and the release flow) for AI
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
Node 22 and 24 — all must pass. Run them locally before committing.

## Architecture

Request flow: `index.ts` reads config, builds the server via `server.ts:createServer(client,
vendorNumber, allowWrites, uploadDir, downloadDir)`, and connects it over stdio. Each tool calls the App Store Connect REST `client`.

- **`src/index.ts`** — entry point. Stdio transport only (single-account).
- **`src/config.ts`** — reads env at import time and **exits the process** if `ASC_KEY_ID`,
  `ASC_ISSUER_ID` or a private key (`ASC_PRIVATE_KEY` / `ASC_PRIVATE_KEY_PATH`) is missing. Exports
  `config` (including `allowWrites` from `ASC_ALLOW_WRITES`, `uploadDir` from `ASC_UPLOAD_DIR` and
  `downloadDir` from `ASC_DOWNLOAD_DIR`) and `client`.
- **`src/asc/jwt.ts`** — `createTokenProvider(auth)`: returns a cached ES256 JWT signer (via `jose`)
  for App Store Connect. Tokens are valid 20 min (Apple's max) and cached with a 60 s buffer. The
  `.p8` key is loaded lazily on first use (inline or from a file path).
- **`src/asc/client.ts`** — `AppStoreConnectClient`, a thin `fetch` wrapper over
  `https://api.appstoreconnect.apple.com/v1`. `get`/`getAll` (cursor pagination via `links.next`),
  `getJson` (raw body + optional extra headers, for the non-JSON:API metrics/diagnostics endpoints),
  `post`, `patch`, `delete` (optional JSON body, for relationship removals), `postNoContent`
  (relationship adds, which answer 204), `downloadText`/`downloadBinary` (presigned asset URLs — **no** auth header),
  `uploadPart` (presigned or signed upload URLs, optional longer timeout),
  `downloadGzipText` (analytics segments), `getGzippedReport` (gzipped sales/finance CSV). Throws on
  non-2xx with the response body in the message.
- **`src/asc/format.ts`** — shared helpers: `ok`/`err` (MCP content envelopes; `ok` passes strings
  through unquoted), `imageResult`, and JSON:API helpers `singleRef`, `manyRefs`, `findIncluded`,
  `flattenResource`, `shapeResource` (lift `attributes` to top level + resolve named relationships
  from `included`).
- **`src/asc/files.ts`** — `resolveUploadFile(uploadDir, path, rule)`: the one place that confines
  uploads to `ASC_UPLOAD_DIR` (real path containment, extension of the link and its target, regular
  file, size limit), plus `readBytes` and `hashFile`. Every upload tool goes through it.
- **`src/asc/sigv4.ts`** — `signRequest`: AWS Signature V4 for the S3 upload of a notarization
  submission (Apple returns temporary AWS credentials). Tested against AWS's documented examples.
- **`src/asc/profile.ts`** — `decodeProfile(base64)`: pulls the embedded XML plist out of a
  CMS-signed `.mobileprovision` (no signature verification), parses it with a small built-in plist
  parser and returns team, dates, entitlements, devices, certificate serials and an inferred type.
  Used by `get_profile`.
- **`src/tools/*.ts`** — each exports a `register*Tools(server, client)` function that `server.ts`
  calls: `feedback`, `apps`, `testflight` (build beta state, "What to Test", TestFlight usage
  metrics), `testers`, `analytics` (also takes the default vendor number), `provisioning`,
  `metadata` (App Store versions + review pipeline), `diagnostics` (perf/power metrics, diagnostic
  signatures and logs), `ci` (Xcode Cloud), `screenshots` (App Store screenshot sets + upload), `listing` (App Information, age rating,
  version text — writes), `release` (App Store version create/build attach, review submissions, phased release,
  release request — writes only), `reviews` (customer review responses — writes only), `uploads`
  (build uploads: list/get and `upload_build`), `notary` (macOS notarization through the Notary API on
  `appstoreconnect.apple.com/notary/v2`, same JWT). `listing`, `screenshots`, `release`, `reviews`, `uploads`, `notary`, `testers`,
  `testflight` and `provisioning` take `allowWrites` (third argument; `provisioning` is
  `(server, client, allowWrites, downloadDir)` and `screenshots`, `uploads` and `notary` are
  `(…, allowWrites, uploadDir)`). `provisioning` holds bundle IDs, capabilities,
  certificates, profiles and devices (reads and writes); `testers` the beta group/tester writes;
  `testflight` the build writes (export compliance, What to Test, beta review).
- **`src/tools/shared.ts`** — the tool annotation presets (`READ_ONLY`, `CREATE`, `OVERWRITE`,
  `DESTRUCTIVE`) and `UNTRUSTED_NOTE`. Reuse these instead of redeclaring them.

## Conventions

- **ESM with Node16 module resolution: all relative imports must end in `.js`** (e.g.
  `import { ok } from "../asc/format.js"`), even though the source is `.ts`.
- **Tool handler shape:** `server.tool(name, description, zodShape, annotations, async (args) => {
try { return ok(...); } catch (e) { return err(e); } })`. The third argument is a raw Zod shape
  object, the fourth one of the annotation presets from `tools/shared.ts` (`READ_ONLY` for anything
  that only reads). Match this try/catch-`ok`/`err` style exactly. `server.test.ts` fails if a tool
  has no annotations.
- **Write tools are opt-in.** `update_*` and `upload_app_screenshots` are only registered when
  `allowWrites` is true (`ASC_ALLOW_WRITES`). Implemented as an early `if (!allowWrites) return;` in
  the register function, with the write tools after it, so the gating is one obvious line rather than
  a per-tool condition. Any new write goes below that line.
- **Stranger-written text is untrusted.** Tools that return tester comments, crash logs or customer
  reviews append `UNTRUSTED_NOTE` to their description. Do the same for any new tool that returns
  text written by third parties.
- **Uploads only read from `ASC_UPLOAD_DIR`.** `upload_app_screenshots`, `upload_build` and
  `submit_for_notarization` go through `resolveUploadFile` (`asc/files.ts`): real paths, nothing
  outside that directory, only the tool's own extensions and size limit, plus a magic-number check in
  the tool, all before the first API call. `upload_build` deletes its upload record when the transfer
  fails. The notary upload credentials and the presigned upload URLs are never returned to the agent. With `replace_existing` it uploads and commits the new screenshots
  before deleting the previous ones; keep that order.
- **Profiles are only written to `ASC_DOWNLOAD_DIR`.** `download_profile` takes a relative
  `.mobileprovision` path, resolves the real path of its parent directory and rejects anything outside
  the download directory, refuses symlink targets, never overwrites without `overwrite` (temp file +
  rename) and can alternatively return base64 without touching the disk. Keep new local file writes
  confined the same way.
- **iCloud containers are not in the API.** Do not invent endpoints for them (or app groups): the
  OpenAPI spec has none. The `enable_capability`/`update_capability` descriptions and the README say the
  container must be linked in the developer portal; keep that in sync. Certificate revocation and the
  app record creation are deliberately not offered.
- **Pass the API through, don't fabricate fields.** Tools resolve `included` and flatten
  `attributes`, but surface whatever Apple returns rather than hand-mapping into a fixed schema — so
  the server stays correct if Apple adds/renames attributes. (An earlier third-party server invented
  field names like `timestamp`/`screenshotAsset`; the real fields are `createdDate`/`screenshots[]`.)
- **Don't add comments, docstrings, or type annotations** unless they already exist in the file
  you're editing (per global preference).
- **Scope: retrieval first, writes opt-in.** Read tools are the default. Writes are limited to what
  the README catalog lists: the App Store listing (`tools/listing.ts`, `upload_app_screenshots`),
  signing/provisioning (bundle IDs, capabilities, certificate creation from a CSR, profiles, devices),
  TestFlight groups/testers/builds/export compliance/What to Test/beta review, build uploads, the
  App Store release flow (`tools/release.ts`), customer review responses and notarization
  submissions. Pick the annotation preset by effect: `CREATE` for new resources,
  `OVERWRITE` for idempotent updates, `DESTRUCTIVE` for deletes, removals, cancellations, anything
  that sends something to Apple review and anything that cannot be undone (releasing a version,
  completing a phased release, expiring a build). The other `POST` outside the gate is
  `create_analytics_report_request`, which only requests a report snapshot to _read_ analytics.
  **Deliberately excluded** (and must not be re-added from the upstream reference projects):
  Apple-ID-password browser/Playwright scraping of the internal `iris` API, SMTP "respond to tester"
  email, and certificate revocation.
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

Gated modules (`listing`, `screenshots`, `release`, `reviews`, and the write halves of `provisioning`,
`testers`, `testflight`, `uploads` and `notary`) take `allowWrites` in the test `collect()` helper and assert
the **exact list of registered tool names** when it is false, so a new write tool added above the
gate fails the test. `server.test.ts` connects a real MCP client over an in-memory transport and
asserts the tool list with and without writes, that every tool has annotations, and that the tools
returning third-party text carry the untrusted note. `screenshots.test.ts`, `uploads.test.ts` and
`notary.test.ts` work in a real temp directory (including real symlinks) to cover traversal and symlink
escapes; the `download_profile`
tests in `provisioning.test.ts` do the same for `ASC_DOWNLOAD_DIR`. `profile-fixture.ts` builds fake
CMS-wrapped profiles (with a throwaway self-signed certificate) for `profile.test.ts` and
`get_profile`/`download_profile`.
