# Architecture

The plugin is one Cordis row with two halves that never call each other directly:

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

### 7. Upload report route

`lib/report.js` owns everything the status page needs, and it is built off the capture path:

- A `SessionReport` rebuilds on a timer (5 s while a client is asking, 60 s when idle) and answers from the cached value, so `session/event` never pays for it. With no client around, nothing is built.
- Sources: `sessionPersistence.list()` for stored session headers and event counts, `ctx.sessions.list()` for live sessions (which answer from memory and therefore never trail their own log), the watermark rows for the acknowledgement, a directory sweep of `<DSH_HOME>/sessions/*/*.jsonl` for activity timestamps, and a bounded log read (96 events, 8 sessions per rebuild) for titles.
- At most 500 rows are published, newest activity first; totals count every session, so a truncated table still answers "how much of the corpus is uploaded".
- `state` is derived, not stored: `uploaded` when `ackedSeq + 1 >= localEvents`, `partial` when an acknowledgement exists but covers only a prefix, `never` when there is none.

The route:

| property | value |
|---|---|
| path | `GET /plugin/session-log-universal/report` (exact match, registered through `ctx.inject(["webServer"], ...)` on a child context) |
| methods | GET only (405 otherwise) |
| access | loopback `host` header only (403 otherwise) — the response carries session titles and working directories |
| caching | `cache-control: no-store`, `content-length`; a refused build answers 500 with the diagnostic instead of an empty table |
| absent web server | uploading keeps working, the route simply does not exist; a conflicting registration is a warning, not a failure |

Report value:

```json
{
  "version": 1,
  "generatedAt": 1762200000000,
  "endpoint": "https://dsh-otel-collector.deepseeksvc.com/v1/logs",
  "enabled": true,
  "truncated": false,
  "totals": { "sessions": 37, "uploaded": 30, "partial": 2, "never": 5, "events": 8123, "ackedEvents": 7900 },
  "rows": [{
    "sessionId": "...", "title": "...", "cwd": "D:\\work", "parentSession": null,
    "updatedAt": 1762200000000, "localSeq": 41, "localEvents": 42,
    "ackedSeq": 41, "ackedAt": 1762199990000,
    "upstream": { "code": 200, "at": 1762199990000, "note": null },
    "state": "uploaded"
  }]
}
```

### 8. Configuration surface

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

The status tab does not poll the Host config: a `ReportFeed` fetches `plugin/session-log-universal/report` (document-relative, through the page transport when one is injected) on mount and on Refresh, and publishes one immutable snapshot with `{ report, status }`. The tab renders from that snapshot, so a failed read is a visible state rather than an empty table.

The tab renders, in order: the five totals (sessions, uploaded, partial, never, uploaded events), the generation instant, the collector endpoint, a Refresh button, a search box filtering by title / session id / directory, and one row per session:

| row part | source |
|---|---|
| title | `title`, falling back to the session id, then "untitled conversation" |
| directory | `cwd`, or "unknown directory" |
| facts | `localEvents`, `ackedSeq`/`localSeq`, and a subagent marker when `parentSession` is set |
| badge | `state` → green 已上传 / light gray 未上传 or 部分 {acked}/{total} |
| evidence | `upstream.code` as `HTTP nnn`, `ackedAt` as a relative time, `upstream.note` as the tooltip |

Colour is a CSS `data-state` attribute on the badge (`uploaded` uses the theme success token, `partial` and `never` share the muted surface), so the state that the Host derived is the only thing the client has to agree on.

### Locale and assets

Two dictionaries live in the bundle (`settings.sessionLogUniversal` for the switch, `settings.sessionLogUniversalStatus` for the tab, each `en` + `zh`) and are registered during `apply`. Component styles are injected as `<style data-plugin-css="dsh-session-log-universal/UploadRow.module.css">` (and `…/UploadStatus.module.css`) tags keyed by a stable id, so hot reload replaces rather than duplicates them.
