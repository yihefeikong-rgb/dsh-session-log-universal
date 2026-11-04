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
 * pushed. A route also keeps a table of up to 500 rows out of the settings
 * document every other surface pays for.
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
/** Maximum published rows; every session still counts towards the totals. */
export const REPORT_MAX_ROWS = 500;
/** Default cache lifetime: a request older than this starts one background rebuild. */
export const REPORT_REFRESH_MILLIS = 5000;
/** A request this recent keeps the rebuild timer awake; an unwatched plugin does no report work. */
const REPORT_ACTIVE_MILLIS = 30000;
/** Published title length limit, in characters. */
export const TITLE_MAX_CHARS = 80;
/** Log prefix scanned for a title (the title event or the first human prompt). */
const TITLE_SCAN_EVENTS = 96;
/** Titles resolved per rebuild; a cold log read must not stall the whole table. */
const TITLE_BATCH = 8;
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
 * @param localEvents - number of events in the local log.
 * @returns `uploaded` when the acknowledgement covers the whole log,
 *   `partial` when it covers a prefix, `never` when nothing was acknowledged.
 */
export function stateOf(ackedSeq, localEvents) {
  if (ackedSeq === null || ackedSeq === undefined) return "never";
  return ackedSeq + 1 >= localEvents ? "uploaded" : "partial";
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
 * Rows are ordered by activity, newest first, and capped; totals count every
 * session, so a truncated table still answers how much of the corpus is uploaded.
 * @param observation - endpoint facts, per-session facts and the upload ledger.
 * @returns the report value served to the client.
 */
export function buildReport(observation) {
  const { now, endpoint, enabled, sessions, ledger, maxRows = REPORT_MAX_ROWS } = observation;
  const totals = { sessions: 0, uploaded: 0, partial: 0, never: 0, events: 0, ackedEvents: 0 };
  const ordered = [...sessions].sort((left, right) => right.updatedAt - left.updatedAt);
  const rows = [];
  for (const session of ordered) {
    const record = ledger?.[session.sessionId];
    const ackedSeq = typeof record?.seq === "number" ? record.seq : null;
    const localEvents = Math.max(0, session.localEvents);
    const state = stateOf(ackedSeq, localEvents);
    totals.sessions += 1;
    totals[state] += 1;
    totals.events += localEvents;
    totals.ackedEvents += ackedSeq === null ? 0 : Math.min(ackedSeq + 1, localEvents);
    if (rows.length >= maxRows) continue;
    rows.push({
      sessionId: session.sessionId,
      title: session.title ?? null,
      cwd: session.cwd ?? null,
      parentSession: session.parentSession ?? null,
      updatedAt: session.updatedAt,
      localSeq: localEvents - 1,
      localEvents,
      ackedSeq,
      ackedAt: ackedSeq === null ? null : numberOrNull(record?.at),
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
    totals,
    rows,
  };
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
 * The sweep is the most expensive thing this module does — 856 sessions cost
 * ~90 ms on Windows — so it is cached for half a minute and only reached while
 * somebody is watching.
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
  }

  /** Current epoch milliseconds, from the injected clock. */
  now() {
    return this.options.now?.() ?? Date.now();
  }

  /** Read the fields taken at build time: endpoint URL, switch state, upload ledger. */
  facts() {
    let endpoint = "";
    let enabled = true;
    let ledger;
    try {
      endpoint = this.options.endpoint();
      enabled = this.options.enabled();
      ledger = this.options.ledger();
    } catch (error) {
      this.options.logger.warn("session-log-universal: report sources failed: %s", String(error));
    }
    return { endpoint, enabled, ledger };
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
      maxRows: this.options.maxRows,
    });
    this.builtAt = now;
  }

  /**
   * Read every session's identity, length and activity.
   * @param now - build timestamp, used for the title and storage caches.
   * @returns one entry per known session, newest first.
   */
  async collect(now) {
    const byId = new Map();
    const stored = await this.inventory(now);
    for (const snapshot of stored ?? []) {
      const header = snapshot?.header;
      const sessionId = header?.id === undefined ? undefined : String(header.id);
      if (sessionId === undefined) continue;
      byId.set(sessionId, {
        sessionId,
        header,
        localEvents: typeof snapshot.eventCount === "number" ? snapshot.eventCount : 0,
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
        updatedAt: session.updatedAt,
      });
    }
    const files = await this.storageFiles(now, byId.size);
    const entries = [];
    for (const entry of byId.values()) {
      const header = entry.header ?? {};
      const updatedAt = entry.updatedAt ?? files?.get(entry.sessionId)?.updatedAt ?? numberOrNull(header.createdAt) ?? 0;
      entries.push({
        sessionId: entry.sessionId,
        title: null,
        cwd: typeof header.cwd === "string" ? header.cwd : null,
        parentSession: header.parentSession === undefined ? null : String(header.parentSession),
        updatedAt,
        localEvents: entry.localEvents,
      });
    }
    entries.sort((left, right) => right.updatedAt - left.updatedAt);
    await this.resolveTitles(now, entries.slice(0, this.options.maxRows));
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
   * rows a client actually sees and cached for the lifetime of the process.
   * @param now - build timestamp.
   * @param entries - the rows that are about to be published.
   */
  async resolveTitles(now, entries) {
    let spent = 0;
    for (const entry of entries) {
      const cached = this.titles.get(entry.sessionId);
      if (cached !== undefined && (cached.title !== null || now < cached.retryAt)) {
        entry.title = cached.title;
        continue;
      }
      if (spent >= TITLE_BATCH) continue;
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
 * Create the HTTP handler that serves the report.
 *
 * GET only; a refused build answers 500 with a diagnostic rather than an empty
 * table, and the response is never cached because it is a live observation.
 * @param report - the builder this route publishes.
 * @param logger - Host logger for refused builds.
 * @returns the route handler.
 */
export function reportHandler(report, logger) {
  return async (request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET" });
      response.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    if (!isLoopbackRequest(request)) {
      response.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "loopback hosts only" }));
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
    const payload = Buffer.from(body, "utf8");
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": payload.byteLength,
    });
    response.end(payload);
  };
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
