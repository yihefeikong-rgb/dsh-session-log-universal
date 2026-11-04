/**
 * Tests for the upload report (`lib/report.js`) and the report route handler.
 *
 * Self-contained: every input is an in-memory stub, nothing reads the harness
 * home, no fixture files and no network. Run with `npm test`,
 * `node --test tests/` or `node tests/report.test.mjs`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BACKFILL_ROUTE,
  DEFAULT_BACKFILL_BYTES,
  DEFAULT_BACKFILL_SESSIONS,
  EMPTY_LOG_BYTES,
  REPORT_MAX_ROWS,
  REPORT_ROUTE,
  REPORT_VERSION,
  TITLE_MAX_CHARS,
  buildReport,
  describeResponse,
  emptyReport,
  isEmptyOf,
  reportHandler,
  SessionBackfill,
  SessionReport,
  defaultBackfillLimits,
  emptyBackfill,
  parseBackfillLimits,
  selectBackfillTargets,
  stateOf,
  titleFromEvents,
  upstreamOf,
} from "../lib/report.js";

/** Logger stub the report builder accepts. */
const quiet = { warn() {}, info() {}, error() {}, debug() {} };

/** A stored-session snapshot whose backend reports no event count. */
function storedSnapshot(sessionId, sizeBytes, updatedAt) {
  return { header: { id: sessionId, version: 4, createdAt: updatedAt, isSeeded: false }, sizeBytes };
}

/** A human prompt event, as the session log stores it. */
function promptEvent(text) {
  return { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text }] } };
}

/** A title event, as the shipped title service writes it. */
function titleEvent(title) {
  return { type: "session/title", data: { title } };
}

