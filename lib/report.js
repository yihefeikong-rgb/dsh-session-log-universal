/**
 * Session upload report for the universal session-log uploader.
 *
 * The Settings page answers "which conversations reached the collector?" from
 * this module: one row per session with the local length of its log and the
 * acknowledgement the collector returned, so a row can be shown as uploaded
 * (a 2xx covered the whole log), partial (a 2xx covered a prefix) or never (the
 * ledger holds no acknowledgement at all).
 *
 * The report is served over one read-only HTTP route rather than through the
 * plugin's Config: a volatile Config field only reaches a browser when
 * `settings.describe` re-reads it, and that read is triggered by the plugin's
 * *raw* config changing, so a value the Host writes by itself would never be
 * pushed. A route also keeps the whole session table out of the settings document
 * every other surface pays for.
 *
 * Nothing here may run on the capture path. `session/event` receives dozens of
 * events per second; the report is built off that path, cached for five
 * seconds, and skipped entirely while nobody is asking for it.
 *
 * @module dsh-session-log-universal/report
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Report contract version; bump when a client-visible field changes meaning. */
export const REPORT_VERSION = 1;
/** Route the Settings page reads. Absolute pathname, as `ctx.webServer` requires. */
export const REPORT_ROUTE = "/plugin/session-log-universal/report";
/** Route that starts a one-click backfill of the sessions still owed. */
export const BACKFILL_ROUTE = "/plugin/session-log-universal/backfill";
/** Sessions a backfill uploads when the request names no limit. */
export const DEFAULT_BACKFILL_SESSIONS = 50;
/** Bytes of session logs a backfill admits when the request names no limit (200 MiB). */
export const DEFAULT_BACKFILL_BYTES = 209715200;
/** Smallest and largest accepted session limit, so one click cannot sweep the corpus. */
const BACKFILL_MIN_SESSIONS = 1;
const BACKFILL_MAX_SESSIONS = 500;
/** Smallest and largest accepted byte limit (1 MiB … 2 GiB). */
const BACKFILL_MIN_BYTES = 1048576;
const BACKFILL_MAX_BYTES = 2147483648;
/** A backfill request body is two integers; anything larger is refused unread. */
const BACKFILL_BODY_MAX_BYTES = 4096;
/**
 * Maximum published rows. The page filters and paginates on the client, so the
 * report gives it the whole corpus in one answer; only a corpus larger than this
 * is truncated, and every session still counts towards the totals.
 */
export const REPORT_MAX_ROWS = 5000;
/** Default cache lifetime: a request older than this starts one background rebuild. */
export const REPORT_REFRESH_MILLIS = 5000;
/** A request this recent keeps the rebuild timer awake; an unwatched plugin does no report work. */
const REPORT_ACTIVE_MILLIS = 30000;
/** Published title length limit, in characters. */
export const TITLE_MAX_CHARS = 80;
/** Log prefix scanned for a title (the title event or the first human prompt). */
const TITLE_SCAN_EVENTS = 96;
/** Titles resolved per rebuild; a cold log read must not stall the whole table. */
const TITLE_BATCH = 32;
/**
 * Wider title budget for the very first build: a page that has just opened
 * would otherwise show a wall of short ids for minutes. One batch of 32 cold
 * reads costs a few hundred milliseconds, so this is spent once.
 */
const TITLE_FIRST_BATCH = 96;
/** Retry delay for a session whose title was still empty (its prompt may come later). */
const TITLE_RETRY_MILLIS = 60000;
/** Storage metadata cache lifetime; row order tolerates this much staleness. */
const STORAGE_SCAN_MILLIS = 30000;
/**
 * Stored-inventory cache lifetime. A stored session's length only changes while
 * something is writing it, and that session is live at the time, so the
 * expensive backend listing is not repeated on every rebuild.
 */
const INVENTORY_CACHE_MILLIS = 10000;
/** Above this many stored sessions the filesystem sweep is skipped entirely. */
const STORAGE_MAX_SESSIONS = 2000;
/** Bounded response-body excerpt kept as upstream evidence. */
const RESPONSE_EXCERPT_BYTES = 2048;

/**
 * Byte ceiling for "this stored log holds no events".
 *
 * The shipped JSONL backend materializes a session on its first write, so a
 * session that was created and never used is a single header record and nothing
 * else. Measured across a few hundred logs on one machine, header-only logs stay
 * well under 2 KiB — current-format ones are a few hundred bytes, while an older
 * generation of a forked subagent session stores a larger header — and the
 * smallest log that holds an event is at least several KiB. 4096 sits in that gap
 * with room on both sides. This is a measured bound, not a derived one: a backend
 * that writes a bigger header for an empty session needs it raised.
 */
export const EMPTY_LOG_BYTES = 4096;

/**
 * Tolerance between a log's modification time and the acknowledgement that read
 * it, used when the event count is unknown. It covers the uploader's 5 s flush
 * delay plus the round trip, so an ordinary turn is not mistaken for an owed
 * tail while a genuinely newer write still is.
 */
const PARTIAL_GRACE_MILLIS = 60000;

/**
 * The value served before the first build finishes. Every field obeys the same
 * contract as a real report, so a client never has to special-case absence.
 * @returns an empty report value.
 */
