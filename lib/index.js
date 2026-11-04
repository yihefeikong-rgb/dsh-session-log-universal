/**
 * Universal session-log uploader for DeepSeek Harness.
 *
 * The shipped `@deepseek-ai/dsh-session-log-deepseek` row only rides on requests
 * to the official DeepSeek LLM API: it contributes a `dsh_session_log` request
 * field through `deepseekLlmApiExtensions`, so a conversation driven by any other
 * provider never reaches the collector. This row uploads the same canonical
 * session-event ledger straight to the official OTLP endpoint instead, for every
 * session and every provider.
 *
 * Transport is a hand-rolled OTLP/HTTP JSON POST that is byte-identical to
 * `@opentelemetry/otlp-transformer`'s `JsonLogsSerializer` for the same records
 * (verified against the shipped 0.220.0 build). Owning the transport is what makes
 * the durable watermark honest: a seq is recorded as uploaded only after the
 * collector answered 2xx, so a crash or an offline collector replays the tail
 * instead of silently dropping it.
 *
 * The same ledger answers the Settings page: `lib/report.js` serves one read-only
 * route with a row per session — local length, acknowledged seq and the HTTP
 * status the collector answered — so a conversation can be shown as uploaded,
 * partial or never.
 *
 * @module dsh-session-log-universal
 */
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import z from "@deepseek-ai/schemastery";
import {
  BACKFILL_ROUTE,
  REPORT_MAX_ROWS,
  REPORT_REFRESH_MILLIS,
  REPORT_ROUTE,
  SessionBackfill,
  SessionReport,
  describeResponse,
  reportHandler,
} from "./report.js";

/** Cordis plugin name. */
export const name = "session-log-universal";
/** Services used by the Host plugin. */
export const inject = ["sessions"];

const DEFAULT_URL = "https://dsh-otel-collector.deepseeksvc.com/v1/logs";
const DEFAULT_SCOPE = "dsh-session-log-universal";
const SESSION_LOG_MAX_REQUEST_BYTES = 4e6;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SEVERITY_NUMBER = { info: 9, warn: 13, error: 17 };
const SEVERITY_TEXT = { 9: "INFO", 13: "WARN", 17: "ERROR" };

/**
 * Plugin configuration. `enabled` is volatile so the Settings switch can flip it
 * on a live fiber; everything else is ordinary config read once at load.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  url: z.string().default(DEFAULT_URL),
  includeHistory: z.boolean().default(true),
  scopeName: z.string().default(DEFAULT_SCOPE),
  flushDelayMillis: z.number().step(1).min(100).max(60000).default(5000),
  maxRequestBytes: z.number().step(1).min(1).max(SESSION_LOG_MAX_REQUEST_BYTES).default(SESSION_LOG_MAX_REQUEST_BYTES),
  maxBatchRecords: z.number().step(1).min(1).max(2048).default(512),
  maxQueueRecords: z.number().step(1).min(64).max(100000).default(4096),
  retries: z.number().step(1).min(0).max(10).default(3),
  requestTimeoutMillis: z.number().step(1).min(1000).max(120000).default(20000),
});

// #region payload encoding (byte-identical to JsonLogsSerializer)

/** OTLP AnyValue encoding for one JSON value. */
function toAnyValue(value) {
  const type = typeof value;
  if (type === "string") return { stringValue: value };
  if (type === "number") return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
  if (type === "boolean") return { boolValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toAnyValue) } };
  if (type === "object" && value !== null) {
    return { kvlistValue: { values: Object.keys(value).map((key) => ({ key, value: toAnyValue(value[key]) })) } };
  }
  return {};
}

/** OTLP attribute list; insertion order is the payload's attribute order. */
function toAttributes(attributes) {
  return Object.keys(attributes).map((key) => ({ key, value: toAnyValue(attributes[key]) }));
}

/** Epoch milliseconds to the decimal nanosecond string the collector expects. */
function toUnixNano(millis) {
  return (BigInt(Math.trunc(millis)) * 1000000n).toString();
}

