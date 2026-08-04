import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const hudSource = await readFile(
  new URL("../rg_hud_dev.user.js", import.meta.url),
  "utf8",
);

function extractHudFunction(name, context = {}) {
  const asyncStart = hudSource.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0
    ? asyncStart
    : hudSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const signatureStart = hudSource.indexOf("(", start);
  let signatureDepth = 0;
  let signatureEnd = -1;
  for (let index = signatureStart; index < hudSource.length; index += 1) {
    if (hudSource[index] === "(") signatureDepth += 1;
    if (hudSource[index] === ")") signatureDepth -= 1;
    if (signatureDepth === 0) {
      signatureEnd = index;
      break;
    }
  }
  const bodyStart = hudSource.indexOf("{", signatureEnd);
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
  assert.notEqual(start, -1, `missing ${name}`);
  const signatureStart = hudSource.indexOf("(", start);
  let signatureDepth = 0;
  let signatureEnd = -1;
  for (let index = signatureStart; index < hudSource.length; index += 1) {
    if (hudSource[index] === "(") signatureDepth += 1;
    if (hudSource[index] === ")") signatureDepth -= 1;
    if (signatureDepth === 0) {
      signatureEnd = index;
      break;
    }
  }
  const bodyStart = hudSource.indexOf("{", signatureEnd);
  let depth = 0;
  for (let index = bodyStart; index < hudSource.length; index += 1) {
    if (hudSource[index] === "{") depth += 1;
    if (hudSource[index] === "}") depth -= 1;
    if (depth === 0) return hudSource.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

test("dev metadata stays on the dev update channel", () => {
  assert.match(hudSource, /^\/\/ @version\s+16\.9-dev$/m);
  assert.match(hudSource, /refs\/heads\/dev\/rg_hud_dev\.user\.js/);
});

test("dev keeps reservation-backed clan loading", () => {
  const source = hudFunctionSource("loadClanData");
  assert.match(source, /clan_memberships/);
  assert.match(source, /clan_devices/);
  assert.match(source, /clans_directory/);
});

test("ranked popup controls are removed from settings", () => {
  assert.doesNotMatch(hudSource, /Ranked player popups/i);
  assert.doesNotMatch(hudSource, /id="rgSetPopup/);
  assert.match(hudSource, /const RANKED_POPUP_PREFERENCES = Object\.freeze/);
});

test("opponent streaks baseline, extend, reset, and accept published values", () => {
  const advanceOpponentStreak = extractHudFunction("advanceOpponentStreak");
  const baseline = advanceOpponentStreak(null, 10, 20, null, 1_000);
  assert.deepEqual(JSON.parse(JSON.stringify(baseline)), {
    streak: 0,
    confident: false,
    lastWins: 10,
    lastMatches: 20,
    updatedAt: 1_000,
  });

  const fourWins = advanceOpponentStreak(baseline, 14, 24, null, 2_000);
  assert.equal(fourWins.streak, 4);
  assert.equal(fourWins.confident, true);
  assert.equal(
    advanceOpponentStreak(fourWins, 16, 26, null, 3_000).streak,
    6,
  );
  assert.equal(
    advanceOpponentStreak(fourWins, 14, 25, null, 3_000).streak,
    -1,
  );
  assert.equal(
    advanceOpponentStreak(null, 50, 80, 8, 4_000).streak,
    8,
  );
});

test("opponent streak reads trust current dev data and ignore stale merged fields", async () => {
  const advanceOpponentStreak = extractHudFunction("advanceOpponentStreak");
  const submissionTotals = extractHudFunction("submissionTotals");
  const opponentStreakCache = {
    old: {
      streak: 2,
      confident: true,
      lastWins: 10,
      lastMatches: 20,
      updatedAt: 1,
    },
    failed: {
      streak: 20,
      confident: true,
      lastWins: 40,
      lastMatches: 50,
      updatedAt: 1,
    },
  };
  const docs = {
    fresh: {
      versionNum: 16.4,
      currentStreak: 7,
      stats: {
        Competitive2v2: { wins: 30, matchesPlayed: 50 },
      },
    },
    old: {
      versionNum: 16.2,
      currentStreak: 99,
      stats: {
        Competitive2v2: { wins: 12, matchesPlayed: 22 },
      },
    },
  };
  const reads = [];
  const fb = {
    db: {},
    doc: (_db, collection, uid) => ({ collection, uid }),
    getDoc: async (reference) => {
      reads.push(reference);
      if (reference.uid === "failed") throw new Error("offline");
      return {
        exists: () => Boolean(docs[reference.uid]),
        data: () => docs[reference.uid],
      };
    },
  };
  const resolveOpponentStreak = extractHudFunction("resolveOpponentStreak", {
    initFirebase: async () => fb,
    LEADERBOARD_COLLECTION: "script_submissions",
    submissionTotals,
    advanceOpponentStreak,
    opponentStreakCache,
    saveOpponentStreakCache: () => {},
    dbg: () => {},
  });

  assert.equal((await resolveOpponentStreak("fresh")).streak, 7);
  assert.equal((await resolveOpponentStreak("old")).streak, 4);
  assert.equal((await resolveOpponentStreak("failed")).confident, false);
  assert.deepEqual(reads, [
    { collection: "script_submissions", uid: "fresh" },
    { collection: "script_submissions", uid: "old" },
    { collection: "script_submissions", uid: "failed" },
  ]);
});

test("only a ranked win can produce streak-snipe candidates", () => {
  const streakSnipeCandidates = extractHudFunction(
    "streakSnipeCandidates",
    {
      RG_LB_MODES: [
        "Competitive1v1",
        "Competitive2v2",
        "Competitive3v3",
      ],
      STREAK_SNIPE_MIN: 3,
    },
  );
  const opponents = [
    { uid: "a", name: "Five", streak: 5, confident: true, isTeammate: false },
    { uid: "b", name: "Two", streak: 2, confident: true, isTeammate: false },
    { uid: "c", name: "Mate", streak: 9, confident: true, isTeammate: true },
  ];
  const before = {
    Competitive1v1: 1000,
    Competitive2v2: 2000,
    Competitive3v3: 3000,
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(streakSnipeCandidates(
      before,
      { ...before, Competitive2v2: 2010 },
      opponents,
    ))),
    [opponents[0]],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(streakSnipeCandidates(
      before,
      { ...before, Competitive2v2: 1990 },
      opponents,
    ))),
    [],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(streakSnipeCandidates(
      before,
      { ...before, Competitive2v2: 2010, Competitive3v3: 3010 },
      opponents,
    ))),
    [],
  );
});