export function emptyReport() {
  return {
    version: REPORT_VERSION,
    generatedAt: 0,
    endpoint: "",
    enabled: true,
    truncated: false,
    moreSessions: 0,
    backfill: emptyBackfill(),
    totals: { sessions: 0, uploaded: 0, partial: 0, never: 0, events: 0, ackedEvents: 0 },
    rows: [],
  };
}

/** Read a finite number, or null when the value does not carry one. */
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Derive one row's colour from its acknowledgement and its local length.
 * @param ackedSeq - highest seq the collector acknowledged, or null.
 * @param localEvents - number of events in the local log, or null when the
 *   persistence backend does not report one.
 * @param ackedAt - when that acknowledgement landed, or null.
 * @param updatedAt - when the local log was last written.
 * @returns `uploaded` when the acknowledgement covers the whole log,
 *   `partial` when it covers a prefix or the log was written afterwards,
 *   `never` when nothing was acknowledged.
 */
export function stateOf(ackedSeq, localEvents, ackedAt, updatedAt) {
  if (ackedSeq === null || ackedSeq === undefined) return "never";
  if (typeof localEvents !== "number") {
    // Unknown length. A checkpoint only advances on a 2xx, so the prefix it
    // covers is upstream; a log written after that acknowledgement can still owe
    // a tail, and the grace window absorbs flush delay plus the round trip.
    if (typeof ackedAt === "number" && typeof updatedAt === "number" && updatedAt > ackedAt + PARTIAL_GRACE_MILLIS) return "partial";
    return "uploaded";
  }
  return ackedSeq + 1 >= localEvents ? "uploaded" : "partial";
}

/**
 * Whether a session's log holds no events at all.
 *
 * An empty session never owed the collector anything, so the page can hide it
 * without pretending the row is missing.
 * @param localEvents - exact event count, or null when the backend omits it.
 * @param sizeBytes - physical log size, or null when unknown.
 * @returns whether the log is empty.
 */
export function isEmptyOf(localEvents, sizeBytes) {
  if (typeof localEvents === "number") return localEvents === 0;
  return typeof sizeBytes === "number" && sizeBytes <= EMPTY_LOG_BYTES;
}

/**
 * Project one ledger row onto the upstream evidence a report row publishes.
 *
 * A ledger row carries the acknowledged checkpoint (`seq`, `at`, `code`,
 * `note`) and, when the last attempt was refused, that refusal (`failCode`,
 * `failAt`, `failNote`). A checkpoint without a recorded status predates
 * receipts and is still proof of a 2xx, because only a 2xx advances it.
 * @param record - the persisted ledger row for one session, if any.
 * @returns the `{ code, at, note }` evidence, nulls when the row has none.
 */
export function upstreamOf(record) {
  if (record === null || typeof record !== "object") return { code: null, at: null, note: null };
  if (typeof record.seq === "number") {
    return {
      code: numberOrNull(record.code) ?? 200,
      at: numberOrNull(record.at),
      note: typeof record.note === "string" && record.note.length > 0 ? record.note : null,
    };
  }
  if (record.failCode !== undefined || record.failNote !== undefined || record.failAt !== undefined) {
    return {
      code: numberOrNull(record.failCode),
      at: numberOrNull(record.failAt),
      note: typeof record.failNote === "string" && record.failNote.length > 0 ? record.failNote : null,
    };
  }
  return { code: null, at: null, note: null };
}

/** Truncate to a character budget, appending an ellipsis only when shortened. */
function truncate(text, limit) {
  const characters = [...text];
  if (characters.length <= limit) return text;
  return characters.slice(0, limit).join("").trimEnd() + "\u2026";
}

/**
 * Fold a session's title out of a window of its log.
 *
 * The accepted title is the latest `session/title` event; without one the first
 * human `user/message` opens the conversation, which is what the shipped title
 * service falls back to.
 * @param events - a prefix of the session log, in log order.
 * @param maxChars - published length limit.
 * @returns the title, or null when the window holds neither source.
 */
export function titleFromEvents(events, maxChars = TITLE_MAX_CHARS) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "session/title") continue;
    const title = event.data?.title;
    if (typeof title === "string" && title.trim().length > 0) return truncate(title.trim(), maxChars);
  }
  for (const event of events) {
    if (event?.type !== "user/message") continue;
    if (event.data?.source?.kind !== "user") continue;
    const blocks = Array.isArray(event.data.content) ? event.data.content : [];
    const text = blocks
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text.length > 0) return truncate(text, maxChars);
  }
  return null;
}

/**
 * Assemble one report value from a read-only observation.
 *
 * Rows are ordered by activity, newest first, and capped. Sessions whose log
 * holds no events are published only after every session that has some, so the
 * cap is spent on conversations; `moreSessions` reports how many sessions with
 * content the cap left out. Totals count every session, so a truncated table
 * still answers how much of the corpus is uploaded.
 * A session's length may be unknown — the shipped JSONL backend lists sessions
 * without an event count — in which case `localEvents` and `localSeq` are null
 * and `totals.events` counts only what is known.
 * @param observation - endpoint facts, per-session facts and the upload ledger.
 * @returns the report value served to the client.
 */
