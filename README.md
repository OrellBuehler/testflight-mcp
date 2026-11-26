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
standard App Store Connect API key (ES256 JWT), and is **read-only by default**. Everything that
changes your account is opt-in via `ASC_ALLOW_WRITES`: editing the App Store listing (App Information,
product page text and screenshots), managing signing (bundle IDs and capabilities, certificates,
provisioning profiles, devices), TestFlight groups/testers/builds, the App Store release flow
(versions, builds, review submissions, phased release), uploading builds without Xcode or Transporter,
replying to customer reviews, and submitting Mac software to Apple's notary service.

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
env vars below set. Requires Node.js 22+.

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

| Variable               | Required | Description                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ASC_KEY_ID`           | yes      | App Store Connect API **Key ID**.                                                                                                                                                                                                                                                                                                             |
| `ASC_ISSUER_ID`        | yes      | App Store Connect API **Issuer ID** (per team).                                                                                                                                                                                                                                                                                               |
| `ASC_PRIVATE_KEY_PATH` | yes\*    | Path to the downloaded `.p8` private key file.                                                                                                                                                                                                                                                                                                |
| `ASC_PRIVATE_KEY`      | yes\*    | The `.p8` contents inline (alternative to the path; `\n` escapes are unescaped).                                                                                                                                                                                                                                                              |
| `ASC_VENDOR_NUMBER`    | no       | Vendor number; required only for `download_sales_report` / `download_finance_report`.                                                                                                                                                                                                                                                         |
| `ASC_ALLOW_WRITES`     | no       | Set to `true` or `1` to register all write tools (see the tool catalog). Off by default.                                                                                                                                                                                                                                                      |
| `ASC_UPLOAD_DIR`       | no       | Directory the upload tools may read from; required for them. After resolving symlinks only files inside it are accepted: `.png`/`.jpg`/`.jpeg` for `upload_app_screenshots` (max 30 MB) and `upload_app_store_asset` (max 50 MB), `.ipa`/`.pkg` (max 4 GB) for `upload_build`, `.zip`/`.dmg`/`.pkg` (max 5 GB) for `submit_for_notarization`. |
| `ASC_DOWNLOAD_DIR`     | no       | Directory `download_profile` may write `.mobileprovision` files to. Required to save a profile to disk (`return_base64` works without it); only relative paths inside it ending in `.mobileprovision` are accepted, symlinks are never followed.                                                                                              |

\* Provide **either** `ASC_PRIVATE_KEY_PATH` **or** `ASC_PRIVATE_KEY`.

### Enabling writes

By default the server registers only read tools. Tester feedback, crash logs and customer reviews are
text written by strangers, and an agent that reads them next to write tools could be talked into
changing your account by a crafted comment. Only set `ASC_ALLOW_WRITES` when you want the agent to
change something (edit the listing, set up signing, manage TestFlight, upload a build, submit a release), ideally in a
separate MCP server entry that you enable for that task:

```json
{
  "mcpServers": {
    "testflight-writes": {
      "command": "npx",
      "args": ["-y", "@orellbuehler/testflight-mcp"],
      "env": {
        "ASC_KEY_ID": "ABCD123456",
        "ASC_ISSUER_ID": "12a3b456-7890-1234-5678-9abcdef01234",
        "ASC_PRIVATE_KEY_PATH": "/path/to/AuthKey_ABCD123456.p8",
        "ASC_ALLOW_WRITES": "true",
        "ASC_UPLOAD_DIR": "/path/to/uploads",
        "ASC_DOWNLOAD_DIR": "/path/to/profiles"
      }
    }
  }
}
```

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`) so clients can ask for confirmation before a write.

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

With writes enabled:

