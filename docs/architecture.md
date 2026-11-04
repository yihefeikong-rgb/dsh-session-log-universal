# Architecture

The plugin ships as a profile **bundle**: `package.json` declares `dsh.bundle.patch = ./cordis.patch.yml`, and that five-line patch is what inserts the single loader row, so listing the package in `dsh.profile.bundles` is enough to mount it (and to make it appear on the Plugins page).

That row has two halves that never call each other directly:

- **Host half** (`lib/index.js`, `lib/report.js`) — Node modules the harness imports. They capture session events, encode OTLP, upload, own the durable watermark, and publish a read-only upload report.
- **Client half** (`lib/client.js`) — one browser bundle registered through `window.__ModuleLoader__.load({ id, factory })`. It renders the Settings switch and the upload status tab, and reads the report over HTTP.

The wire between them is deliberately thin: the switch travels through the `dsh-settings` volatile form, the report travels over a named route. Nothing in the browser process talks to the collector.

---

## Host half

### Flow

```text
  session firehose (Cordis events on the Host context)
  ───────────────────────────────────────────────────────
   ctx.on("session/created")  ─┐
   ctx.on("session/event")    ─┤
   ctx.on("session/flush")    ─┼─▶ capture  ──▶ redact waterfall
   ctx.on("session/disposed") ─┤   (replay any         ("session-telemetry/record")
   mount sweep over live      ─┘    gap first)                │
   sessions at apply()                                        │
                                                              ▼
                                                   Uploader.push()
                                          bounded queue, maxQueueRecords records
                                          newest record is refused, never evicted
                                                              │
                                        flushDelayMillis timer / drain on flush
                                                              ▼
                                              batch: maxBatchRecords records,
                                              maxRequestBytes bytes per request
                                                              │
                                                              ▼
                                    gzip(OTLP/HTTP JSON logs) ──POST──▶ <url>
                                                                   (default:
                                                             /v1/logs on the
                                                              official collector)
                                                              │
                                        ┌─────────────────────┴─────────────────────┐
                                   2xx answer                              network error /
                                        │                                   non-2xx answer
                                        ▼                                          │
                          Watermark.advance(sessionId, seq, receipt)      Watermark.noteFailure
                                        │                                  + retry with backoff
                                        ▼                                  (retries, 250 ms ×2)
                     atomic write of <profile>/data/                        then leave the records
                     session-log-universal.json                              queued for the next pass
                     (coalesced to at most one write per second)

  read-only side channel (never on the capture path)
  ──────────────────────────────────────────────────
   SessionReport (timer, only while a client is watching)
        ├─ sessionPersistence.list()      → stored session headers and counts
        ├─ ctx.sessions.list()            → live sessions answer from memory
        ├─ Watermark rows                 → acked seq plus its receipt
        └─ <DSH_HOME>/sessions/*/*.jsonl  → activity timestamps
                    │
                    ▼
     GET /plugin/session-log-universal/report   (loopback only, no-store)
```

### 1. Capture

Every event of every session reaches the plugin through the session firehose, so the model provider plays no part: a conversation driven by the official DeepSeek API, a third-party API, a local model or a subagent is captured the same way.

- `session/created` and the mount sweep queue everything a session already holds that it still owes.
- `session/event` queues one live event, and first replays any gap that opened since the last queued seq (the enablement switch was off, or a capture step threw), reading the missing events back out of the canonical session log.
- `session/flush` — the end-of-turn durability checkpoint — replays the owed tail and drains the queue.
- `session/disposed` and plugin teardown flush the queue and the watermark.

`includeHistory` decides what a session owes *before* it has a checkpoint: with it on, everything from seq 0 of a session that is still live; with it off, only events from now on. It never reaches into past sessions the profile is not holding — see "Known limits" in the README.

### 2. Record shape

One OTLP log record per session event:

