import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(testDirectory, "..");
const fixture = JSON.parse(await readFile(
  path.join(testDirectory, "fixtures", "atlas-contract.json"),
  "utf8",
));
const mainSitePath = process.env.MAIN_SITE_PATH
  ? path.resolve(process.env.MAIN_SITE_PATH)
  : path.resolve(workspace, "../../rgleaderboard");
const { MAX_PLAYLIST_ROWS } = await import(pathToFileURL(
  path.join(mainSitePath, "src/config.js"),
));
const hudSource = await readFile(
  process.env.HUD_SCRIPT
    ? path.resolve(process.env.HUD_SCRIPT)
    : path.resolve(workspace, "../rg_hud.user.js"),
  "utf8",
);
const budgets = fixture.operationBudgets;

function operationCount({ reads = 0, writes = 0 }, action) {
  if (action === "read") return { reads: reads + 1, writes };
  return { reads, writes: writes + 1 };
}

function simulateMatchSync() {
  let count = { reads: 0, writes: 0 };
  for (const action of [
    "read",
    "read",
    "read",
    "read",
    "write",
    "write",
    "write",
    "write",
    "write",
    "write",
    "write",
  ]) {
    count = operationCount(count, action);
  }
  return count;
}

function simulateConcurrentMemberMatches(memberCount) {
  let count = { reads: 0, writes: 0 };
  for (let member = 0; member < memberCount; member += 1) {
    count = operationCount(count, "read");
    count = operationCount(count, "read");
    count = operationCount(count, "write");
    count = operationCount(count, "write");
  }
  return count;
}

test("every canonical operation budget is documented", () => {
  for (const [name, budget] of Object.entries(budgets)) {
    assert.ok(Number.isInteger(budget.reads), `${name} reads`);
    assert.ok(Number.isInteger(budget.writes), `${name} writes`);
    assert.ok(budget.assumption.length >= 20, `${name} assumption`);
  }
});

test("active leaderboard and popup cache stay playlist scoped", () => {
  const popupTopN = Number(
    hudSource.match(/const RG_LB_TOP_N = (\d+);/)?.[1],
  );
  assert.equal(MAX_PLAYLIST_ROWS, 100);
  assert.equal(popupTopN, 100);
  assert.deepEqual(budgets.activeLeaderboardLoad, {
    reads: 112,
    writes: 0,
    assumption: "100 active-playlist rows plus at most 12 cached icon-key rows",
  });
  assert.equal(budgets.coldPopupCache.reads, popupTopN + 1);
  assert.deepEqual(
    { reads: budgets.warmPopupCache.reads, writes: budgets.warmPopupCache.writes },
    { reads: 0, writes: 0 },
  );
});

test("match sync and clan reopen stay inside their ceilings", () => {
  assert.deepEqual(simulateMatchSync(), {
    reads: budgets.matchSync.reads,
    writes: budgets.matchSync.writes,
  });
  assert.deepEqual(
    { reads: budgets.clanReopen.reads, writes: budgets.clanReopen.writes },
    { reads: 12, writes: 0 },
  );
  assert.match(hudSource, /fb\.getDoc\(fb\.doc\(fb\.db, "clan_memberships", uid\)\)/);
  assert.match(hudSource, /fb\.getDoc\(fb\.doc\(fb\.db, "clan_devices", deviceId\)\)/);
});

test("structural and concurrent match budgets cover the five-member maximum", () => {
  assert.deepEqual(
    { reads: budgets.structuralAction.reads, writes: budgets.structuralAction.writes },
    { reads: 10, writes: 12 },
  );
  assert.deepEqual(simulateConcurrentMemberMatches(5), {
    reads: budgets.concurrentMemberMatches.reads,
    writes: budgets.concurrentMemberMatches.writes,
  });
});