export function buildReport(observation) {
  const { now, endpoint, enabled, sessions, ledger, maxRows = REPORT_MAX_ROWS } = observation;
  const totals = { sessions: 0, uploaded: 0, partial: 0, never: 0, events: 0, ackedEvents: 0 };
  const rows = [];
  let contentSessions = 0;
  for (const session of orderSessions(sessions)) {
    const record = ledger?.[session.sessionId];
    const ackedSeq = typeof record?.seq === "number" ? record.seq : null;
    const localEvents = typeof session.localEvents === "number" ? Math.max(0, session.localEvents) : null;
    const sizeBytes = numberOrNull(session.sizeBytes);
    const ackedAt = ackedSeq === null ? null : numberOrNull(record?.at);
    const state = stateOf(ackedSeq, localEvents, ackedAt, session.updatedAt);
    totals.sessions += 1;
    totals[state] += 1;
    // A lower bound: a session whose length the backend does not report
    // contributes nothing here rather than a fabricated zero.
    totals.events += localEvents ?? 0;
    totals.ackedEvents += ackedSeq === null ? 0 : localEvents === null ? ackedSeq + 1 : Math.min(ackedSeq + 1, localEvents);
    const isEmpty = isEmptyOf(localEvents, sizeBytes);
    if (!isEmpty) contentSessions += 1;
    if (rows.length >= maxRows) continue;
    rows.push({
      sessionId: session.sessionId,
      title: session.title ?? null,
      cwd: session.cwd ?? null,
      parentSession: session.parentSession ?? null,
      updatedAt: session.updatedAt,
      localSeq: localEvents === null ? null : localEvents - 1,
      localEvents,
      sizeBytes,
      isEmpty,
      ackedSeq,
      ackedAt,
      upstream: upstreamOf(record),
      state,
    });
  }
  return {
    version: REPORT_VERSION,
    generatedAt: now,
    endpoint,
    enabled,
    truncated: totals.sessions > rows.length,
    moreSessions: Math.max(0, contentSessions - Math.min(contentSessions, rows.length)),
    backfill: observation.backfill ?? emptyBackfill(),
    totals,
    rows,
  };
}

/**
 * Publish order: newest activity first, and every session that holds events
 * before the empty ones.
 *
 * A session that never received an event has nothing to say about uploading, so
 * it must not spend rows a conversation could use. The partition is stable, so
 * each group keeps the newest-first order.
 * @param sessions - per-session facts, in any order.
 * @returns the same facts in publish order.
 */
export function orderSessions(sessions) {
  const ordered = [...sessions].sort((left, right) => right.updatedAt - left.updatedAt);
  const content = [];
  const empties = [];
  for (const session of ordered) {
    const localEvents = typeof session.localEvents === "number" ? session.localEvents : null;
    const isEmpty = isEmptyOf(localEvents, numberOrNull(session.sizeBytes));
    (isEmpty ? empties : content).push(session);
  }
  return content.concat(empties);
}

/**
 * The published defaults for one backfill run.
 *
 * Kept apart from the limits a run actually used: a page shows these as the
 * placeholders behind an empty field, so they must not drift to whatever the
 * last run happened to request.
 * @returns a fresh copy of the default limits.
 */
export function defaultBackfillLimits() {
  return { maxSessions: DEFAULT_BACKFILL_SESSIONS, maxBytes: DEFAULT_BACKFILL_BYTES };
}

/**
 * The backfill state a report carries before anything has run.
 * @returns a fresh, structurally complete backfill snapshot.
 */
export function emptyBackfill() {
  return {
    running: false,
    startedAt: null,
    finishedAt: null,
    sessions: 0,
    bytes: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    sentRecords: 0,
    lastError: null,
    limits: defaultBackfillLimits(),
    defaults: defaultBackfillLimits(),
  };
}

/**
 * Validate one backfill request body into the limits that will apply.
 *
 * An absent field means "use the default"; a present one must be an integer
 * inside the published range, because the request is what bounds how much a
 * single click can push to the collector.
 * @param text - the raw request body; empty means "all defaults".
 * @returns `{ limits }` on success, or `{ error }` with the message to refuse with.
 */
export function parseBackfillLimits(text) {
  const defaults = { maxSessions: DEFAULT_BACKFILL_SESSIONS, maxBytes: DEFAULT_BACKFILL_BYTES };
  if (text === undefined || text === null || text.trim().length === 0) return { limits: defaults };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "request body is not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "request body must be a JSON object" };
  }
  const maxSessions = parsed.maxSessions === undefined || parsed.maxSessions === null ? defaults.maxSessions : parsed.maxSessions;
  const maxBytes = parsed.maxBytes === undefined || parsed.maxBytes === null ? defaults.maxBytes : parsed.maxBytes;
  if (!Number.isInteger(maxSessions) || maxSessions < BACKFILL_MIN_SESSIONS || maxSessions > BACKFILL_MAX_SESSIONS) {
    return { error: "maxSessions must be an integer from " + String(BACKFILL_MIN_SESSIONS) + " to " + String(BACKFILL_MAX_SESSIONS) };
  }
  if (!Number.isInteger(maxBytes) || maxBytes < BACKFILL_MIN_BYTES || maxBytes > BACKFILL_MAX_BYTES) {
    return { error: "maxBytes must be an integer from " + String(BACKFILL_MIN_BYTES) + " to " + String(BACKFILL_MAX_BYTES) };
  }
  return { limits: { maxSessions, maxBytes } };
}