| field | value |
|---|---|
| `resource.attributes` | `service.name` = `deepseek-harness`, `service.version` = the harness version, `user.id` = the anonymous id in `<DSH_HOME>/.anonymous-user-id` |
| `scope` | `config.scopeName` (default `dsh-session-log-universal`) and the same version |
| `timeUnixNano`, `observedTimeUnixNano` | the event timestamp |
| `severityNumber` / `severityText` | `9/INFO`, `13/WARN`, `17/ERROR`; a failed tool result and an errored turn end map to ERROR |
| `body` | the constant string `session-log` |
| `eventName` | `session-log` |
| `attributes` | `session.id`, `event.type`, `event.seq`, plus `session.cwd`, `session.parent_id`, `session.seed_length` when present, plus `content` = the whole event as a JSON string |

The encoder is a hand-written equivalent of `@opentelemetry/otlp-transformer`'s `JsonLogsSerializer` for the same records, so the payload is byte-identical without taking a dependency on it.

Before a record is queued it passes the `session-telemetry/record` waterfall, so any deployment redaction rule the profile already registered applies to this uploader too. A rule that removes the record's source identity withholds it.

### 3. Queue

- Bounded by `maxQueueRecords`; above that the **newest** record is refused instead of evicting the oldest. Keeping a contiguous prefix per session is what makes the acknowledgement a prefix as well, so the checkpoint can never step over a record the collector never received.
- One in-flight request at a time; a failed batch stops the pass and the tail stays queued.
- A refused record is *owed*, not lost: the next replay re-reads exactly what is missing from the session log.

### 4. Transport, retries and receipts

`POST <config.url>` with `content-type: application/json`, `content-encoding: gzip` and a `<scopeName>/<version>` user agent, inside an `AbortSignal.timeout(requestTimeoutMillis)` deadline.

- `2xx` → every record in the batch is acknowledged, and the batch's receipt (status code plus a one-line note) travels with the checkpoint.
- `5xx` and `429` → retried up to `retries` times with exponential backoff (250 ms, 500 ms, 1 s, … capped at 5 s).
- Any other `4xx` → treated as a permanent refusal for that batch: the records stay unacknowledged and are replayed later rather than being declared uploaded.

The note is extracted from the response body, read once and bounded to 2 KB: an OTLP `partialSuccess` becomes "`partialSuccess: N record(s) rejected: <message>`", anything else becomes a truncated excerpt. That is what lets the status page distinguish "the collector took it" from "the collector took it and complained".

### 5. Watermark

`<profile>/data/session-log-universal.json`:

```json
{
  "version": 1,
  "rows": {
    "<session-id>": { "seq": 42, "at": 1762200000000, "code": 200, "note": null,
                      "failCode": 503, "failAt": 1762199000000, "failNote": "..." }
  }
}
```

- `advance()` runs only from an acknowledgement callback, is monotonic per session, and stores the receipt (`code`, `note`) beside the seq.
- `noteFailure()` stores the last refused attempt (`failCode`, `failAt`, `failNote`) **without** touching `seq`, so a row can show both how far the collector confirmed and why the latest attempt failed.
- Writes go through a temporary file and an atomic rename, coalesced to at most one per second; a failing write leaves the in-memory rows authoritative and retries on the next change.
- The file is the whole reliability story: a checkpoint that trails reality by a few records costs a re-run of those records, a checkpoint that leads it would lose them, so the plugin only ever does the former.

### 6. Recovery paths

| trigger | what it re-sends |
|---|---|
| mount sweep at `apply()` | every live session's owed tail (covers a hot reload or a restart) |
| `session/flush` | the tail of the session that just ended a turn |
| `/uploadlog [session-id]` | the tail of one session, live or stored, ignoring the in-memory "already queued" marker but honouring the durable checkpoint |

A manual re-send drops the queued copies of that session first, so the re-read cannot upload the same tail twice. A batch already in flight is not recalled: for a manual command, a rare duplicate beats a lost record.

### 7. The report and backfill routes

`lib/report.js` owns everything the status page needs, and it is built off the capture path:

