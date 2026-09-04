import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function scanSkipString(source, i) {
  const quote = source[i];
  i += 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (quote === "`" && source[i] === "$" && source[i + 1] === "{") {
      const innerEnd = matchPair(source, i + 1, "{", "}");
      i = innerEnd + 1;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  throw new Error("unterminated string");
}

function matchPair(source, start, open, close) {
  if (source[start] !== open) throw new Error(`expected ${open} at ${start}`);
  let depth = 0;
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? source.length : nl + 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      i = scanSkipString(source, i);
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  throw new Error("unmatched pair");
}

function includeLeadingComments(source, start) {
  let idx = source.lastIndexOf("\n", start - 1);
  if (idx < 0) return start;
  while (idx > 0) {
    const prevNl = source.lastIndexOf("\n", idx - 1);
    const line = source.slice(prevNl + 1, idx);
    if (line.startsWith("    //") || /^\s*$/.test(line)) {
      idx = prevNl;
      continue;
    }
    break;
  }
  return idx + 1;
}

export function extractFunction(source, name) {
  const needles = [`    async function ${name}(`, `    function ${name}(`];
  let start = -1;
  for (const needle of needles) {
    start = source.indexOf(needle);
    if (start >= 0) break;
  }
  if (start < 0) throw new Error(`missing function ${name}`);
  const rangeStart = includeLeadingComments(source, start);
  const paren = source.indexOf("(", start);
  const parenEnd = matchPair(source, paren, "(", ")");
  let i = parenEnd + 1;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  if (source[i] !== "{") throw new Error(`${name}: missing body`);
  const braceEnd = matchPair(source, i, "{", "}");
  let end = braceEnd + 1;
  if (source[end] === "\n") end += 1;
  return { start: rangeStart, end, text: source.slice(rangeStart, end) };
}

export function extractConst(source, needle) {
  const startRaw = source.indexOf(needle);
  if (startRaw < 0) throw new Error(`missing ${needle}`);
  const start = includeLeadingComments(source, startRaw);
  const eq = source.indexOf("=", startRaw);
  let i = eq + 1;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  const ch = source[i];
  if (ch === "{" || ch === "[" || ch === "(") {
    const close = { "{": "}", "[": "]", "(": ")" }[ch];
    i = matchPair(source, i, ch, close) + 1;
  } else {
    const semi = source.indexOf(";", i);
    if (semi < 0) throw new Error(`no semicolon for ${needle}`);
    i = semi;
  }
  while (i < source.length && source[i] !== ";") i += 1;
  let end = i + 1;
  if (source[end] === "\n") end += 1;
  return { start, end, text: source.slice(start, end) };
}

function dedent(block) {
  return block.split("\n").map((line) => (
    line.startsWith("    ") ? line.slice(4) : line
  )).join("\n");
}

function exportify(block) {
  return dedent(block).split("\n").map((line) => {
    if (/^(async )?function /.test(line) || /^(const|let) /.test(line)) {
      return `export ${line}`;
    }
    return line;
  }).join("\n").replace(/\n+$/, "\n");
}

function writeModule(rel, header, parts) {
  const dest = path.join(root, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  const body = parts.map((p) => exportify(p).replace(/\n+$/, "\n")).join("\n");
  writeFileSync(dest, header + body);
  console.log(`wrote ${rel} (${body.split("\n").length} lines)`);
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (!invokedDirectly) {
  // imported for extractFunction / extractConst only
} else {
  const hudPath = path.join(root, "src/hud.js");
  let src = readFileSync(hudPath, "utf8");
  const ranges = [];

  function takeFn(name) {
    const hit = extractFunction(src, name);
    ranges.push(hit);
    return hit.text;
  }

  function takeConst(needle) {
    const hit = extractConst(src, needle);
    ranges.push(hit);
    return hit.text;
  }

  const chromeParts = [
    takeFn("pageWindow"),
    takeFn("currentUidForDeny"),
    takeFn("formatAtlasError"),
    takeConst("    const ATLAS_ICON_URL"),
    takeConst("    const DEFAULT_SETTINGS"),
    takeFn("saveSettings"),
    takeFn("browserConnection"),
    takeFn("ensurePingTracker"),
    takeFn("renderPingTracker"),
    takeFn("probePingTracker"),
    takeFn("syncPingTracker"),
    takeFn("clampHudOnScreen"),
    takeFn("dragElement"),
    takeFn("manualToggle"),
    takeFn("setAutoVisible"),
    takeFn("showError"),
    takeFn("clearError"),
    takeFn("saveStreak"),
    takeFn("resetStreak"),
    takeFn("updateStreak"),
    takeFn("streakBadge"),
    takeFn("captureSessionStart"),
    takeFn("deltaBadge"),
    takeFn("rankBadge"),
    takeFn("netSessionMMR"),
    takeFn("resolveTitle"),
    takeFn("applyTitle"),
    takeFn("updateMomentum"),
    takeFn("showBanner"),
    takeFn("checkRankTransitions"),
    takeFn("applyGlowSettings"),
    takeFn("isNameForgeInput"),
    takeFn("createHUD"),
    takeFn("showNameModal"),
    takeFn("hideNameModal"),
    takeFn("hideNameModalSoon"),
    takeFn("paintAuthUid"),
  ];
  const matchHistParts = [
    takeConst("    const MATCH_HISTORY_CAP"),
    takeConst("    const MATCH_HISTORY_STORAGE_PREFIX"),
    takeConst("    const RECENT_MATCHES_CAP"),
    takeConst("    const MODES_FOR_SNAPSHOTS"),
    takeFn("loadMatchHistory"),
    takeFn("saveMatchHistory"),
    takeFn("writeMatchAudit"),
    takeFn("writeMatchSnapshotDoc"),
    takeFn("handleMatchSnapshots"),
    takeFn("captureMatchSnapshotsIfAny"),
    takeFn("rosterSnapshot"),
    takeFn("ensureRingHydrated"),
    takeFn("refreshRanks"),
    takeFn("freezeRoster"),
    takeFn("syncForgeFromLogin"),
  ];
  const firebaseAuthParts = [
    takeFn("atlasTmStorage"),
    takeFn("hydrateAtlasAuthFromTm"),
    takeFn("backupAtlasAuthToTm"),
    takeFn("atlasSetLongCookie"),
    takeFn("atlasReadCookie"),
    takeFn("getAtlasProxyKvConfig"),
    takeFn("importAtlasProxyKvKey"),
    takeFn("hydrateAtlasAuthFromProxyKv"),
    takeFn("backupAtlasAuthToProxyKv"),
    takeFn("initFirebaseInner"),
    takeFn("initFirebase"),
    takeFn("retryFirebaseAuth"),
    takeFn("ensureAnonymousAuth"),
  ];
  const firebaseWriteParts = [
    takeFn("logDeny"),
    takeFn("firestoreReadBudgetPassed"),
    takeFn("logRead"),
    takeFn("logWrite"),
    takeFn("scheduleHudStatsUpload"),
    takeFn("isAllowlistGatedLabel"),
    takeFn("atlasMutationAllowed"),
    takeFn("atlasStampedMutationData"),
    takeFn("describeWriteSubject"),
    takeFn("atlasSetDoc"),
    takeFn("atlasDeleteDoc"),
    takeFn("runAtlasTransaction"),
    takeFn("showUpdateRequiredUI"),
    takeFn("showWritesPausedUI"),
    takeFn("showNotAllowlistedUI"),
    takeFn("isUpdateRequired"),
    takeFn("maybeShowUpdateNudge"),
    takeFn("showUpdateNudge"),
    takeFn("uploadHudReadStats"),
  ];
  const lbUiParts = [
    takeConst("    const RG_LB_CACHE_KEY_LEGACY"),
    takeConst("    const RG_LB_CACHE_KEY_PREFIX"),
    takeConst("    const RG_LB_CONFIG_KEY"),
    takeConst("    const RG_LB_CONFIG_TTL_MS"),
    takeConst("    const RG_LB_MODES"),
    takeConst("    const RG_LB_MODE_TO_PLAYLIST"),
    takeConst("    const RG_LB_TOP_N"),
    takeConst("    const STREAK_SNIPE_MIN"),
    takeConst("    const RG_LB_DEFAULT_CONFIG"),
    takeConst("    const RANKED_POPUP_PREFERENCES"),
    takeConst("    const OPPONENT_STREAK_CACHE_KEY"),
    takeConst("    const REAL_LEADERBOARD_COLLECTION"),
    takeConst("    const LEADERBOARD_CACHE_COLLECTION"),
    takeFn("ensureLbPopupStyles"),
    takeFn("showLbOpponentPopup"),
    takeFn("ensureStreakSnipeStyles"),
    takeFn("showStreakSnipeOverlay"),
    takeFn("maybeShowStreakSnipe"),
    takeFn("resetMatchPopupState"),
    takeFn("snapshotDeferredRoster"),
    takeFn("onRosterEntry"),
    takeFn("fireAllRankedPopups"),
    takeFn("firePostmortemPopupsIfDeferred"),
    takeFn("scheduleRankedRosterPopups"),
    takeFn("saveOpponentStreakCache"),
    takeFn("fetchRemoteConfig"),
    takeFn("getRemoteConfig"),
    takeFn("fetchLeaderboardCacheFromAggregate"),
    takeFn("fetchLeaderboardCacheDirect"),
    takeFn("fetchLeaderboardCache"),
    takeFn("getLeaderboardCache"),
    takeFn("fetchSiteLeaderboardRows"),
    takeFn("rankCacheKey"),
    takeFn("hydrateRankCache"),
    takeFn("persistRankCache"),
    takeFn("resetAccountRankState"),
    takeFn("submitToLeaderboard"),
    takeFn("submitToLeaderboardInner"),
    takeFn("syncToRealLeaderboard"),
    takeFn("upsertPlaylistEntry"),
    takeFn("upsertIfChanged"),
  ];
  const identityUiParts = [
    takeFn("lookupDisplayNameFromBoard"),
    takeFn("isNameTaken"),
    takeFn("askDisplayName"),
    takeFn("showToast"),
    takeFn("showDialog"),
  ];
  const clanOpsParts = [
    takeConst("    const clanSyncLocks"),
    takeFn("queueClanMMRSync"),
    takeFn("syncClanAfterMatch"),
    takeFn("updateMyClanMMR"),
    takeFn("loadEventConfig"),
    takeFn("loadClanRolePerms"),
    takeFn("maybeCaptureEventBaseline"),
    takeFn("loadClanDirectoryLite"),
    takeFn("attachClanListener"),
    takeFn("detachClanListener"),
    takeFn("loadClanData"),
    takeFn("loadClanDataInner"),
    takeFn("linkCurrentClanDevice"),
    takeFn("patchMyClanInDirectory"),
    takeFn("refreshDirectoryThrottled"),
    takeFn("saveClanTagStyle"),
    takeFn("renderClanTagPanel"),
    takeFn("refreshDirectory"),
    takeFn("createClan"),
    takeFn("requestJoin"),
    takeFn("approveRequest"),
    takeFn("writeClanNotice"),
    takeFn("kickMember"),
    takeFn("scheduleClanNoticeCheck"),
    takeFn("checkClanNotices"),
    takeFn("setMemberRole"),
    takeFn("editClan"),
    takeFn("showEditClanForm"),
    takeFn("showLineupPicker"),
    takeFn("saveStartingLineup"),
    takeFn("transferLeadership"),
    takeFn("leaveClan"),
    takeFn("renderClanView"),
    takeFn("renderClanViewFromMemory"),
    takeFn("refreshClanViewIfOpen"),
    takeFn("renderNoClan"),
    takeFn("showCreateClanForm"),
    takeFn("renderMyClan"),
    takeFn("showManageMemberMenu"),
    takeFn("myUserId"),
    takeFn("myGameNamePlain"),
    takeFn("myName"),
  ];

  const ordered = [...ranges].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].start < ordered[i - 1].end) {
      throw new Error("overlapping extracts");
    }
  }

  writeModule("src/hud/chrome.js", "", chromeParts);
  writeModule("src/matches/history.js", "", matchHistParts);
  writeModule("src/firebase/auth.js", "", firebaseAuthParts);
  writeModule("src/firebase/writes.js", "", firebaseWriteParts);
  writeModule("src/leaderboard/ui.js", "", lbUiParts);
  writeModule("src/identity/ui.js", "", identityUiParts);
  writeModule("src/clans/ops.js", "", clanOpsParts);

  for (const hit of [...ranges].sort((a, b) => b.start - a.start)) {
    src = src.slice(0, hit.start) + src.slice(hit.end);
  }
  while (src.includes("\n\n\n\n")) src = src.replaceAll("\n\n\n\n", "\n\n\n");
  writeFileSync(hudPath, src);
  console.log(`hud.js now ${src.split("\n").length} lines`);
}