/**
 * Choose what one backfill uploads.
 *
 * A target is any stored session the collector has not fully confirmed — an
 * acknowledged prefix still owes its tail, which is what "not uploaded" means
 * here — and that holds at least one event. Both limits apply at once: the run
 * stops at whichever one is reached first, and everything left out is counted as
 * skipped rather than silently dropped.
 * @param sessions - per-session facts as the report collects them.
 * @param ledger - the durable upload ledger, keyed by session id.
 * @param limits - `{ maxSessions, maxBytes }`; missing fields fall back to the defaults.
 * @returns the chosen targets in activity order, their byte total and the skip count.
 */
export function selectBackfillTargets(sessions, ledger, limits) {
  const maxSessions = Number.isInteger(limits?.maxSessions) ? limits.maxSessions : DEFAULT_BACKFILL_SESSIONS;
  const maxBytes = Number.isInteger(limits?.maxBytes) ? limits.maxBytes : DEFAULT_BACKFILL_BYTES;
  const eligible = [];
  for (const session of sessions) {
    const record = ledger?.[session.sessionId];
    const localEvents = typeof session.localEvents === "number" ? session.localEvents : null;
    const sizeBytes = numberOrNull(session.sizeBytes);
    if (isEmptyOf(localEvents, sizeBytes)) continue;
    const ackedSeq = typeof record?.seq === "number" ? record.seq : null;
    const ackedAt = ackedSeq === null ? null : numberOrNull(record?.at);
    const state = stateOf(ackedSeq, localEvents, ackedAt, session.updatedAt);
    if (state === "uploaded") continue;
    eligible.push({ sessionId: session.sessionId, sizeBytes: sizeBytes ?? 0, updatedAt: session.updatedAt, state });
  }
  eligible.sort((left, right) => right.updatedAt - left.updatedAt);
  const targets = [];
  let bytes = 0;
  for (const candidate of eligible) {
    if (targets.length >= maxSessions) break;
    if (bytes + candidate.sizeBytes > maxBytes) break;
    targets.push(candidate);
    bytes += candidate.sizeBytes;
  }
  return { targets, bytes, skipped: eligible.length - targets.length };
}

/** Stored event-log file names the shipped JSONL backend writes, generation tagged. */
const LOG_FILE_PATTERN = /^session(?:\.v([0-9]+))?\.jsonl(?:\.zstd)?$/u;

/** The generation and encoding the shipped backend writes today. */
const CURRENT_LOG_FILE = "session.v4.jsonl.zstd";

/** Generation of one stored log file name, or undefined when it is not one. */
function logGeneration(name) {
  const match = LOG_FILE_PATTERN.exec(name);
  if (match === null) return undefined;
  return match[1] === undefined ? 0 : Number(match[1]);
}

/**
 * Read the modification time of every stored session log, keyed by session id.
 *
 * The persistence seam exposes headers and event counts but no timestamp, so
 * activity comes from the artifact the shipped backend writes. This is a plain
 * directory sweep: one call per project directory plus one stat per session,
 * cached by the caller, and abandoned as soon as the corpus is implausibly
 * large. A different backend simply leaves every row on its creation time.
 *
 * The sweep is the most expensive thing this module does — a few hundred sessions
 * cost under ~0.1 s on a typical desktop — so it is cached for half a minute and
 * only reached while somebody is watching.
 * @param root - the persistence root directory.
 * @returns session id to `{ updatedAt, sizeBytes }`, or undefined when the root
 *   is unreadable (an absent or foreign layout).
 */
export async function scanStorage(root) {
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const files = new Map();
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = join(root, project.name);
    let sessions;
    try {
      sessions = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (files.size + sessions.length > STORAGE_MAX_SESSIONS) return files;
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const sessionDir = join(projectDir, session.name);
      // Fast path: the current generation is what almost every session holds, so
      // one stat answers without listing the directory. A historical generation
      // (or a plaintext root) costs the listing instead.
      const current = join(sessionDir, CURRENT_LOG_FILE);
      let info;
      try {
        info = await stat(current);
      } catch {
        info = undefined;
      }
      if (info === undefined) {
        let entries;
        try {
          entries = await readdir(sessionDir);
        } catch {
          continue;
        }
        let newest;
        for (const entry of entries) {
          const generation = logGeneration(entry);
          if (generation === undefined) continue;
          if (newest === undefined || generation > newest.generation) newest = { generation, name: entry };
        }
        if (newest === undefined) continue;
        try {
          info = await stat(join(sessionDir, newest.name));
        } catch {
          continue;
        }
      }
      files.set(session.name, { updatedAt: Math.round(info.mtimeMs), sizeBytes: info.size });
    }
  }
  return files;
}

