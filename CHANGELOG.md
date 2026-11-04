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
  `GET /plugin/session-log-universal/report` (loopback only, `no-store`, at most
  500 rows, built off the capture path). The report derives each state from the
  watermark, so "uploaded" always means "the collector answered 2xx".
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
  (`DEFAULT_BACKFILL_SESSIONS` = 50 conversations, `DEFAULT_BACKFILL_BYTES` =
  200 MiB, accepted ranges 1..500 and 1 MiB..2 GiB). If the first candidate alone
  exceeds the byte cap the run selects zero sessions instead of overshooting.
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
- Titles: 96 events scanned per log, 32 new titles per rebuild (96 on the first
  build), so a freshly opened page fills 500 rows in about a minute.
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