- A `SessionReport` answers from a cached value and rebuilds at most every `REPORT_REFRESH_MILLIS` (5 s), and only while somebody is reading: a tick does nothing unless the route was requested within `REPORT_ACTIVE_MILLIS` (30 s). A plugin nobody opened performs no report work at all — the timer wakes, sees no reader and returns.
- Sources: `sessionPersistence.list()` for stored session headers, sizes and revisions (cached for `INVENTORY_CACHE_MILLIS`, 10 s), `ctx.sessions.list()` for live sessions (which answer from memory and therefore never trail their own log), the watermark rows for the acknowledgement, a directory sweep of `<DSH_HOME>/sessions/*/session*.jsonl` for activity timestamps and physical sizes (cached for `STORAGE_SCAN_MILLIS`, 30 s), and a bounded log read for titles.
- Titles: each read scans the first `TITLE_SCAN_EVENTS` (96) events of a log; a normal rebuild resolves `TITLE_BATCH` (32) new titles, the very first rebuild `TITLE_FIRST_BATCH` (96). A session the page hides (an empty log) is skipped before the read, so the budget lands only on rows that will be shown. The cache is per process and retries an empty title after `TITLE_RETRY_MILLIS` (60 s), so a page that has just opened fills its list over roughly a minute instead of showing short ids for minutes.
- **Event counts are only known for live sessions.** The shipped JSONL backend's `list()` returns header / `sizeBytes` / `revision` and no `eventCount` (that field is "provided when the backend can do it cheaply"), so a stored session reports `localEvents: null` and `localSeq: null`. `totals.events` is therefore a **lower bound** over the known counts, while `totals.ackedEvents` counts the acknowledged prefix of every session (unknown-length ones contribute `ackedSeq + 1`).
- **Publish order**: sessions that hold events before empty ones, newest write first inside each group (`orderSessions`). The whole corpus is published — `REPORT_MAX_ROWS` is 5000, so the 856-row development corpus (258–317 KB of JSON) arrives in one answer and the page does the paging. `truncated` / `moreSessions` still describe a cut table and still prefer sessions with content, but only a corpus above 5000 rows reaches them. Cutting at 500 was what made "Not uploaded" show zero: 500 rows ordered by recent activity were mostly already-backfilled sessions.
- **Emptiness** is decided once, in `isEmptyOf`: `localEvents === 0`, or — when the count is unknown — `sizeBytes <= EMPTY_LOG_BYTES` (4096). That bound is measured, not derived: across 856 logs on the development machine, header-only logs run up to 2231 bytes (older generations) while the smallest log holding an event is 8192 bytes.
- `state` is derived, not stored:

| condition | state |
|---|---|
| `ackedSeq == null` | `never` |
| count known, `ackedSeq + 1 >= localEvents` | `uploaded` |
| count known, `ackedSeq + 1 < localEvents` | `partial` |
| count unknown, `updatedAt > ackedAt + PARTIAL_GRACE_MILLIS` (60 000 ms) | `partial` |
| count unknown, otherwise | `uploaded` |

  The grace window covers the uploader's flush delay plus the round trip, so an ordinary turn is not mistaken for an owed tail while a genuinely newer write still is.

  `totals` counts **every** session, empty ones included, because it describes the corpus. Cross-tabulating the 856 rows of the development machine by `isEmpty` × `state` gives:

| | uploaded | never | total |
|---|---|---|---|
| content | 507 | 170 | 677 |
| empty | 34 | 145 | 179 |
| total | 541 | 315 | 856 |

  The page's three state cards deliberately count only the rows the list can show (507 / 0 / 170), while `totals.uploaded` (541) and `totals.never` (315) include the empty sessions — 34 of those did get uploaded while they still had content, which is why the two scopes differ by 34 and 145 rather than by the whole 179. Keep that split when changing the client: a card that counted empty sessions would promise rows the filter cannot deliver, and a totals field that excluded them would stop describing the corpus.

The routes:

| property | value |
|---|---|
| paths | `REPORT_ROUTE` = `/plugin/session-log-universal/report` and `BACKFILL_ROUTE` = `/plugin/session-log-universal/backfill`, both an exact match, both registered with the *same* handler through `ctx.inject(["webServer"], ...)` on a child context |
| methods | one handler dispatches by method: GET publishes the report, POST starts a backfill. Anything else answers `405` with `allow: GET, POST`. Because both paths share the handler, `GET /backfill` also publishes the report and `POST /report` also starts a run — one capability in one namespace, not a widened surface |
| access | loopback `host` header only (403 otherwise) — the payload carries session titles and working directories, and POST is a write. `sec-fetch-site` is checked too: anything other than `same-origin` / `none` is refused with 403, because a browser cannot forge that header and it is the only signal a `no-cors` request from a foreign page gives. A request without the header (curl, a test) falls through to the authority check |
| caching | `cache-control: no-store`, `content-length`; the value is reused for `REPORT_REFRESH_MILLIS` (5 s) and rebuilt only while the route was read within `REPORT_ACTIVE_MILLIS` (30 s); a request during that window gets the previous value while the next one builds (stale-while-revalidate, so progress moves in 5–10 s steps). A refused build answers 500 with the diagnostic instead of an empty table |
| absent web server | uploading keeps working, the routes simply do not exist; a conflicting registration is a warning, not a failure |