/** Build one OTLP/HTTP JSON logs request body from records sharing one resource. */
function buildRequest(entries, scope, resourceAttributes) {
  return {
    resourceLogs: [{
      resource: { attributes: toAttributes(resourceAttributes), droppedAttributesCount: 0 },
      scopeLogs: [{
        scope: { name: scope.name, version: scope.version },
        logRecords: entries.map((entry) => {
          const severityNumber = SEVERITY_NUMBER[entry.severity] ?? SEVERITY_NUMBER.info;
          return {
            timeUnixNano: toUnixNano(entry.event.time),
            observedTimeUnixNano: toUnixNano(entry.event.time),
            severityNumber,
            severityText: SEVERITY_TEXT[severityNumber],
            body: toAnyValue("session-log"),
            eventName: "session-log",
            attributes: toAttributes({
              ...entry.attributes,
              sessionId: entry.sessionId,
              content: JSON.stringify(entry.event),
            }),
            droppedAttributesCount: 0,
          };
        }),
      }],
    }],
  };
}

// #endregion

// #region record capture (mirrors @deepseek-ai/dsh-session-telemetry)

/** Map an event's own outcome flag to the pre-baked alerting severity. */
function severityOf(event) {
  switch (event.type) {
    case "tool/result": return event.data.message.isError === true ? "error" : "info";
    case "turn/end": return event.data.reason.kind === "error" ? "error" : "info";
    default: return "info";
  }
}

/** Build the minimal identity attributes: envelope plus self-contained header facts. */
function identityOf(header, event, seedLength) {
  const attributes = {
    "session.id": String(header.id),
    "session.format_version": header.version,
    "event.type": event.type,
    "event.seq": event.seq,
  };
  const { cwd, parentSession, isSeeded } = header;
  if (cwd !== undefined) attributes["session.cwd"] = cwd;
  if (parentSession !== undefined) attributes["session.parent_id"] = String(parentSession);
  if (isSeeded === true) attributes["session.seed_length"] = seedLength;
  return attributes;
}

// #endregion

// #region durable watermark

/**
 * Per-session upload checkpoint, persisted as JSON beside the profile.
 *
 * A seq is written here only after the collector acknowledged the request that
 * carried it, so the file never claims more than the collector has.
 */
class Watermark {
  /** @param path - absolute JSON file path. */
  constructor(path) {
    this.path = path;
    this.rows = {};
    this.dirty = false;
    this.timer = undefined;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed !== null && typeof parsed === "object" && parsed.rows !== null && typeof parsed.rows === "object") this.rows = parsed.rows;
    } catch {
      /* absent or unreadable: start from an empty ledger */
    }
  }

  /** Highest acknowledged seq for one session, or undefined when never uploaded. */
  get(sessionId) {
    const row = this.rows[sessionId];
    return typeof row?.seq === "number" ? row.seq : undefined;
  }

  /**
   * Record an acknowledged seq, never moving a session's checkpoint backwards.
   *
   * The receipt travels with the checkpoint so the report can show what the
   * collector actually answered, not just that it answered something. A row
   * written before receipts existed keeps working: its missing status is read as
   * the 2xx that advanced it.
   *
   * @param sessionId - the session the batch belonged to.
   * @param seq - highest seq of that session inside the acknowledged batch.
   * @param receipt - HTTP status and note of the acknowledgement.
   */
  advance(sessionId, seq, receipt) {
    const row = this.rows[sessionId] ?? {};
    const previous = row.seq;
    if (typeof previous === "number" && previous >= seq) return;
    this.rows[sessionId] = {
      ...row,
      seq,
      at: Date.now(),
      code: receipt?.code ?? null,
      note: receipt?.note ?? null,
    };
    this.dirty = true;
  }

  /**
   * Record the last refused attempt for one session without advancing it.
   *
   * A refused batch leaves its records owed, so the checkpoint stays where it
   * was; only the failure evidence moves. That is what lets a row say "the
   * collector answered HTTP 500" while still showing what it had confirmed.
   *
   * @param sessionId - the session the refused batch belonged to.
   * @param receipt - HTTP status (null when the request never completed) and note.
   */
  noteFailure(sessionId, receipt) {
    const row = this.rows[sessionId] ?? {};
    this.rows[sessionId] = {
      ...row,
      failCode: receipt?.code ?? null,
      failAt: Date.now(),
      failNote: receipt?.note ?? null,
    };
    this.dirty = true;
  }

  /** Persist the ledger atomically; failures leave the in-memory rows authoritative. */
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${String(process.pid)}.tmp`;
      // Owner-only: the ledger says which conversations were uploaded, and it
    // lives beside a profile that may be shared between accounts.
    writeFileSync(temporary, `${JSON.stringify({ version: 1, rows: this.rows }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.path);
    } catch {
      this.dirty = true;
    }
  }

  /** Coalesce writes so a busy turn does not rewrite the file per event. */
  schedule() {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 1000);
    this.timer.unref?.();
  }
}