test("remote config controls the streak-snipe threshold safely", () => {
  const streakSnipeMinimum = extractHudFunction("streakSnipeMinimum", {
    STREAK_SNIPE_MIN: 3,
  });
  assert.equal(streakSnipeMinimum({ streakSnipeMin: 8 }), 8);
  assert.equal(streakSnipeMinimum({ streakSnipeMin: 0 }), 1);
  assert.equal(streakSnipeMinimum({ streakSnipeMin: 500 }), 100);
  assert.equal(streakSnipeMinimum({ streakSnipeMin: "nope" }), 3);
  const maybeShowSource = hudFunctionSource("maybeShowStreakSnipe");
  assert.match(maybeShowSource, /streakSnipeMinimum\(config\)/);
  assert.doesNotMatch(maybeShowSource, /getRemoteConfig/);
});

test("dev settings preview the streak snipe without Firebase traffic", () => {
  assert.match(hudSource, /id="rgSetPreviewStreakSnipe"/);
  const start = hudSource.indexOf(
    'document.getElementById("rgSetPreviewStreakSnipe").onclick',
  );
  assert.notEqual(start, -1);
  const end = hudSource.indexOf("\n        };", start);
  assert.notEqual(end, -1);
  const handler = hudSource.slice(start, end);
  assert.match(handler, /showStreakSnipeOverlay/);
  assert.match(handler, /Preview Opponent/);
  assert.doesNotMatch(handler, /(?:getRemoteConfig|initFirebase|getDoc|setDoc)/);
});

