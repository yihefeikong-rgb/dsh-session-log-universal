/**
 * Tests for the durable upload watermark (`internalWatermark` in lib/index.js).
 *
 * Self-contained: every path lives in a fresh directory under the operating
 * system temp directory, nothing reads the harness home, no fixture is shipped
 * and no request leaves the process.
 *
 * The Host module imports `@deepseek-ai/schemastery`, which only exists inside a
 * harness installation. Outside one the import fails, so this file reports its
 * tests as skipped instead of failing: the report tests in
 * `tests/report.test.mjs` carry the coverage that always runs.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { upstreamOf } from "../lib/report.js";

/**
 * Where to import the Host half from.
 *
 * The default is this checkout. A harness installation also resolves the peer
 * dependency that module needs, so pointing the DSH_SLU_HOST_MODULE environment
 * variable at the installed copy (for example
 * DSH_HOME/node_modules/dsh-session-log-universal/lib/index.js) runs these tests
 * unchanged outside the harness tree.
 */
const configuredHost = process.env.DSH_SLU_HOST_MODULE;
const hostSpecifier = configuredHost === undefined || configuredHost.length === 0
  ? "../lib/index.js"
  : pathToFileURL(resolve(configuredHost)).href;
/** The Host module, or null when the harness runtime is not importable here. */
const host = await import(hostSpecifier).catch(() => null);
/** Reason reported for every skipped test in this file. */
const skip = host === null
  ? "lib/index.js needs the harness runtime (@deepseek-ai/schemastery); set DSH_SLU_HOST_MODULE to an installed copy"
  : false;
/** Scratch directory owned by this file. */
const scratch = mkdtempSync(join(tmpdir(), "dsh-session-log-universal-"));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A fresh watermark over a path that does not exist yet. */
function freshLedger(name) {
  const path = join(scratch, name, "data", "session-log-universal.json");
  return { path, ledger: new host.internalWatermark(path) };
}

test("watermark: an absent file starts empty", { skip }, () => {
  const { ledger } = freshLedger("absent");
  assert.equal(ledger.get("unknown"), undefined);
  assert.deepEqual(ledger.rows, {});
});

test("watermark: a checkpoint carries the receipt that advanced it", { skip }, () => {
  const { ledger } = freshLedger("receipt");
  ledger.advance("s1", 5, { code: 200, note: null });
  assert.equal(ledger.get("s1"), 5);
  const row = ledger.rows.s1;
  assert.equal(row.seq, 5);
  assert.equal(row.code, 200);
  assert.equal(row.note, null);
  assert.equal(typeof row.at, "number");
  // Without a receipt the status is simply unknown.
  ledger.advance("s2", 1);
  assert.equal(ledger.rows.s2.code, null);
});

test("watermark: a checkpoint never moves backwards", { skip }, () => {
  const { ledger } = freshLedger("monotonic");
  ledger.advance("s1", 7, { code: 200, note: null });
  ledger.advance("s1", 3, { code: 200, note: null });
  assert.equal(ledger.get("s1"), 7);
  assert.equal(ledger.rows.s1.code, 200);
  ledger.advance("s1", 8, { code: 207, note: "partialSuccess: 1 record(s) rejected" });
  assert.equal(ledger.get("s1"), 8);
  assert.equal(ledger.rows.s1.code, 207);
  assert.match(ledger.rows.s1.note, /partialSuccess/);
});

test("watermark: a refused attempt records evidence without advancing", { skip }, () => {
  const { ledger } = freshLedger("failure");
  ledger.advance("s1", 4, { code: 200, note: null });
  const acknowledgedAt = ledger.rows.s1.at;
  ledger.noteFailure("s1", { code: 503, note: "collector returned HTTP 503" });
  assert.equal(ledger.get("s1"), 4);
  assert.equal(ledger.rows.s1.code, 200);
  assert.equal(ledger.rows.s1.at, acknowledgedAt);
  assert.equal(ledger.rows.s1.failCode, 503);
  assert.equal(ledger.rows.s1.failNote, "collector returned HTTP 503");
  assert.ok(ledger.rows.s1.failAt >= acknowledgedAt);
  // A transport failure has no HTTP status at all.
  ledger.noteFailure("s2", { code: null, note: "request failed" });
  assert.equal(ledger.rows.s2.failCode, null);
  assert.equal(ledger.rows.s2.seq, undefined);
});

test("watermark: the ledger is readable by its owner only", {
  skip: skip || (process.platform === "win32" ? "file modes are POSIX-only" : false),
}, () => {
  const { path, ledger } = freshLedger("mode");
  ledger.advance("s1", 3, { code: 200, note: null });
  ledger.flush();
  // The ledger names conversations that reached the collector, and the profile it
  // sits beside may be shared, so the file must not be world-readable.
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
test("watermark: flush persists atomically and reloads", { skip }, () => {
  const { path, ledger } = freshLedger("persist");
  ledger.advance("s1", 9, { code: 202, note: "accepted" });
  ledger.noteFailure("s2", { code: 500, note: "collector returned HTTP 500" });
  ledger.flush();
  const persisted = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.rows.s1.seq, 9);
  assert.equal(persisted.rows.s1.code, 202);
  assert.equal(persisted.rows.s2.failCode, 500);
  const reopened = new host.internalWatermark(path);
  assert.equal(reopened.get("s1"), 9);
  assert.equal(reopened.rows.s1.note, "accepted");
  assert.equal(reopened.rows.s2.failCode, 500);
  // Nothing dirty means nothing is rewritten.
  const before = readFileSync(path, "utf8");
  reopened.flush();
  assert.equal(readFileSync(path, "utf8"), before);
});

test("watermark: a row written before receipts existed still reads as a 2xx", { skip }, () => {
  const path = join(scratch, "legacy", "session-log-universal.json");
  mkdirSync(join(scratch, "legacy"), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, rows: { old: { seq: 2, at: 1762200000000 } } }), "utf8");
  const ledger = new host.internalWatermark(path);
  assert.equal(ledger.get("old"), 2);
  assert.deepEqual(upstreamOf(ledger.rows.old), { code: 200, at: 1762200000000, note: null });
});

test("watermark: an unreadable file is treated as empty instead of fatal", { skip }, () => {
  const path = join(scratch, "broken", "session-log-universal.json");
  mkdirSync(join(scratch, "broken"), { recursive: true });
  writeFileSync(path, "{not json", "utf8");
  const ledger = new host.internalWatermark(path);
  assert.deepEqual(ledger.rows, {});
  // And it heals on the next acknowledgement.
  ledger.advance("s1", 1, { code: 200, note: null });
  ledger.flush();
  assert.equal(JSON.parse(readFileSync(path, "utf8")).rows.s1.seq, 1);
});
