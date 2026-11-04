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
  REPORT_MAX_ROWS,
  REPORT_ROUTE,
  REPORT_VERSION,
  TITLE_MAX_CHARS,
  buildReport,
  describeResponse,
  emptyReport,
  reportHandler,
  stateOf,
  titleFromEvents,
  upstreamOf,
} from "../lib/report.js";

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
  assert.equal(REPORT_MAX_ROWS, 500);
  assert.equal(TITLE_MAX_CHARS, 80);
  const empty = emptyReport();
  assert.deepEqual(empty.totals, { sessions: 0, uploaded: 0, partial: 0, never: 0, events: 0, ackedEvents: 0 });
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.truncated, false);
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
