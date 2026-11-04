# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-11-04

### Added

- Upload status page in the Web client, registered into the built-in plugins
  settings page (`settings.plugins.tab`, id `upload-status`, order 20) as its
  own tab: totals, a search box, a refresh button and one row per session.
  A row is green when the collector acknowledged its whole log, light gray when
  nothing (or only a prefix) was acknowledged.
- `lib/report.js`: the upload report and its read-only route
  `GET /plugin/session-log-universal/report` (loopback only, `no-store`, the whole
  session list up to `REPORT_MAX_ROWS` = 5000 rows, built off the capture path).
  The report derives each state from the watermark, so "uploaded" always means
  "the collector answered 2xx".
- Upstream evidence in the watermark: each acknowledgement now stores the HTTP
  status and a bounded note from the response body (`partialSuccess` included),
  and a refused batch stores `failCode`/`failAt`/`failNote` without moving the
  checkpoint. The status page renders that pair as "HTTP nnn · <time ago>".
- Titles and activity for the report: read from `session/title` (falling back to
  the opening human prompt) and from the stored session logs, both cached and
  budgeted.
- One-click backfill: `POST /plugin/session-log-universal/backfill` (the write
  half of the same handler, same loopback guard) starts one serial run over the
  sessions the collector has not fully confirmed, with dual caps
  (`DEFAULT_BACKFILL_BYTES` = 200 MiB, `DEFAULT_BACKFILL_SESSIONS` = `null`,
  accepted ranges 1 MiB..2 GiB and — for an explicit count — 1..500). A
  conversation that alone exceeds the byte budget is skipped and counted, so one
  oversized log cannot turn a run into nothing.
  The caps are validated at the API boundary only: the page always sends
  `{"maxSessions": null, "maxBytes": null}` and shows the published allowance
  (`backfill.defaults`) as small print. The run is published in the report as
  `backfill` (running, progress, skipped, sent records, last error, limits,
  defaults).
- Filterable totals in the status page: the five cards are always rendered (so
  the row never reflows), and "Uploaded" / "Not uploaded" toggle a filter
  ("Not uploaded" includes partial rows) that stacks with the search box, so the
  visibility line counts exactly what is on screen.
- `scripts/sync-dev.mjs`, so a checkout can be copied into the runtime copy the
  loader imports (`--dry-run`, `--check`, `--target`, idempotent).
- Test suite under `tests/` (`npm test`): the report and its route are covered by
  self-contained in-memory assertions, and the watermark by tests that skip
  themselves outside a harness installation.
- Documentation for maintainers: how the two halves become live (client hot
  reload vs. one restart for the Host), the test commands, and why the report
  travels over a route instead of a volatile Config field.
- English README, architecture notes and packaging metadata for publishing.

### Changed

- The status page no longer assumes an event count is available: the shipped
  JSONL backend lists sessions without `eventCount`, so a stored session reports
  `localEvents: null` and the state falls back to comparing the acknowledgement
  time with the log's last write (60 s grace). Rows carry `sizeBytes` and
  `isEmpty`, and `localEvents` is `null` rather than a fabricated zero.
- Report ordering spends the 500-row cap on sessions that hold events (content
  first, newest write first inside each group) and publishes `moreSessions` for
  what the cap left out. `totals.events` is documented as a lower bound;
  `totals.ackedEvents` is the headline number.
- Rebuilding is activity-gated: the report is reused for 5 s and rebuilt on that
  cadence only while the route was read within the last 30 s, so an unopened
  plugin does no report work at all. Because a request is answered with the
  previous value while the next one builds, backfill progress is reported in
  5–10 second steps.
- The report no longer truncates at 500 rows: `REPORT_MAX_ROWS` is 5000, so the
  whole corpus (856 sessions, a 258–317 KB JSON payload) arrives in one answer
  and the page pages it. That 500-row cut was the root cause of "Not uploaded"
  showing zero — the 500 rows were ordered by recent activity, so sessions that
  had just been backfilled filled the quota and the old unuploaded ones never
  entered the payload. `truncated` / `moreSessions` keep their meaning and now
  only fire above 5000 sessions.
- The status list is paged: 20 / 50 / 100 / 200 rows per page (50 by default),
  with a range line and page buttons. Filter, search and page size reset to page
  1, a refresh keeps the page and clamps it, and an empty result renders no pager.
- The three state cards now count only the rows the list can show, so the numbers
  add up: 856 − 179 empty = 677 = 507 uploaded + 0 partial + 170 not uploaded.
  Counting empty sessions as "not uploaded" promised rows the filter could never
  deliver.
- A selected filter card paints with the business accent (border, tinted fill,
  1 px inset ring, brighter label) instead of looking like an unselected one.
- Backfill limits are **size-only by default**: `DEFAULT_BACKFILL_SESSIONS` is
  now `null` (no count limit) while `DEFAULT_BACKFILL_BYTES` stays 200 MiB, so a
  run keeps taking conversations until the byte budget is spent. `maxSessions`
  is still honoured when a caller passes it explicitly in the POST body
  (integer 1..500), and the report publishes `null` in `limits` / `defaults`
  when no count limit applies.
- Shipped as a profile bundle: `package.json` declares `dsh.bundle.patch`
  (`./cordis.patch.yml`, one loader row), so the plugin can be installed by
  listing it in `dsh.profile.bundles` — which is also what makes the Plugins
  page able to show, toggle and remove it. A hand-written patch row still works
  but keeps the plugin out of that page, so the two are alternatives, not steps.
- The report route is guarded for a public install: a request that declares itself
  cross-site (`Sec-Fetch-Site` other than `same-origin` / `none`) is refused with
  403, and the backfill POST additionally requires `content-type:
  application/json` (415 otherwise). Both checks leave curl and the app's own
  page working while a foreign tab cannot trigger a write.
- Empty sessions no longer consume the title budget: a session the list hides is
  skipped before its cold title read, so the 32 titles per rebuild land on rows
  that are actually shown.
- Titles: 96 events scanned per log, 32 new titles per rebuild (96 on the first
  build), so a freshly opened page fills its list in about a minute.
- `package.json` is publishable (`private: false`, `files`, `exports`,
  `dsh.client` declaration, license and repository fields).

## [1.0.0] - 2026-09-29

### Added

- Host-side universal uploader: captures every session event of every provider
  through the session firehose, encodes it as OTLP/HTTP JSON logs, gzip-compresses
  it and POSTs it to the official collector.
- Acknowledgement-gated durable watermark at
  `<profile>/data/session-log-universal.json`, advanced only after a 2xx answer.
- Bounded upload queue with one in-flight request, retries with backoff, and
  replay of the owed tail from the canonical session log (mount sweep,
  `session/flush`, and a manual re-send).
- `/uploadlog [session-id]` command for on-demand re-sending, including
  sessions this profile never captured live.
- Settings row under Settings → General that flips the volatile `enabled`
  switch through the Host configuration form.

[1.1.0]: https://github.com/yihefeikong-rgb/dsh-session-log-universal/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/yihefeikong-rgb/dsh-session-log-universal/releases/tag/v1.0.0