// #endregion

// #region upload queue

/**
 * Bounded record queue with one in-flight request and ack-gated checkpoints.
 *
 * Records are refused only when the queue budget is exhausted, and a refused
 * record is never silently declared uploaded: the checkpoint stops short of it,
 * so the session stays visibly owed until a replay re-reads the record from the
 * log and the collector acknowledges it. A restart replays it through the mount
 * sweep, `/uploadlog` replays it on demand, and the `session/flush` checkpoint at
 * the end of a turn replays it as soon as the queue has room again.
 */
class Uploader {
  /** @param options - endpoint, limits, logger and acknowledgement sink. */
  constructor(options) {
    this.options = options;
    this.pending = [];
    this.timer = undefined;
    this.active = undefined;
    this.stopped = false;
    this.overflowing = false;
    this.stats = { sent: 0, requests: 0, failures: 0, dropped: 0, lastError: undefined, lastSuccessAt: undefined };
  }

  /**
   * Queue one record; once the budget is exhausted the newest records are refused.
   *
   * Refusing the newest instead of evicting the oldest keeps the queue a
   * contiguous prefix per session, so acknowledgements stay a prefix too and the
   * checkpoint can never step over a record the collector never received. A
   * refused record is still owed, not lost: the replay that recovers it re-reads
   * exactly what is missing, and never a duplicate of what already landed.
   *
   * @returns true when the record is settled (queued, or deliberately withheld),
   *   false when the queue was full and the record stays owed.
   */
  push(entry) {
    if (this.stopped) return false;
    let bytes;
    try {
      bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
    } catch (error) {
      this.stats.dropped++;
      this.options.logger.warn("session-log-universal: record of session %s is not serializable and was dropped: %s", entry.sessionId, String(error));
      return true;
    }
    if (bytes > this.options.maxRequestBytes) {
      this.stats.dropped++;
      this.stats.lastError = `record seq ${String(entry.seq)} of session ${entry.sessionId} exceeds maxRequestBytes`;
      this.options.logger.warn("session-log-universal: %s; the event is too large to upload and stays unsent", this.stats.lastError);
      return true;
    }
    if (this.pending.length >= this.options.maxQueueRecords) {
      this.stats.dropped++;
      this.stats.lastError = `upload queue is full: seq ${String(entry.seq)} of session ${entry.sessionId} stays owed`;
      if (!this.overflowing) {
        this.overflowing = true;
        this.options.logger.warn("session-log-universal: upload queue is full (%d record(s)); new records stay owed until the collector catches up, and a replay re-reads them from the session log", this.options.maxQueueRecords);
      }
      return false;
    }
    this.overflowing = false;
    this.pending.push({ entry, bytes });
    this.schedule();
    return true;
  }

  /**
   * Drop every queued record of one session.
   *
   * The manual recovery path re-reads a session from its durable checkpoint, so
   * the queued copies of that tail would otherwise be uploaded twice. A batch
   * already in flight is not recalled; that is the safe direction for a manual
   * command, where a rare duplicate beats a lost record.
   */
  discard(sessionId) {
    this.pending = this.pending.filter((item) => item.entry.sessionId !== sessionId);
  }