Report value. **The row fields below are placeholders**: a session id, its title and its working directory are private, so the sample keeps the shape and the counts, not the content.

```json
{
  "version": 1,
  "generatedAt": 1762200000000,
  "endpoint": "https://dsh-otel-collector.deepseeksvc.com/v1/logs",
  "enabled": true,
  "truncated": false,
  "moreSessions": 0,
  "backfill": {
    "running": false, "startedAt": 1762195000000, "finishedAt": 1762195001800,
    "sessions": 365, "bytes": 205520896, "completed": 365, "failed": 0,
    "skipped": 248, "sentRecords": 20318, "lastError": null,
    "limits": { "maxSessions": null, "maxBytes": 209715200 },
    "defaults": { "maxSessions": null, "maxBytes": 209715200 }
  },
  "totals": { "sessions": 856, "uploaded": 541, "partial": 0, "never": 315, "events": 9287, "ackedEvents": 333216 },
  "rows": [
    {
      "sessionId": "<session-id>", "title": "<title>",
      "cwd": "<cwd>", "parentSession": null,
      "updatedAt": 1762200000000,
      "localSeq": null, "localEvents": null, "sizeBytes": 184320, "isEmpty": false,
      "ackedSeq": 211, "ackedAt": 1762199950000,
      "upstream": { "code": 200, "at": 1762199950000, "note": null },
      "state": "uploaded"
    },
    {
      "sessionId": "<child-session-id>", "title": null,
      "cwd": "<cwd>", "parentSession": "<session-id>",
      "updatedAt": 1762199000000,
      "localSeq": 40, "localEvents": 41, "sizeBytes": 23347, "isEmpty": false,
      "ackedSeq": 12, "ackedAt": 1762198800000,
      "upstream": { "code": 207, "at": 1762198800000, "note": "partialSuccess: 1 record(s) rejected" },
      "state": "partial"
    }
  ]
}
```

The counts are **one real snapshot** from the development machine, taken at a single moment while that machine kept uploading; the row fields above are placeholders, so only the shape and the counts are borrowed. Concretely: 856 sessions, `truncated: false` and `moreSessions: 0` because nothing is cut any more. `totals.uploaded` (541) and `totals.never` (315) are whole-corpus counts that include the empty sessions, while the page's cards show the 507 / 0 / 170 rows it can list. `totals.events` (9,287) is a lower bound over the sessions whose length is known — a stored session has no `eventCount`, so most of the corpus contributes nothing — which is why the page headlines `ackedEvents` instead.

Two fields move with activity, so other numbers in these docs come from other moments and are not a contradiction: `ackedEvents` is a running counter (333,216 here; the README quotes 332,831 from an earlier snapshot), and the `backfill` block — which sits between `moreSessions` and `totals` and describes the last run (or the empty run a fresh install reports) — shows a run that stopped on the byte budget rather than on a count: 365 sessions, ~196 MiB of logs, and 248 eligible conversations left for the next click.

### 8. One-click backfill

`SessionBackfill` turns the inventory the report already collects into an upload plan, then drives the ordinary capture path for it.

`POST /plugin/session-log-universal/backfill`, optional JSON body:

```json
{ "maxSessions": null, "maxBytes": 209715200 }
```

| field | rule |
|---|---|
| `maxSessions` | `null` = **no count limit** (the default, `DEFAULT_BACKFILL_SESSIONS = null`); an explicit count must be an integer 1..500 |
| `maxBytes` | integer 1 MiB..2 GiB; `null` or absent → `DEFAULT_BACKFILL_BYTES` (200 MiB) |
| body size | above `BACKFILL_BODY_MAX_BYTES` (4096) the read stops and the request is refused |
| content type | must be `application/json` (a `charset` parameter is accepted); anything else, including no header, answers `415`. Together with the `sec-fetch-site` guard this is what keeps the write to this machine's own page or a command line |