- "Look at the App ID for com.acme.app: which capabilities are on, and is the iCloud entitlement in its profile?"
- "Enable push notifications on com.acme.app, then create an App Store profile named 'Acme App Store' with my distribution certificate and save it to my profiles folder."
- "Create an external beta group 'Friends', add these testers and the latest build, and submit the build for beta review."
- "Create version 1.0.0, attach build 12, set release after approval and submit it to App Review."
- "Upload build/App.ipa as 1.4.0 (42), wait until it is processed and give it to the internal group."
- "Version 1.4.0 is approved: turn on phased release and release it. Pause the rollout if crashes go up."
- "Notarize dist/Acme.dmg and tell me what the notary log says."

## Tools

Start from `list_apps` to get an `app_id`, then drill into feedback. Tools marked **Writes** are only
registered when `ASC_ALLOW_WRITES` is set; everything else is read-only.

**TestFlight feedback**

| Tool                       | Description                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_screenshot_feedback` | Screenshot feedback for an app: tester comment, screenshot URLs, device/OS, resolved tester and build (build number `build.version` + TestFlight version `build.preReleaseVersion.version`). Defaults to the latest version only (`app_version`: a version like `1.2.0`, or `all`). Filter by build/platform/device/OS/tester. |
| `list_crash_feedback`      | Crash feedback for an app: comment, device/OS, resolved tester and build (build number + TestFlight version `build.preReleaseVersion.version`), crash-log reference. Defaults to the latest version only (`app_version`: a version like `1.2.0`, or `all`).                                                                    |
| `get_screenshot_feedback`  | One screenshot submission; optionally returns the first screenshot inline as an image.                                                                                                                                                                                                                                         |
| `get_crash_feedback`       | One crash submission with full metadata and crash-log reference.                                                                                                                                                                                                                                                               |
| `get_crash_log`            | Download the crash log text for a crash submission.                                                                                                                                                                                                                                                                            |

**Apps & builds**

| Tool                              | Description                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `list_apps`                       | Apps in the account (id, name, bundleId, sku). Filter by bundle ID.                                     |
| `get_app`                         | One app by ID.                                                                                          |
| `list_builds`                     | TestFlight builds for an app (version, processing state, expiry) with their TestFlight beta state.      |
| `get_build`                       | One build with its pre-release version and beta state.                                                  |
| `list_customer_reviews`           | Public App Store reviews for a released app, with your published response. Distinct from beta feedback. |
| `reply_to_customer_review`        | **Writes, public.** Publish (or replace) your developer response to a review.                           |
| `delete_customer_review_response` | **Writes, destructive.** Delete your developer response to a review.                                    |

**Build uploads** (`upload_build` needs `ASC_ALLOW_WRITES` and `ASC_UPLOAD_DIR`)

| Tool                 | Description                                                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_build_uploads` | Every binary sent to App Store Connect (by this server, Xcode or Transporter) with its upload state, Apple's errors/warnings and the resulting build. |
| `get_build_upload`   | One upload with its state, files and resulting build; poll it after `upload_build`.                                                                   |
| `upload_build`       | **Writes.** Upload a signed `.ipa` (iOS, tvOS, visionOS) or `.pkg` (macOS) from `ASC_UPLOAD_DIR` without Xcode or Transporter.                        |

**TestFlight build status & metrics**

| Tool                            | Description                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `get_build_status`              | Why a build is (not) available to testers: internal/external build state, beta review state, and "What to Test" per locale. |
| `get_build_usage_metrics`       | Installs, sessions, crashes, invites and feedback counts for a build.                                                       |
| `get_beta_tester_metrics`       | Tester engagement (sessions, crashes, feedback) per tester, for an app or a beta group.                                     |
| `list_beta_app_localizations`   | Tester-facing TestFlight metadata (beta description, feedback email, privacy URL).                                          |
| `get_beta_app_review_detail`    | Beta App Review contact, demo-account requirement and review notes.                                                         |
| `set_build_export_compliance`   | **Writes.** Answer the export compliance question (`usesNonExemptEncryption`) for a build.                                  |
| `set_build_whats_new`           | **Writes.** Set a build's "What to Test" text for a locale (creates the locale if missing).                                 |
| `update_beta_app_review_detail` | **Writes.** Set the beta review contact, demo account and review notes (the demo password is write-only).                   |
| `set_beta_app_localization`     | **Writes.** Set the tester-facing description, feedback email and URLs for a locale (creates the locale if missing).        |
| `delete_beta_app_localization`  | **Writes, destructive.** Delete one locale of the TestFlight app information.                                               |
| `submit_build_for_beta_review`  | **Writes.** Submit a build for beta app review (needed for external groups).                                                |
| `expire_build`                  | **Writes, destructive.** Expire a build so it can no longer be installed or submitted (cannot be undone).                   |