  /** Arm the flush timer if it is not already pending. */
  schedule() {
    if (this.stopped || this.active !== undefined || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, this.options.flushDelayMillis);
    this.timer.unref?.();
  }

  /** Send queued records until the queue empties; a failing batch stops the pass. */
  drain() {
    if (this.stopped) return Promise.resolve();
    if (this.active !== undefined) return this.active;
    this.active = this.run().finally(() => {
      this.active = undefined;
      if (this.pending.length > 0 && !this.stopped) this.schedule();
    });
    return this.active;
  }

  /** Drain the queue once, stopping at the first batch the collector refused. */
  async run() {
    while (!this.stopped && this.pending.length > 0) {
      const batch = [];
      let bytes = 0;
      for (const item of this.pending) {
        if (batch.length >= this.options.maxBatchRecords || bytes + item.bytes > this.options.maxRequestBytes) break;
        batch.push(item);
        bytes += item.bytes;
      }
      const accepted = await this.send(batch.map((item) => item.entry));
      if (!accepted) return;
      this.pending.splice(0, batch.length);
    }
  }

  /** POST one batch with bounded retries; true when the batch may leave the queue. */
  async send(entries) {
    const body = JSON.stringify(buildRequest(entries, this.options.scope, this.options.resourceAttributes));
    const compressed = gzipSync(Buffer.from(body, "utf8"));
    const attempts = this.options.retries + 1;
    let lastReceipt;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (this.stopped) return false;
      if (attempt > 0) await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(5000, 250 * 2 ** (attempt - 1)));
        timer.unref?.();
      });
      let response;
      try {
        response = await fetch(this.options.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
            "user-agent": this.options.userAgent,
          },
          body: compressed,
          signal: AbortSignal.timeout(this.options.requestTimeoutMillis),
        });
      } catch (error) {
        this.stats.lastError = `request failed: ${String(error)}`;
        lastReceipt = { code: null, note: this.stats.lastError };
        continue;
      }
      // The body is read once, here, so the acknowledgement and any partial
      // success travel to the ledger as evidence instead of being drained.
      const note = await describeResponse(response);
      const receipt = { code: response.status, note };
      if (response.ok) {
        for (const entry of entries) this.options.onAck(entry.sessionId, entry.seq, receipt);
        this.stats.sent += entries.length;
        this.stats.requests++;
        this.stats.lastSuccessAt = Date.now();
        return true;
      }
      this.stats.lastError = `collector returned HTTP ${String(response.status)}`;
      if (response.status < 500 && response.status !== 429) {
        this.stats.failures++;
        this.options.onReject?.(entries, receipt);
        this.options.logger.warn("session-log-universal: %s; %d record(s) stay unacknowledged and will be replayed", this.stats.lastError, entries.length);
        return true;
      }
      lastReceipt = receipt;
    }
    this.stats.failures++;
    this.options.onReject?.(entries, lastReceipt ?? { code: null, note: this.stats.lastError });
    this.options.logger.warn("session-log-universal: %s after %d attempt(s); %d record(s) stay queued", this.stats.lastError, attempts, this.pending.length);
    return false;
  }

  /** Stop accepting records and wait briefly for the in-flight request. */
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    const active = this.active;
    if (active === undefined) return;
    await Promise.race([active, new Promise((resolve) => {
      const timer = setTimeout(resolve, this.options.requestTimeoutMillis);
      timer.unref?.();
    })]);
  }
}

// #endregion

// #region helpers

/** Harness version for `service.version`, read from the runtime's own manifest. */
function runtimeVersion(anchor) {
  const candidates = [anchor, process.argv[2] === undefined ? undefined : join(process.argv[2], "package.json")];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    try {
      const manifest = JSON.parse(readFileSync(candidate, "utf8"));
      if (typeof manifest.version === "string" && manifest.version.length > 0) return manifest.version;
    } catch {
      /* try the next candidate */
    }
  }
  return "unknown";
}