/** Capture what the route handler wrote, without a real socket. */
function fakeResponse() {
  return {
    statusCode: undefined,
    headers: undefined,
    body: undefined,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

/** A request stub carrying only what the handler reads. */
function request(method = "GET", host = "127.0.0.1:26117") {
  return { method, headers: host === undefined ? {} : { host } };
}

test("report contract constants are the published ones", () => {
  assert.equal(REPORT_VERSION, 1);
  assert.equal(REPORT_ROUTE, "/plugin/session-log-universal/report");
  assert.equal(REPORT_MAX_ROWS, 5000);
  assert.equal(TITLE_MAX_CHARS, 80);
  const empty = emptyReport();
  assert.deepEqual(empty.totals, { sessions: 0, uploaded: 0, partial: 0, never: 0, events: 0, ackedEvents: 0 });
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.truncated, false);
  assert.equal(empty.moreSessions, 0);
  assert.equal(empty.version, REPORT_VERSION);
});

test("stateOf: no acknowledgement is never, a full prefix is uploaded, a short one is partial", () => {
  assert.equal(stateOf(null, 42), "never");
  assert.equal(stateOf(undefined, 42), "never");
  assert.equal(stateOf(41, 42), "uploaded");
  assert.equal(stateOf(42, 42), "uploaded");
  assert.equal(stateOf(10, 42), "partial");
  // seq 0 is the first event, so an ack of 0 covers exactly one event.
  assert.equal(stateOf(0, 1), "uploaded");
  assert.equal(stateOf(0, 5), "partial");
  // Empty local log: any acknowledgement covers it; none still means never.
  assert.equal(stateOf(0, 0), "uploaded");
  assert.equal(stateOf(null, 0), "never");
});

test("stateOf: an unknown event count falls back to the acknowledgement time", () => {
  const ackedAt = 1762200000000;
  assert.equal(stateOf(null, null), "never");
  assert.equal(stateOf(null, null, ackedAt, ackedAt + 999999), "never");
  // Acknowledged, and the log has not been written since: everything is upstream.
  assert.equal(stateOf(12, null, ackedAt, ackedAt - 1000), "uploaded");
  assert.equal(stateOf(12, null, ackedAt, ackedAt + 1000), "uploaded");
  // The grace window absorbs the uploader's flush delay plus the round trip.
  assert.equal(stateOf(12, null, ackedAt, ackedAt + 30000), "uploaded");
  // A log written long after the acknowledgement still owes a tail.
  assert.equal(stateOf(12, null, ackedAt, ackedAt + 120000), "partial");
  // Without both timestamps nothing can prove an owed tail.
  assert.equal(stateOf(12, null, null, ackedAt + 999999), "uploaded");
  assert.equal(stateOf(12, null, ackedAt, null), "uploaded");
  // A known count keeps the prefix rule regardless of timing.
  assert.equal(stateOf(3, 10), "partial");
  assert.equal(stateOf(9, 10), "uploaded");
  assert.equal(stateOf(9, 10, 1, 1762200000000), "uploaded");
});

test("isEmptyOf: an unknown count is decided by the header-only log size", () => {
  assert.equal(EMPTY_LOG_BYTES, 4096);
  assert.equal(isEmptyOf(0, undefined), true);
  assert.equal(isEmptyOf(3, 900000), false);
  assert.equal(isEmptyOf(null, 186), true);
  assert.equal(isEmptyOf(null, EMPTY_LOG_BYTES), true);
  assert.equal(isEmptyOf(null, EMPTY_LOG_BYTES + 1), false);
  assert.equal(isEmptyOf(null, null), false);
  assert.equal(isEmptyOf(undefined, undefined), false);
});

test("buildReport: a stored session without an event count is judged by its log", () => {
  const now = 1762200000000;
  const sessions = [
    { sessionId: "header-only", localEvents: null, sizeBytes: 331, updatedAt: now, cwd: "C:/work", title: null },
    { sessionId: "written-since", localEvents: null, sizeBytes: 300000, updatedAt: now - 1000, cwd: "C:/work", title: null },
    { sessionId: "no-artifact", localEvents: null, sizeBytes: null, updatedAt: now - 2000, cwd: null, title: null },
  ];
  const ledger = {
    // Acknowledged ten minutes before the log was last written.
    "written-since": { seq: 120, at: now - 600000, code: 200, note: null },
  };
  const report = buildReport({ now, endpoint: "https://collector.invalid/v1/logs", enabled: true, sessions, ledger });
  const byId = Object.fromEntries(report.rows.map((row) => [row.sessionId, row]));

  assert.equal(byId["header-only"].localEvents, null);
  assert.equal(byId["header-only"].localSeq, null);
  assert.equal(byId["header-only"].sizeBytes, 331);
  assert.equal(byId["header-only"].isEmpty, true);
  assert.equal(byId["header-only"].state, "never");

  assert.equal(byId["written-since"].sizeBytes, 300000);
  assert.equal(byId["written-since"].isEmpty, false);
  assert.equal(byId["written-since"].ackedSeq, 120);
  assert.equal(byId["written-since"].state, "partial");

  assert.equal(byId["no-artifact"].sizeBytes, null);
  assert.equal(byId["no-artifact"].isEmpty, false);
  assert.equal(byId["no-artifact"].state, "never");

  // Unknown lengths contribute nothing to events, while an acknowledgement
  // still counts the prefix it covers.
  assert.deepEqual(report.totals, { sessions: 3, uploaded: 0, partial: 1, never: 2, events: 0, ackedEvents: 121 });
});

test("buildReport: known lengths still win over the artifact size", () => {
  const now = 1762200000000;
  const report = buildReport({
    now,
    endpoint: "x",
    enabled: true,
    sessions: [{ sessionId: "live", localEvents: 4, sizeBytes: 900000, updatedAt: now, title: null, cwd: null }],
    ledger: { live: { seq: 3, at: now, code: 200, note: null } },
  });
  assert.equal(report.rows[0].localEvents, 4);
  assert.equal(report.rows[0].localSeq, 3);
  assert.equal(report.rows[0].isEmpty, false);
  assert.equal(report.rows[0].state, "uploaded");
  assert.deepEqual(report.totals, { sessions: 1, uploaded: 1, partial: 0, never: 0, events: 4, ackedEvents: 4 });
});

test("upstreamOf: a checkpoint without a recorded status reads as the 200 that advanced it", () => {
  assert.deepEqual(upstreamOf(undefined), { code: null, at: null, note: null });
  assert.deepEqual(upstreamOf(null), { code: null, at: null, note: null });
  // Rows written before receipts existed.
  assert.deepEqual(upstreamOf({ seq: 42, at: 1762200000000 }), { code: 200, at: 1762200000000, note: null });
  assert.deepEqual(
    upstreamOf({ seq: 7, at: 5, code: 207, note: "partialSuccess: 1 record(s) rejected" }),
    { code: 207, at: 5, note: "partialSuccess: 1 record(s) rejected" },
  );
});

test("upstreamOf: a refused attempt reports the failure instead of a checkpoint", () => {
  assert.deepEqual(
    upstreamOf({ failCode: 503, failAt: 99, failNote: "collector returned HTTP 503" }),
    { code: 503, at: 99, note: "collector returned HTTP 503" },
  );
  // A transport failure has no status at all.
  assert.deepEqual(upstreamOf({ failCode: null, failAt: 12, failNote: "request failed" }), { code: null, at: 12, note: "request failed" });
  // An empty record carries no evidence.
  assert.deepEqual(upstreamOf({}), { code: null, at: null, note: null });
  // A checkpoint outranks an older failure on the same row.
  assert.equal(upstreamOf({ seq: 3, at: 10, code: 200, failCode: 503, failAt: 9 }).code, 200);
});

test("titleFromEvents: the latest session/title wins", () => {
  const events = [promptEvent("first prompt"), titleEvent("named by the title service"), titleEvent("renamed later")];
  assert.equal(titleFromEvents(events), "renamed later");
});

test("titleFromEvents: falls back to the first human prompt", () => {
  const events = [
    { type: "session/title", data: { title: "   " } },
    { type: "user/message", data: { source: { kind: "assistant" }, content: [{ type: "text", text: "not human" }] } },
    { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "image", url: "x" }, { type: "text", text: "hello" }, { type: "text", text: "world" }] } },
    promptEvent("second prompt"),
  ];
  assert.equal(titleFromEvents(events), "hello\nworld");
  // Only the outer whitespace of the joined prompt is trimmed.
  assert.equal(titleFromEvents([promptEvent("  padded prompt  ")]), "padded prompt");
});

test("titleFromEvents: truncates to the character budget with an ellipsis", () => {
  const long = "x".repeat(TITLE_MAX_CHARS + 20);
  const title = titleFromEvents([titleEvent(long)]);
  assert.equal([...title].length, TITLE_MAX_CHARS + 1);
  assert.ok(title.endsWith("\u2026"));
  assert.equal(title.slice(0, TITLE_MAX_CHARS), "x".repeat(TITLE_MAX_CHARS));
  // A title that fits is returned untouched, without an ellipsis.
  assert.equal(titleFromEvents([titleEvent("short")]), "short");
  // A smaller budget is honoured too.
  assert.equal(titleFromEvents([titleEvent("abcdef")], 3), "abc\u2026");
});

test("titleFromEvents: nothing to name is null", () => {
  assert.equal(titleFromEvents([]), null);
  assert.equal(titleFromEvents([{ type: "turn/start" }]), null);
  assert.equal(titleFromEvents([{ type: "user/message", data: { source: { kind: "user" }, content: [] } }]), null);
});

