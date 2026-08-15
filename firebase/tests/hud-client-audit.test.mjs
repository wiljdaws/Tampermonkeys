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
const advanceOpponentStreak = extractHudFunction("advanceOpponentStreak");
const streakSnipeMinimum = extractHudFunction("streakSnipeMinimum", {
  STREAK_SNIPE_MIN: 3,
});
const streakSnipeCandidates = extractHudFunction("streakSnipeCandidates", {
  RG_LB_MODES: [
    "Competitive1v1",
    "Competitive2v2",
    "Competitive3v3",
  ],
  STREAK_SNIPE_MIN: 3,
});
const nameForgePresetKey = extractHudFunction("nameForgePresetKey");
const stripClanTagPrefix = extractHudFunction("stripClanTagPrefix");

test("release metadata and debug logging stay synchronized", () => {
  const version = hudSource.match(/^\/\/ @version\s+(.+)$/m)?.[1].trim();
  const fallback = hudSource.match(
    /const SCRIPT_VERSION = [^\n]+\|\| "([^"]+)"/,
  )?.[1];
  assert.ok(version, "missing userscript version");
  assert.equal(version.replace(/-dev$/, ""), fallback);
  assert.equal(version, "19.9");
  assert.match(hudSource, /const RG_DEBUG = true;/);
});

