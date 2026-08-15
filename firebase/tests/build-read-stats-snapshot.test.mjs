import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  windowStartIso,
  redactAdminDoc,
  buildSnapshot,
  run,
} from "../scripts/build-read-stats-snapshot.mjs";

test("parseArgs: required + defaults", () => {
  const a = parseArgs(["--state-dir", "/tmp/x"]);
  assert.equal(a.stateDir, "/tmp/x");
  assert.equal(a.project, "rgleaderboard");
  assert.equal(a.windowDays, 7);
  assert.equal(a.dryRun, false);
});

test("parseArgs: honors overrides", () => {
  const a = parseArgs([
    "--project", "another",
    "--state-dir", "/tmp/y",
    "--window-days", "7",
    "--dry-run",
  ]);
  assert.equal(a.project, "another");
  assert.equal(a.windowDays, 7);
  assert.equal(a.dryRun, true);
});

test("windowStartIso: rolls back N-1 days from today (inclusive window)", () => {
  const fixedNow = new Date("2026-08-09T12:00:00Z");
  assert.equal(windowStartIso(30, fixedNow), "2026-07-11");
  assert.equal(windowStartIso(7, fixedNow), "2026-08-03");
  assert.equal(windowStartIso(1, fixedNow), "2026-08-09");
});

test("redactAdminDoc: strips adminEmail, keeps everything else", () => {
  const input = {
    id: "2026-08-09_abc",
    date: "2026-08-09",
    sessionId: "abc",
    adminEmail: "dawson@example.com",
    userAgent: "Mozilla/5.0 (Macintosh)",
    total: 42,
    perLabel: { readStatsQuery: 40 },
  };
  const out = redactAdminDoc(input);
  assert.equal(out.adminEmail, undefined);
  assert.equal(out.sessionId, "abc");
  assert.equal(out.userAgent, "Mozilla/5.0 (Macintosh)");
  assert.equal(out.total, 42);
  // Original untouched.
  assert.equal(input.adminEmail, "dawson@example.com");
});

test("buildSnapshot: shape + metadata", () => {
  const now = new Date("2026-08-09T12:34:56Z");
  const snap = buildSnapshot({
    siteDocs: [
      { id: "s1", date: "2026-08-09", sessionId: "s1", adminEmail: "leak@x.com", total: 1 },
    ],
    hudDocs: [{ id: "h1", date: "2026-08-09", sourceUserId: "u1", readTotal: 2 }],
    windowDays: 30,
    windowStart: "2026-07-11",
    windowEnd: "2026-08-09",
    now,
  });
  assert.equal(snap.generatedAt, now.toISOString());
  assert.equal(snap.windowDays, 30);
  assert.equal(snap.windowStart, "2026-07-11");
  assert.equal(snap.windowEnd, "2026-08-09");
  assert.equal(snap.site.length, 1);
  assert.equal(snap.site[0].adminEmail, undefined, "adminEmail must be redacted");
  assert.equal(snap.site[0].sessionId, "s1");
  assert.equal(snap.hud.length, 1);
  // Missing totalDocs / visitorDocs default to empty arrays — old callers
  // still work.
  assert.deepEqual(snap.total, []);
  assert.deepEqual(snap.visitors, []);
});

test("buildSnapshot: includes total + visitor collections when supplied", () => {
  const now = new Date("2026-08-09T12:34:56Z");
  const snap = buildSnapshot({
    siteDocs: [{ id: "s1", date: "2026-08-09", sessionId: "s1", total: 1 }],
    hudDocs: [{ id: "h1", date: "2026-08-09", sourceUserId: "u1", readTotal: 2 }],
    totalDocs: [
      { id: "2026-08-09", date: "2026-08-09", reads: 100, writes: 20, deletes: 1 },
    ],
    visitorDocs: [
      // Visitor docs shouldn't carry adminEmail, but defensively redact.
      { id: "v1", date: "2026-08-09", sessionId: "v1", adminEmail: "leak@x.com", total: 5 },
    ],
    windowDays: 60,
    windowStart: "2026-06-11",
    windowEnd: "2026-08-09",
    now,
  });
  assert.equal(snap.total.length, 1);
  assert.equal(snap.total[0].reads, 100);
  assert.equal(snap.visitors.length, 1);
  assert.equal(snap.visitors[0].sessionId, "v1");
  assert.equal(snap.visitors[0].adminEmail, undefined, "visitor adminEmail must be redacted too");
});

test("run: dry-run does not call writer, fetches token + both collections", async () => {
  const now = new Date("2026-08-09T12:00:00Z");
  const calls = { fetch: [], write: 0, mkdir: 0 };
  const fetchImpl = async (url, opts) => {
    calls.fetch.push({ url, body: opts?.body });
    // Return a small structured-query response with one doc.
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        {
          document: {
            name: "projects/x/databases/(default)/documents/admin_read_stats/2026-08-09_abc",
            fields: {
              date: { stringValue: "2026-08-09" },
              sessionId: { stringValue: "abc" },
              adminEmail: { stringValue: "leak@example.com" },
              total: { integerValue: "10" },
            },
            createTime: "2026-08-09T00:00:00Z",
            updateTime: "2026-08-09T00:00:00Z",
          },
        },
      ]),
    };
  };
  const snap = await run({
    argv: ["--state-dir", "/tmp/does-not-exist", "--dry-run"],
    fetchImpl,
    getToken: async () => "test-token",
    now,
    writer: async () => { calls.write += 1; },
    mkdirImpl: async () => { calls.mkdir += 1; },
    logger: { info() {} },
  });
  assert.equal(calls.write, 0, "dry-run must not write");
  assert.equal(calls.mkdir, 0, "dry-run must not mkdir");
  assert.equal(calls.fetch.length, 4, "one query per collection (admin, hud, total, visitor)");
  assert.ok(snap.site.length > 0);
  assert.equal(snap.site[0].adminEmail, undefined, "email redacted before write");
  // Structural check: run() now populates total + visitors alongside site + hud.
  assert.ok(Array.isArray(snap.total), "snapshot has total collection");
  assert.ok(Array.isArray(snap.visitors), "snapshot has visitors collection");
});