test("SessionReport: the first build spends a wide title budget, later builds a narrow one", async () => {
  const sessions = Array.from({ length: 200 }, (_, index) => storedSnapshot("s-" + index, 9000, 1000 - index));
  let reads = 0;
  let clock = 1762200000000;
  const report = new SessionReport({
    logger: quiet,
    refreshMillis: 5000,
    maxRows: 500,
    endpoint: () => "https://collector.invalid/v1/logs",
    enabled: () => true,
    ledger: () => ({}),
    listStored: async () => sessions,
    liveSessions: () => [],
    readEvents: async () => {
      reads += 1;
      return [];
    },
    storageRoot: () => undefined,
    now: () => clock,
  });
  await report.report();
  assert.equal(reads, 96, "the first build fills what it can in one pass");
  clock += 6000;
  await report.refresh();
  assert.equal(reads, 96 + 32, "later builds keep a narrow budget");
  clock += 6000;
  await report.refresh();
  assert.equal(reads, 96 + 64);
  await report.stop();
});

test("SessionReport: title reads are spent on sessions that hold content", async () => {
  const seen = [];
  const report = new SessionReport({
    logger: quiet,
    refreshMillis: 5000,
    maxRows: 1,
    endpoint: () => "https://collector.invalid/v1/logs",
    enabled: () => true,
    ledger: () => ({}),
    // The empty session is the most recently touched one.
    listStored: async () => [storedSnapshot("empty", 200, 2000), storedSnapshot("content", 90000, 1000)],
    liveSessions: () => [],
    readEvents: async (sessionId) => {
      seen.push(sessionId);
      return [promptEvent("a real conversation")];
    },
    storageRoot: () => undefined,
    now: () => 1762200000000,
  });
  const value = await report.report();
  assert.deepEqual(seen, ["content"], "the row the cap keeps is the one whose title is read");
  assert.deepEqual(value.rows.map((row) => row.sessionId), ["content"]);
  assert.equal(value.rows[0].title, "a real conversation");
  assert.equal(value.moreSessions, 0);
  await report.stop();
});

test("SessionReport: a source that throws degrades the row instead of the build", async () => {
  const report = new SessionReport({
    logger: quiet,
    refreshMillis: 5000,
    maxRows: 500,
    endpoint: () => "https://collector.invalid/v1/logs",
    enabled: () => true,
    ledger: () => ({}),
    listStored: async () => { throw new Error("persistence exploded"); },
    liveSessions: () => { throw new Error("sessions exploded"); },
    readEvents: async () => [],
    storageRoot: () => undefined,
    now: () => 1762200000000,
  });
  const value = await report.report();
  assert.deepEqual(value.rows, []);
  assert.equal(value.totals.sessions, 0);
  await report.stop();
});