**Beta testers & groups**

| Tool                             | Description                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `list_beta_groups`               | Beta groups for an app (internal/external, public link, feedback enabled).                   |
| `list_beta_testers`              | Beta testers (name, email, invite type, state). Filter by app/group/email.                   |
| `list_group_testers`             | Testers in a specific beta group.                                                            |
| `create_beta_group`              | **Writes.** Create an internal or external beta group.                                       |
| `delete_beta_group`              | **Writes, destructive.** Delete a beta group.                                                |
| `add_beta_tester`                | **Writes.** Create a tester by email in groups (Apple emails an invitation).                 |
| `add_testers_to_beta_group`      | **Writes.** Add existing testers to a group.                                                 |
| `remove_testers_from_beta_group` | **Writes, destructive.** Remove testers from a group.                                        |
| `add_builds_to_beta_group`       | **Writes.** Make builds available to a group.                                                |
| `remove_builds_from_beta_group`  | **Writes, destructive.** Remove builds from a group.                                         |
| `update_beta_group`              | **Writes.** Rename a group, switch its public link or tester limit, turn feedback on or off. |
| `remove_beta_tester`             | **Writes, destructive.** Remove a tester from one app or from the whole team.                |

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

Everything needed to set up signing for a new app without a Mac: register the bundle ID, enable
capabilities, pick a distribution certificate, create and verify an App Store profile and export it.

