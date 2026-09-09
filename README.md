# testflight-mcp

[![npm](https://img.shields.io/npm/v/@orellbuehler/testflight-mcp.svg)](https://www.npmjs.com/package/@orellbuehler/testflight-mcp)
[![CI](https://github.com/OrellBuehler/testflight-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/OrellBuehler/testflight-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@orellbuehler/testflight-mcp.svg)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

MCP server for **TestFlight** and **App Store Connect** that exposes the
[App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi) as tools for AI
agents.

Its focus is **TestFlight beta feedback retrieval** — pulling the screenshot feedback (with the
tester's comment), crash feedback and crash logs your testers submit — plus the surrounding context
an agent needs to make sense of it: apps, builds, beta testers/groups, analytics & sales reports,
provisioning, and App Store metadata. It talks **only to the official, documented API** using a
standard App Store Connect API key (ES256 JWT), and is **read-only**.

> It deliberately does **not** scrape App Store Connect with your Apple ID / password (no headless
> browser, no internal `iris` API) and does **not** send email to testers. Some third-party
> TestFlight servers do; this one stays on the supported API.

## Install

The package is published as
[`@orellbuehler/testflight-mcp`](https://www.npmjs.com/package/@orellbuehler/testflight-mcp) and runs
directly with `npx` — no clone or build needed:

```bash
claude mcp add testflight \
  --env ASC_KEY_ID=ABCD123456 \
  --env ASC_ISSUER_ID=12a3b456-7890-1234-5678-9abcdef01234 \
  --env ASC_PRIVATE_KEY_PATH=/path/to/AuthKey_ABCD123456.p8 \
  -- npx -y @orellbuehler/testflight-mcp
```

For any other MCP client, run the package directly — `npx -y @orellbuehler/testflight-mcp` with the
env vars below set. Requires Node.js 20+.

## Getting an API key

The server authenticates with an **App Store Connect API key** (a `.p8` file plus a key ID and issuer
ID), the same credentials `fastlane`/`altool` use:

1. In [App Store Connect](https://appstoreconnect.apple.com), go to **Users and Access →
   Integrations → App Store Connect API** (Team Keys).
2. **Generate** a key. A role of **App Manager** (or **Admin**) covers TestFlight feedback; **Finance**
   is additionally required for sales/finance reports.
3. Download the `AuthKey_XXXXXXXXXX.p8` (you can only download it once — keep it safe), and note the
   **Key ID** and the team **Issuer ID** shown above the keys table.

Provide the key either as a file path (`ASC_PRIVATE_KEY_PATH`) or inline (`ASC_PRIVATE_KEY`, newlines
may be escaped as `\n`). The key is read locally and used only to sign short-lived request tokens.

## Configuration

| Variable               | Required | Description                                                                           |
| ---------------------- | -------- | ------------------------------------------------------------------------------------- |
| `ASC_KEY_ID`           | yes      | App Store Connect API **Key ID**.                                                     |
| `ASC_ISSUER_ID`        | yes      | App Store Connect API **Issuer ID** (per team).                                       |
| `ASC_PRIVATE_KEY_PATH` | yes\*    | Path to the downloaded `.p8` private key file.                                        |
| `ASC_PRIVATE_KEY`      | yes\*    | The `.p8` contents inline (alternative to the path; `\n` escapes are unescaped).      |
| `ASC_VENDOR_NUMBER`    | no       | Vendor number; required only for `download_sales_report` / `download_finance_report`. |

\* Provide **either** `ASC_PRIVATE_KEY_PATH` **or** `ASC_PRIVATE_KEY`.

## Usage with Claude Code

Add the server to `~/.claude/settings.json` (or a project `.mcp.json`):

```json
{
  "mcpServers": {
    "testflight": {
      "command": "npx",
      "args": ["-y", "@orellbuehler/testflight-mcp"],
      "env": {
        "ASC_KEY_ID": "ABCD123456",
        "ASC_ISSUER_ID": "12a3b456-7890-1234-5678-9abcdef01234",
        "ASC_PRIVATE_KEY_PATH": "/path/to/AuthKey_ABCD123456.p8"
      }
    }
  }
}
```

If you built from source instead, use `"command": "node"` with
`"args": ["/path/to/testflight-mcp/dist/index.js"]`. Restart Claude Code and verify with
`claude mcp list` (should show `testflight ✓ connected`) or `/mcp` inside a session.

### Example prompts

Once connected, ask the agent things like:

- "List the latest TestFlight screenshot feedback for my app and summarize the recurring complaints."
- "Show crash feedback for build 1.4.0 and download the crash log for the most recent one."
- "Which beta testers reported feedback this week, and what devices/OS versions were they on?"
- "Why can't my external testers see build 1.4.0 yet?"
- "How many installs and crashes does the latest build have, and what's the crash rate?"
- "Where is version 1.4.0 in App Review, and is anything blocking it?"
- "What's the top hang signature in the latest build?"
- "The last Xcode Cloud build failed — what were the errors?"
- "Pull this month's sales summary as CSV."

## Tools

Start from `list_apps` to get an `app_id`, then drill into feedback. All tools are read-only.

**TestFlight feedback**

| Tool                       | Description                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_screenshot_feedback` | Screenshot feedback for an app: tester comment, screenshot URLs, device/OS, resolved tester and build (build number `build.version` + TestFlight version `build.preReleaseVersion.version`). Defaults to the latest version only (`app_version`: a version like `1.2.0`, or `all`). Filter by build/platform/device/OS/tester. |
| `list_crash_feedback`      | Crash feedback for an app: comment, device/OS, resolved tester and build (build number + TestFlight version `build.preReleaseVersion.version`), crash-log reference. Defaults to the latest version only (`app_version`: a version like `1.2.0`, or `all`).                                                                    |
| `get_screenshot_feedback`  | One screenshot submission; optionally returns the first screenshot inline as an image.                                                                                                                                                                                                                                         |
| `get_crash_feedback`       | One crash submission with full metadata and crash-log reference.                                                                                                                                                                                                                                                               |
| `get_crash_log`            | Download the crash log text for a crash submission.                                                                                                                                                                                                                                                                            |

**Apps & builds**

| Tool                    | Description                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `list_apps`             | Apps in the account (id, name, bundleId, sku). Filter by bundle ID.                                     |
| `get_app`               | One app by ID.                                                                                          |
| `list_builds`           | TestFlight builds for an app (version, processing state, expiry) with their TestFlight beta state.      |
| `get_build`             | One build with its pre-release version and beta state.                                                  |
| `list_customer_reviews` | Public App Store reviews for a released app, with your published response. Distinct from beta feedback. |

**TestFlight build status & metrics**

| Tool                          | Description                                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `get_build_status`            | Why a build is (not) available to testers: internal/external build state, beta review state, and "What to Test" per locale. |
| `get_build_usage_metrics`     | Installs, sessions, crashes, invites and feedback counts for a build.                                                       |
| `get_beta_tester_metrics`     | Tester engagement (sessions, crashes, feedback) per tester, for an app or a beta group.                                     |
| `list_beta_app_localizations` | Tester-facing TestFlight metadata (beta description, feedback email, privacy URL).                                          |
| `get_beta_app_review_detail`  | Beta App Review contact, demo-account requirement and review notes.                                                         |

**Beta testers & groups**

| Tool                 | Description                                                                |
| -------------------- | -------------------------------------------------------------------------- |
| `list_beta_groups`   | Beta groups for an app (internal/external, public link, feedback enabled). |
| `list_beta_testers`  | Beta testers (name, email, invite type, state). Filter by app/group/email. |
| `list_group_testers` | Testers in a specific beta group.                                          |

**Analytics & reports**

| Tool                                | Description                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `create_analytics_report_request`   | Request an analytics report (the required first step). Returns a request ID.                           |
| `list_analytics_reports`            | Reports available for a request, optionally filtered by category.                                      |
| `list_analytics_report_segments`    | Downloadable segments of a report (presigned URLs).                                                    |
| `download_analytics_report_segment` | Download + decompress a segment to CSV/TSV text (url must come from `list_analytics_report_segments`). |
| `download_sales_report`             | Sales & Trends report as CSV (needs `ASC_VENDOR_NUMBER`).                                              |
| `download_finance_report`           | Financial report as CSV (needs `ASC_VENDOR_NUMBER` and a region code).                                 |

**Provisioning & devices**

| Tool                | Description                                         |
| ------------------- | --------------------------------------------------- |
| `list_devices`      | Registered devices (name, platform, UDID, status).  |
| `list_certificates` | Signing certificates (type, name, serial, expiry).  |
| `list_profiles`     | Provisioning profiles with their bundle ID.         |
| `list_bundle_ids`   | Registered bundle IDs (identifier, name, platform). |

**App metadata & localizations**

| Tool                                   | Description                                                    |
| -------------------------------------- | -------------------------------------------------------------- |
| `list_app_store_versions`              | App Store versions for an app (version, platform, state).      |
| `list_app_store_version_localizations` | Per-locale metadata (description, keywords, what's new, URLs). |
| `get_app_store_version_localization`   | One localization by ID.                                        |

**App Review pipeline**

| Tool                           | Description                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `list_review_submissions`      | What is in App Review and its state, with the version under review and the submitted items.                |
| `get_app_store_version_status` | One call for a version's release status: attached build, submission, phased release, review contact/notes. |

**Performance & diagnostics**

| Tool                         | Description                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `get_perf_power_metrics`     | MetricKit metrics for an app's recent versions or one build (launch, hang, memory, disk, battery) plus regression insights. |
| `list_diagnostic_signatures` | Grouped disk-write / hang / launch problems for a build, weighted, with Apple's insight.                                    |
| `get_diagnostic_logs`        | Logs for a signature; call stacks are stripped unless `include_call_stacks` is set.                                         |

**Xcode Cloud**

| Tool                    | Description                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `list_ci_products`      | Xcode Cloud products, optionally filtered by app.                                   |
| `list_ci_build_runs`    | Build runs for a product or workflow (number, status, commit, branch/PR).           |
| `list_ci_build_actions` | The actions of a build run (build, test, analyze, archive) with their status.       |
| `list_ci_issues`        | Errors, warnings and test failures for a build action — what to read when CI fails. |
| `list_ci_artifacts`     | Artifacts of a build action (logs, archives, test results) with download URLs.      |

## Notes & caveats

- **Read-only.** The server cannot add/remove testers, edit metadata, or submit apps. The only `POST`
  is `create_analytics_report_request`, which requests an analytics snapshot so the data can be read;
  it does not change your app.
- **TestFlight feedback** requires builds uploaded with feedback enabled and is retained by Apple for
  a limited window (~90 days). The tester's typed comment is the `comment` field on a screenshot
  submission.
- **Crash logs** come from Apple's `betaCrashLogs` resource linked to each crash submission
  (`GET /betaFeedbackCrashSubmissions/{id}/crashLog`), whose `logText` is the full symbolicated
  `.crash` report. `get_crash_log` returns that text; if a submission has no log attached it says so.
- **Reports** (`download_sales_report` / `download_finance_report`) are gzipped CSV decompressed for
  you, and need the **Finance** role on the API key plus `ASC_VENDOR_NUMBER`.
- **Power & performance** data (`get_perf_power_metrics`, `list_diagnostic_signatures`,
  `get_diagnostic_logs`) is aggregated MetricKit data from devices whose owners opted in to sharing
  analytics, is iOS-only, and is empty for apps with too little usage to anonymize.
- **Demo account passwords** are never requested: `get_beta_app_review_detail` and
  `get_app_store_version_status` deliberately omit the `demoAccountPassword` field.
- **Your data goes to the agent/LLM.** Feedback includes tester names, emails and device details. Use
  an API key scoped to the access you actually want.

## Development

```bash
npm install
npm run build         # tsc -> dist/
npm test              # vitest run
npm run typecheck     # tsc --noEmit
npm run lint          # eslint src
npm run format:check  # prettier --check .
```

Run a single test file:

```bash
npx vitest run src/__tests__/feedback.test.ts
```

## CI / Releasing

- **CI** (`.github/workflows/ci.yml`) runs on every push to `main` and on pull requests:
  `format:check`, `lint`, `typecheck` (once) and `test` + `build` on Node 20 and 22.
- **Publish** (`.github/workflows/publish.yml`) runs when a GitHub Release is published. It builds,
  tests, and publishes to npm using [trusted publishing](https://docs.npmjs.com/trusted-publishers)
  (OIDC) — **no `NPM_TOKEN` secret required**, with provenance generated automatically. It skips
  publishing if that version is already on npm.

Cut a release:

```bash
npm version patch          # bumps package.json + creates a vX.Y.Z tag (use minor/major as needed)
git push --follow-tags
gh release create "v$(node -p "require('./package.json').version")" --generate-notes
```

## License

[MIT](./LICENSE) © Orell Bühler