/** A POST request stub with an optional body, as the handler reads it. */
function postRequest(body, host = "127.0.0.1:26117") {
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const bytes = Buffer.from(text, "utf8");
  return {
    method: "POST",
    headers: { host, "content-type": "application/json" },
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
}

/** One stored session row the way the report collects it. */
function stored(id, sizeBytes, updatedAt, localEvents = null) {
  return { sessionId: id, sizeBytes, updatedAt, localEvents, title: null, cwd: null, parentSession: null };
}

test("parseBackfillLimits: an absent or empty body means the published defaults", () => {
  const defaults = { limits: { maxSessions: DEFAULT_BACKFILL_SESSIONS, maxBytes: DEFAULT_BACKFILL_BYTES } };
  assert.deepEqual(parseBackfillLimits(undefined), defaults);
  assert.deepEqual(parseBackfillLimits(""), defaults);
  assert.deepEqual(parseBackfillLimits("   "), defaults);
  assert.deepEqual(parseBackfillLimits("{}"), defaults);
  assert.deepEqual(parseBackfillLimits(JSON.stringify({ maxSessions: null, maxBytes: null })), defaults);
  assert.deepEqual(parseBackfillLimits(JSON.stringify({ maxSessions: 7 })), { limits: { maxSessions: 7, maxBytes: DEFAULT_BACKFILL_BYTES } });
  assert.deepEqual(parseBackfillLimits(JSON.stringify({ maxSessions: 500, maxBytes: 1048576 })), { limits: { maxSessions: 500, maxBytes: 1048576 } });
});

test("parseBackfillLimits: out-of-range and malformed bodies are refused with a reason", () => {
  assert.match(parseBackfillLimits(JSON.stringify({ maxSessions: 0 })).error, /maxSessions/);
  assert.match(parseBackfillLimits(JSON.stringify({ maxSessions: 501 })).error, /maxSessions/);
  assert.match(parseBackfillLimits(JSON.stringify({ maxSessions: 2.5 })).error, /maxSessions/);
  assert.match(parseBackfillLimits(JSON.stringify({ maxSessions: "10" })).error, /maxSessions/);
  assert.match(parseBackfillLimits(JSON.stringify({ maxBytes: 1024 })).error, /maxBytes/);
  assert.match(parseBackfillLimits(JSON.stringify({ maxBytes: 2147483649 })).error, /maxBytes/);
  assert.match(parseBackfillLimits("{not json").error, /not valid JSON/);
  assert.match(parseBackfillLimits("[1,2]").error, /JSON object/);
});

test("selectBackfillTargets: takes what is owed and leaves out what is done or empty", () => {
  const now = 1762200000000;
  const sessions = [
    stored("uploaded", 9000, now),
    stored("partial", 9000, now - 10),
    stored("never", 9000, now - 20),
    stored("empty", 200, now - 30, 0),
    stored("header-only", 331, now - 40),
  ];
  const ledger = {
    uploaded: { seq: 9, at: now },
    // A prefix was acknowledged ten minutes before the log stopped changing.
    partial: { seq: 3, at: now - 600000 },
  };
  const selection = selectBackfillTargets(sessions, ledger, { maxSessions: 10, maxBytes: DEFAULT_BACKFILL_BYTES });
  assert.deepEqual(selection.targets.map((target) => target.sessionId), ["partial", "never"]);
  assert.equal(selection.bytes, 18000);
  assert.equal(selection.skipped, 0);
  assert.equal(selection.targets[0].state, "partial");
  assert.equal(selection.targets[1].state, "never");
});

test("selectBackfillTargets: the session limit and the byte limit both apply", () => {
  const now = 1762200000000;
  // 5000-byte logs: above the header-only ceiling, so every one holds events.
  const sessions = [stored("s1", 5000, now), stored("s2", 5000, now - 1), stored("s3", 5000, now - 2), stored("s4", 5000, now - 3)];
  const bySessions = selectBackfillTargets(sessions, {}, { maxSessions: 2, maxBytes: DEFAULT_BACKFILL_BYTES });
  assert.deepEqual(bySessions.targets.map((target) => target.sessionId), ["s1", "s2"]);
  assert.equal(bySessions.bytes, 10000);
  assert.equal(bySessions.skipped, 2);

  const byBytes = selectBackfillTargets(sessions, {}, { maxSessions: 10, maxBytes: 12000 });
  assert.deepEqual(byBytes.targets.map((target) => target.sessionId), ["s1", "s2"]);
  assert.equal(byBytes.bytes, 10000);
  assert.equal(byBytes.skipped, 2);

  // Whichever is reached first wins.
  const both = selectBackfillTargets(sessions, {}, { maxSessions: 3, maxBytes: 10000 });
  assert.deepEqual(both.targets.map((target) => target.sessionId), ["s1", "s2"]);
  assert.equal(both.skipped, 2);

  // A limit too small for the very first candidate uploads nothing rather than
  // silently exceeding it.
  const tooSmall = selectBackfillTargets(sessions, {}, { maxSessions: 10, maxBytes: 4999 });
  assert.deepEqual(tooSmall.targets, []);
  assert.equal(tooSmall.bytes, 0);
  assert.equal(tooSmall.skipped, 4);
});

test("selectBackfillTargets: activity order is newest first", () => {
  const sessions = [stored("old", 9000, 100), stored("new", 9000, 300), stored("mid", 9000, 200)];
  const selection = selectBackfillTargets(sessions, {}, { maxSessions: 3, maxBytes: DEFAULT_BACKFILL_BYTES });
  assert.deepEqual(selection.targets.map((target) => target.sessionId), ["new", "mid", "old"]);
});

test("selectBackfillTargets: missing limits fall back to the defaults", () => {
  const sessions = Array.from({ length: 60 }, (_, index) => stored("s" + index, 5000, 1000 - index));
  const selection = selectBackfillTargets(sessions, {}, {});
  assert.equal(selection.targets.length, DEFAULT_BACKFILL_SESSIONS);
  assert.equal(selection.skipped, 10);
});

/** A runner over in-memory sources, with the per-session step recorded. */
function runner(overrides = {}) {
  const calls = [];
  let sent = 0;
  let clock = 1762200000000;
  const backfill = new SessionBackfill({
    logger: quiet,
    now: () => clock,
    isEnabled: () => true,
    sessions: async () => [stored("owed", 9000, 100), stored("done", 9000, 200)],
    ledger: () => ({ done: { seq: 9, at: 200 } }),
    sentRecords: () => sent,
    runSession: async (sessionId) => {
      calls.push(sessionId);
      sent += 5;
    },
    ...overrides,
  });
  return { backfill, calls, advance: (millis) => { clock += millis; } };
}

test("SessionBackfill: runs the owed sessions once and refuses a second run", async () => {
  const { backfill, calls } = runner();
  const outcome = await backfill.start({ maxSessions: 10, maxBytes: DEFAULT_BACKFILL_BYTES });
  assert.equal(outcome.status, 200);
  assert.equal(outcome.started, true);
  assert.equal(outcome.snapshot.running, true);
  assert.equal(outcome.snapshot.sessions, 1, "only the owed session is selected");
  assert.deepEqual(outcome.snapshot.limits, { maxSessions: 10, maxBytes: DEFAULT_BACKFILL_BYTES });

  const conflict = await backfill.start({ maxSessions: 10, maxBytes: DEFAULT_BACKFILL_BYTES });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.started, false);
  assert.equal(conflict.snapshot.running, true);

  await backfill.active;
  assert.deepEqual(calls, ["owed"]);
  const finished = backfill.snapshot();
  assert.equal(finished.running, false);
  assert.equal(finished.completed, 1);
  assert.equal(finished.failed, 0);
  assert.equal(finished.sentRecords, 5);
  assert.notEqual(finished.finishedAt, null);
  // The run's own limits are reported, and they never leak into the defaults.
  assert.deepEqual(finished.limits, { maxSessions: 10, maxBytes: DEFAULT_BACKFILL_BYTES });
  assert.deepEqual(finished.defaults, { maxSessions: DEFAULT_BACKFILL_SESSIONS, maxBytes: DEFAULT_BACKFILL_BYTES });
});