| outcome | answer |
|---|---|
| started | `200` + the report snapshot + `started: true` |
| nothing owed | `200` + `started: false`, `sessions: 0` |
| a run is already going | `409` + the snapshot (with `running: true`) |
| bad JSON, non-integer or out-of-range limit, oversized body | `400` + `{ error }` |
| uploading switched off | `400` |
| non-loopback request, or one that declares itself cross-site | `403` |
| POST whose content type is not `application/json` | `415` |
| any method other than GET/POST | `405` + `allow: GET, POST` |

Selection (`selectBackfillTargets`): eligible means a stored session where `!isEmptyOf(...)` **and** `stateOf(...) !== "uploaded"` — a `partial` session still owes its tail. Eligible sessions are ordered by `updatedAt` descending and the run is truncated **by bytes only**: it stops when the next conversation would push the total past `maxBytes`, and `skipped` is eligible minus chosen. `maxSessions` is a gate only when a caller asks for one (`null` = unlimited, the default).

One oversized log cannot stall the run: a conversation whose own size exceeds `maxBytes` is skipped (and counted in `skipped`) while the loop keeps scanning, so the smaller ones behind it still go. The earlier behaviour — a single oversized first candidate turning the run into zero sessions — is gone; `sessions: 0` with `skipped > 0` now means every candidate exceeded the budget on its own.

Execution (`SessionBackfill.run`) is serial and yields between sessions:

```text
for each target:                      (newest activity first)
   uploader.discard(sessionId)        ← drop the queued copies first, or the
   queued.delete(sessionId)             replay would upload a second copy
   await captureAny(sessionId)        ← re-read the owed tail from the checkpoint
   await uploader.drain()             ← one batch at a time, still ack-gated
   watermark.flush()                  ← the checkpoint survives a crash
   setImmediate(...)                  ← keep the event loop responsive
```

A session that throws is counted in `failed` and the run continues; `lastError` keeps the detail. `sentRecords` is the difference of the uploader's counter across the run, so it reports what actually left rather than what was planned.

The state is published in the report as `backfill`: `{ running, startedAt, finishedAt, sessions, bytes, completed, failed, skipped, sentRecords, lastError, limits, defaults }`, where `limits` is what the run used and `defaults` is the allowance this Host publishes (`defaultBackfillLimits()`, always re-read at snapshot time). In both, `maxSessions: null` means **no count limit** and only `maxBytes` bounds a run. Its freshness is bounded by the report cache — that is why the client polls once per `REPORT_REFRESH_MILLIS` and progress moves in 5–10 second steps.

`limits` and `defaults` are published separately on purpose: the UI shows the default allowance as small print next to the button and never builds its own, so a run started by a script with custom limits does not change what the page promises. The limits stay validated at the API boundary even though the page stopped exposing them — an out-of-range body (bytes outside 1 MiB..2 GiB, or an explicit count outside 1..500) is still `400`, not silently clamped.

### 9. Configuration surface

`Config` (`@deepseek-ai/schemastery`) validates the patch row's `config` block. `enabled` is declared `.volatile()`: the client can flip it on a live fiber without restarting the row, which is what the Settings switch does. Everything else is read once at load and needs a reload to change.

---

## Client half

### Flow

```text
  window.__ModuleLoader__.load({ id: "dsh-session-log-universal", factory })
        │
        ▼
  factory(require) ──▶ exports.apply(ctx)          (assets, no bundler)
        │
        ├─ ctx.locale.register("settings.sessionLogUniversal",       { en, zh })
        ├─ ctx.locale.register("settings.sessionLogUniversalStatus", { en, zh })
        │
        ├─ ctx.configForms.get("dsh-session-log-universal")
        │      └─ snapshot store mirrored from the Host Config
        │         (only the switch needs it)
        │
        ├─ slot "settings.general.item"  (order 91)
        │      └─ the upload switch, under the official session-log row
        │
        ├─ slot "settings.plugins.tab"   (id upload-status, order 20)
        │      └─ ReportFeed: GET plugin/session-log-universal/report
        │
        └─ slot "shell.overlay"
               └─ save notice toast that survives the settings panel closing
```