/**
 * Cached builder of the session report.
 *
 * Every source is injected so the builder stays testable without a Host, and so
 * the mount decides what counts as "activity": live sessions answer in memory,
 * stored ones from the metadata sweep, and a session whose log vanished falls
 * back to its creation time.
 */
export class SessionReport {
  /** @param options - sources and cadence. */
  constructor(options) {
    this.options = options;
    this.value = undefined;
    this.builtAt = 0;
    this.building = undefined;
    this.timer = undefined;
    this.stopped = false;
    this.lastRequestAt = 0;
    this.titles = new Map();
    this.storage = undefined;
    this.stored = undefined;
    this.failure = undefined;
    /** The next build is the first one this instance publishes. */
    this.firstBuild = true;
  }

  /** Current epoch milliseconds, from the injected clock. */
  now() {
    return this.options.now?.() ?? Date.now();
  }

  /** Read the fields taken at build time: endpoint URL, switch state, ledger, backfill state. */
  facts() {
    let endpoint = "";
    let enabled = true;
    let ledger;
    let backfill;
    try {
      endpoint = this.options.endpoint();
      enabled = this.options.enabled();
      ledger = this.options.ledger();
      backfill = this.options.backfill?.();
    } catch (error) {
      this.options.logger.warn("session-log-universal: report sources failed: %s", String(error));
    }
    return { endpoint, enabled, ledger, backfill };
  }

  /**
   * Answer one client request: return the held value, rebuilding in the
   * background when it is stale, and await the very first build.
   *
   * A build that never produced a value rejects here, so the route can answer
   * with a diagnostic instead of an empty table that looks like "nothing was
   * ever uploaded". Once a value exists, a later failing rebuild keeps serving
   * the last good one.
   * @returns the report value to serve.
   */
  async report() {
    this.lastRequestAt = this.now();
    if (this.value === undefined) {
      await this.refresh();
      if (this.value === undefined) throw this.failure ?? new Error("report build produced no value");
    } else if (this.now() - this.builtAt >= this.options.refreshMillis) {
      void this.refresh();
    }
    return this.value;
  }

  /**
   * Rebuild the report once; concurrent callers share the running build.
   * @returns settlement after the value is replaced.
   */
  refresh() {
    if (this.stopped) return Promise.resolve();
    if (this.building !== undefined) return this.building;
    this.building = this.build()
      .then(() => {
        this.failure = undefined;
      })
      .catch((error) => {
        this.failure = error;
        this.options.logger.warn("session-log-universal: report build failed: %s", String(error));
      })
      .finally(() => {
        this.building = undefined;
      });
    return this.building;
  }

  /**
   * Rebuild for as long as somebody is reading.
   *
   * A plugin nobody opened rebuilds nothing — the report is only worth keeping
   * warm while a Settings page is polling the route — so the timer costs a host
   * that never opens the page exactly nothing.
   */
  tick() {
    if (this.stopped) return;
    const now = this.now();
    if (now - this.lastRequestAt > REPORT_ACTIVE_MILLIS) return;
    if (now - this.builtAt < this.options.refreshMillis) return;
    void this.refresh();
  }