test("SessionBackfill: defaults stay constant while limits follow the last run", async () => {
  const defaults = { maxSessions: DEFAULT_BACKFILL_SESSIONS, maxBytes: DEFAULT_BACKFILL_BYTES };
  const empty = emptyBackfill();
  assert.deepEqual(empty.defaults, defaults);
  assert.deepEqual(empty.limits, defaults);
  assert.deepEqual(defaultBackfillLimits(), defaults);

  const { backfill } = runner();
  const custom = { maxSessions: 2, maxBytes: 1048576 };
  const outcome = await backfill.start(custom);
  assert.deepEqual(outcome.snapshot.defaults, defaults, "a running snapshot keeps the defaults");
  await backfill.active;
  const finished = backfill.snapshot();
  assert.deepEqual(finished.limits, custom, "limits report what this run actually used");
  assert.deepEqual(finished.defaults, defaults, "defaults do not follow the last run");

  // A second run with different limits still leaves the defaults alone.
  const second = await backfill.start({ maxSessions: 1, maxBytes: 2097152000 });
  assert.deepEqual(second.snapshot.limits, { maxSessions: 1, maxBytes: 2097152000 });
  await backfill.active;
  assert.deepEqual(backfill.snapshot().defaults, defaults);
});

test("SessionBackfill: one unreadable session is counted and the run continues", async () => {
  const seen = [];
  const { backfill } = runner({
    sessions: async () => [stored("a", 9000, 300), stored("b", 9000, 200), stored("c", 9000, 100)],
    runSession: async (sessionId) => {
      seen.push(sessionId);
      if (sessionId === "b") throw new Error("log is corrupt");
    },
  });
  await backfill.start({ maxSessions: 10, maxBytes: DEFAULT_BACKFILL_BYTES });
  await backfill.active;
  assert.deepEqual(seen, ["a", "b", "c"]);
  const state = backfill.snapshot();
  assert.equal(state.completed, 3);
  assert.equal(state.failed, 1);
  assert.match(state.lastError, /log is corrupt/);
});

test("SessionBackfill: nothing owed answers zero sessions without starting", async () => {
  const { backfill } = runner({ sessions: async () => [stored("done", 1000, 200)], ledger: () => ({ done: { seq: 9, at: 200 } }) });
  const outcome = await backfill.start({ maxSessions: 10, maxBytes: DEFAULT_BACKFILL_BYTES });
  assert.equal(outcome.status, 200);
  assert.equal(outcome.started, false);
  assert.equal(outcome.snapshot.running, false);
  assert.equal(outcome.snapshot.sessions, 0);
});

test("SessionBackfill: uploading switched off refuses to start", async () => {
  const { backfill } = runner({ isEnabled: () => false });
  const outcome = await backfill.start({ maxSessions: 10, maxBytes: DEFAULT_BACKFILL_BYTES });
  assert.equal(outcome.status, 400);
  assert.match(outcome.error, /is off/);
});

/** A backfill runner stub the handler tests drive directly. */
function stubBackfill(outcome) {
  const limits = [];
  return {
    limits,
    start: async (given) => {
      limits.push(given);
      return outcome;
    },
  };
}

test("reportHandler: POST starts a backfill and answers the snapshot", async () => {
  const snapshot = { ...emptyBackfill(), running: true, sessions: 4, bytes: 4096, startedAt: 7, limits: { maxSessions: 4, maxBytes: 1048576 } };
  const backfill = stubBackfill({ status: 200, started: true, snapshot });
  const handler = reportHandler({ report: async () => emptyReport() }, quiet, backfill);
  const response = fakeResponse();
  await handler(postRequest({ maxSessions: 4, maxBytes: 1048576 }), response);
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body.toString("utf8"));
  assert.equal(body.started, true);
  assert.equal(body.running, true);
  assert.equal(body.sessions, 4);
  assert.deepEqual(body.limits, { maxSessions: 4, maxBytes: 1048576 });
  assert.deepEqual(body.defaults, { maxSessions: DEFAULT_BACKFILL_SESSIONS, maxBytes: DEFAULT_BACKFILL_BYTES });
  assert.deepEqual(backfill.limits, [{ maxSessions: 4, maxBytes: 1048576 }]);
  // No body at all means the defaults, not a refusal.
  const bare = fakeResponse();
  await handler(postRequest(undefined), bare);
  assert.equal(bare.statusCode, 200);
  assert.deepEqual(backfill.limits.at(-1), { maxSessions: DEFAULT_BACKFILL_SESSIONS, maxBytes: DEFAULT_BACKFILL_BYTES });
});

test("reportHandler: POST reports a run already in progress as a conflict", async () => {
  const backfill = stubBackfill({ status: 409, started: false, snapshot: { ...emptyBackfill(), running: true, sessions: 3 } });
  const handler = reportHandler({ report: async () => emptyReport() }, quiet, backfill);
  const response = fakeResponse();
  await handler(postRequest({}), response);
  assert.equal(response.statusCode, 409);
  const body = JSON.parse(response.body.toString("utf8"));
  assert.equal(body.started, false);
  assert.equal(body.running, true);
  assert.equal(body.sessions, 3);
});

test("reportHandler: POST refuses a bad limit and an oversized body", async () => {
  const backfill = stubBackfill({ status: 200, started: false, snapshot: emptyBackfill() });
  const handler = reportHandler({ report: async () => emptyReport() }, quiet, backfill);
  const tooMany = fakeResponse();
  await handler(postRequest({ maxSessions: 900 }), tooMany);
  assert.equal(tooMany.statusCode, 400);
  assert.match(JSON.parse(tooMany.body.toString("utf8")).error, /maxSessions/);
  assert.equal(backfill.limits.length, 0, "an invalid body never reaches the runner");

  const notJson = fakeResponse();
  await handler(postRequest("{nope"), notJson);
  assert.equal(notJson.statusCode, 400);

  const oversized = fakeResponse();
  await handler(postRequest("x".repeat(5000)), oversized);
  assert.equal(oversized.statusCode, 400);
  assert.match(JSON.parse(oversized.body.toString("utf8")).error, /larger than 4096/);
});

