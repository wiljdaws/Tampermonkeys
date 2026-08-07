import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  after,
  before,
  beforeEach,
  test,
} from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  where,
} from "firebase/firestore";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(testDirectory, "..");
const rulesPath = process.env.ATLAS_RULES_PATH;
if (!rulesPath) {
  console.log("Skipping leaderboard-popup: ATLAS_RULES_PATH not set");
  process.exit(0);
}
const rules = await readFile(path.resolve(rulesPath), "utf8");
const hudScriptPath = process.env.HUD_SCRIPT
  ? path.resolve(process.env.HUD_SCRIPT)
  : path.resolve(workspace, "../rg_hud.user.js");
const hudSource = await readFile(
  hudScriptPath,
  "utf8",
);

function extractHudFunction(name, context = {}) {
  const start = hudSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name} in dev HUD`);
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

const parseRosterInitLine = extractHudFunction("parseRosterInitLine");
const derivedFormatFromPlayerCount = extractHudFunction(
  "derivedFormatFromPlayerCount",
);
const trustedTeamContext = extractHudFunction("trustedTeamContext");
const lookupInCache = extractHudFunction("lookupInCache");
const medianPingSample = extractHudFunction("medianPingSample");
const normalizePopupPreferences = extractHudFunction(
  "normalizePopupPreferences",
);
const rankedPopupAllowed = extractHudFunction("rankedPopupAllowed", {
  normalizePopupPreferences,
});
const rankedPopupDuration = extractHudFunction("rankedPopupDuration", {
  normalizePopupPreferences,
});
const popupStackPositionStyle = extractHudFunction(
  "popupStackPositionStyle",
  { normalizePopupPreferences },
);
const leaderboardCacheKey = extractHudFunction("leaderboardCacheKey", {
  RG_LB_CACHE_KEY_PREFIX: "rgHudLbCache_v2",
});

const modes = [
  "Competitive1v1",
  "Competitive2v2",
  "Competitive3v3",
];
const modeToPlaylist = {
  Competitive1v1: "1v1",
  Competitive2v2: "2v2",
  Competitive3v3: "3v3",
};

let environment;

before(async () => {
  environment = await initializeTestEnvironment({
    projectId: "demo-rgleaderboard",
    firestore: { rules },
  });
});

after(async () => {
  await environment.cleanup();
});

beforeEach(async () => {
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const entries = [
      ["one-top", "one-top", "1v1", "One Top", 2200],
      ["one-second", "one-second", "1v1", "One Second", 2100],
      ["tm-two", "tm-two", "2v2", "Two Teammate", 2300],
      ["opp-two-a", "opp-two-a", "2v2", "Two Opponent A", 2200],
      ["opp-two-b", "opp-two-b", "2v2", "Two Opponent B", 2100],
      ["tm-three-a", "tm-three-a", "3v3", "Three Teammate A", 2400],
      ["tm-three-b", "tm-three-b", "3v3", "Three Teammate B", 2350],
      ["opp-three-a", "opp-three-a", "3v3", "Three Opponent A", 2300],
      ["opp-three-b", "opp-three-b", "3v3", "Three Opponent B", 2250],
      ["opp-three-c", "opp-three-c", "3v3", "Three Opponent C", 2200],
    ];
    await Promise.all(entries.map(([id, sourceUserId, playlist, name, mmr]) =>
      setDoc(doc(db, "leaderboard", id), {
        sourceUserId,
        playlist,
        name,
        mmr,
      })
    ));
    await setDoc(doc(db, "atlas_config", "hud"), {
      popupEnabled: true,
      minRankToShow: 100,
      popupDurationMs: 6000,
    });
  });
});

function publicDb() {
  return environment.unauthenticatedContext("popup-reader").firestore();
}

async function fetchLeaderboardCache(db) {
  const cache = { modes: {}, fetchedAt: Date.now() };
  for (const mode of modes) {
    const snapshot = await getDocs(query(
      collection(db, "leaderboard"),
      where("playlist", "==", modeToPlaylist[mode]),
      orderBy("mmr", "desc"),
      limit(100),
    ));
    cache.modes[mode] = snapshot.docs.map((entry, index) => ({
      uid: entry.data().sourceUserId,
      name: entry.data().name,
      mmr: entry.data().mmr,
      rank: index + 1,
    }));
  }
  return cache;
}

async function fetchPopupConfig(db) {
  return (await getDoc(doc(db, "atlas_config", "hud"))).data();
}

function initLine(name, uid, team, extra = "") {
  const suffix = [
    extra,
    `UserId: ${uid}`,
    team ? `Team: ${team}` : "",
  ].filter(Boolean).join(", ");
  return `[PlayerDataManager] Initialized stats for player: ${name} (${suffix})`;
}

class PopupReplay {
  constructor({ selfUid, cache, config, preferences = {} }) {
    this.selfUid = selfUid;
    this.cache = cache;
    this.config = config;
    this.preferences = preferences;
    this.reset();
  }

  reset() {
    this.playerCount = 0;
    this.mode = null;
    this.roster = [];
    this.shown = new Set();
    this.deferred = false;
    this.fired = false;
    this.popups = [];
  }

  setSelfUid(uid) {
    this.selfUid = uid;
    this.maybeFire();
  }

  replay(line) {
    const countMatch = line.match(/Starting game with\s+(\d+)\s+players/);
    if (countMatch) {
      this.playerCount = Number(countMatch[1]);
      this.mode = derivedFormatFromPlayerCount(this.playerCount);
      if (this.mode) {
        this.deferred = false;
        this.maybeFire();
      }
    }

    if (line.includes("Initialized stats for player")) {
      const parsed = parseRosterInitLine(line);
      if (!parsed?.name || !parsed.uid) return;
      const existing = this.roster.find((player) => player.uid === parsed.uid);
      if (existing) {
        if (parsed.name) existing.name = parsed.name;
        if (parsed.team) existing.team = parsed.team;
      } else {
        this.roster.push(parsed);
      }
      if (!this.mode) {
        this.deferred = true;
        return;
      }
      this.maybeFire();
    }
  }

  maybeFire(force = false) {
    if (this.fired || !this.selfUid || !this.mode || !this.roster.length) return;
    if (force || (this.playerCount && this.roster.length >= this.playerCount)) {
      this.fire(this.mode, this.playerCount);
    }
  }

  fire(mode, expectedPlayerCount, alreadyShown = this.shown) {
    this.fired = true;
    if (!this.cache) return;
    const { teamsBalanced, selfTeam } = trustedTeamContext(
      this.roster,
      this.selfUid,
      expectedPlayerCount,
    );
    for (const player of this.roster) {
      if (player.uid === this.selfUid || alreadyShown.has(player.uid)) continue;
      const hit = lookupInCache(this.cache, player.uid, mode);
      if (!hit) continue;
      const isTeammate = teamsBalanced && selfTeam && player.team
        ? player.team === selfTeam
        : null;
      if (!rankedPopupAllowed(
        hit.rank,
        isTeammate,
        this.config,
        this.preferences,
      )) continue;
      alreadyShown.add(player.uid);
      this.popups.push({
        uid: player.uid,
        name: hit.name || player.name,
        rank: hit.rank,
        mode,
        isTeammate,
      });
    }
  }

  flushQuietTimer() {
    this.maybeFire(true);
  }

  matchEnd(changedRankedModes) {
    if (this.deferred && changedRankedModes.length === 1 && this.selfUid) {
      this.fire(
        changedRankedModes[0],
        this.roster.length,
        new Set(this.shown),
      );
    }
    const emitted = this.popups.slice();
    this.reset();
    return emitted;
  }
}

async function createReplay(overrides = {}) {
  const db = publicDb();
  return new PopupReplay({
    selfUid: "self",
    cache: await fetchLeaderboardCache(db),
    config: await fetchPopupConfig(db),
    ...overrides,
  });
}

test("Firestore cache is ranked independently for every playlist", async () => {
  const cache = await fetchLeaderboardCache(publicDb());
  assert.deepEqual(
    cache.modes.Competitive1v1.map((entry) => [entry.uid, entry.rank]),
    [["one-top", 1], ["one-second", 2]],
  );
  assert.equal(cache.modes.Competitive2v2[0].uid, "tm-two");
  assert.equal(cache.modes.Competitive3v3[0].uid, "tm-three-a");
});

test("HUD cache is isolated per playlist and fetches only the active mode", () => {
  assert.notEqual(
    leaderboardCacheKey("Competitive1v1"),
    leaderboardCacheKey("Competitive2v2"),
  );
  assert.match(
    leaderboardCacheKey("Competitive3v3"),
    /Competitive3v3/,
  );

  const fetchStart = hudSource.indexOf(
    "async function fetchLeaderboardCache(mode)",
  );
  const fetchEnd = hudSource.indexOf(
    "async function getLeaderboardCache(mode)",
    fetchStart,
  );
  assert.notEqual(fetchStart, -1);
  assert.notEqual(fetchEnd, -1);
  const fetchSource = hudSource.slice(fetchStart, fetchEnd);
  assert.match(fetchSource, /RG_LB_MODE_TO_PLAYLIST\[mode\]/);
  assert.doesNotMatch(fetchSource, /for\s*\([^)]*RG_LB_MODES/);

  const liveStart = hudSource.indexOf("async function fireAllRankedPopups()");
  const liveEnd = hudSource.indexOf(
    "async function firePostmortemPopupsIfDeferred",
    liveStart,
  );
  assert.match(
    hudSource.slice(liveStart, liveEnd),
    /getLeaderboardCache\(matchFormat\)/,
  );

  const postmortemStart = liveEnd;
  const postmortemEnd = hudSource.indexOf(
    "async function syncToRealLeaderboard",
    postmortemStart,
  );
  assert.match(
    hudSource.slice(postmortemStart, postmortemEnd),
    /getLeaderboardCache\(mode\)/,
  );
});

test("network RTT smoothing follows sustained ping changes", () => {
  assert.equal(medianPingSample([42]), 42);
  assert.equal(medianPingSample([42, 48, 220]), 48);
  assert.equal(medianPingSample([48, 220, 205]), 205);
});

test("1v1 replay detects and names a ranked opponent end to end", async () => {
  const replay = await createReplay();
  replay.replay("Starting game with 2 players");
  replay.replay(initLine("Me", "self", "Orange"));
  replay.replay(initLine("Photon Alias", "one-top", "Blue"));

  assert.deepEqual(replay.popups, [{
    uid: "one-top",
    name: "One Top",
    rank: 1,
    mode: "Competitive1v1",
    isTeammate: false,
  }]);
});

test("2v2 self-last replay labels one teammate and two opponents", async () => {
  const replay = await createReplay();
  replay.replay("Starting game with 4 players");
  replay.replay(initLine("TM", "tm-two", "Orange"));
  replay.replay(initLine("O1", "opp-two-a", "Blue"));
  replay.replay(initLine("O2", "opp-two-b", "Blue"));
  replay.replay(initLine("Me", "self", "Orange"));

  assert.deepEqual(
    replay.popups.map((popup) => [popup.uid, popup.isTeammate]),
    [
      ["tm-two", true],
      ["opp-two-a", false],
      ["opp-two-b", false],
    ],
  );
});

test("3v3 replay classifies two teammates and three opponents", async () => {
  const replay = await createReplay();
  replay.replay("Starting game with 6 players");
  replay.replay(initLine("T1", "tm-three-a", "Blue"));
  replay.replay(initLine("O1", "opp-three-a", "Orange"));
  replay.replay(initLine("T2", "tm-three-b", "Blue"));
  replay.replay(initLine("O2", "opp-three-b", "Orange"));
  replay.replay(initLine("O3", "opp-three-c", "Orange"));
  replay.replay(initLine("Me", "self", "Blue"));

  assert.equal(
    replay.popups.filter((popup) => popup.isTeammate === true).length,
    2,
  );
  assert.equal(
    replay.popups.filter((popup) => popup.isTeammate === false).length,
    3,
  );
});

test("late Starting line fires once and does not duplicate at match end", async () => {
  const replay = await createReplay();
  replay.replay(initLine("Me", "self", "Orange"));
  replay.replay(initLine("O1", "one-top", "Blue"));
  assert.equal(replay.popups.length, 0);

  replay.replay("Starting game with 2 players");
  assert.equal(replay.popups.length, 1);
  assert.equal(
    replay.matchEnd(["Competitive1v1"]).length,
    1,
  );
});

test("missing Starting line waits for rating mode and handles self last", async () => {
  const replay = await createReplay();
  replay.replay(initLine("TM", "tm-two", "Orange"));
  replay.replay(initLine("O1", "opp-two-a", "Blue"));
  replay.replay(initLine("O2", "opp-two-b", "Blue"));
  replay.replay(initLine("Me", "self", "Orange"));

  const popups = replay.matchEnd(["Competitive2v2"]);
  assert.deepEqual(
    popups.map((popup) => [popup.uid, popup.isTeammate]),
    [
      ["tm-two", true],
      ["opp-two-a", false],
      ["opp-two-b", false],
    ],
  );
});

test("login arriving after roster resumes popup detection", async () => {
  const replay = await createReplay({ selfUid: null });
  replay.replay("Starting game with 2 players");
  replay.replay(initLine("Me", "self", "Orange"));
  replay.replay(initLine("O1", "one-top", "Blue"));
  assert.equal(replay.popups.length, 0);

  replay.setSelfUid("self");
  assert.equal(replay.popups.length, 1);
  assert.equal(replay.popups[0].isTeammate, false);
});

test("warmups are ignored and corrected duplicate teams are accepted", async () => {
  assert.deepEqual(
    { ...parseRosterInitLine(initLine("Warmup", "", "Orange")) },
    { name: "Warmup", uid: "", team: "Orange" },
  );
  assert.deepEqual(
    {
      ...parseRosterInitLine(
        initLine("Player (GOAT)", "tm-two", "blue", "Actor: 7"),
      ),
    },
    { name: "Player (GOAT)", uid: "tm-two", team: "Blue" },
  );

  const replay = await createReplay();
  replay.replay("Starting game with 4 players");
  replay.replay(initLine("Me", "self", "Orange"));
  replay.replay(initLine("TM", "tm-two", "Blue"));
  replay.replay(initLine("O1", "opp-two-a", "Blue"));
  replay.replay(initLine("TM Corrected", "tm-two", "Orange"));
  replay.replay(initLine("O2", "opp-two-b", "Blue"));

  assert.equal(replay.roster.length, 4);
  assert.equal(
    replay.popups.find((popup) => popup.uid === "tm-two")?.isTeammate,
    true,
  );
});

test("incomplete or impossible team splits use neutral labels", async () => {
  const replay = await createReplay();
  replay.replay("Starting game with 4 players");
  replay.replay(initLine("Me", "self", "Orange"));
  replay.replay(initLine("O1", "opp-two-a", "Blue"));
  replay.replay(initLine("TM", "tm-two", "Orange"));
  replay.flushQuietTimer();

  assert.ok(replay.popups.length > 0);
  assert.ok(replay.popups.every((popup) => popup.isTeammate === null));
});

test("config, rank threshold, mode misses, and cache failure skip safely", async () => {
  const cache = await fetchLeaderboardCache(publicDb());
  const strict = await createReplay({
    cache,
    config: { popupEnabled: true, minRankToShow: 1 },
  });
  strict.replay("Starting game with 2 players");
  strict.replay(initLine("Me", "self", "Orange"));
  strict.replay(initLine("Second", "one-second", "Blue"));
  assert.equal(strict.popups.length, 0);

  const disabled = await createReplay({
    cache,
    config: { popupEnabled: false, minRankToShow: 100 },
  });
  disabled.replay("Starting game with 2 players");
  disabled.replay(initLine("Me", "self", "Orange"));
  disabled.replay(initLine("Wrong Mode", "tm-two", "Blue"));
  assert.equal(disabled.popups.length, 0);

  const unavailable = await createReplay({ cache: null });
  unavailable.replay("Starting game with 2 players");
  unavailable.replay(initLine("Me", "self", "Orange"));
  unavailable.replay(initLine("Top", "one-top", "Blue"));
  assert.equal(unavailable.popups.length, 0);
});

test("local role controls independently hide teammates and opponents", async () => {
  const opponentsOnly = await createReplay({
    preferences: {
      popupShowOpponents: true,
      popupShowTeammates: false,
    },
  });
  opponentsOnly.replay("Starting game with 4 players");
  opponentsOnly.replay(initLine("TM", "tm-two", "Orange"));
  opponentsOnly.replay(initLine("O1", "opp-two-a", "Blue"));
  opponentsOnly.replay(initLine("O2", "opp-two-b", "Blue"));
  opponentsOnly.replay(initLine("Me", "self", "Orange"));
  assert.deepEqual(
    opponentsOnly.popups.map((popup) => popup.uid),
    ["opp-two-a", "opp-two-b"],
  );

  const teammatesOnly = await createReplay({
    preferences: {
      popupShowOpponents: false,
      popupShowTeammates: true,
    },
  });
  teammatesOnly.replay("Starting game with 4 players");
  teammatesOnly.replay(initLine("TM", "tm-two", "Orange"));
  teammatesOnly.replay(initLine("O1", "opp-two-a", "Blue"));
  teammatesOnly.replay(initLine("O2", "opp-two-b", "Blue"));
  teammatesOnly.replay(initLine("Me", "self", "Orange"));
  assert.deepEqual(
    teammatesOnly.popups.map((popup) => popup.uid),
    ["tm-two"],
  );
});

test("local rank limit cannot loosen the remote rank limit", () => {
  assert.equal(
    rankedPopupAllowed(
      25,
      false,
      { popupEnabled: true, minRankToShow: 20 },
      { popupMaxRank: 100 },
    ),
    false,
  );
  assert.equal(
    rankedPopupAllowed(
      25,
      false,
      { popupEnabled: true, minRankToShow: 100 },
      { popupMaxRank: 25 },
    ),
    true,
  );
  assert.equal(
    rankedPopupAllowed(
      26,
      false,
      { popupEnabled: true, minRankToShow: 100 },
      { popupMaxRank: 25 },
    ),
    false,
  );
});

test("duration and corner preferences normalize to safe values", () => {
  assert.equal(
    rankedPopupDuration(
      { popupDurationMs: 6000 },
      { popupDurationMs: 3000 },
    ),
    3000,
  );
  assert.equal(
    rankedPopupDuration(
      { popupDurationMs: 22000 },
      { popupDurationMs: 0 },
    ),
    15000,
  );
  assert.deepEqual(
    { ...popupStackPositionStyle("bottom-left") },
    {
      top: "auto",
      bottom: "20px",
      left: "20px",
      right: "auto",
      flexDirection: "column-reverse",
    },
  );
  assert.equal(
    popupStackPositionStyle("not-a-corner").right,
    "20px",
  );
});

test("userscript resets popup state at both match boundaries", () => {
  const startingBranch = hudSource.slice(
    hudSource.indexOf('if (arg.includes("Starting game with")'),
    hudSource.indexOf(
      "// ---- left match another way",
      hudSource.indexOf('if (arg.includes("Starting game with")'),
    ),
  );
  assert.match(startingBranch, /resetMatchPopupState\(\)/);

  const matchEndBranch = hudSource.slice(
    hudSource.indexOf('if (url.includes("/v0304_player/matchEnd"))'),
    hudSource.indexOf('} else if (url.includes("/v0304_login/login"))'),
  );
  assert.match(matchEndBranch, /resetMatchPopupState\(\)/);
});

test("match reset allows the same ranked player in the next match", async () => {
  const replay = await createReplay();
  const playOne = () => {
    replay.replay("Starting game with 2 players");
    replay.replay(initLine("Me", "self", "Orange"));
    replay.replay(initLine("Top", "one-top", "Blue"));
    return replay.matchEnd(["Competitive1v1"]);
  };

  assert.equal(playOne().length, 1);
  assert.equal(playOne().length, 1);
});
