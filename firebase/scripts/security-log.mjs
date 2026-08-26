// Free incident log for the publisher. Writes GitHub logs, job summary,
// and a rolling JSON file on the data branch. Never writes Firestore —
// Spark writes are the budget an attack would burn.

export const SECURITY_LOG_PREFIX = "[security]";
export const SECURITY_EVENTS_MAX = 200;

export function makeSecurityEvent(partial = {}) {
  const mmr = Number(partial.mmr);
  return {
    at: typeof partial.at === "string" && partial.at ? partial.at : new Date().toISOString(),
    severity: partial.severity || "info",
    kind: String(partial.kind || "unknown"),
    actorUid: String(partial.actorUid || "").slice(0, 64),
    name: String(partial.name || "").slice(0, 48),
    playlist: String(partial.playlist || "").slice(0, 16),
    mmr: Number.isFinite(mmr) ? mmr : null,
    threshold: Number.isFinite(Number(partial.threshold)) ? Number(partial.threshold) : null,
    reason: String(partial.reason || "").slice(0, 240),
    source: String(partial.source || "build-leaderboard-cache").slice(0, 64),
  };
}

export function eventsFromCacheResult(result = {}, { autoBan = [], at } = {}) {
  const when = at || new Date().toISOString();
  const events = [];
  if (result.paused) {
    events.push(makeSecurityEvent({
      at: when,
      severity: "critical",
      kind: "writes_paused",
      reason: "admin/blacklist.pauseWrites is on; publish skipped",
    }));
  }
  for (const row of result.heldRows || []) {
    const mmr = Number(row.mmr);
    events.push(makeSecurityEvent({
      at: when,
      severity: Number.isFinite(mmr) && mmr >= 20000 ? "critical" : "hold",
      kind: "first_seen_mmr_hold",
      actorUid: row.uid,
      name: row.name,
      playlist: row.playlist,
      mmr: row.mmr,
      threshold: row.threshold,
      reason: row.reason,
    }));
  }
  for (const uid of autoBan) {
    events.push(makeSecurityEvent({
      at: when,
      severity: "critical",
      kind: "auto_blacklist",
      actorUid: uid,
      reason: "first-seen hold over auto-ban MMR; appended to admin/blacklist.userIds",
    }));
  }
  for (const upload of result.uploads || []) {
    if (upload.action !== "failed") continue;
    events.push(makeSecurityEvent({
      at: when,
      severity: "warning",
      kind: "json_upload_failed",
      playlist: upload.playlist,
      reason: upload.error,
    }));
  }
  return events;
}

export function formatSecurityLine(event) {
  return `${SECURITY_LOG_PREFIX} ${JSON.stringify(event)}`;
}

function cell(value) {
  return String(value ?? "").replace(/\|/g, "/").replace(/\n/g, " ");
}

export function renderStepSummary(events) {
  if (!events.length) return "";
  const rows = [
    "## Security events",
    "",
    "| severity | kind | uid | playlist | mmr | reason |",
    "|----------|------|-----|----------|-----|--------|",
  ];
  for (const event of events) {
    rows.push(
      `| ${cell(event.severity)} | ${cell(event.kind)} | ${cell(event.actorUid).slice(0, 16)} | ${cell(event.playlist)} | ${cell(event.mmr)} | ${cell(event.reason)} |`,
    );
  }
  return `${rows.join("\n")}\n`;
}

export function mergeRollingEvents(existing, incoming, max = SECURITY_EVENTS_MAX) {
  const prev = Array.isArray(existing?.events) ? existing.events : [];
  const next = Array.isArray(incoming) ? incoming : [];
  const events = [...prev, ...next].slice(-max);
  return {
    events,
    updatedAt: events.length ? events[events.length - 1].at : null,
  };
}

export async function persistSecurityEvents(events, options = {}) {
  const list = Array.isArray(events) ? events : [];
  const log = options.log || console;
  for (const event of list) {
    log.warn(formatSecurityLine(event));
  }
  if (options.outputPath && typeof options.writeFile === "function") {
    const body = list.length ? `${list.map(event => JSON.stringify(event)).join("\n")}\n` : "";
    await options.writeFile(options.outputPath, body, "utf8");
  }
  if (options.statePath && typeof options.writeFile === "function") {
    let existing = { events: [] };
    if (typeof options.readFile === "function") {
      try {
        existing = JSON.parse(await options.readFile(options.statePath, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    const merged = mergeRollingEvents(existing, list);
    await options.writeFile(options.statePath, JSON.stringify(merged), "utf8");
  }
  if (list.length && options.stepSummaryPath && typeof options.appendFile === "function") {
    await options.appendFile(options.stepSummaryPath, renderStepSummary(list));
  }
}