test("reportHandler: POST is refused when uploading is off", async () => {
  const backfill = stubBackfill({ status: 400, started: false, error: "session-log-universal is off" });
  const handler = reportHandler({ report: async () => emptyReport() }, quiet, backfill);
  const response = fakeResponse();
  await handler(postRequest({}), response);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body.toString("utf8")), { error: "session-log-universal is off" });
});

/** A request stub carrying an explicit Sec-Fetch-Site declaration. */
function siteRequest(site, method = "GET", type = "application/json") {
  const headers = { host: "127.0.0.1:26117" };
  if (site !== undefined) headers["sec-fetch-site"] = site;
  if (type !== undefined && type !== null) headers["content-type"] = type;
  const bytes = Buffer.from(JSON.stringify({ maxSessions: 2 }), "utf8");
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
}

test("reportHandler: a request that declares itself cross-site is refused", async () => {
  const handler = reportHandler({ report: async () => emptyReport() }, quiet, stubBackfill({ status: 200, started: false, snapshot: emptyBackfill() }));
  // A `no-cors` POST from another page cannot hide this header.
  for (const site of ["cross-site", "same-site", "Cross-Site"]) {
    const response = fakeResponse();
    await handler(siteRequest(site, "POST"), response);
    assert.equal(response.statusCode, 403, site);
    assert.deepEqual(JSON.parse(response.body.toString("utf8")), { error: "cross-site requests are refused" });
  }
  // The page itself and a direct navigation are both fine.
  for (const site of ["same-origin", "none"]) {
    const response = fakeResponse();
    await handler(siteRequest(site, "POST"), response);
    assert.equal(response.statusCode, 200, site);
  }
  // curl and the tests send no such header at all.
  const bare = fakeResponse();
  await handler(siteRequest(undefined, "POST"), bare);
  assert.equal(bare.statusCode, 200);
});

test("reportHandler: POST requires a JSON content type", async () => {
  const backfill = stubBackfill({ status: 200, started: false, snapshot: emptyBackfill() });
  const handler = reportHandler({ report: async () => emptyReport() }, quiet, backfill);
  // Exactly what a cross-site form or `no-cors` fetch can send.
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/json-seq", null]) {
    const response = fakeResponse();
    await handler(siteRequest("same-origin", "POST", type), response);
    assert.equal(response.statusCode, 415, String(type));
    assert.deepEqual(JSON.parse(response.body.toString("utf8")), { error: "content-type must be application/json" });
  }
  // A browser same-origin fetch sends the charset parameter too.
  const accepted = fakeResponse();
  await handler(siteRequest("same-origin", "POST", "application/json; charset=utf-8"), accepted);
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(backfill.limits, [{ maxSessions: 2, maxBytes: DEFAULT_BACKFILL_BYTES }]);
  // GET never needs a content type.
  const report = fakeResponse();
  await handler({ method: "GET", headers: { host: "127.0.0.1:26117" } }, report);
  assert.equal(report.statusCode, 200);
});
test("reportHandler: POST obeys the loopback guard and the method list", async () => {
  const handler = reportHandler({ report: async () => emptyReport() }, quiet, stubBackfill({ status: 200, started: false, snapshot: emptyBackfill() }));
  const foreign = fakeResponse();
  await handler(postRequest({}, "evil.example.com"), foreign);
  assert.equal(foreign.statusCode, 403);

  const put = fakeResponse();
  await handler({ method: "PUT", headers: { host: "127.0.0.1:26117" } }, put);
  assert.equal(put.statusCode, 405);
  assert.equal(put.headers.allow, "GET, POST");

  // Without a runner the route stays read-only, and says so.
  const readOnly = reportHandler({ report: async () => emptyReport() }, quiet);
  const posted = fakeResponse();
  await readOnly(postRequest({}), posted);
  assert.equal(posted.statusCode, 405);
  assert.equal(posted.headers.allow, "GET");
});

test("reportHandler: a POST that throws answers 500 with the diagnostic", async () => {
  const backfill = { start: async () => { throw new Error("selection exploded"); } };
  const handler = reportHandler({ report: async () => emptyReport() }, quiet, backfill);
  const response = fakeResponse();
  await handler(postRequest({}), response);
  assert.equal(response.statusCode, 500);
  assert.match(JSON.parse(response.body.toString("utf8")).error, /selection exploded/);
});

test("report value: the backfill state rides beside the rows", () => {
  const snapshot = { ...emptyBackfill(), running: true, startedAt: 1, sessions: 3, bytes: 900, completed: 1, limits: { maxSessions: 3, maxBytes: 5000 } };
  const value = buildReport({ now: 2, endpoint: "x", enabled: true, sessions: [], ledger: {}, backfill: snapshot });
  assert.deepEqual(value.backfill, snapshot);
  assert.deepEqual(emptyReport().backfill, emptyBackfill());
  assert.equal(BACKFILL_ROUTE, "/plugin/session-log-universal/backfill");
});
/** Sessions and ledger shared by the report assembly tests. */
function fixture() {
  return {
    now: 1762200000000,
    endpoint: "https://collector.invalid/v1/logs",
    enabled: true,
    sessions: [
      { sessionId: "acked", localEvents: 10, updatedAt: 100, cwd: "C:/work/acked", title: "Acked session" },
      { sessionId: "busy", localEvents: 5, updatedAt: 300, cwd: "C:/work/busy", parentSession: "acked", title: null },
      { sessionId: "never", localEvents: 3, updatedAt: 200, cwd: null, title: "Never uploaded" },
    ],
    ledger: {
      acked: { seq: 9, at: 111, code: 200, note: null },
      busy: { seq: 1, at: 222, code: 207, note: "partialSuccess: 1 record(s) rejected" },
    },
  };
}