  /** Arm the rebuild timer; it never keeps the process alive. */
  start() {
    if (this.timer !== undefined || this.stopped) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        this.options.logger.warn("session-log-universal: report timer failed: %s", String(error));
      }
    }, this.options.refreshMillis);
    this.timer.unref?.();
  }

  /** Stop rebuilding and wait for a running build to settle. */
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.building;
  }

  /** Build one value from every source. */
  async build() {
    const now = this.now();
    const sessions = await this.collect(now);
    const facts = this.facts();
    this.value = buildReport({
      now,
      endpoint: facts.endpoint,
      enabled: facts.enabled,
      sessions,
      ledger: facts.ledger,
      backfill: facts.backfill,
      maxRows: this.options.maxRows,
    });
    this.builtAt = now;
    this.firstBuild = false;
  }

  /**
   * Identity, length and activity of every known session, without spending the
   * title budget. The backfill selects its targets from this.
   * @returns one entry per known session, unsorted.
   */
  async sessions() {
    return await this.gather(this.now());
  }

  /**
   * Read every session's identity, length and activity, then fill published
   * titles.
   * @param now - build timestamp, used for the title and storage caches.
   * @returns one entry per known session, unsorted.
   */
  async collect(now) {
    const entries = await this.gather(now);
    // Titles are read in publish order, so the budget lands on the rows the cap
    // will actually keep.
    await this.resolveTitles(now, orderSessions(entries).slice(0, this.options.maxRows));
    return entries;
  }

  /**
   * Read every session's identity, length and activity.
   * @param now - build timestamp, used for the storage cache.
   * @returns one entry per known session, unsorted.
   */
  async gather(now) {
    const byId = new Map();
    const stored = await this.inventory(now);
    for (const snapshot of stored ?? []) {
      const header = snapshot?.header;
      const sessionId = header?.id === undefined ? undefined : String(header.id);
      if (sessionId === undefined) continue;
      byId.set(sessionId, {
        sessionId,
        header,
        // The persistent snapshot carries an event count only when the backend
        // can produce it cheaply; the shipped JSONL backend does not, so an
        // absent count means unknown, never zero.
        localEvents: typeof snapshot.eventCount === "number" ? snapshot.eventCount : null,
        sizeBytes: typeof snapshot.sizeBytes === "number" ? snapshot.sizeBytes : null,
        updatedAt: undefined,
      });
    }
    let live;
    try {
      live = this.options.liveSessions();
    } catch (error) {
      this.options.logger.warn("session-log-universal: live sessions are unreadable: %s", String(error));
    }
    for (const session of live ?? []) {
      byId.set(session.sessionId, {
        sessionId: session.sessionId,
        header: session.header,
        localEvents: session.localEvents,
        sizeBytes: session.sizeBytes,
        updatedAt: session.updatedAt,
      });
    }
    const files = await this.storageFiles(now, byId.size);
    const entries = [];
    for (const entry of byId.values()) {
      const header = entry.header ?? {};
      const staged = files?.get(entry.sessionId);
      entries.push({
        sessionId: entry.sessionId,
        title: null,
        cwd: typeof header.cwd === "string" ? header.cwd : null,
        parentSession: header.parentSession === undefined ? null : String(header.parentSession),
        updatedAt: entry.updatedAt ?? staged?.updatedAt ?? numberOrNull(header.createdAt) ?? 0,
        localEvents: entry.localEvents,
        // The sweep already stats every log, so the artifact size is free here.
        sizeBytes: entry.sizeBytes ?? staged?.sizeBytes ?? null,
      });
    }
    return entries;
  }

  /**
   * Read the stored-session inventory, at most once per cache window.
   *
   * A failing backend keeps the previous inventory instead of painting the whole
   * corpus as absent.
   * @param now - build timestamp.
   * @returns the snapshots the backend listed, or undefined when unreadable.
   */
  async inventory(now) {
    if (this.stored !== undefined && now - this.stored.at < INVENTORY_CACHE_MILLIS) return this.stored.list;
    let list;
    try {
      list = await this.options.listStored();
    } catch (error) {
      this.options.logger.warn("session-log-universal: stored sessions are unreadable: %s", String(error));
      list = this.stored?.list;
    }
    this.stored = { at: now, list };
    return list;
  }

  /**
   * Read the metadata sweep, at most once per cache window.
   * @param now - build timestamp.
   * @param sessionCount - known sessions; an empty corpus needs no sweep.
   * @returns session id to `{ updatedAt, sizeBytes }`, or undefined.
   */
  async storageFiles(now, sessionCount) {
    if (sessionCount === 0) return undefined;
    if (this.storage !== undefined && now - this.storage.at < STORAGE_SCAN_MILLIS) return this.storage.files;
    const root = this.options.storageRoot?.();
    let files;
    if (root !== undefined) {
      try {
        files = await scanStorage(root);
      } catch (error) {
        this.options.logger.warn("session-log-universal: session storage sweep failed: %s", String(error));
      }
    }
    this.storage = { at: now, files };
    return files;
  }

  /**
   * Fill titles for the sessions that will be published, within one budget.
   *
   * A cold log read is the only expensive part of a build, so it is spent on the
   * rows a client actually sees and cached for the lifetime of the process. The
   * first build reads a much larger batch, because a page that has just opened
   * would otherwise show short ids for minutes.
   * @param now - build timestamp.
   * @param entries - the rows that are about to be published.
   */
  async resolveTitles(now, entries) {
    const budget = this.firstBuild ? TITLE_FIRST_BATCH : TITLE_BATCH;
    let spent = 0;
    for (const entry of entries) {
      const cached = this.titles.get(entry.sessionId);
      if (cached !== undefined && (cached.title !== null || now < cached.retryAt)) {
        entry.title = cached.title;
        continue;
      }
      if (spent >= budget) continue;
      // The page hides a session that never received an event, so a cold read
      // for its title would buy nothing.
      if (isEmptyOf(entry.localEvents, entry.sizeBytes)) continue;
      spent += 1;
      let title = null;
      try {
        title = titleFromEvents(await this.options.readEvents(entry.sessionId, TITLE_SCAN_EVENTS));
      } catch {
        /* an unreadable log keeps its row, just without a title */
      }
      this.titles.set(entry.sessionId, { title, retryAt: now + TITLE_RETRY_MILLIS });
      entry.title = title;
    }
  }
}

/**
 * One-click backfill of every session the collector has not fully confirmed.
 *
 * The run is deliberately serial — one session at a time through the existing
 * capture path — so the upload queue never carries two sessions' tails at once,
 * and a session already in flight is dropped from the queue and re-read instead
 * of being uploaded twice. Its state is what the page renders, so a run that is
 * still going is visible from the outside and a second click is refused rather
 * than racing the first.
 */
export class SessionBackfill {
  /** @param options - sources, the per-session step and the clock. */
  constructor(options) {
    this.options = options;
    this.state = emptyBackfill();
    this.sentAtStart = undefined;
    this.starting = false;
    this.active = undefined;
  }

  /** The backfill snapshot the report publishes. */
  snapshot() {
    const state = { ...this.state, limits: { ...this.state.limits }, defaults: defaultBackfillLimits() };
    if (state.running) state.sentRecords = this.sent();
    return state;
  }