### Slots

- **`settings.general.item`** — one row: a title, a description and a `Switch`. Rendering the accepted value (not an optimistic one) means a refused write stays visible; the write itself is an ordered `form.set("enabled", value)` call, and the outcome lands in a snapshot store that drives the toast.
- **`settings.plugins.tab`** — the built-in plugins settings page (`@deepseek-ai/dsh-client-ui-settings-plugins`) is a shell that owns the tab row; every tab is contributed by another plugin. This plugin registers `id: "upload-status"`, `order: 20`, so the page shows 上传状态 / Upload status next to the read-only inventory tab without touching any official package. The tab mounts on first selection and stays mounted.
- **`shell.overlay`** — a toast for the save outcome, rendered outside the settings panel so closing the panel does not swallow it.

### Report feed

The status tab does not poll the Host config: a `ReportFeed` fetches the report route on mount and on Refresh, and publishes one immutable snapshot with `{ report, status }`. The tab renders from that snapshot, so a failed read is a visible state rather than an empty table.

The request goes out as `plugin/session-log-universal/report` — the **document-relative** form, without the leading slash — through `globalThis.__DSH_TRANSPORT__.fetch` when the shell injected one, falling back to `fetch`. The desktop window is served from a custom scheme, so a rooted path is not the same origin as the Host route; the relative form is the one the shipped transport accepts. A plain browser tab reaches the identical route as `http://127.0.0.1:<port>/plugin/session-log-universal/report`.

The tab renders, in order: five fixed totals with two of them acting as filter buttons, the toolbar (one-click upload, refresh, and the default-allowance line built from `backfill.defaults`), the last-run result line, the generation instant, the collector endpoint, one line of visibility counters, the search box (title / session id / directory), the pager row, the current page of rows, and — when the report was cut — a line saying how many conversations with content are not shown (`moreSessions`, always 0 below 5000 sessions). The five cards are always rendered: a card that vanished when its count reached zero would reflow the row and hide the fact that the state exists.

What each card counts differs on purpose:

| card | value | scope |
|---|---|---|
| sessions | `totals.sessions` | every session record on disk, empty ones included |
| uploaded / partial / never | the client's own tally over `visible` | only rows the list can show — an empty session is never a backfill target, so counting it would promise rows the filter cannot deliver |
| uploaded events | `totals.ackedEvents` | the Host's cumulative acknowledgement count |

That is why `totals.never` (315) and the "Not uploaded" card (170) disagree by exactly the 145 empty sessions that were never uploaded — and `totals.uploaded` (541) exceeds the "Uploaded" card (507) by the other 34 empty ones — while 856 − 179 = 507 + 0 + 170 holds either way.

The list is paged in the tab, not by the Host: `pageSize` starts at 50 and offers 20 / 50 / 100 / 200; `total` is the row count after filter and search; the range line reads `{from}-{to} of {total}`, the page buttons read `Page {page} / {pages}` and disable at the ends; choosing a filter, editing the search or changing the page size resets to page 1, while a refresh keeps the page and clamps it to the new page count; an empty result renders no pager at all. The selected card carries `data-active` and paints with the business accent (border, tinted fill, 1 px inset ring, brighter label), with `aria-pressed` mirroring the filter.

| row part | source |
|---|---|
| title | `title`, falling back to the session id, then "untitled conversation" |
| directory | `cwd`, or "unknown directory" |
| facts | event count (`localEvents` — "event count unknown" when `null`, never a 0), log size (`sizeBytes`), upstream progress (`acked`/`total`, or `acked` only when the total is unknown, or "acknowledged through N · newer content exists" for an open-ended partial), and a subagent marker when `parentSession` is set |
| badge | `state` → green 已上传 / light gray 未上传, or 部分 {acked}/{total} 条 when the count is known and plain 部分上传 when it is not |
| evidence | `upstream.code` as `HTTP nnn`, `ackedAt` as a relative time, `upstream.note` as the tooltip |

