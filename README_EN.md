# dsh-session-log-universal

[中文](README.md) · [Architecture](docs/architecture.md) · [Changelog](CHANGELOG.md)

Upload **every** DeepSeek Harness session log to the official OTLP collector, whichever model provider drove the conversation.

> **Where the data goes, up front.** This plugin sends session events to DeepSeek's official collector at `https://dsh-otel-collector.deepseeksvc.com/v1/logs`: your prompts, the model's replies, tool calls and their results, timestamps and session identifiers. If that is not acceptable, do not install it — or remove it completely using [Removing it](#removing-it).

---

## What this is

A DSH (DeepSeek Harness) plugin: one Cordis row with two halves.

- **Host half** (`lib/index.js`, Node ESM) listens on the session event bus, encodes each event as OTLP/HTTP JSON, gzip-compresses it, POSTs it to the collector, and advances a durable local watermark only after a 2xx answer.
- **Client half** (`lib/client.js`, browser bundle) contributes the UI: the master switch under Settings → General, and a new "Upload status" tab under Settings → Built-in plugins.

## Why it exists

The shipped row `@deepseek-ai/dsh-session-log-deepseek` works on the **request** side: through `deepseekLlmApiExtensions` it adds a `dsh_session_log` field to requests sent to the official DeepSeek model API. Consequently:

- A conversation driven by the official model API carries its log with the request, and the collector sees it.
- A conversation driven by any other provider (a third-party OpenAI-compatible endpoint, a self-hosted or local model, a proxy) never touches the official API, so **not a single field leaves the machine** and the collector has no record of that session at all.

This plugin takes the same canonical session-event ledger and sends it **directly** to the official OTLP endpoint, bypassing the request side. Every session — main or subagent, any provider — is uploaded as long as it runs in a profile with this plugin.

The built-in switch and the official row are complementary: with both on, an official-API conversation is recorded twice (once per request, once per event). That is intentional — this plugin exists for coverage, not as a replacement.

## Install

Requires DSH Desktop (web profile, 0.2.x). Node has to resolve the package from the profile directory, so pick **one** of the two layouts below.

### Option A: install it as a profile bundle (recommended: it then appears on the Plugins page, where it can be toggled and removed)

The package is itself a profile bundle: `package.json` declares `dsh.bundle.patch = ./cordis.patch.yml`, and that patch holds the single loader row (`id` and `name` are both `dsh-session-log-universal`). Listing the package in the profile's bundle list is enough — the loader inserts that row itself, so **the profile's `cordis.patch.yml` needs no edit**.

1. Add the dependency to the profile's `package.json` (point it at your clone; use forward slashes on Windows):

```json
{
  "dependencies": {
    "dsh-session-log-universal": "link:D:/dev/dsh-session-log-universal"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-session-log-universal"
      ]
    }
  }
}
```

   (`dsh.profile.bundles` already exists — **append** this entry, do not replace the other bundles.)

2. Install inside the profile directory (that profile uses pnpm):

```bash
cd %USERPROFILE%\.dsh\profiles\desktop
pnpm install
```

> The Plugins settings page lists `dsh.profile.bundles` and nothing else, so this route also makes the plugin visible there, toggleable and removable like a market plugin — a plugin mounted only by a hand-written patch row never shows up on that page.

### Option B: drop it into the harness home (what this repository uses during development)

Copy the repository to `%USERPROFILE%\.dsh\node_modules\dsh-session-log-universal\` (it needs `lib/` and `package.json`). The profile directory lives below it, so Node resolution finds it while walking up; the profile manifest stays untouched.

After that, push local edits into that runtime copy with the bundled sync script:

```bash
npm run sync                          # copy lib/*.js and package.json, idempotent
node scripts/sync-dev.mjs --dry-run   # print the plan, write nothing
node scripts/sync-dev.mjs --check     # exit 1 on drift, suitable for a pre-commit hook
```

The script writes only `package.json`, `cordis.patch.yml` and `lib/*.js` of the runtime copy (the patch is the bundle's own layer, read from the package root) and touches nothing else; a stale `.js` file in `lib/` that no longer exists here is deleted, so the loader cannot import abandoned code. Use `--target <dir>` or `DSH_RUNTIME_DIR` to point at a different copy.

### Then (option B only, or when the package is not listed in `dsh.profile.bundles`): insert one row into the profile cordis.patch.yml

Option A already inserts that row through the bundle's own patch — do **not** write it again, or the same `id` ends up as two loader rows. For a manual install (option B), edit `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` (your own tweak layer, applied after every bundle layer):

```yaml
- insert:
    - id: dsh-session-log-universal
      name: 'dsh-session-log-universal'
      config:
        enabled: true
```

Keep `id` exactly `dsh-session-log-universal`: `dsh-settings` keys the client configuration namespace by it, so renaming breaks the Settings switch and the status page.

The whole `config` block may be omitted (the defaults are usable as-is); add fields only to change the endpoint, batching and so on, as described in [Configuration](#configuration). The patch layer hot-reloads (`patchReload: live`), so saving is usually enough — no application restart.

Signs that it works: the DSH log contains

```text
session-log-universal: uploading every session log to https://dsh-otel-collector.deepseeksvc.com/v1/logs (enabled=true, scope=dsh-session-log-universal)
```

and Settings → General shows a row titled "Upload Session Log for every conversation (plugin-provided)" beneath the official upload row.

## Settings

**Location: Settings → General → "Upload Session Log for every conversation (plugin-provided)" / 「上传全部会话日志（插件提供）」**

It sits directly below the official "Upload session log" row. The switch flips the Host field `enabled`, which is declared `volatile`, so it takes effect **immediately, without a restart**: turning it off stops new captures (records already queued keep going out), and turning it back on replays the gap that opened meanwhile from the session log instead of silently skipping it.

When the write is refused or fails in transport, the UI keeps showing the accepted value plus a failure notice; it never paints an optimistic "on".

## Upload status page

**Location: Settings → Built-in plugins → the "Upload status / 上传状态" tab**

The page is the plugin's own tab inside the built-in plugins settings section (registered into the root list slot `settings.plugins.tab`, id `upload-status`, order 20, after the read-only plugin inventory). No official package is touched.

The top of the page always holds five totals — **Sessions / Uploaded / Partial / Not uploaded / Uploaded events** (Partial shows 0 rather than disappearing, so the row never changes width) — with the toolbar (one-click upload, refresh, and a small line naming the current cap), the instant the data was generated and the collector endpoint. Below them: a search box (title, session id or directory), one pager row, and one row per session.

"Uploaded events" is `totals.ackedEvents`: the sum of the **acknowledged event counts** (a session with an unknown length contributes `ackedSeq + 1`). `totals.events` is only a **lower bound on the known counts** — historical sessions have no count, so it is often 0 — and the page does not use it as its headline number.

### What the cards count (856 = 507 + 0 + 170, plus 179 empty sessions)

The three state cards count **rows the list can show**: an empty conversation is never a backfill target (`selectBackfillTargets` drops it via `isEmptyOf`), so counting it as "not uploaded" would promise a number the filter cannot deliver.

| Card | Scope | Real corpus |
|---|---|---|
| Sessions | session records on disk (**including** empty ones) | 856 |
| Uploaded | rows with `state = uploaded` | 507 |
| Partial | rows with `state = partial` | 0 |
| Not uploaded | rows with `state = never` | 170 |
| Uploaded events | the Host's cumulative acknowledgement count (`totals.ackedEvents`) | 332,831 (a snapshot; it grows with activity) |

So **856 − 179 (empty) = 677 = 507 + 0 + 170**.

The report's `totals` use a different scope — do not mix the two:

| Host `totals` field | Value | Breakdown |
|---|---|---|
| `totals.sessions` | 856 | every session record |
| `totals.uploaded` | **541** | 507 displayable rows + **34** empty sessions that were uploaded back when they still had content |
| `totals.partial` | 0 | — |
| `totals.never` | **315** | 170 displayable rows + **145** empty sessions that were never uploaded |

So those 179 empty sessions are not "all unuploaded": **34 were uploaded, 145 never were**, and the two cards differ from the totals by exactly those 34 and 145.

Two details: clicking "Not uploaded" filters on "state is not uploaded", so `partial` rows make the list slightly longer than the card number (with `partial = 0` today the two agree); and empty conversations take neither a row nor a card — the line `179 empty conversations hidden (no events)` is where they surface, and clicking "Not uploaded" will not show the 145 of them either, because they are not in the list.

Each row shows:

- the session's own `session/title`, falling back to the first human prompt;
- the cwd, and a subagent session is labelled as such;
- facts: event count, log size and upstream progress. A **known** count renders `{count} events`; an unknown count with no acknowledgement renders `event count unknown` — **never a 0**. Log size renders as `1.2 MB log`. Progress renders as `{acked}/{total} events uploaded`, `{acked} events uploaded · total unknown`, or `acknowledged through {acked} · newer content exists`;
- the badge on the right is **green = uploaded** (a 2xx covered the whole log) or **light gray = not uploaded / partial**;
- under the badge sits the upstream evidence: the HTTP status of that acknowledgement, how long ago it happened, and any `partialSuccess` note from the collector (how many records it rejected and why) — so "offline", "401" and "the collector accepted only part of it" do not all look the same.

Above the list one line reports visibility: `677 of 856 conversations shown`; with empty conversations hidden it becomes `…; 179 empty conversations hidden (no events)`. That N is the **total after filter + search**, not the size of the current page — the page slice is stated by the pager row.

- **The totals double as filters**: clicking "Uploaded" or "Not uploaded" narrows the list to that state, and clicking the same card again clears it. "Not uploaded" includes the partial rows — they are not finished either. The filter stacks with the search box, so the "N of M shown" line above counts what is really on screen, and a `Filtered: {name}` line says which filter is active. The selected card switches to the theme's business accent (border, tinted fill and a 1 px inset ring, with a brighter label; the "Uploaded" number itself stays success green) and `aria-pressed` flips with it.
- **The list is paged**: one row under the search box. On the left `1-50 of 677`, on the right the "per page" selector (**20 / 50 / 100 / 200, 50 by default**), `Previous`, `Page 1 / 14` and `Next`. Choosing a filter, editing the search or changing the page size returns to page 1; `Refresh` keeps the current page and clamps it to the valid range; an empty result renders no pager row at all. Real corpus: 677 rows / 14 pages unfiltered, 170 rows / 4 pages after clicking "Not uploaded" (last page 151-170).
- **Toolbar**: only **One-click upload** and **Refresh**, plus one small line naming the current allowance — `up to 50 conversations / 200 MB per run`, taken from the report's `backfill.defaults`. The page does **not** expose the caps: a click always uses the Host defaults (50 conversations / 200 MiB), so sending more means clicking again. While a run is going the upload button is disabled and reads `uploading completed/sessions`; when it finishes the page says `backfilled N conversation(s) (M record(s) sent)`, adds `N failed` when some did, and keeps a separate `last upload error: …` line for the detail. Nothing to send reads `no conversations need backfilling`; an allowance too small to fit even one conversation reads `cap too small: N conversation(s) exceed the per-run byte limit`; a run already in progress reads `the previous batch is still uploading`.
- **Progress is slow on purpose**: the report is cached for 5 seconds and is stale-while-revalidate (this request answers with the previous value while the next one is built in the background), so progress moves in **roughly 5–10 second steps**. A stalled-looking counter is normal, not a hang.

**Empty conversations** (not a single event) do not take a row by default: hundreds of empty rows would bury the ones that can say something. The Host decides with `isEmpty` — `localEvents === 0`, or, when the count is unknown, a physical log size `sizeBytes <= 4096` (`EMPTY_LOG_BYTES`; measured header-only logs run up to 2231 bytes and the smallest log holding an event is 8192 bytes, so 4096 sits in the middle of the safe gap). Empty conversations still count in the totals.

**Order**: sessions with content first (`isEmpty` false before true), newest write first inside each group. The report **no longer truncates rows** (see `REPORT_MAX_ROWS` below), so the order now sets the list's natural sequence and decides where the title budget goes — an empty session costs no cold title read, leaving that budget for conversations that hold events.

The badge is derived from **locally recorded upstream evidence**, never from "we handed the record to the transport":

| Badge | Rule | Meaning |
|---|---|---|
| Not uploaded (light gray) | `ackedSeq == null` | no upstream confirmation at all |
| Uploaded (green) | count known: `ackedSeq + 1 >= localEvents` | the confirmed range covers the whole local log |
| Uploaded (green) | count unknown: `updatedAt <= ackedAt + 60000` | the log has not been written since the acknowledgement (the 60 s grace absorbs flush delay and the round trip), so no owed tail can be proven |
| Partial (light gray) | count known: `ackedSeq + 1 < localEvents` | the acknowledgement covers a prefix only |
| Partial (light gray) | count unknown: `updatedAt > ackedAt + 60000` | the log was written again after the acknowledgement |

> **Why a count can be unknown:** the shipped JSONL persistence backend returns only header / `sizeBytes` / `revision` from `list()`; it does not return `eventCount` (that contract is "when the backend can provide it cheaply"). Historical sessions therefore report `localEvents` / `localSeq` as `null`, and only a **live** session — whose log is in memory — has a real count. The page treats `null` as unknown: never as 0, and never as an invented number.

### Where the data comes from

The page is fed by routes registered by the Host — one handler serves both the **read-only report** and the **write-side backfill** (next section):

```text
GET  /plugin/session-log-universal/report
POST /plugin/session-log-universal/backfill
```

| Property | Behaviour |
|---|---|
| Methods | one handler dispatches by method: GET answers the report, POST starts a one-click backfill (below); anything else answers `405` with `allow: GET, POST` |
| Access | loopback only (`127.0.0.1`, `localhost`, `::1` and their port forms); a foreign `host` answers `403` — the payload carries session titles and directories and does not belong off this machine. A request that declares itself cross-site (`Sec-Fetch-Site` set to anything other than `same-origin` or `none`) is also `403`: a page cannot forge that header, so it stops a `no-cors` call from another tab, while clients such as curl send no such header and are unaffected |
| Caching | `cache-control: no-store`; the same report is reused for 5 seconds. Rebuilding on the 5 s cadence happens **only while the route was read within the last 30 seconds**; with no client watching, nothing is built at all (the timer idles without doing work) |
| Rows | **the whole corpus in one answer, no 500-row cut**: `REPORT_MAX_ROWS = 5000`, so the real 856-row corpus arrives complete (a 258–317 KB JSON payload) and paging is entirely a page concern. `truncated` / `moreSessions` mean what they always meant and are now almost always `false` / `0`; only a corpus above 5000 rows is cut (content first, as before) |
| Failures | a refused build answers `500` with the diagnostic, never an empty table |

Two ways to audit it:

- open `http://127.0.0.1:<webserver port>/plugin/session-log-universal/report` in a browser for the raw JSON;
- inside the desktop application the page itself is served from a custom scheme, so the client does not call `fetch` with a rooted path: it goes through the shell-provided `__DSH_TRANSPORT__.fetch` with the **document-relative** form of the same path (`plugin/session-log-universal/report`, no leading slash). One route, two ways to reach it.

### One-click backfill (batch)

The "One-click upload" button talks to the other half of the same handler:

```text
POST /plugin/session-log-universal/backfill
```

This is a **write**: it starts one run that backfills the conversations the collector has not fully confirmed. The handler dispatches by method — GET answers the report, POST starts a backfill — so `GET /backfill` also returns the report and `POST /report` also starts a run. One capability in one namespace, not a widened permission surface.

The body is optional JSON, and **the content type must be `application/json`** (a `; charset=utf-8` parameter is fine) — anything else answers `415`, which together with the cross-site guard leaves the write reachable only from this machine's own page or a command line. A non-empty body must parse:

```json
{ "maxSessions": 50, "maxBytes": 209715200 }
```

Both fields may be `null` or absent, which means "use the default". Defaults: **`DEFAULT_BACKFILL_SESSIONS = 50`** conversations, **`DEFAULT_BACKFILL_BYTES = 209715200` (200 MiB)** bytes. Accepted ranges: **1..500** conversations, **1 MiB..2 GiB** bytes.

The page's "One-click upload" always sends `{"maxSessions": null, "maxBytes": null}` — the two inputs are gone from the UI (the defaults are adequate and the inputs were noise), so a click always uses the Host default. The parameters and their validation stay in the **API**, available to scripts or to whatever needs them later.

| Outcome | Answer |
|---|---|
| Started | `200` + the report snapshot + `started: true` |
| Nothing to backfill | `200` + `started: false`, `sessions: 0` |
| A run is already going | `409` + the same snapshot |
| Out-of-range or non-integer limit, bad JSON, body > 4096 bytes | `400` + `{"error": "..."}` |
| Uploading switched off | `400` |
| Not loopback, or the request declares itself cross-site | `403` |
| POST without `content-type: application/json` | `415` + `{"error": "content-type must be application/json"}` |
| Method other than GET/POST | `405` + `allow: GET, POST` |

**What it picks**: every stored conversation where `stateOf(...) !== "uploaded"` and `!isEmptyOf(...)` — a `partial` session owes its tail, so it counts — newest write first, stopping at whichever of the two caps is reached first. Whatever is left out is counted in `skipped`.

One deliberate conservative choice: if the **first** candidate alone exceeds `maxBytes`, the run selects **zero** sessions rather than squeezing one in — a blown-up single request is not worth one conversation. The page says "cap too small" for that case.

**Execution is serial**: per conversation `uploader.discard → queued.delete → captureAny → uploader.drain → watermark.flush`. `discard` has to run before `captureAny`: dropping the queued copies first turns the re-read into a re-send instead of a second copy of the same records. The loop yields to the event loop between conversations, and a conversation that cannot be read is counted in `failed` while the rest of the run continues.

The report carries the run as a new top-level field `backfill` (key order: after `moreSessions`, before `totals`):

```json
"backfill": {
  "running": false, "startedAt": null, "finishedAt": null,
  "sessions": 0, "bytes": 0, "completed": 0, "failed": 0,
  "skipped": 0, "sentRecords": 0, "lastError": null,
  "limits": { "maxSessions": 50, "maxBytes": 209715200 },
  "defaults": { "maxSessions": 50, "maxBytes": 209715200 }
}
```

`limits` is what **this run** used; `defaults` is the allowance the Host publishes, which the toolbar line renders — so a run started with custom limits does not change the small print. Before the first run: `running: false`, every counter 0, both at the defaults.

> To drive it without the UI: `curl -X POST http://127.0.0.1:<webserver port>/plugin/session-log-universal/backfill -H 'content-type: application/json' -d '{"maxSessions":2}'` (the `-H` is required, otherwise `415`), and the answer is the snapshot the run started with.

With the switch off, the page shows a banner saying uploading is switched off.

> **Why not `configForms`:** mirroring a volatile Config field to the browser was the first design, and it cannot work — `describe` re-reads a volatile field only when the plugin's **raw** config changes, and the watermark is written by the Host itself, so that read never happens and the value is never pushed. The final split is therefore: the switch still travels through `configForms` (a user action changes the raw config and does trigger the re-read), the report travels over this route. It also keeps a table of several hundred rows out of the settings document every other surface pays for. Please keep that split when maintaining this plugin.

## Watermark and delivery semantics

Watermark file: **`%USERPROFILE%\.dsh\profiles\desktop\data\session-log-universal.json`**

```json
{
  "version": 1,
  "rows": {
    "<session-id>": {
      "seq": 42,
      "at": 1762200000000,
      "code": 200,
      "note": null,
      "failCode": null,
      "failAt": null,
      "failNote": null
    }
  }
}
```

- `seq`: the highest event sequence of that session that the collector **acknowledged with a 2xx**, per session, monotonic.
- `at`: the acknowledgement time (epoch milliseconds).
- `code`: the HTTP status of that acknowledgement (for example `200`, `202`). A row written before this field existed is read as `200`, because only a 2xx advances `seq` — a missing status *is* a 2xx.
- `note`: the collector's own explanation, mainly `partialSuccess` (accepted, but rejected some records); `null` when there is nothing to say. `code` + `note` together are the upstream evidence the status page renders.
- `failCode`/`failAt`/`failNote`: the **last refused or failed attempt** (a transport failure leaves `failCode` null). A refusal **never advances `seq`**; it only records the evidence, so one row shows both how far upstream confirmed and why the latest attempt failed.
- **Backwards compatible:** missing fields are read as `null` (`code` as `200`), so rows written with only `{seq, at}` need no migration and are never mistaken for failures; the next acknowledgement fills the receipt fields in.
- Writes go through a temporary file and an atomic rename, coalesced to at most one per second; a failed write keeps the in-memory rows authoritative and retries on the next change.

The delivery guarantee in one sentence: **the watermark only ever trails reality, never leads it.**

- Only a 2xx advances it; network errors, timeouts, 5xx and 429 retry without moving it.
- The queue is bounded (`maxQueueRecords`). When it is full, **new records are refused instead of evicting old ones**, which keeps each session's queued records a contiguous prefix — so the acknowledgement is a prefix too, and the watermark can never step over a record the collector never received. A refused record stays owed: when the collector recovers, a replay re-reads it from the session log.
- Flush points: a sweep over live sessions at mount, the end-of-turn `session/flush`, session disposal, and plugin teardown.
- A crash, an offline network or a collector outage only leaves the watermark where it was; the next pass resumes from the checkpoint and neither loses the middle of a session nor claims unsent records as sent.

## Manual re-send: `/uploadlog`

```text
/uploadlog                # re-send what the current session still owes
/uploadlog <session-id>   # re-send a specific session, stored ones included
```

The command gives you three exits: catch up without waiting for the next turn after a collector outage, repair a segment the queue refused, and **backfill sessions that predate the installation** (see the honest note below). It re-reads from the watermark rather than from the in-memory "already queued" marker, which is exactly what recovers a tail that was counted as queued but never sent. To do this in bulk instead of one id at a time, use the status page's [one-click backfill](#one-click-backfill-batch) — it selects the same "unconfirmed and non-empty" sessions, with the two caps applied and the run serialised.

On success it answers like this:

```text
session-log-universal: uploaded 12 record(s) of "<session-id>"; checkpoint: seq 137; still queued: 0
```

## Auditing it

Four ways to verify what is sent and what the upstream side received:

1. **Read the watermark**: one row per session in the JSON above; `at` is the upstream acknowledgement time. Compare the recorded seq with the session's last event seq to see what is still owed.
2. **Read the status page**: Settings → Built-in plugins → Upload status, green/gray at a glance. For the raw JSON, read its data source directly:

```bash
curl -s http://127.0.0.1:<GUI port>/plugin/session-log-universal/report
```

   It returns `totals` and `rows` (`state` is `uploaded`/`partial`/`never`, `upstream` carries the `code`/`at`/`note` of the acknowledgement) — about 258–317 KB for 856 rows; to see only the unuploaded ones, click the card in the page or filter the JSON by `state`.
3. **Read the log**: normally the install-time `uploading every session log to …` line; on problems warnings such as `collector returned HTTP <status>`, `upload queue is full` or `record … exceeds maxRequestBytes`.
4. **Capture one request end to end**: point `config.url` at a local server, for example

```bash
node -e "require('http').createServer((q,s)=>{let n=0;q.on('data',c=>n+=c.length);q.on('end',()=>{console.log(q.method,q.url,q.headers['content-encoding'],n,'bytes');s.writeHead(200).end()})}).listen(8787)"
```

   then set `url` to `http://127.0.0.1:8787/v1/logs` in the patch and run `/uploadlog` once: you see the real headers, the gzip size and the 2xx path. Restore the default `url` afterwards.

## Removing it

In order; the first two steps already stop the uploads, the rest removes the traces:

1. **Turn the switch off**: Settings → General → "Upload Session Log for every conversation (plugin-provided)". Immediate, no restart.
2. **Remove the loader row** — how depends on the install:

   - **Option A (bundle)**: drop `dsh-session-log-universal` from `dsh.profile.bundles` in the profile `package.json` (or toggle/remove it on the Plugins page), then remove the dependency and run `pnpm install`. The package's own `cordis.patch.yml` stops applying with it.
   - **Option B (hand-written patch)**: remove the `- insert:` block (`id: dsh-session-log-universal`) from `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`.

   Patch and bundle layers both hot-reload; otherwise restart DSH.
3. **Delete the runtime copy**:

```bat
rmdir /s /q "%USERPROFILE%\.dsh\node_modules\dsh-session-log-universal"
```

   (On option A the dependency is already gone after step 2; this step only clears the leftover directory.)

4. **Delete the watermark** (optional — it only means forgetting what was uploaded already):

```bat
del "%USERPROFILE%\.dsh\profiles\desktop\data\session-log-universal.json"
```

5. Restart DSH and confirm the Settings → General row is gone and no `session-log-universal:` line appears in the log.

Note that **data already uploaded cannot be recalled**: the steps above remove local files and the execution path, while whatever the collector already accepted stays subject to DeepSeek's own policies.

## Configuration

Written under `config:` of the patch row and validated by the Host `Config` (`@deepseek-ai/schemastery`). Everything except `enabled` is read once at load, so a change needs a reload (patch hot-reload is enough).

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch, `volatile`; flippable live from Settings → General. |
| `url` | string | `https://dsh-otel-collector.deepseeksvc.com/v1/logs` | OTLP/HTTP logs endpoint. |
| `includeHistory` | boolean | `true` | When on, a **live** session without a watermark starts at seq 0; when off, only from now on. Never reaches stored sessions. |
| `scopeName` | string | `dsh-session-log-universal` | OTLP scope name, also the user-agent prefix. |
| `flushDelayMillis` | number | `5000` | Batching delay, 100–60000 ms. |
| `maxRequestBytes` | number | `4000000` | Per-request byte budget; a single record larger than this cannot be uploaded (warned and skipped). |
| `maxBatchRecords` | number | `512` | Records per request, 1–2048. |
| `maxQueueRecords` | number | `4096` | In-memory queue bound, 64–100000; when full, new records are refused and wait for a replay. |
| `retries` | number | `3` | Retries for 5xx/429 and network errors, 0–10, exponential backoff. |
| `requestTimeoutMillis` | number | `20000` | Per-request timeout, 1000–120000 ms. |

## Repository layout

```text
dsh-session-log-universal/
├─ lib/
│  ├─ index.js          # Host half: capture, encoding, queue, upload, watermark, /uploadlog
│  ├─ report.js         # Host half: upload report and its read-only route
│  └─ client.js         # Client half: browser bundle wrapped by the module loader (no build step)
├─ scripts/
│  └─ sync-dev.mjs      # repository → runtime copy (idempotent; --dry-run / --check / --target)
├─ tests/
│  ├─ index.js          # entry for `node --test tests/`, imports both suites
│  ├─ report.test.mjs   # report and route: self-contained, runs anywhere
│  └─ watermark.test.mjs# watermark: needs the harness runtime, skips without it
├─ docs/
│  └─ architecture.md   # both halves, their flows and contracts
├─ cordis.patch.yml     # bundle patch: the single loader row (dsh.bundle.patch points here)
├─ package.json         # package metadata, dsh.bundle / dsh.client declaration, sync / test / check scripts
├─ CHANGELOG.md
├─ LICENSE              # MIT
├─ README.md
└─ README_EN.md
```

## Development

No build step: `lib/index.js` and `lib/report.js` are plain ESM modules and `lib/client.js` is a browser bundle wrapped in `window.__ModuleLoader__.load({ id, factory })` — all hand-written, no bundler, no build script.

The two halves do not become live the same way:

| Half | How a change takes effect |
|---|---|
| Client (`lib/client.js`) | client-hmr watches the runtime copy's bundle, so **saving is enough**; the page remounts and React state (search text, scroll position, refresh time) resets — that is expected |
| Host (`lib/index.js`, `lib/report.js`) | **no hot reload**: the already imported module is not re-imported, so a change needs one desktop application restart. Until then you see the mismatch — the new bundle requests `/plugin/session-log-universal/report`, the old Host never registered it, and the page reports a read failure |

Daily loop:

```bash
npm run sync      # repository → runtime copy (lib/*.js and package.json), idempotent
npm test          # node --test "tests/*.test.mjs"
npm run check     # syntax check of the three lib files
```

The suite runs the same three ways: `npm test`, `node --test tests/` (the entry is `tests/index.js`), or a single file such as `node tests/report.test.mjs`.

- `node scripts/sync-dev.mjs --dry-run` prints the plan; `--check` exits 1 on drift (suitable for a pre-commit hook); `--target <dir>` or `DSH_RUNTIME_DIR` points at another copy.
- `tests/report.test.mjs` is fully self-contained (in-memory stubs, no fixture files, no network, no harness home): state derivation, upstream evidence, title extraction, report assembly and truncation, and the route's 200/405/403/500 answers with their headers.
- `tests/watermark.test.mjs` covers the watermark (monotonic advance, receipt, failure evidence, atomic write and reload, legacy rows, self-healing from a corrupt file). It needs `@deepseek-ai/schemastery`, a peer that only exists inside a harness installation, so it skips itself in a plain checkout; point it at an installed copy to run it for real:

```bash
DSH_SLU_HOST_MODULE="%USERPROFILE%\.dsh\node_modules\dsh-session-log-universal\lib\index.js" node tests/watermark.test.mjs
```

## Wire protocol

| Item | Value |
|---|---|
| Method and path | `POST https://dsh-otel-collector.deepseeksvc.com/v1/logs` |
| Headers | `content-type: application/json`, `content-encoding: gzip`, `user-agent: <scopeName>/<harness version>` |
| Body | OTLP/HTTP JSON (`resourceLogs` → `scopeLogs` → `logRecords`), byte-identical to `@opentelemetry/otlp-transformer`'s `JsonLogsSerializer` for the same records |
| One record | one session event: `eventName = session-log`, `body = "session-log"`, attributes `session.id`, `event.type`, `event.seq`, `session.cwd`, `session.parent_id`, `session.seed_length`, plus `content` = the full event JSON |
| Resource attributes | `service.name = deepseek-harness`, `service.version` = harness version, `user.id` = the anonymous uuid in `<DSH_HOME>/.anonymous-user-id` (shared with the official helper) |
| Success | HTTP 2xx |
| Status page data | `GET /plugin/session-log-universal/report` (local Host route, loopback only, `no-store`) |
| One-click backfill | `POST /plugin/session-log-universal/backfill` (the write half of the same handler, same loopback guard, 4096-byte body cap) |

## Known limits

- **Sessions from before the installation are not backfilled automatically.** Only events after the plugin loads are captured; `includeHistory` means "start at seq 0" for sessions that are **still live in memory** at mount time, nothing more. Old sessions on disk do not need a `/uploadlog <session-id>` each — "One-click upload" selects every unconfirmed non-empty stored session and backfills them; leave it alone if you do not want that.
- **Data leaves the machine.** See the note at the top: content goes to DeepSeek's official collector. The anonymous `user.id` is not an account identity, but session content is session content.
- The queue bound (4096 records by default) can be reached after a long offline stretch and a sudden recovery; the status page then shows gray dots and the watermark trails until the collector is reachable again or `/uploadlog` runs. Records are not silently dropped.
- A single event larger than `maxRequestBytes` (4 MB by default) cannot be split; it is skipped with a warning.
- Non-2xx 4xx answers (except 429) are treated as a permanent refusal of that batch: the records stay unacknowledged for a later replay, so a wrong `url` retries and warns forever.
- Historical sessions have no known event count (the JSONL backend's `list()` returns no `eventCount`); only live sessions have a real count. For an unknown count the page falls back to comparing the acknowledgement time with the log's last write, with a 60 second grace window (see the badge table above).
- **The report no longer truncates at 500 rows** (`REPORT_MAX_ROWS = 5000`, one full answer), which removes the illusion a 500-row "most recent first" cut created. Clicking "Not uploaded" and seeing 0 was exactly that bug: the 500 rows were ordered by recent activity, sessions that had just been backfilled filled the quota, and the old unuploaded ones never entered the payload. Now all 856 rows are there and the "Not uploaded" filter finds 170.
- The price is bandwidth: a full report is roughly 258–317 KB (856 rows including the 5 s cache snapshot) over loopback only — no traffic leaves the machine. Only beyond 5000 sessions does `truncated` / `moreSessions` matter again.
- The status page needs the Host web server: a composition without `webServer` (headless, ACP) keeps uploading, but the route is absent and the page reports a read failure.
- Meaningful for the web profile only (`dsh.client.platform: web`); headless and ACP profiles have no settings UI and keep only the Host-side upload.
- **Backfill scale** (all of these are one snapshot from the moment these docs were written; they move with new sessions and backfills): on the development machine about **613** of 856 sessions were eligible at first (non-empty, unconfirmed); the default caps (50 sessions / 200 MiB) cover 50 sessions in one run, about 54 MiB, and `skipped` stood at 611 then. Backfilled sessions leave the candidate set — after a few runs "not uploaded" is down to **170**, the number the card shows — so each click takes the 50 most owed at that moment. The **session cap is the bottleneck**: the 200 MiB byte cap needs roughly 380 median-sized (562 KiB) sessions to fill, and since the page does not expose the caps, sending more means clicking again.
- Backfill progress moves in 5–10 second steps (5 s report cache plus stale-while-revalidate), and one run only covers the sessions it selected; the rest wait for the next click.

## License

[MIT](LICENSE) © 2026 yihefeikong-rgb