test("automatic streak snipe can be turned off locally", () => {
  assert.match(hudSource, /streakSnipeEnabled:\s*true/);
  assert.match(hudSource, /id="rgSetStreakSnipe"/);
  assert.match(hudSource, /setStreakSnipe\.checked = settings\.streakSnipeEnabled !== false/);
  assert.match(hudSource, /settings\.streakSnipeEnabled = setStreakSnipe\.checked/);
  assert.match(
    hudFunctionSource("maybeShowStreakSnipe"),
    /settings\.streakSnipeEnabled === false\) return null/,
  );
});

test("ranked opponent popup shows a streak but teammate popup does not", () => {
  let stack = null;
  class FakeElement {
    constructor() {
      this.children = [];
      this.dataset = {};
      this.innerHTML = "";
      this.id = "";
      this.style = {
        setProperty: () => {},
      };
      this.classList = {
        add: () => {},
        remove: () => {},
      };
    }

    appendChild(child) {
      this.children.push(child);
      return child;
    }

    remove() {}
  }
  const document = {
    body: {
      appendChild(element) {
        if (element.id === "rgLbPopupStack") stack = element;
      },
    },
    createElement: () => new FakeElement(),
    getElementById: (id) => id === "rgLbPopupStack" ? stack : null,
  };
  const showLbOpponentPopup = extractHudFunction("showLbOpponentPopup", {
    RG_LB_DEFAULT_CONFIG: {
      popupEnabled: true,
      minRankToShow: 100,
      popupDurationMs: 6000,
    },
    RANKED_POPUP_PREFERENCES: {},
    normalizePopupPreferences: () => ({
      showOpponents: true,
      showTeammates: true,
      maxRank: 100,
      durationMs: 0,
      position: "top-right",
    }),
    rankedPopupAllowed: () => true,
    ensureLbPopupStyles: () => {},
    rankedPopupDuration: () => 6000,
    popupStackPositionStyle: () => ({}),
    tierColorForRank: () => "#ffd700",
    escapeHtml: (value) => String(value),
    modeLabel: () => "Competitive 2v2",
    prefersReducedPopupMotion: () => false,
    requestAnimationFrame: (callback) => callback(),
    setTimeout: () => {},
    document,
    dbg: () => {},
  });

  showLbOpponentPopup({
    rank: 4,
    name: "Opponent",
    mode: "Competitive2v2",
    isTeammate: false,
    winStreak: 7,
  });
  assert.match(stack.children[0].innerHTML, /🔥 7 win streak/);

  showLbOpponentPopup({
    rank: 5,
    name: "Teammate",
    mode: "Competitive2v2",
    isTeammate: true,
    winStreak: 12,
  });
  assert.doesNotMatch(stack.children[1].innerHTML, /win streak/);
});

test("dev publishes and renders streak data without a separate write", () => {
  const streakReadSource = hudFunctionSource("resolveOpponentStreak");
  assert.equal((streakReadSource.match(/\.getDoc\(/g) || []).length, 1);
  assert.doesNotMatch(streakReadSource, /\b(?:setDoc|atlasSetDoc)\(/);
  assert.match(hudFunctionSource("submitToLeaderboardInner"), /currentStreak/);
  assert.match(hudFunctionSource("showLbOpponentPopup"), /winStreak/);
  assert.match(hudFunctionSource("fireAllRankedPopups"), /resolveOpponentStreak/);
  assert.match(hudFunctionSource("maybeShowStreakSnipe"), /showStreakSnipeOverlay/);
});

test("streak snipe uses the scoped shot and readable precision finish", () => {
  const styles = hudFunctionSource("ensureStreakSnipeStyles");
  const overlay = hudFunctionSource("showStreakSnipeOverlay");
  assert.match(styles, /rg-snipe-lens/);
  assert.match(styles, /rg-snipe-hit/);
  assert.match(styles, /rg-snipe-finish-ring/);
  assert.match(styles, /0%, 29% \{ opacity: 0; transform: scale\(\.35\); \}/);
  assert.match(styles, /45%, 96\.5%/);
  assert.doesNotMatch(styles, /rg-snipe-spark/);
  assert.match(overlay, /You sniped/);
  assert.match(overlay, /7250/);
});