/** Read or create the shared anonymous user id, matching the official helper. */
function anonymousUserId(home) {
  const file = join(home, ".anonymous-user-id");
  const read = () => {
    try {
      const value = readFileSync(file, "utf8").trim();
      if (UUID_PATTERN.test(value)) return value;
    } catch {
      /* absent */
    }
    return undefined;
  };
  const existing = read();
  if (existing !== undefined) return existing;
  const created = randomUUID();
  try {
    // Owner-only: the id identifies this installation to the collector.
    writeFileSync(file, `${created}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch {
    /* another process won the race */
  }
  return read() ?? created;
}

// #endregion

/**
 * Mount the uploader: capture every session event, POST it to the collector and
 * persist an acknowledgement-gated checkpoint per session.
 *
 * @param ctx - Host plugin context.
 * @param config - validated configuration.
 */
export function apply(ctx, config) {
  const profileContext = ctx.get("profileContext");
  const home = profileContext?.home ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const profileDir = profileContext?.dir ?? join(home, "profiles", "desktop");
  const watermark = new Watermark(join(profileDir, "data", "session-log-universal.json"));
  const scope = { name: config.scopeName, version: runtimeVersion(profileContext?.installAnchor) };
  const resourceAttributes = {
    "service.name": "deepseek-harness",
    "service.version": scope.version,
    "user.id": anonymousUserId(home),
  };
  const logger = ctx.logger;
  const uploader = new Uploader({
    url: config.url,
    scope,
    resourceAttributes,
    maxRequestBytes: config.maxRequestBytes,
    maxBatchRecords: config.maxBatchRecords,
    maxQueueRecords: config.maxQueueRecords,
    retries: config.retries,
    requestTimeoutMillis: config.requestTimeoutMillis,
    flushDelayMillis: config.flushDelayMillis,
    userAgent: `${scope.name}/${scope.version}`,
    logger,
    onAck: (sessionId, seq, receipt) => {
      watermark.advance(sessionId, seq, receipt);
      watermark.schedule();
    },
    onReject: (entries, receipt) => {
      for (const entry of entries) watermark.noteFailure(entry.sessionId, receipt);
      watermark.schedule();
    },
  });

  /** Run one capture-side step with its exception contained, like the official coordinator. */
  const contain = (step) => {
    try {
      step();
    } catch (error) {
      logger.warn("session-log-universal: capture step failed: %s", String(error));
    }
  };

  /** Redact one record through the deployment's rules; a throwing rule withholds it. */
  const redact = (record) => ctx.waterfall("session-telemetry/record", record, () => record);

  /** Build the ledger record for one event. */
  const recordOf = (header, sessionId, event, seedLength) => {
    const { data, ...envelope } = event;
    return {
      sourceEvent: { sessionId, envelope: structuredClone(envelope) },
      channel: "ledger",
      time: event.time,
      severity: severityOf(event),
      attributes: identityOf(header, event, seedLength),
      body: structuredClone(data),
    };
  };

  /**
   * Queue one redacted record unless redaction removed its source identity.
   *
   * @returns true when the record no longer needs queueing — it was queued, or it
   *   was deliberately withheld; false when the queue was full and it stays owed.
   */
  const enqueue = (record, seq) => {
    if (record.sourceEvent === undefined) {
      logger.warn("session-log-universal: record withheld: redaction removed sourceEvent");
      return true;
    }
    return uploader.push({
      sessionId: record.sourceEvent.sessionId,
      seq,
      severity: record.severity,
      attributes: record.attributes,
      event: { ...record.sourceEvent.envelope, data: record.body },
    });
  };

  /**
   * Highest seq queued contiguously per live session.
   *
   * In-memory only: the durable truth is the watermark, which trails it by
   * whatever is still in flight. It exists so a gap in the firehose — the
   * enablement switch being off, or an event that arrived while a handler threw —
   * is detected and replayed instead of being skipped over, and so a session that
   * reaches `captureSession` twice (the mount sweep and `session/created`) is not
   * queued twice.
   */
  const queued = new Map();

  /** Remember the highest seq queued contiguously, never moving the marker back. */
  const markQueued = (sessionId, last) => {
    const previous = queued.get(sessionId);
    if (previous === undefined || last > previous) queued.set(sessionId, last);
  };

  /**
   * Queue every event of a session's canonical log in `[fromSeq, toSeqExclusive)`.
   *
   * Stops at the first event the queue refused, so the caller's marker never
   * claims more than the queue actually holds.
   *
   * @returns the highest seq queued contiguously, or `fromSeq - 1` when nothing was.
   */
  const replay = (session, fromSeq, toSeqExclusive) => {
    let last = fromSeq - 1;
    if (fromSeq >= toSeqExclusive) return last;
    const seedLength = session.inheritedEventCount;
    for (const event of session.snapshotEvents(fromSeq, toSeqExclusive)) {
      if (!enqueue(redact(recordOf(session.header, session.id, event, seedLength)), event.seq)) break;
      last = event.seq;
    }
    return last;
  };

  /**
   * First seq a live session still owes.
   *
   * After an acknowledged checkpoint that is the next seq. Without one it is seq
   * 0, or the first live seq when `includeHistory` is off — so a restored session
   * contributes only what happens from now on.
   */
  const owedFrom = (session) => {
    const checkpoint = watermark.get(session.id);
    if (checkpoint !== undefined) return checkpoint + 1;
    return config.includeHistory || session.firstLifecycleSeq === 0 ? 0 : session.firstLifecycleSeq;
  };

  /**
   * First seq a live session still needs queued: the durable checkpoint and the
   * in-memory marker, whichever is further along.
   *
   * `owedFrom` alone answers "what has the collector acknowledged"; the marker
   * answers "what is already queued". Both must be honoured, because the same
   * session is captured more than once — the mount sweep and `session/created`
   * both call `captureSession` — and only the marker remembers the earlier pass.
   */
  const pendingFrom = (session) => {
    const last = queued.get(session.id);
    const owed = owedFrom(session);
    return last === undefined ? owed : Math.max(owed, last + 1);
  };

  /** Queue everything a live session owes up to its current end. */
  const captureSession = (session) => {
    if (!config.enabled.get()) return;
    const from = pendingFrom(session);
    if (from >= session.seq) return;
    markQueued(session.id, replay(session, from, session.seq));
  };

  /**
   * Queue one live event, replaying any gap that opened since the last one.
   *
   * Re-enabling the switch, or a capture step that threw, leaves the log
   * contiguous only up to the last queued seq; the events in between are read
   * back out of the canonical log rather than being silently declared uploaded.
   *
   * The event itself is queued only when the replay did not already cover it: an
   * event that `session/created` or the mount sweep already replayed is at or
   * below the marker, and queueing it again would upload it twice. The marker
   * advances only as far as the queue actually accepted, so a full queue leaves
   * the session visibly owed instead of silently truncated.
   */
  const captureEvent = (session, event) => {
    if (!config.enabled.get()) return;
    const from = pendingFrom(session);
    const replayed = replay(session, from, event.seq);
    let last = replayed;
    if (event.seq >= from && event.seq > replayed) {
      if (enqueue(redact(recordOf(session.header, session.id, event, session.inheritedEventCount)), event.seq)) last = event.seq;
    }
    markQueued(session.id, last);
  };

  /**
   * Replay a session that is not live, through a read handle on its stored log.
   *
   * @param sessionId - the session to read.
   * @returns completion after its missing tail was queued.
   */
  const captureStored = async (sessionId) => {
    const persistence = ctx.get("sessionPersistence");
    if (persistence === undefined) return;
    const handle = await persistence.open(sessionId, "read");
    try {
      const checkpoint = watermark.get(sessionId);
      const start = checkpoint !== undefined ? checkpoint + 1 : 0;
      const { events } = await handle.read(start, undefined);
      const seedLength = handle.inheritedEventCount;
      for (const event of events) {
        if (!enqueue(redact(recordOf(handle.header, sessionId, event, seedLength)), event.seq)) break;
      }
    } finally {
      await handle.close();
    }
  };

  /** Replay one session whether it is live or only stored. */
  const captureAny = async (sessionId) => {
    const live = ctx.sessions.get(sessionId);
    if (live !== undefined) {
      captureSession(live);
      return;
    }
    await captureStored(sessionId);
  };

  // #region report

  /** Time of a live session's newest event, or undefined for an empty log. */
  const lastEventTime = (session) => {
    if (session.seq <= 0) return undefined;
    return session.eventAt(session.seq - 1)?.time;
  };

  /**
   * Inventory of what every session owes and what the collector confirmed,
   * served from one route pair.
   *
   * Every source below is read outside the capture path: the report is rebuilt
   * on a timer while a client is watching and answered from a cached value, so
   * `session/event` never pays for it. The Settings page reads the route itself;
   * the settings document only carries the switch. The backfill runner reuses the
   * same sources and the same capture path, so the page and the uploader cannot
   * disagree about what a session owes.
   */
  let backfill;
  const report = new SessionReport({
    logger,
    refreshMillis: REPORT_REFRESH_MILLIS,
    maxRows: REPORT_MAX_ROWS,
    endpoint: () => config.url,
    // Assigned just below; the report only reads it when it rebuilds.
    backfill: () => backfill?.snapshot(),
    enabled: () => config.enabled.get(),
    ledger: () => watermark.rows,
    // The seam's own metadata read: headers and event counts, never a log body.
    listStored: async () => {
      const persistence = ctx.get("sessionPersistence");
      if (persistence === undefined) return undefined;
      return await persistence.list();
    },
    // A live session answers in memory, so its row never trails its own log.
    liveSessions: () => ctx.sessions.list().map((session) => ({
      sessionId: String(session.id),
      header: session.header,
      localEvents: session.seq,
      updatedAt: lastEventTime(session),
    })),
    // Titles come from a `session/title` event, else the opening human prompt.
    readEvents: async (sessionId, limit) => {
      const live = ctx.sessions.get(sessionId);
      if (live !== undefined) {
        const events = [];
        for (let seq = 0; seq < Math.min(limit, live.seq); seq += 1) {
          const event = live.eventAt(seq);
          if (event !== undefined) events.push(event);
        }
        return events;
      }
      const persistence = ctx.get("sessionPersistence");
      if (persistence === undefined) return [];
      const handle = await persistence.open(sessionId, "read");
      try {
        const { events } = await handle.read(0, limit);
        return events;
      } finally {
        await handle.close();
      }
    },
    // The seam reports no timestamp, so activity comes from the artifact the
    // shipped backend writes; without that root a row keeps its creation time.
    storageRoot: () => join(home, "sessions"),
  });
  /**
   * One-click backfill: replay, through the ordinary capture path, every session
   * the collector has not fully confirmed.
   *
   * Reusing the ordinary capture path is what keeps this honest: a session that is
   * already queued is dropped first and then re-read from its durable checkpoint,
   * so the run can neither double-upload a tail nor skip a record the checkpoint
   * still owes.
   */
  backfill = new SessionBackfill({
    logger,
    now: () => Date.now(),
    isEnabled: () => config.enabled.get(),
    sessions: () => report.sessions(),
    ledger: () => watermark.rows,
    sentRecords: () => uploader.stats.sent,
    runSession: async (sessionId) => {
      // Order matters: dropping the queued copies before re-reading is what makes
      // the replay a re-read instead of a second copy of the same records.
      uploader.discard(sessionId);
      queued.delete(sessionId);
      await captureAny(sessionId);
      await uploader.drain();
      watermark.flush();
    },
  });
  ctx.effect(() => {
    report.start();
    return () => {
      void report.stop();
    };
  }, "session-log-universal report");
  // A headless composition has no web server: uploading keeps working and the
  // routes are simply absent. Registering inside the injection means a replaced
  // web server gets them back.
  const handler = reportHandler(report, logger, backfill);
  ctx.inject(["webServer"], (child) => {
    child.effect(() => {
      const disposers = [];
      // The same handler serves both paths: GET publishes the report, POST starts
      // a backfill, so either path can answer both.
      for (const path of [REPORT_ROUTE, BACKFILL_ROUTE]) {
        try {
          disposers.push(child.webServer.register({ kind: "exact", path, handler }));
        } catch (error) {
          // A conflicting registration belongs to the composition, not to the
          // uploader: warn and keep uploading without the page.
          logger.warn("session-log-universal: route %s is unavailable: %s", path, String(error));
        }
      }
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, "session-log-universal report routes");
  });

  // #endregion
  // Live capture follows the session firehose; the sweep covers sessions that a
  // hot reload or a restart left alive without replaying `session/created`.
  ctx.on("session/created", (session) => contain(() => captureSession(session)));
  ctx.on("session/event", (session, event) => contain(() => captureEvent(session, event)));
  // `session/flush` is the durability checkpoint at the end of a turn: retry the
  // owed tail there, so a session whose queue overflowed heals by itself as soon
  // as the collector catches up instead of waiting for a restart.
  ctx.on("session/flush", (session) => contain(() => {
    captureSession(session);
    void uploader.drain();
  }));
  ctx.on("session/disposed", () => {
    contain(() => {
      void uploader.drain();
      watermark.flush();
    });
  });
  ctx.effect(() => () => {
    void uploader.stop();
    watermark.flush();
  }, "session-log-universal shutdown");
  for (const session of ctx.sessions.list()) contain(() => captureSession(session));

  logger.info("session-log-universal: uploading every session log to %s (enabled=%s, scope=%s)", config.url, String(config.enabled.get()), scope.name);

  // `/uploadlog` re-sends a session's missing tail on demand — the manual recovery
  // path when the collector was unreachable, and the way to backfill a session
  // that this profile never saw live.
  ctx.inject(["commands"], (child) => {
    child.commands.register({
      name: "uploadlog",
      description: "Upload a session's conversation log to the official collector now",
      input: { hint: "[session-id]" },
      recordInput: false,
      handler: async (invocation) => {
        if (!config.enabled.get()) return { kind: "error", text: "session-log-universal is off; enable it in Settings → General" };
        const requested = invocation.rawInput.trim();
        const sessionId = requested.length > 0 ? requested : invocation.agent.session.id;
        try {
          // A manual re-send trusts the durable checkpoint, not the in-memory
          // marker: the point of the command is to recover a tail the queue
          // dropped or the collector refused, which the marker has already
          // counted as queued. Dropping the queued copies first keeps the
          // re-read from uploading that tail twice.
          uploader.discard(sessionId);
          queued.delete(sessionId);
          await captureAny(sessionId);
        } catch (error) {
          return { kind: "error", text: `session-log-universal: cannot read session "${sessionId}": ${String(error)}` };
        }
        const before = uploader.stats.sent;
        await uploader.drain();
        watermark.flush();
        const sent = uploader.stats.sent - before;
        const through = watermark.get(sessionId);
        const pendingCount = uploader.pending.filter((item) => item.entry.sessionId === sessionId).length;
        return {
          kind: "success",
          text: [
            `session-log-universal: uploaded ${String(sent)} record(s) of "${sessionId}"`,
            `checkpoint: seq ${through === undefined ? "none" : String(through)}`,
            `still queued: ${String(pendingCount)}`,
            uploader.stats.lastError === undefined ? undefined : `last error: ${uploader.stats.lastError}`,
          ].filter((line) => line !== undefined).join("; "),
        };
      },
    });
  });
}

export { buildRequest as internalBuildRequest, Uploader as internalUploader, Watermark as internalWatermark };