test("buildReport: newest activity first, with totals over every session", () => {
  const report = buildReport(fixture());
  assert.equal(report.version, REPORT_VERSION);
  assert.equal(report.generatedAt, 1762200000000);
  assert.equal(report.endpoint, "https://collector.invalid/v1/logs");
  assert.equal(report.enabled, true);
  assert.equal(report.truncated, false);
  assert.deepEqual(report.rows.map((row) => row.sessionId), ["busy", "never", "acked"]);
  assert.deepEqual(report.totals, { sessions: 3, uploaded: 1, partial: 1, never: 1, events: 18, ackedEvents: 12 });

  const byId = Object.fromEntries(report.rows.map((row) => [row.sessionId, row]));
  assert.equal(byId.acked.state, "uploaded");
  assert.equal(byId.acked.localSeq, 9);
  assert.equal(byId.acked.ackedSeq, 9);
  assert.equal(byId.acked.ackedAt, 111);
  assert.deepEqual(byId.acked.upstream, { code: 200, at: 111, note: null });
  assert.equal(byId.acked.cwd, "C:/work/acked");
  assert.equal(byId.acked.parentSession, null);
  assert.equal(byId.acked.title, "Acked session");
  assert.equal(byId.busy.title, null);

  assert.equal(byId.busy.state, "partial");
  assert.equal(byId.busy.parentSession, "acked");
  assert.deepEqual(byId.busy.upstream, { code: 207, at: 222, note: "partialSuccess: 1 record(s) rejected" });

  assert.equal(byId.never.state, "never");
  assert.equal(byId.never.ackedSeq, null);
  assert.equal(byId.never.ackedAt, null);
  assert.equal(byId.never.cwd, null);
});

test("buildReport: maxRows truncates the table but not the totals", () => {
  const report = buildReport({ ...fixture(), maxRows: 2 });
  assert.equal(report.rows.length, 2);
  assert.equal(report.truncated, true);
  assert.deepEqual(report.rows.map((row) => row.sessionId), ["busy", "never"]);
  assert.deepEqual(report.totals, { sessions: 3, uploaded: 1, partial: 1, never: 1, events: 18, ackedEvents: 12 });
});

test("buildReport: an empty corpus still answers with the full contract", () => {
  const report = buildReport({ now: 1, endpoint: "https://collector.invalid/v1/logs", enabled: false, sessions: [], ledger: {} });
  assert.deepEqual(report.rows, []);
  assert.equal(report.truncated, false);
  assert.equal(report.enabled, false);
  assert.deepEqual(report.totals, { sessions: 0, uploaded: 0, partial: 0, never: 0, events: 0, ackedEvents: 0 });
});

test("buildReport: a capped table is spent on sessions that hold events", () => {
  const now = 1762200000000;
  const sessions = [
    // An empty session that is the most recently touched row of all.
    { sessionId: "empty-newest", localEvents: 0, sizeBytes: 200, updatedAt: now, title: null, cwd: null },
    { sessionId: "content-new", localEvents: 4, sizeBytes: 90000, updatedAt: now - 10, title: null, cwd: null },
    { sessionId: "empty-old", localEvents: null, sizeBytes: 331, updatedAt: now - 20, title: null, cwd: null },
    { sessionId: "content-old", localEvents: 7, sizeBytes: 120000, updatedAt: now - 30, title: null, cwd: null },
  ];
  const report = buildReport({ now, endpoint: "x", enabled: true, sessions, ledger: {}, maxRows: 2 });
  // Both content sessions come first, each group keeping newest-first order.
  assert.deepEqual(report.rows.map((row) => row.sessionId), ["content-new", "content-old"]);
  assert.equal(report.rows.every((row) => row.isEmpty === false), true);
  assert.equal(report.truncated, true, "two of four sessions are not shown");
  assert.equal(report.moreSessions, 0, "no session with content was left out");
  assert.equal(report.totals.sessions, 4);
});

test("buildReport: empty sessions fill the rows a content session did not claim", () => {
  const now = 1762200000000;
  const sessions = [
    { sessionId: "content", localEvents: 2, sizeBytes: 9000, updatedAt: now - 100, title: null, cwd: null },
    { sessionId: "empty-new", localEvents: 0, sizeBytes: 200, updatedAt: now, title: null, cwd: null },
    { sessionId: "empty-old", localEvents: null, sizeBytes: 300, updatedAt: now - 200, title: null, cwd: null },
  ];
  const report = buildReport({ now, endpoint: "x", enabled: true, sessions, ledger: {}, maxRows: 3 });
  assert.deepEqual(report.rows.map((row) => row.sessionId), ["content", "empty-new", "empty-old"]);
  assert.equal(report.truncated, false);
  assert.equal(report.moreSessions, 0);
});