  /** Records this run has sent so far, by difference against the uploader counter. */
  sent() {
    if (this.sentAtStart === undefined || typeof this.options.sentRecords !== "function") return 0;
    return Math.max(0, this.options.sentRecords() - this.sentAtStart);
  }

  /** Whether the uploader is on; a backfill with uploading off would push nothing. */
  isEnabled() {
    try {
      return this.options.isEnabled() !== false;
    } catch {
      return false;
    }
  }

  /**
   * Start one run, selecting its targets from the current session inventory.
   * @param limits - validated limits from {@link parseBackfillLimits}.
   * @returns `{ status, started, snapshot?, error? }` for the route.
   */
  async start(limits) {
    if (!this.isEnabled()) return { status: 400, started: false, error: "session-log-universal is off" };
    if (this.state.running || this.starting) return { status: 409, started: false, snapshot: this.snapshot() };
    this.state = {
      ...emptyBackfill(),
      running: true,
      startedAt: this.options.now(),
      limits: { maxSessions: limits.maxSessions, maxBytes: limits.maxBytes },
    };
    this.starting = true;
    try {
      const sessions = await this.options.sessions();
      const selection = selectBackfillTargets(sessions, this.options.ledger(), limits);
      this.state.sessions = selection.targets.length;
      this.state.bytes = selection.bytes;
      this.state.skipped = selection.skipped;
      if (selection.targets.length === 0) {
        this.state.running = false;
        this.state.finishedAt = this.options.now();
        return { status: 200, started: false, snapshot: this.snapshot() };
      }
      this.sentAtStart = typeof this.options.sentRecords === "function" ? this.options.sentRecords() : undefined;
      this.active = this.run(selection.targets);
      return { status: 200, started: true, snapshot: this.snapshot() };
    } catch (error) {
      this.state.running = false;
      this.state.finishedAt = this.options.now();
      this.state.lastError = String(error);
      this.options.logger.warn("session-log-universal: backfill could not start: %s", String(error));
      return { status: 500, started: false, error: String(error) };
    } finally {
      this.starting = false;
    }
  }

  /**
   * Upload the chosen sessions one after another.
   *
   * A session that cannot be read is counted as failed and the run continues:
   * one broken log must not stop the other forty-nine. The yield between sessions
   * keeps the event loop responsive while a large tail is replayed.
   * @param targets - the sessions this run selected, in activity order.
   */
  async run(targets) {
    try {
      for (const target of targets) {
        try {
          await this.options.runSession(target.sessionId);
        } catch (error) {
          this.state.failed += 1;
          this.state.lastError = target.sessionId + ": " + String(error);
          this.options.logger.warn("session-log-universal: backfill of %s failed: %s", target.sessionId, String(error));
        }
        this.state.completed += 1;
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
      }
    } catch (error) {
      this.state.lastError = String(error);
      this.options.logger.warn("session-log-universal: backfill stopped: %s", String(error));
    } finally {
      this.state.sentRecords = this.sent();
      this.sentAtStart = undefined;
      this.state.running = false;
      this.state.finishedAt = this.options.now();
    }
  }
}

/**
 * Whether a request addresses this machine by a loopback name.
 *
 * The route carries session titles and working directories, and a named route is
 * outside the browser-trust fence the `/api` bridge applies, so a request that
 * claims a foreign authority is refused instead of served.
 * @param request - the incoming request.
 * @returns whether the claimed authority is loopback (or absent).
 */
function isLoopbackRequest(request) {
  const host = request.headers.host;
  if (typeof host !== "string" || host.length === 0) return true;
  let hostname;
  try {
    hostname = new URL("http://" + host).hostname;
  } catch {
    return false;
  }
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return bare === "localhost" || bare === "::1" || /^127\./u.test(bare);
}

/**
 * Whether a request declares itself as issued by another site.
 *
 * `Sec-Fetch-Site` is set by every current browser and cannot be forged by a
 * page, so a `no-cors` POST from some other tab is refused here. A request that
 * omits the header — curl, a test, any non-browser client — is left to the
 * authority check above instead of being refused for a header it never had.
 * @param request - the incoming request.
 * @returns whether the request declares a foreign site.
 */
function isCrossSiteRequest(request) {
  const site = request.headers["sec-fetch-site"];
  if (typeof site !== "string" || site.length === 0) return false;
  const value = site.toLowerCase();
  return value !== "same-origin" && value !== "none";
}

/**
 * Whether a request body declares JSON, with or without a charset parameter.
 * @param request - the incoming request.
 * @returns whether the declared content type is JSON.
 */
function isJsonRequest(request) {
  const type = request.headers["content-type"];
  if (typeof type !== "string") return false;
  const mediaType = type.split(";")[0].trim().toLowerCase();
  return mediaType === "application/json";
}

/**
 * Create the HTTP handlers for the status page and the backfill it can start.
 *
 * GET answers the report, POST starts one backfill; a refused build answers 500
 * with a diagnostic rather than an empty table, and nothing is ever cached
 * because both are live observations. A POST is a write, so it is fenced twice:
 * the authority must name this machine (a named route sits outside the browser
 * trust fence the `/api` bridge applies, which is what stops DNS rebinding), and
 * a request that declares itself cross-site is refused. The JSON content-type
 * requirement on POST is the third layer — it is what a cross-site page cannot
 * satisfy without a preflight. A run in progress is reported as a conflict
 * instead of being restarted.
 * @param report - the builder this route publishes.
 * @param logger - Host logger for refused builds.
 * @param backfill - the runner behind POST; absent means the route is read-only.
 * @returns the route handler.
 */
