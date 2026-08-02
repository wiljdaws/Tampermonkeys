import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { JSDOM } from "jsdom";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(testDirectory, "..");
const hudScriptPath = process.env.HUD_SCRIPT
  ? path.resolve(process.env.HUD_SCRIPT)
  : path.resolve(workspace, "../rg_hud.user.js");
const hudSource = await readFile(hudScriptPath, "utf8");

function extractHudFunction(name, context = {}) {
  const asyncStart = hudSource.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0
    ? asyncStart
    : hudSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name} in HUD`);
  const bodyStart = hudSource.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < hudSource.length; index += 1) {
    if (hudSource[index] === "{") depth += 1;
    if (hudSource[index] === "}") depth -= 1;
    if (depth === 0) {
      return vm.runInNewContext(
        `(${hudSource.slice(start, index + 1)})`,
        context,
      );
    }
  }
  throw new Error(`unterminated ${name}`);
}

function hudFunctionSource(name) {
  const asyncStart = hudSource.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0
    ? asyncStart
    : hudSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name} in HUD`);
  const signatureEnd = hudSource.indexOf(") {", start);
  assert.notEqual(signatureEnd, -1, `missing ${name} body in HUD`);
  const bodyStart = signatureEnd + 2;
  let depth = 0;
  for (let index = bodyStart; index < hudSource.length; index += 1) {
    if (hudSource[index] === "{") depth += 1;
    if (hudSource[index] === "}") depth -= 1;
    if (depth === 0) return hudSource.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const redactSupportText = extractHudFunction("redactSupportText");
const normalizePopupPreferences = extractHudFunction(
  "normalizePopupPreferences",
);
const rankedPopupAllowed = extractHudFunction("rankedPopupAllowed", {
  normalizePopupPreferences,
});
const popupStackPositionStyle = extractHudFunction(
  "popupStackPositionStyle",
  { normalizePopupPreferences },
);
const nameForgePresetKey = extractHudFunction("nameForgePresetKey");
const stripClanTagPrefix = extractHudFunction("stripClanTagPrefix");

test("release metadata and debug logging stay synchronized", () => {
  const version = hudSource.match(/^\/\/ @version\s+(.+)$/m)?.[1].trim();
  const fallback = hudSource.match(
    /const SCRIPT_VERSION = [^\n]+\|\| "([^"]+)"/,
  )?.[1];
  assert.ok(version, "missing userscript version");
  assert.equal(version.replace(/-dev$/, ""), fallback);
  assert.equal(version, "16.1");
  assert.match(hudSource, /const RG_DEBUG = true;/);
});