test("deny logger attaches client-side reasons (19.5+)", () => {
  // describeDenyReasons must be defined and called from atlasSetDoc's
  // catch — otherwise deny records ship without the reason list and
  // the admin panel can't say "mode must be one of [...], got X".
  assert.match(hudSource, /function describeDenyReasons\(bucket, data, opts/);
  assert.match(hudSource, /reasons: describeDenyReasons\(label, data, \{ docId \}\)/);
  // Per-bucket helpers must be defined for the three write paths.
  assert.match(hudSource, /function describeLeaderboardReasons\(/);
  assert.match(hudSource, /function describeScriptSubmissionReasons\(/);
  assert.match(hudSource, /function describeMatchSnapshotReasons\(/);
});

test("HUD tells unlisted players to ask Pal or Jesus on Discord", () => {
  assert.match(hudSource, /https:\/\/discord\.gg\/MDz7hsrh9m/);
  assert.match(hudSource, /function showNotAllowlistedUI/);
  assert.match(hudSource, /isAllowlistGatedLabel/);
  assert.match(hudSource, /allowedUserIds/);
});

test("clan MMR sync skips Firestore when no event is active", () => {
  const source = hudFunctionSource("updateMyClanMMR");
  assert.match(source, /eventPhase\(\) !== "active"/);
  assert.match(source, /Clan MMR write skipped: no active event/);
  assert.match(source, /await loadEventConfig\(fb\)/);
  assert.doesNotMatch(
    source.slice(0, source.indexOf("Clan MMR write skipped")),
    /loadClanData\(true\)/,
  );
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
    writesPaused: false,
    updateRequired: true,
    notAllowlisted: false,
    isAllowlistGatedLabel: () => false,
    showUpdateRequiredUI,
    showNotAllowlistedUI: () => {},
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

test("Firestore diagnostics use rolling budgets without losing session totals", () => {
  assert.match(hudSource, /let firestoreReadCount = 0;/);
  assert.match(hudSource, /function logRead\(/);
  assert.match(hudSource, /FIRESTORE_READ_BUDGET/);
  assert.match(hudSource, /FIRESTORE_WRITE_BUDGET/);
  assert.match(hudSource, /FIRESTORE_BUDGET_WINDOW_MS/);
  assert.match(hudSource, /function nextFirestoreBudgetWindow\(/);
  assert.match(hudSource, /firestore:\s*\{[\s\S]*reads:\s*firestoreReadCount/);
  assert.match(hudSource, /writes:\s*firestoreWriteCount/);
  assert.match(hudSource, /windowReads:\s*firestoreBudgetWindow\.reads/);
  assert.match(hudSource, /windowWrites:\s*firestoreBudgetWindow\.writes/);

  const nextFirestoreBudgetWindow = extractHudFunction(
    "nextFirestoreBudgetWindow",
    { FIRESTORE_BUDGET_WINDOW_MS: 10 * 60 * 1000 },
  );
  const active = {
    startedAt: 1_000,
    reads: 120,
    writes: 40,
    readWarned: true,
    writeWarned: true,
  };
  assert.equal(nextFirestoreBudgetWindow(active, 2_000), active);
  assert.deepEqual(
    JSON.parse(JSON.stringify(nextFirestoreBudgetWindow(active, 601_000))),
    {
      startedAt: 601_000,
      reads: 0,
      writes: 0,
      readWarned: false,
      writeWarned: false,
    },
  );
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

test("settings keep the streak toggle and remove ranked popup controls", () => {
  const resetStart = hudSource.indexOf(
    'document.getElementById("rgSetReset").onclick',
  );
  const resetEnd = hudSource.indexOf(
    "// trim player data",
    resetStart,
  );
  const resetSource = hudSource.slice(resetStart, resetEnd);
  assert.match(resetSource, /applyTitle\(\)/);

  for (const id of [
    "rgSetPopupOpponents",
    "rgSetPopupTeammates",
    "rgSetPopupMaxRank",
    "rgSetPopupDuration",
    "rgSetPopupPosition",
  ]) {
    assert.doesNotMatch(hudSource, new RegExp(`id="${id}"`));
    assert.doesNotMatch(hudSource, new RegExp(`getElementById\\("${id}"\\)`));
  }

  assert.doesNotMatch(hudSource, /Ranked player popups/);
  assert.doesNotMatch(hudSource, /applyPopupPreferencesToOpenStack/);
  assert.match(hudSource, /id="rgSetStreakSnipe"/);
  assert.match(hudSource, /settings\.streakSnipeEnabled = setStreakSnipe\.checked/);
  assert.doesNotMatch(hudSource, /rgSetPreviewStreakSnipe|Preview streak snipe/i);
});

test("streak publication piggybacks the existing merged submission", () => {
  const submission = hudFunctionSource("submitToLeaderboardInner");
  assert.match(
    submission,
    /currentStreak:\s*streakData\?\.accountId === data\.Id/,
  );
  assert.match(
    submission,
    /currentStreak:\s*payload\.currentStreak/,
  );
  assert.match(
    submission,
    /atlasSetDoc\([\s\S]*"script_submissions"[\s\S]*\{\s*merge:\s*true\s*\}/,
  );
  assert.equal(
    (submission.match(/"script_submissions"/g) || []).length,
    1,
    "streak publication must not add another Firestore write",
  );
});

test("opponent streak inference accepts publication and safe deltas", () => {
  const published = advanceOpponentStreak(null, 10, 20, 7, 1000);
  assert.deepEqual(
    JSON.parse(JSON.stringify(published)),
    {
      streak: 7,
      confident: true,
      lastWins: 10,
      lastMatches: 20,
      updatedAt: 1000,
    },
  );

  const baseline = advanceOpponentStreak(null, 10, 20, null, 1000);
  assert.equal(baseline.confident, false);
  const inferred = advanceOpponentStreak(baseline, 12, 22, null, 2000);
  assert.equal(inferred.streak, 2);
  assert.equal(inferred.confident, true);
});

test("streak snipe threshold is clamped without a match-end config read", () => {
  assert.equal(streakSnipeMinimum(undefined), 3);
  assert.equal(streakSnipeMinimum({ streakSnipeMin: -8 }), 1);
  assert.equal(streakSnipeMinimum({ streakSnipeMin: 999 }), 100);

  const maybeSource = hudFunctionSource("maybeShowStreakSnipe");
  assert.match(maybeSource, /config = _remoteConfigMemo/);
  assert.match(maybeSource, /settings\.streakSnipeEnabled === false/);
  assert.doesNotMatch(maybeSource, /getRemoteConfig\(/);

  const matchEndSource = hudSource.slice(
    hudSource.indexOf('if (url.includes("/v0304_player/matchEnd"))'),
    hudSource.indexOf('} else if (url.includes("/v0304_login/login"))'),
  );
  const triggerStart = matchEndSource.indexOf("maybeShowStreakSnipe(");
  const triggerEnd = matchEndSource.indexOf(");", triggerStart);
  assert.notEqual(triggerStart, -1);
  assert.doesNotMatch(
    matchEndSource.slice(triggerStart, triggerEnd + 2),
    /getRemoteConfig\(/,
  );
});

test("streak snipe selects the strongest tracked opponent after a win", () => {
  const candidates = streakSnipeCandidates(
    { Competitive1v1: 1200 },
    { Competitive1v1: 1212 },
    [
      { name: "Three", streak: 3, confident: true, isTeammate: false },
      { name: "Eight", streak: 8, confident: true, isTeammate: false },
      { name: "Teammate", streak: 20, confident: true, isTeammate: true },
      { name: "Guess", streak: 30, confident: false, isTeammate: false },
    ],
    3,
  );
  assert.deepEqual(
    Array.from(candidates, candidate => candidate.name),
    ["Eight", "Three"],
  );
  assert.equal(
    streakSnipeCandidates(
      { Competitive1v1: 1200 },
      { Competitive1v1: 1190 },
      [{ streak: 8, confident: true, isTeammate: false }],
      3,
    ).length,
    0,
  );
});

test("ranked popups keep fixed defaults and show opponent streak badges", () => {
  assert.match(
    hudSource,
    /const RANKED_POPUP_PREFERENCES = Object\.freeze\(/,
  );
  assert.match(
    hudFunctionSource("showLbOpponentPopup"),
    /preferences \|\| RANKED_POPUP_PREFERENCES/,
  );
  for (const name of [
    "fireAllRankedPopups",
    "firePostmortemPopupsIfDeferred",
  ]) {
    assert.match(
      hudFunctionSource(name),
      /normalizePopupPreferences\(RANKED_POPUP_PREFERENCES\)/,
    );
  }
  assert.match(hudSource, /class="rg-lb-streak"/);
  assert.match(hudSource, /_matchOpponentStreaks\.set\(/);
});

test("streak snipe uses the selected precision timing and safe text nodes", () => {
  const styles = hudSource.slice(
    hudSource.indexOf("function ensureStreakSnipeStyles()"),
    hudSource.indexOf("function showStreakSnipeOverlay("),
  );
  assert.match(styles, /rgSnipeOverlay 7\.2s/);
  assert.match(styles, /0%, 29%[\s\S]*31%/);
  assert.match(styles, /45%, 96\.5% \{ opacity: 1/);
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: 4\.8s/,
  );

  const overlay = hudFunctionSource("showStreakSnipeOverlay");
  assert.match(overlay, /title\.textContent/);
  assert.match(overlay, /value\.textContent/);
  assert.match(overlay, /prefersReducedPopupMotion\(\) \? 4850 : 7250/);
  assert.doesNotMatch(overlay, /\.innerHTML\s*=/);
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
