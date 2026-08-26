import assert from "node:assert/strict";
import test from "node:test";

import {
  SECURITY_LOG_PREFIX,
  eventsFromCacheResult,
  formatSecurityLine,
  makeSecurityEvent,
  mergeRollingEvents,
  persistSecurityEvents,
  renderStepSummary,
} from "../scripts/security-log.mjs";

test("makeSecurityEvent clamps fields and drops non-numeric mmr", () => {
  const event = makeSecurityEvent({
    kind: "first_seen_mmr_hold",
    actorUid: "x".repeat(80),
    name: "n".repeat(80),
    mmr: "nope",
    threshold: 15000,
    reason: "r".repeat(400),
  });
  assert.equal(event.actorUid.length, 64);
  assert.equal(event.name.length, 48);
  assert.equal(event.mmr, null);
  assert.equal(event.threshold, 15000);
  assert.equal(event.reason.length, 240);
  assert.equal(event.source, "build-leaderboard-cache");
});

test("eventsFromCacheResult covers pause, hold, autoban, and upload fail", () => {
  const events = eventsFromCacheResult({
    paused: true,
    heldRows: [{
      uid: "evil",
      name: "Hax",
      playlist: "1v1",
      mmr: 27284,
      threshold: 15000,
      reason: "first-seen mmr 27284 > 15000",
    }],
    uploads: [{ action: "failed", playlist: "3v3", error: "R2 503" }],
  }, { autoBan: ["evil"], at: "2026-08-19T06:00:00.000Z" });
  assert.deepEqual(events.map(e => e.kind), [
    "writes_paused",
    "first_seen_mmr_hold",
    "auto_blacklist",
    "json_upload_failed",
  ]);
  assert.equal(events[1].severity, "critical");
  assert.equal(events[1].actorUid, "evil");
  assert.equal(events[3].reason, "R2 503");
});

test("quiet cache runs emit no security events", () => {
  assert.deepEqual(eventsFromCacheResult({ heldRows: [], uploads: [] }), []);
});

test("formatSecurityLine is one grep-able JSON line", () => {
  const event = makeSecurityEvent({ kind: "writes_paused", at: "2026-08-19T06:00:00.000Z" });
  const line = formatSecurityLine(event);
  assert.ok(line.startsWith(`${SECURITY_LOG_PREFIX} {`));
  assert.equal(JSON.parse(line.slice(SECURITY_LOG_PREFIX.length + 1)).kind, "writes_paused");
});

test("renderStepSummary is empty when there is nothing to report", () => {
  assert.equal(renderStepSummary([]), "");
  assert.match(renderStepSummary([makeSecurityEvent({ kind: "auto_blacklist", actorUid: "abc" })]), /auto_blacklist/);
});

test("mergeRollingEvents keeps the newest 200", () => {
  const existing = { events: Array.from({ length: 198 }, (_, i) => ({ at: String(i) })) };
  const merged = mergeRollingEvents(existing, [{ at: "new-1" }, { at: "new-2" }, { at: "new-3" }]);
  assert.equal(merged.events.length, 200);
  assert.equal(merged.events[0].at, "1");
  assert.equal(merged.events.at(-1).at, "new-3");
});

test("persistSecurityEvents writes jsonl, rolling state, and step summary", async () => {
  const files = new Map();
  const warns = [];
  const events = eventsFromCacheResult({
    heldRows: [{ uid: "u1", name: "X", playlist: "2v2", mmr: 16000, threshold: 15000, reason: "held" }],
  }, { at: "2026-08-19T06:00:00.000Z" });
  await persistSecurityEvents(events, {
    log: { warn: line => warns.push(line) },
    writeFile: async (path, body) => { files.set(path, body); },
    readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    appendFile: async (path, body) => { files.set(path, (files.get(path) || "") + body); },
    outputPath: "/tmp/security-events.jsonl",
    statePath: "/tmp/security-events.json",
    stepSummaryPath: "/tmp/summary.md",
  });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /^\[security\] /);
  assert.match(files.get("/tmp/security-events.jsonl"), /first_seen_mmr_hold/);
  assert.equal(JSON.parse(files.get("/tmp/security-events.json")).events.length, 1);
  assert.match(files.get("/tmp/summary.md"), /## Security events/);
});