| Tool                 | Description                                                                                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_devices`       | Registered devices (name, platform, UDID, status).                                                                                                                                                                                             |
| `list_certificates`  | Signing certificates with `certificateType`, name, serial, expiry and `activated`; filter by type.                                                                                                                                             |
| `get_certificate`    | One certificate; optionally with its base64 DER content.                                                                                                                                                                                       |
| `list_profiles`      | Provisioning profiles with type, state, expiry and bundle ID; filter by state or type.                                                                                                                                                         |
| `get_profile`        | One profile in depth: type, state, expiry, bundle ID, its certificates and devices, plus the decoded profile content (entitlements, team, inferred type, certificate serials). Catches a Development profile where an App Store one is needed. |
| `list_bundle_ids`    | Registered bundle IDs (id, identifier, name, platform).                                                                                                                                                                                        |
| `get_bundle_id`      | One bundle ID (by id or exact identifier) with its enabled capabilities and settings and its profiles.                                                                                                                                         |
| `register_bundle_id` | **Writes.** Register a bundle ID (App ID).                                                                                                                                                                                                     |
| `update_bundle_id`   | **Writes.** Rename a bundle ID (the identifier is permanent).                                                                                                                                                                                  |
| `delete_bundle_id`   | **Writes, destructive.** Delete a bundle ID (only possible while no App Store Connect app uses it).                                                                                                                                            |
| `enable_capability`  | **Writes.** Enable a capability (push notifications, iCloud, associated domains, ...) with optional settings, e.g. iCloud with CloudKit.                                                                                                       |
| `update_capability`  | **Writes.** Change the settings of an enabled capability.                                                                                                                                                                                      |
| `disable_capability` | **Writes, destructive.** Disable a capability.                                                                                                                                                                                                 |
| `create_certificate` | **Writes.** Create a certificate from a CSR (you keep the private key). Revoking certificates is deliberately not offered.                                                                                                                     |
| `create_profile`     | **Writes.** Create a provisioning profile of any type the API supports (`IOS_APP_STORE` for App Store/TestFlight, `IOS_APP_DEVELOPMENT`, `IOS_APP_ADHOC`, `IOS_APP_INHOUSE`, the macOS, tvOS and Catalyst variants).                           |
| `delete_profile`     | **Writes, destructive.** Delete a provisioning profile.                                                                                                                                                                                        |
| `download_profile`   | **Writes to local disk.** Export a profile as a `.mobileprovision` file inside `ASC_DOWNLOAD_DIR` and/or return it base64-encoded.                                                                                                             |
| `register_device`    | **Writes.** Register a device by UDID.                                                                                                                                                                                                         |
| `update_device`      | **Writes.** Rename a device or enable/disable it.                                                                                                                                                                                              |

**iCloud containers are not manageable through the API.** The App Store Connect API (OpenAPI spec 4.6.1,
and the _Provisioning_ section of the
[API documentation](https://developer.apple.com/documentation/appstoreconnectapi)) has no endpoint to
list or create iCloud containers or to link one to a bundle ID; the same goes for app groups and
Sign in with Apple groups. `enable_capability` with `ICLOUD` (settings
`[{ "key": "ICLOUD_VERSION", "options": [{ "key": "XCODE_6", "enabled": true }] }]` for CloudKit) only
switches the capability on. Create the container and associate it with the App ID in the Apple
Developer portal (Certificates, Identifiers & Profiles > Identifiers > your App ID > iCloud >
Configure), **then** create the profile, because a profile's entitlements are fixed when it is created
(changing the App ID later invalidates it). Check the result with `get_profile`: a profile without a
`com.apple.developer.icloud-container-identifiers` entitlement has no container.

**App metadata & localizations**

| Tool                                   | Description                                                    |
| -------------------------------------- | -------------------------------------------------------------- |
| `list_app_store_versions`              | App Store versions for an app (version, platform, state).      |
| `list_app_store_version_localizations` | Per-locale metadata (description, keywords, what's new, URLs). |
| `get_app_store_version_localization`   | One localization by ID.                                        |

**App Information & product page** (`update_*` need `ASC_ALLOW_WRITES`)

| Tool                                    | Description                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `get_app_info`                          | App Information: primary locale, content rights, per-locale name/subtitle/privacy URL, categories, age rating. |
| `list_app_categories`                   | Category and subcategory IDs.                                                                                  |
| `update_app`                            | **Writes.** Content rights declaration, primary locale.                                                        |
| `update_app_info`                       | **Writes.** Primary/secondary categories.                                                                      |
| `update_app_info_localization`          | **Writes.** Name, subtitle, privacy policy/choices URL per locale (creates the locale if missing).             |
| `update_age_rating_declaration`         | **Writes.** Age rating questionnaire answers.                                                                  |
| `update_app_store_version`              | **Writes.** Version string, copyright, release type.                                                           |
| `update_app_store_version_localization` | **Writes.** Description, keywords, promotional text, what's new, URLs (creates the locale if missing).         |

**App Store screenshots and header assets** (`upload_app_screenshots` and `upload_app_store_asset` need `ASC_ALLOW_WRITES` and `ASC_UPLOAD_DIR`)

| Tool                               | Description                                                                                                                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_app_screenshot_sets`         | Screenshot sets of a localization (one per display type) with their screenshots and processing state.                                                                                                            |
| `upload_app_screenshots`           | **Writes.** Uploads PNG/JPEG files from `ASC_UPLOAD_DIR` to one display type, in order. With `replace_existing` the previous screenshots are deleted only after every new one is uploaded.                       |
| `list_app_store_asset_placements`  | Asset library placements of a localization, such as the product page header and the search results asset ("Header and Search Results" tab), with state and image.                                                |
| `get_app_asset_library_specs`      | Apple's reference data for those assets: accepted dimensions, file types, sizes and placement groups.                                                                                                            |
| `upload_app_store_asset`           | **Writes.** Uploads a PNG/JPEG from `ASC_UPLOAD_DIR` as the product page header or search results asset of a localization. With `replace_existing` the previous placement is removed once the new one is placed. |
| `delete_app_store_asset_placement` | **Writes, destructive.** Removes a placement from its localization; the image stays in the asset library.                                                                                                        |