test("every client mutation path uses the central version gate", () => {
  const mutationPaths = [
    "submitToLeaderboardInner",
    "upsertPlaylistEntry",
    "updateMyClanMMR",
    "maybeCaptureEventBaseline",
    "linkCurrentClanDevice",
    "refreshDirectory",
    "saveClanTagStyle",
    "createClan",
    "requestJoin",
    "approveRequest",
    "kickMember",
    "writeClanNotice",
    "checkClanNotices",
    "setMemberRole",
    "editClan",
    "transferLeadership",
    "leaveClan",
  ];
  for (const name of mutationPaths) {
    assert.match(
      hudFunctionSource(name),
      /\b(?:atlasSetDoc|atlasDeleteDoc|runAtlasTransaction)\s*\(/,
      `${name} bypasses the centralized mutation gate`,
    );
  }

  const gate = hudFunctionSource("atlasMutationAllowed");
  assert.match(gate, /isUpdateRequired\(fb\)/);
  assert.match(gate, /showUpdateRequiredUI\(\)/);
});

test("every clan write carries the forced-upgrade version", () => {
  const atlasStampedMutationData = extractHudFunction(
    "atlasStampedMutationData",
    {
      SCRIPT_VERSION: "16.1",
      SCRIPT_VERSION_NUM: 16.1,
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(atlasStampedMutationData(
      { path: "clans/clan-one" },
      { totalMMR: 1234 },
    ))),
    {
      totalMMR: 1234,
      scriptVersion: "16.1",
      versionNum: 16.1,
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(atlasStampedMutationData(
      { path: "clans_directory/clan-one" },
      { totalMMR: 1234 },
    ))),
    { totalMMR: 1234 },
  );
});

test("outdated clients see one update UI while reads stay available", async () => {
  let updateUiCount = 0;
  const uiContext = {
    updateRequiredUiShown: false,
    showBanner: () => { updateUiCount += 1; },
  };
  const showUpdateRequiredUI = extractHudFunction(
    "showUpdateRequiredUI",
    uiContext,
  );
  showUpdateRequiredUI();
  showUpdateRequiredUI();
  assert.equal(updateUiCount, 1);

  const atlasMutationAllowed = extractHudFunction("atlasMutationAllowed", {
    isUpdateRequired: async () => true,
    showUpdateRequiredUI,
    dbg: () => {},
  });
  assert.equal(await atlasMutationAllowed({}, "test write"), false);

  for (const readName of [
    "loadEventConfig",
    "loadClanRolePerms",
    "loadClanData",
    "fetchLeaderboardCache",
  ]) {
    assert.doesNotMatch(
      hudFunctionSource(readName),
      /atlasMutationAllowed\(/,
      `${readName} blocks a read`,
    );
  }
});

test("Firestore diagnostics count reads and writes with budgets", () => {
  assert.match(hudSource, /let firestoreReadCount = 0;/);
  assert.match(hudSource, /function logRead\(/);
  assert.match(hudSource, /FIRESTORE_READ_BUDGET/);
  assert.match(hudSource, /FIRESTORE_WRITE_BUDGET/);
  assert.match(hudSource, /firestore:\s*\{[\s\S]*reads:\s*firestoreReadCount/);
  assert.match(hudSource, /writes:\s*firestoreWriteCount/);
});

test("denied match audits stay disabled", () => {
  const source = hudFunctionSource("writeMatchAudit");
  assert.match(source, /disabled/i);
  assert.doesNotMatch(source, /\.(?:addDoc|setDoc|runTransaction)\s*\(/);
  assert.doesNotMatch(hudSource, /["']match_audits["']\),\s*audit/);
});

test("sourced leaderboard writes use deterministic ids only", () => {
  const source = hudFunctionSource("upsertPlaylistEntry");
  assert.match(
    source,
    /fb\.doc\(fb\.db,\s*REAL_LEADERBOARD_COLLECTION,\s*deterministicId\)/,
  );
  assert.doesNotMatch(source, /fb\.(?:query|getDocs|addDoc)\s*\(/);
  assert.doesNotMatch(source, /\.deleteDoc\s*\(/);
});

test("support bundle redacts stable identifiers and full user agents", () => {
  const deviceId = "device-123456789";
  const userAgent = "Example Browser/123.4";
  const playerId = "player-secret-id";
  const safe = redactSupportText(
    `device=${deviceId}\nua=${userAgent}\nplayer=${playerId}`,
    [deviceId, userAgent, playerId],
  );
  assert.doesNotMatch(safe, /device-123456789|Example Browser|player-secret-id/);
  assert.equal((safe.match(/\[redacted\]/g) || []).length, 3);

  const debugStart = hudSource.indexOf(
    'document.getElementById("rgSetCopyDebug").onclick',
  );
  const debugEnd = hudSource.indexOf(
    "// handler early-returns",
    debugStart,
  );
  const debugSource = hudSource.slice(debugStart, debugEnd);
  assert.match(debugSource, /hudExists: !!q\("rgHUD"\)/);
  assert.doesNotMatch(debugSource, /deviceId:\s*getDeviceId\(\)/);
  assert.doesNotMatch(debugSource, /userAgent:\s*/);
  assert.match(debugSource, /redactSupportText\(text, redactions\)/);
});

test("settings reset refreshes title and every popup setting is wired", () => {
  const resetStart = hudSource.indexOf(
    'document.getElementById("rgSetReset").onclick',
  );
  const resetEnd = hudSource.indexOf(
    "// trim player data",
    resetStart,
  );
  const resetSource = hudSource.slice(resetStart, resetEnd);
  assert.match(resetSource, /applyTitle\(\)/);
  assert.match(resetSource, /applyPopupPreferencesToOpenStack\(\)/);

  for (const id of [
    "rgSetPopupOpponents",
    "rgSetPopupTeammates",
    "rgSetPopupMaxRank",
    "rgSetPopupDuration",
    "rgSetPopupPosition",
  ]) {
    assert.match(hudSource, new RegExp(`id="${id}"`));
    assert.match(hudSource, new RegExp(`getElementById\\("${id}"\\)`));
  }
});

test("account switches clear every rank cache", () => {
  const context = {
    cachedRanks: new Map([["1v1", 1]]),
    cachedMmrToNext: new Map([["1v1", 10]]),
    prevRanks: new Map([["1v1", 2]]),
    lastRankedMMR: new Map([["1v1", 2200]]),
    ranksFetchedThisSession: true,
  };
  const resetAccountRankState = extractHudFunction(
    "resetAccountRankState",
    context,
  );
  resetAccountRankState();
  assert.equal(context.cachedRanks.size, 0);
  assert.equal(context.cachedMmrToNext.size, 0);
  assert.equal(context.prevRanks.size, 0);
  assert.equal(context.lastRankedMMR.size, 0);
  assert.equal(context.ranksFetchedThisSession, false);

  const sessionStart = hudSource.indexOf("function captureSessionStart(data)");
  const deltaStart = hudSource.indexOf("function deltaBadge(", sessionStart);
  assert.match(
    hudSource.slice(sessionStart, deltaStart),
    /resetAccountRankState\(\)/,
  );
});

test("kick and disband notices delete only after acknowledgement", async () => {
  const events = [];
  let acknowledge;
  const fb = {
    db: {},
    doc: (_db, collectionName, id) => `${collectionName}/${id}`,
    getDoc: async () => ({
      exists: () => true,
      data: () => ({
        type: "kicked",
        clanName: "Test Clan",
        message: "Event rule",
      }),
    }),
    deleteDoc: async (ref) => events.push(["delete", ref]),
  };
  const checkClanNotices = extractHudFunction("checkClanNotices", {
    initFirebase: async () => fb,
    myUserId: () => "player-one",
    showDialog: async () => new Promise((resolve) => {
      acknowledge = () => {
        events.push(["ack"]);
        resolve(true);
      };
    }),
    atlasDeleteDoc: async (_fb, _label, ref) => fb.deleteDoc(ref),
    dbg: () => {},
    dbgWarn: () => {},
  });

  const pending = checkClanNotices();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);
  acknowledge();
  await pending;
  assert.deepEqual(events, [
    ["ack"],
    ["delete", "clan_notices/player-one"],
  ]);

  const listenerStart = hudSource.indexOf("async function attachClanListener()");
  const listenerEnd = hudSource.indexOf(
    "function detachClanListener()",
    listenerStart,
  );
  assert.match(
    hudSource.slice(listenerStart, listenerEnd),
    /scheduleClanNoticeCheck\(500\)/,
  );
});

test("HUD dragging keeps unrelated document mouse handlers", () => {
  const dom = new JSDOM(
    '<div id="hud"><div id="handle"></div></div>',
    { url: "https://rocketgoal.io/" },
  );
  const { document } = dom.window;
  const hud = document.getElementById("hud");
  const handle = document.getElementById("handle");
  for (const [key, value] of [
    ["offsetTop", 40],
    ["offsetLeft", 40],
    ["offsetWidth", 300],
  ]) {
    Object.defineProperty(hud, key, { configurable: true, value });
  }

  let propertyHandlerCalls = 0;
  let listenerCalls = 0;
  document.onmousemove = () => { propertyHandlerCalls += 1; };
  document.addEventListener("mousemove", () => { listenerCalls += 1; });
  const dragElement = extractHudFunction("dragElement", {
    document,
    window: dom.window,
    localStorage: dom.window.localStorage,
    dbg: () => {},
  });
  dragElement(hud, handle);

  handle.dispatchEvent(new dom.window.MouseEvent("mousedown", {
    bubbles: true,
    clientX: 100,
    clientY: 100,
  }));
  document.dispatchEvent(new dom.window.MouseEvent("mousemove", {
    bubbles: true,
    clientX: 90,
    clientY: 90,
  }));
  document.dispatchEvent(new dom.window.MouseEvent("mouseup", {
    bubbles: true,
  }));

  assert.equal(propertyHandlerCalls, 1);
  assert.equal(listenerCalls, 1);
  assert.equal(typeof document.onmousemove, "function");
});

test("popup preferences cover roles, safe corners, and reduced motion", () => {
  assert.equal(
    rankedPopupAllowed(
      1,
      false,
      { popupEnabled: true, minRankToShow: 100 },
      { popupShowOpponents: false, popupShowTeammates: true },
    ),
    false,
  );
  assert.equal(
    rankedPopupAllowed(
      1,
      null,
      { popupEnabled: true, minRankToShow: 100 },
      { popupShowOpponents: false, popupShowTeammates: true },
    ),
    true,
  );
  assert.deepEqual(
    { ...popupStackPositionStyle("top-left") },
    {
      top: "20px",
      bottom: "auto",
      left: "20px",
      right: "auto",
      flexDirection: "column",
    },
  );
  assert.match(
    hudSource,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/,
  );
});

test("Name Forge presets and clan-tag cleanup are account safe", () => {
  assert.equal(
    nameForgePresetKey("player-one"),
    "rgNameForge.presets.v2.player-one",
  );
  assert.notEqual(
    nameForgePresetKey("player-one"),
    nameForgePresetKey("player-two"),
  );
  assert.equal(stripClanTagPrefix("[KING] Player", "KING"), "Player");
  assert.equal(
    stripClanTagPrefix(
      "<color=#fff>[<b>K</b>I<color=#0ff>N</color>G]</color> Player",
      "KING",
    ),
    "Player",
  );
  assert.equal(
    stripClanTagPrefix("[OTHER] Player", "KING"),
    "[OTHER] Player",
  );
});