test("buildReport: moreSessions counts the sessions with content the cap left out", () => {
  const now = 1762200000000;
  const sessions = [];
  for (let index = 0; index < 5; index += 1) {
    sessions.push({ sessionId: "content-" + index, localEvents: 3, sizeBytes: 9000, updatedAt: now - index, title: null, cwd: null });
  }
  sessions.push({ sessionId: "empty", localEvents: 0, sizeBytes: 200, updatedAt: now, title: null, cwd: null });
  const report = buildReport({ now, endpoint: "x", enabled: true, sessions, ledger: {}, maxRows: 3 });
  assert.deepEqual(report.rows.map((row) => row.sessionId), ["content-0", "content-1", "content-2"]);
  assert.equal(report.moreSessions, 2);
  assert.equal(report.truncated, true);
  // Totals are unaffected by the cap or the partition.
  assert.deepEqual(report.totals, { sessions: 6, uploaded: 0, partial: 0, never: 6, events: 15, ackedEvents: 0 });
});

test("buildReport: an uncapped table still lists every session, content first", () => {
  const now = 1762200000000;
  const sessions = [
    { sessionId: "empty", localEvents: 0, sizeBytes: 200, updatedAt: now, title: null, cwd: null },
    { sessionId: "content", localEvents: 1, sizeBytes: 9000, updatedAt: now - 1, title: null, cwd: null },
  ];
  const report = buildReport({ now, endpoint: "x", enabled: true, sessions, ledger: {} });
  assert.deepEqual(report.rows.map((row) => row.sessionId), ["content", "empty"]);
  assert.equal(report.truncated, false);
  assert.equal(report.moreSessions, 0);
});

test("buildReport: the default cap covers the whole corpus the page filters", () => {
  const now = 1762200000000;
  const sessions = [];
  // 677 conversations and 179 header-only sessions: the shape of a real corpus.
  for (let index = 0; index < 677; index += 1) sessions.push(stored("content-" + index, 90000, now - index));
  for (let index = 0; index < 179; index += 1) sessions.push(stored("empty-" + index, 300, now - 1000 - index, 0));
  const report = buildReport({ now, endpoint: "x", enabled: true, sessions, ledger: {} });
  assert.equal(report.rows.length, 856);
  assert.equal(report.truncated, false, "nothing is hidden from the filter");
  assert.equal(report.moreSessions, 0);
  assert.equal(report.totals.sessions, 856);
  // Empty sessions still come last, because the page hides them.
  assert.equal(report.rows.slice(0, 677).every((row) => row.isEmpty === false), true);
  assert.equal(report.rows.slice(677).every((row) => row.isEmpty === true), true);
});

test("buildReport: a corpus larger than the default cap still truncates", () => {
  const now = 1762200000000;
  const sessions = [];
  for (let index = 0; index <= REPORT_MAX_ROWS; index += 1) sessions.push(stored("s-" + index, 90000, now - index));
  const report = buildReport({ now, endpoint: "x", enabled: true, sessions, ledger: {} });
  assert.equal(report.rows.length, REPORT_MAX_ROWS);
  assert.equal(report.truncated, true);
  assert.equal(report.moreSessions, 1, "one conversation did not fit");
  assert.equal(report.totals.sessions, REPORT_MAX_ROWS + 1);
});
test("reportHandler: serves the report as uncached JSON", async () => {
  const value = buildReport(fixture());
  const response = fakeResponse();
  await reportHandler({ report: async () => value }, { warn() {} })(request(), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(response.headers["cache-control"], "no-store");
  const body = response.body.toString("utf8");
  assert.equal(response.headers["content-length"], Buffer.byteLength(body, "utf8"));
  assert.deepEqual(JSON.parse(body), value);
});

test("reportHandler: accepts loopback hosts only, in every spelling", async () => {
  for (const host of ["127.0.0.1:26117", "127.0.0.1", "localhost:1", "[::1]:26117", undefined]) {
    const response = fakeResponse();
    await reportHandler({ report: async () => emptyReport() }, { warn() {} })(request("GET", host), response);
    assert.equal(response.statusCode, 200, "host " + String(host));
  }
});

test("reportHandler: refuses a foreign authority and a non-GET method", async () => {
  const handler = reportHandler({ report: async () => emptyReport() }, { warn() {} });

  const foreign = fakeResponse();
  await handler(request("GET", "evil.example.com"), foreign);
  assert.equal(foreign.statusCode, 403);
  assert.deepEqual(JSON.parse(foreign.body.toString("utf8")), { error: "loopback hosts only" });

  const wrongMethod = fakeResponse();
  await handler(request("POST"), wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.headers.allow, "GET");
  assert.deepEqual(JSON.parse(wrongMethod.body.toString("utf8")), { error: "method not allowed" });
});

test("reportHandler: a refused build is a 500 with the diagnostic, not an empty table", async () => {
  const warnings = [];
  const response = fakeResponse();
  const handler = reportHandler({ report: async () => { throw new Error("boom"); } }, { warn: (...args) => warnings.push(args) });
  await handler(request(), response);
  assert.equal(response.statusCode, 500);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(response.body.toString("utf8")), { error: "Error: boom" });
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /report build failed/);
});

/** Encode a body the way a fetch response would hand it back. */
function encodedBody(text) {
  const bytes = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return { arrayBuffer: async () => buffer };
}

test("describeResponse: keeps the collector partial-success note as evidence", async () => {
  assert.equal(
    await describeResponse(encodedBody(JSON.stringify({ partialSuccess: { rejectedLogRecords: 2, errorMessage: "queue full" } }))),
    "partialSuccess: 2 record(s) rejected: queue full",
  );
  assert.equal(
    await describeResponse(encodedBody(JSON.stringify({ partialSuccess: { rejectedLogRecords: 0 } }))),
    null,
  );
  assert.equal(await describeResponse(encodedBody("")), null);
  assert.equal(await describeResponse(encodedBody("upstream is unhappy")), "upstream is unhappy");
  assert.equal(await describeResponse({ arrayBuffer: async () => { throw new Error("aborted"); } }), null);
});