Interaction state lives entirely in the tab: `filter` (`all` / `uploaded` / `pending`), the search text, `page` and `pageSize`. "Not uploaded" filters on `state !== "uploaded"`, so partial rows stay with it — which is why that list can be slightly longer than the card number, and why the visibility line counts filtered rows rather than `totals`.

The one-click button posts a fixed body — `{ maxSessions: null, maxBytes: null }` — and then re-reads the report, so the run always takes the Host defaults; a `200` starts the run, `409` means another run is still going, `400` surfaces the Host's own message (bad limit, oversized body, uploading off). While `backfill.running` is true the button is disabled and reads `uploading completed/sessions`; the tab polls the report every `REPORT_REFRESH_MILLIS`, so that counter advances in 5–10 second steps rather than continuously. When the run ends, the result line distinguishes "backfilled N conversations" from "nothing to backfill" (`sessions === 0 && skipped === 0`) and from "the cap is too small for any single conversation" (`sessions === 0 && skipped > 0`).

Visibility is decided by the Host's `isEmpty`, not by the client: a conversation with no events takes no row (a line above the list counts the hidden ones, and the row still counts in the totals), and `totals.events` is deliberately not shown as a headline because it is only a lower bound. The list is therefore conversations that can actually say something about uploads.

Colour is a CSS `data-state` attribute on the badge (`uploaded` uses the theme success token, `partial` and `never` share the muted surface), so the state that the Host derived is the only thing the client has to agree on.

### Which half owns which state

| state | transport | why |
|---|---|---|
| `enabled` (the switch) | `configForms` volatile form | a user action changes the raw config, which is exactly what makes `describe` re-read the volatile field and push it back |
| the upload report | `GET /plugin/session-log-universal/report` | the watermark is written by the Host itself, so the raw config never changes and no volatile push would ever happen |

Keeping these apart is the one architectural rule a maintainer must not break: moving the report into a Config field produces a page that is always empty, and moving the switch onto the route means the client can no longer write it.

### Locale and assets

Two dictionaries live in the bundle (`settings.sessionLogUniversal` for the switch, `settings.sessionLogUniversalStatus` for the tab, each `en` + `zh`) and are registered during `apply`. Component styles are injected as `<style data-plugin-css="dsh-session-log-universal/UploadRow.module.css">` (and `…/UploadStatus.module.css`) tags keyed by a stable id, so hot reload replaces rather than duplicates them.

---

## Tests

`npm test` → `node --test "tests/*.test.mjs"`, and equivalently `node --test tests/` (through `tests/index.js`) or one file on its own. No fixtures, no network, no harness home.

| file | covers | runs |
|---|---|---|
| `tests/report.test.mjs` | `stateOf` (both length-known and length-unknown branches), `isEmptyOf`, `upstreamOf`, `titleFromEvents`, `buildReport` (order, totals, `moreSessions`, truncation), `SessionReport` title budgets and source-failure degradation, `parseBackfillLimits`, `selectBackfillTargets` (caps, order, defaults), `SessionBackfill` (runs once, refuses a second run, survives a failing session, nothing owed, uploading off), `reportHandler` for GET and POST (200/400/403/405/409/500), `describeResponse`, the published constants and `emptyReport` | everywhere |
| `tests/watermark.test.mjs` | monotonic advance, receipts, failure evidence, atomic write and reload, legacy `{seq, at}` rows, corrupt-file recovery | needs `@deepseek-ai/schemastery`, so it skips itself in a plain checkout; set `DSH_SLU_HOST_MODULE` to an installed `lib/index.js` to run it |

The route handler is exercised against a fake `request`/`response` pair, which is what pins the contract the client depends on: `200` with `content-type` and `cache-control: no-store`, `405` plus `allow: GET`, `403` for a foreign authority, and `500` with the diagnostic when the build throws.

## Development loop

- Client changes are live: client-hmr watches the runtime copy's bundle, so saving `lib/client.js` reloads the page (React state resets).
- Host changes are not: `lib/index.js` and `lib/report.js` are imported once, so they need a desktop application restart. Before that restart the new client asks for a route the old Host never registered and the tab shows a read failure.
- `npm run sync` copies `lib/*.js` and `package.json` into the runtime copy the loader imports (idempotent; `--dry-run`, `--check`, `--target <dir>` or `DSH_RUNTIME_DIR`).
