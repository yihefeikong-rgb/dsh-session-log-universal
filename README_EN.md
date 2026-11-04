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

Requires DSH Desktop (web profile, 0.2.x). Node has to resolve the package from the profile directory, so pick one of the two layouts below.

### Option A: install it as a profile dependency (recommended, upgradeable)

1. Add the dependency to the profile's `package.json` (point it at your clone; use forward slashes on Windows):

```json
{
  "dependencies": {
    "dsh-session-log-universal": "link:D:/dev/dsh-session-log-universal"
  }
}
```

2. Install inside the profile directory (that profile uses pnpm):

```bash
cd %USERPROFILE%\.dsh\profiles\desktop
pnpm install
```

### Option B: drop it into the harness home (what this repository uses during development)

Copy the repository to `%USERPROFILE%\.dsh\node_modules\dsh-session-log-universal\` (it needs `lib/` and `package.json`). The profile directory lives below it, so Node resolution finds it while walking up; the profile manifest stays untouched.

After that, push local edits into that runtime copy with the bundled sync script:

```bash
npm run sync                          # copy lib/*.js and package.json, idempotent
node scripts/sync-dev.mjs --dry-run   # print the plan, write nothing
node scripts/sync-dev.mjs --check     # exit 1 on drift, suitable for a pre-commit hook
```

The script writes only `package.json` and `lib/*.js` of the runtime copy and touches nothing else; a stale `.js` file in `lib/` that no longer exists here is deleted, so the loader cannot import abandoned code. Use `--target <dir>` or `DSH_RUNTIME_DIR` to point at a different copy.

### Then: insert one row into the profile cordis.patch.yml

Edit `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` (your own tweak layer, applied after every bundle layer):

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

The top of the page holds five totals — **Sessions / Uploaded / Partial / Not uploaded / Uploaded events** — plus the instant the data was generated, the current collector endpoint and a **Refresh** button. Below them: a search box (title, session id or directory) and one row per session:

- the row title is the session's own `session/title`, falling back to the first human prompt;
- the second line is the cwd, and a subagent session is labelled as such;
- the facts line shows the event count (`{count} events`) and the upstream progress (`acked seq acked/total`);
- the badge on the right is **green = uploaded** (a 2xx covered the whole log) or **light gray = not uploaded / partial** (never acknowledged, or acknowledged only up to an earlier prefix);
- under the badge sits the upstream evidence: the HTTP status of that acknowledgement, how long ago it happened, and any `partialSuccess` note from the collector (how many records it rejected and why) — so "offline", "401" and "the collector accepted only part of it" do not all look the same.

The badge is derived from **locally recorded upstream evidence**, never from "we handed the record to the transport":

| Badge | Rule | Meaning |
|---|---|---|
| Uploaded (green) | `ackedSeq + 1 >= localEvents` | the confirmed range covers the whole local log |
| Partial (light gray) | an ack exists but covers a prefix | the head is in, the tail is still owed (typically a turn just ended) |
| Not uploaded (light gray) | no ack at all | nothing was confirmed yet, or the session has not had its turn |

The data does not travel through the settings document: it comes from a read-only Host route, `GET /plugin/session-log-universal/report` — GET only, loopback hosts only, `cache-control: no-store`, cached for about five seconds, at most 500 rows (the rest still count in the totals, and the page then says it lists only recent conversations). With the switch off, the page shows a banner saying uploading is switched off.

> Why a route: the earlier design mirrored a volatile Config field to the browser, but `describe` re-reads a volatile field only when the plugin's **raw** config changes, and the watermark is written by the Host itself, so that push never happens. A table of several hundred rows also does not belong in the settings document every other surface pays for.

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
      "failCode": 503,
      "failAt": 1762199000000,
      "failNote": "collector returned HTTP 503"
    }
  }
}
```

- `seq` is the highest event sequence of that session that the collector **acknowledged with a 2xx**, per session, monotonic.
- `at` is the acknowledgement time (epoch milliseconds); `code`/`note` carry the HTTP status and the collector's own explanation (`partialSuccess`, error text) — this pair is what the status page renders as upstream evidence.
- `failCode`/`failAt`/`failNote` record the last refused attempt (a transport failure leaves `failCode` null). **A refusal never advances `seq`**; it only records the evidence, so one row can show both how far upstream confirmed and why the latest attempt failed.
- Writes go through a temporary file and an atomic rename, coalesced to at most one per second; a failed write keeps the in-memory rows authoritative and retries on the next change.
- Rows written by the earlier shape (only `seq`/`at`) stay valid: a missing status is read as the 2xx that advanced it.

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

The command gives you three exits: catch up without waiting for the next turn after a collector outage, repair a segment the queue refused, and **backfill sessions that predate the installation** (see the honest note below). It re-reads from the watermark rather than from the in-memory "already queued" marker, which is exactly what recovers a tail that was counted as queued but never sent.

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

   It returns `totals` and `rows` (`state` is `uploaded`/`partial`/`never`, `upstream` carries the `code`/`at`/`note` of the acknowledgement).
3. **Read the log**: normally the install-time `uploading every session log to …` line; on problems warnings such as `collector returned HTTP <status>`, `upload queue is full` or `record … exceeds maxRequestBytes`.
4. **Capture one request end to end**: point `config.url` at a local server, for example

```bash
node -e "require('http').createServer((q,s)=>{let n=0;q.on('data',c=>n+=c.length);q.on('end',()=>{console.log(q.method,q.url,q.headers['content-encoding'],n,'bytes');s.writeHead(200).end()})}).listen(8787)"
```

   then set `url` to `http://127.0.0.1:8787/v1/logs` in the patch and run `/uploadlog` once: you see the real headers, the gzip size and the 2xx path. Restore the default `url` afterwards.

## Removing it

In order; the first two steps already stop the uploads, the rest removes the traces:

1. **Turn the switch off**: Settings → General → "Upload Session Log for every conversation (plugin-provided)". Immediate, no restart.
2. **Delete the patch row**: remove the `- insert:` block (`id: dsh-session-log-universal`) from `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`. The patch layer hot-reloads; otherwise restart DSH.
3. **Delete the runtime copy**:

```bat
rmdir /s /q "%USERPROFILE%\.dsh\node_modules\dsh-session-log-universal"
```

   (With option A, remove the dependency from the profile `package.json` and run `pnpm install` instead.)

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
├─ docs/
│  └─ architecture.md   # both halves, their flows and contracts
├─ package.json         # package metadata, dsh.client declaration, sync script
├─ CHANGELOG.md
├─ LICENSE              # MIT
├─ README.md
└─ README_EN.md
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

## Known limits

- **Sessions from before the installation are not backfilled.** Only events after the plugin loads are captured; `includeHistory` means "start at seq 0" for sessions that are **still live in memory** at mount time, nothing more. Old sessions on disk need `/uploadlog <session-id>`, or stay unuploaded.
- **Data leaves the machine.** See the note at the top: content goes to DeepSeek's official collector. The anonymous `user.id` is not an account identity, but session content is session content.
- The queue bound (4096 records by default) can be reached after a long offline stretch and a sudden recovery; the status page then shows gray dots and the watermark trails until the collector is reachable again or `/uploadlog` runs. Records are not silently dropped.
- A single event larger than `maxRequestBytes` (4 MB by default) cannot be split; it is skipped with a warning.
- Non-2xx 4xx answers (except 429) are treated as a permanent refusal of that batch: the records stay unacknowledged for a later replay, so a wrong `url` retries and warns forever.
- The status page lists at most the 500 most recent sessions (totals still count every session) and says so when it truncates.
- The status page needs the Host web server: a composition without `webServer` (headless, ACP) keeps uploading, but the route is absent and the page reports a read failure.
- Meaningful for the web profile only (`dsh.client.platform: web`); headless and ACP profiles have no settings UI and keep only the Host-side upload.

## License

[MIT](LICENSE) © 2026 yihefeikong-rgb