**App Review pipeline & release flow**

The API cannot create the app record itself; create the app once in the App Store Connect web UI. The
release flow is then: `create_app_store_version` (or `update_app_store_version` for the release type),
`set_app_store_version_build`, fill in the localizations, `create_review_submission`,
`add_review_submission_item`, `submit_review_submission`. For a staged rollout call
`create_phased_release` before the version goes live; a version with manual release is published with
`release_app_store_version` once it is approved.

| Tool                             | Description                                                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_review_submissions`        | What is in App Review and its state, with the version under review and the submitted items.                                                          |
| `get_app_store_version_status`   | One call for a version's release status: attached build, submission, phased release, review contact/notes.                                           |
| `create_app_store_version`       | **Writes.** Create an App Store version, optionally with release type and build.                                                                     |
| `set_app_store_version_build`    | **Writes.** Attach a build to an editable version.                                                                                                   |
| `update_app_store_review_detail` | **Writes.** Set the App Review notes, contact and demo account of a version (creates the review detail if missing; the demo password is write-only). |
| `create_review_submission`       | **Writes.** Start a review submission for an app and platform (nothing is sent yet).                                                                 |
| `add_review_submission_item`     | **Writes.** Add an App Store version to a submission.                                                                                                |
| `submit_review_submission`       | **Writes, consequential.** Send the submission to App Review.                                                                                        |
| `cancel_review_submission`       | **Writes, destructive.** Cancel a submission that is waiting for or in review.                                                                       |
| `create_phased_release`          | **Writes.** Turn on the 7-day phased release for a version that is not released yet.                                                                 |
| `update_phased_release`          | **Writes, consequential.** Pause or resume a phased release, or release to all users at once.                                                        |
| `delete_phased_release`          | **Writes, destructive.** Turn phased release off again before the rollout started.                                                                   |
| `release_app_store_version`      | **Writes, consequential.** Release an approved version that is pending developer release.                                                            |

**macOS notarization** (`submit_for_notarization` needs `ASC_ALLOW_WRITES` and `ASC_UPLOAD_DIR`)

For Mac software distributed outside the App Store with a Developer ID certificate. These tools use
Apple's [Notary API](https://developer.apple.com/documentation/notaryapi) with the same API key.

| Tool                            | Description                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `list_notarization_submissions` | The team's 100 most recent submissions with name, date and status.                                |
| `get_notarization_submission`   | Status of one submission (Accepted, In Progress, Invalid, Rejected).                              |
| `get_notarization_log`          | The notary log of a finished submission: every issue with its path and architecture.              |
| `submit_for_notarization`       | **Writes.** Upload a signed `.zip`, `.dmg` or `.pkg` from `ASC_UPLOAD_DIR` to the notary service. |

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

- **Read-only unless `ASC_ALLOW_WRITES` is set.** With it, the tools marked **Writes** change your
  account: listing tools (`update_*`, `upload_app_screenshots`), signing and provisioning, TestFlight
  groups/testers/builds, build uploads, the App Store release flow, review replies and notarization. Every write tool carries MCP annotations
  (`CREATE`, `OVERWRITE` or `DESTRUCTIVE`) so clients can ask before running it.
  `create_analytics_report_request` is always available: it only requests an analytics snapshot so the
  data can be read and does not change your app.
- **Not possible through the API:** creating the app record, iCloud containers (see above), revoking
  certificates (deliberately not offered here: do it in the developer portal), deleting devices (they can
  only be disabled).
- **API key role.** Managing identifiers, certificates, profiles and devices needs a key whose role has
  access to Certificates, Identifiers & Profiles (Admin does); TestFlight and App Store tools need
  App Manager or above. Apple does not publish a per-endpoint role table, so a `403` means the key's
  role is too low.
- **Profile files.** `download_profile` only writes `.mobileprovision` files inside
  `ASC_DOWNLOAD_DIR`: the path must be relative, its directory must already exist and resolve (after
  symlinks) to a place inside the download directory, a symlink at the target is refused, and an
  existing file is only replaced with `overwrite` (written to a temporary file first, then renamed).
  Without the variable only `return_base64` works. `get_profile` decodes the CMS-signed profile
  content without verifying its signature.
- **A profile is fixed at creation.** Entitlements come from the App ID at that moment. Enable the
  capabilities (and link the iCloud container in the portal) first, then create the profile; changing
  the App ID later invalidates its profiles.
- **Feedback is untrusted input.** Tester comments, crash logs and customer reviews are written by
  third parties. The tool descriptions tell the agent not to follow instructions found in them, but
  that is a mitigation, not a guarantee, which is why writes are opt-in.
- **Screenshot uploads** only read `.png`/`.jpg`/`.jpeg` files inside `ASC_UPLOAD_DIR` (symlinks are
  resolved first, the content must be PNG or JPEG, max 30 MB). With `replace_existing` the new files
  are uploaded and committed first and the previous screenshots are deleted afterwards; if an upload
  fails the partial uploads are removed and the previous ones stay. A set holds at most 10
  screenshots, so when old and new together exceed 10 the call fails without changing anything unless
  you pass `delete_first`, which deletes just enough previous screenshots up front (those are lost if
  an upload then fails). Apple processes uploads asynchronously, so a screenshot can still fail
  processing after the previous ones were deleted; check with `list_app_screenshot_sets`.
- **Header and search results assets** (`upload_app_store_asset`) follow the same `ASC_UPLOAD_DIR`
  rule (PNG/JPEG, max 50 MB) and go through Apple's asset library: the image is added to the app's
  library and then placed on the localization. Apple validates the dimensions; they are listed by
  `get_app_asset_library_specs`.
- **Build uploads** only read `.ipa`/`.pkg` files inside `ASC_UPLOAD_DIR` (symlinks resolved first,
  max 4 GB). `upload_build` needs the version and build number of the binary because it does not open
  the archive; they must match its `Info.plist`. Only the binary itself is sent, without the analysis
  files Xcode adds. The call returns when the file is delivered; Apple processes it asynchronously and
  reports problems in the upload state, so poll `get_build_upload`. If the transfer fails the upload
  record is deleted again.
- **Notarization** only reads `.zip`/`.dmg`/`.pkg` files inside `ASC_UPLOAD_DIR` (max 5 GB). Apple
  hands out temporary storage credentials per submission; the file is uploaded there and the
  credentials are never returned to the agent. A submission cannot be withdrawn. Stapling the ticket
  still needs `xcrun stapler staple` on a Mac; without it Gatekeeper looks the ticket up online. The
  software must already be signed with a Developer ID certificate, hardened runtime and a secure
  timestamp.
- **Review replies are public.** `reply_to_customer_review` publishes text on the App Store under the
  review. The review itself is untrusted input, so keep a human in the loop for replies.
- **Irreversible releases.** `release_app_store_version`, `update_phased_release` with `COMPLETE` and
  `expire_build` cannot be undone.
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
  `update_beta_app_review_detail` and `update_app_store_review_detail` accept one as input and strip
  it from their result.
- **Your data goes to the agent/LLM.** Feedback includes tester names, emails and device details. Use
  an API key scoped to the access you actually want.

## Upgrading to 0.5.0

Two breaking changes:

- **Writes are opt-in.** The `update_*` tools and `upload_app_screenshots` are no longer registered
  unless `ASC_ALLOW_WRITES=true` (or `1`) is set.
- **Uploads need `ASC_UPLOAD_DIR`.** `upload_app_screenshots` returns an error until it is set, and
  only accepts PNG/JPEG files inside that directory. `replace_existing` now deletes the previous
  screenshots after the upload instead of before, and needs `delete_first` when old and new together
  exceed 10.

Node.js 20 is end-of-life and no longer supported; Node.js 22+ is required.

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
  `format:check`, `lint`, `typecheck` (once) and `test` + `build` on Node 22 and 24.
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