export function reportHandler(report, logger, backfill) {
  const methods = backfill === undefined ? "GET" : "GET, POST";
  return async (request, response) => {
    if (request.method !== "GET" && request.method !== "POST") {
      response.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: methods });
      response.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    if (!isLoopbackRequest(request)) {
      response.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "loopback hosts only" }));
      return;
    }
    if (isCrossSiteRequest(request)) {
      response.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "cross-site requests are refused" }));
      return;
    }
    if (request.method === "POST") {
      await serveBackfill(backfill, logger, request, response);
      return;
    }
    let body;
    try {
      body = JSON.stringify(await report.report());
    } catch (error) {
      logger.warn("session-log-universal: report build failed: %s", String(error));
      response.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: String(error) }));
      return;
    }
    respondJson(response, 200, body);
  };
}

/**
 * Read a bounded request body as text.
 * @param request - the incoming request.
 * @param limit - largest accepted byte count.
 * @returns `{ text }`, or `{ error }` when the body is too large or unreadable.
 */
async function readRequestBody(request, limit) {
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of request) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      total += buffer.length;
      if (total > limit) return { error: "request body is larger than " + String(limit) + " bytes" };
      chunks.push(buffer);
    }
  } catch (error) {
    return { error: "request body could not be read: " + String(error) };
  }
  return { text: Buffer.concat(chunks).toString("utf8") };
}

/** Write one JSON answer, with the length already known. */
function respondJson(response, status, body) {
  const payload = Buffer.from(body, "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": payload.byteLength,
  });
  response.end(payload);
}

/**
 * Answer one POST: validate the body, start the run, report what it chose.
 *
 * The body must declare `application/json`, which is what makes this route
 * unreachable from a cross-site form or a `no-cors` fetch: those can only send
 * `text/plain`, `application/x-www-form-urlencoded` or `multipart/form-data`,
 * and any attempt with a JSON type needs a preflight this route never grants. A
 * non-empty body that does not parse is refused for the same reason as a bad
 * limit — silently falling back to the defaults would upload more than the
 * caller asked for.
 * @param backfill - the runner behind POST, or undefined on a read-only route.
 * @param logger - Host logger.
 * @param request - the incoming request.
 * @param response - the response to own.
 */
async function serveBackfill(backfill, logger, request, response) {
  if (backfill === undefined) {
    response.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET" });
    response.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }
  if (!isJsonRequest(request)) {
    respondJson(response, 415, JSON.stringify({ error: "content-type must be application/json" }));
    return;
  }
  const read = await readRequestBody(request, BACKFILL_BODY_MAX_BYTES);
  if (read.error !== undefined) {
    respondJson(response, 400, JSON.stringify({ error: read.error }));
    return;
  }
  const parsed = parseBackfillLimits(read.text);
  if (parsed.error !== undefined) {
    respondJson(response, 400, JSON.stringify({ error: parsed.error }));
    return;
  }
  let outcome;
  try {
    outcome = await backfill.start(parsed.limits);
  } catch (error) {
    logger.warn("session-log-universal: backfill failed to start: %s", String(error));
    outcome = { status: 500, started: false, error: String(error) };
  }
  if (outcome.snapshot === undefined) {
    respondJson(response, outcome.status, JSON.stringify({ error: outcome.error ?? "backfill failed" }));
    return;
  }
  respondJson(response, outcome.status, JSON.stringify({ ...outcome.snapshot, started: outcome.started === true }));
}

/**
 * Describe what the collector answered, as evidence for the report.
 *
 * The response body is read once here, bounded, so a request that has already
 * been acknowledged can still report "2 record(s) rejected" instead of a bare
 * status code.
 * @param response - the collector's response.
 * @returns a one-line note, or null when the body says nothing.
 */
export async function describeResponse(response) {
  let text;
  try {
    const buffer = await response.arrayBuffer();
    const window = buffer.byteLength > RESPONSE_EXCERPT_BYTES ? new Uint8Array(buffer, 0, RESPONSE_EXCERPT_BYTES) : new Uint8Array(buffer);
    text = new TextDecoder().decode(window).trim();
  } catch {
    return null;
  }
  if (text.length === 0) return null;
  try {
    const parsed = JSON.parse(text);
    const partial = parsed?.partialSuccess;
    if (partial === null || partial === undefined) return null;
    const rejected = typeof partial.rejectedLogRecords === "number" ? partial.rejectedLogRecords : 0;
    const message = typeof partial.errorMessage === "string" && partial.errorMessage.length > 0 ? partial.errorMessage : undefined;
    if (rejected === 0 && message === undefined) return null;
    return "partialSuccess: " + String(rejected) + " record(s) rejected" + (message === undefined ? "" : ": " + message);
  } catch {
    return truncate(text, 200);
  }
}
