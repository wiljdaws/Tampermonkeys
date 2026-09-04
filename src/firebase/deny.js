export function truncateForDeny(value, max) {
    return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function guessDenyRule(message) {
    const m = String(message || "").toLowerCase();
    if (!m) return "";
    if (m.includes("blacklist")) return "blacklisted";
    if (m.includes("version") || m.includes("minversion")) return "version-gate";
    if (m.includes("device")) return "device-id";
    if (m.includes("stamp") || m.includes("lastwriteat")) return "write-stamp";
    if (m.includes("member") || m.includes("clan")) return "clan-membership";
    if (m.includes("profan") || m.includes("emoji") || m.includes("name")) return "name-blocklist";
    return "";
}


export const RULE_MODES = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];

export const RULE_PLAYLISTS = ["1v1", "2v2", "3v3", "wins"];

export const RULE_OUTCOMES = ["W", "L", "T"];

export function describeDenyReasons(bucket, data, opts = {}) {
    const b = String(bucket || "").split("/")[0];
    const reasons = [];
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        return ["payload missing or not a map"];
    }
    // deviceId is required by hasValidDeviceId() on leaderboard,
    // script_submissions, and match_snapshots.
    const needsDeviceId = b === "leaderboard" || b === "script_submissions" || b === "match_snapshots";
    if (needsDeviceId) {
        if (!("deviceId" in data)) reasons.push("missing field: deviceId");
        else if (typeof data.deviceId !== "string" || data.deviceId.length === 0) {
            reasons.push("deviceId must be a non-empty string");
        }
    }
    if (b === "leaderboard") describeLeaderboardReasons(data, reasons);
    else if (b === "script_submissions") describeScriptSubmissionReasons(data, reasons);
    else if (b === "match_snapshots") describeMatchSnapshotReasons(data, reasons, opts);
    return reasons;
}


export function describeLeaderboardReasons(d, reasons) {
    if (!("sourceUserId" in d)) reasons.push("missing field: sourceUserId");
    else if (typeof d.sourceUserId !== "string" || !d.sourceUserId.length) {
        reasons.push("sourceUserId must be a non-empty string");
    }
    if (!RULE_PLAYLISTS.includes(d.playlist)) {
        reasons.push(`playlist must be one of [${RULE_PLAYLISTS.join(", ")}] (got ${JSON.stringify(d.playlist)})`);
    }
    if (typeof d.name !== "string") reasons.push("name must be a string");
    else if (d.name.length === 0) reasons.push("name is empty");
    else if (d.name.length > 22) reasons.push(`name too long: ${d.name.length} chars > 22`);
    if (d.playlist === "wins") {
        if (typeof d.wins !== "number") reasons.push("wins must be a number");
        if (typeof d.matches !== "number") reasons.push("matches must be a number");
        if (typeof d.wins === "number" && d.wins < 0) reasons.push(`wins (${d.wins}) < 0`);
        if (typeof d.matches === "number" && d.matches < 0) reasons.push(`matches (${d.matches}) < 0`);
        if (typeof d.wins === "number" && typeof d.matches === "number" && d.wins > d.matches) {
            reasons.push(`wins (${d.wins}) > matches (${d.matches})`);
        }
        if (typeof d.matches === "number" && d.matches > 100000) {
            reasons.push(`matches (${d.matches}) > 100000 cap`);
        }
    } else if (RULE_PLAYLISTS.includes(d.playlist)) {
        if (typeof d.mmr !== "number") reasons.push("mmr must be a number");
        else if (d.mmr < 0) reasons.push(`mmr (${d.mmr}) must be non-negative`);
    }
    checkOptionalGlickoField(d, "rating", 0, null, reasons);
    checkOptionalGlickoField(d, "rd", 0, 350, reasons);
    checkOptionalGlickoField(d, "vol", 0, 1, reasons);
}


export function describeScriptSubmissionReasons(d, reasons) {
    if (typeof d.nickname !== "string") reasons.push("nickname must be a string");
    else if (!d.nickname.length) reasons.push("nickname is empty");
    else if (d.nickname.length > 500) reasons.push(`nickname too long: ${d.nickname.length} > 500`);
    if ("displayName" in d && d.displayName != null) {
        if (typeof d.displayName !== "string") reasons.push("displayName must be a string");
        else if (!d.displayName.length) reasons.push("displayName is empty");
        else if (d.displayName.length > 15) reasons.push(`displayName too long: ${d.displayName.length} > 15`);
    }
    if ("xp" in d && d.xp != null) {
        if (typeof d.xp !== "number") reasons.push("xp must be a number");
        else if (d.xp < 0 || d.xp > 1000000) reasons.push(`xp (${d.xp}) outside [0, 1000000]`);
    }
    if ("ratings" in d && d.ratings != null) {
        if (typeof d.ratings !== "object" || Array.isArray(d.ratings)) {
            reasons.push("ratings must be a map");
        } else {
            for (const mode of RULE_MODES) {
                const r = d.ratings[mode];
                if (r == null) continue;
                if (typeof r !== "number") reasons.push(`ratings.${mode} must be a number`);
                else if (r < 0) reasons.push(`ratings.${mode} (${r}) must be non-negative`);
            }
        }
    }
    if ("glicko" in d && d.glicko != null && (typeof d.glicko !== "object" || Array.isArray(d.glicko))) {
        reasons.push("glicko must be a map");
    }
    if ("stats" in d && d.stats != null && typeof d.stats === "object") {
        for (const mode of RULE_MODES) {
            const s = d.stats[mode];
            if (s == null) continue;
            if (typeof s.wins !== "number") reasons.push(`stats.${mode}.wins must be a number`);
            if (typeof s.matchesPlayed !== "number") reasons.push(`stats.${mode}.matchesPlayed must be a number`);
            if (typeof s.wins === "number" && s.wins < 0) reasons.push(`stats.${mode}.wins (${s.wins}) < 0`);
            if (typeof s.matchesPlayed === "number" && s.matchesPlayed < 0) reasons.push(`stats.${mode}.matchesPlayed < 0`);
            if (typeof s.wins === "number" && typeof s.matchesPlayed === "number" && s.wins > s.matchesPlayed) {
                reasons.push(`stats.${mode}: wins (${s.wins}) > matchesPlayed (${s.matchesPlayed})`);
            }
            if (typeof s.matchesPlayed === "number" && s.matchesPlayed > 100000) {
                reasons.push(`stats.${mode}.matchesPlayed (${s.matchesPlayed}) > 100000`);
            }
        }
    }
    if ("recentMatches" in d && d.recentMatches != null) {
        if (!Array.isArray(d.recentMatches)) reasons.push("recentMatches must be a list");
        else if (d.recentMatches.length > 25) reasons.push(`recentMatches size ${d.recentMatches.length} > 25`);
    }
}


export function describeMatchSnapshotReasons(d, reasons, opts) {
    if (typeof d.sourceUserId !== "string" || !d.sourceUserId.length) {
        reasons.push("sourceUserId must be a non-empty string");
    }
    if (typeof d.matchId !== "string" || !d.matchId.length) {
        reasons.push("matchId must be a non-empty string");
    } else if (d.matchId.length > 100) {
        reasons.push(`matchId too long: ${d.matchId.length} > 100`);
    }
    if (opts.docId && d.sourceUserId && d.matchId) {
        const expected = `${d.sourceUserId}_${d.matchId}`;
        if (opts.docId !== expected) {
            reasons.push(`docId "${opts.docId}" must equal "${expected}" (sourceUserId + "_" + matchId)`);
        }
    }
    if (!RULE_MODES.includes(d.mode)) {
        reasons.push(`mode must be one of [${RULE_MODES.join(", ")}] (got ${JSON.stringify(d.mode)})`);
    }
    if (!RULE_OUTCOMES.includes(d.outcome)) {
        reasons.push(`outcome must be one of [${RULE_OUTCOMES.join(", ")}] (got ${JSON.stringify(d.outcome)})`);
    }
    if (!d.before || typeof d.before !== "object" || Array.isArray(d.before)) reasons.push("before must be a map");
    if (!d.after || typeof d.after !== "object" || Array.isArray(d.after)) reasons.push("after must be a map");
    if (!Array.isArray(d.roster)) reasons.push("roster must be a list");
    else if (d.roster.length > 8) reasons.push(`roster size ${d.roster.length} > 8 cap`);
}


export function checkOptionalGlickoField(d, key, min, max, reasons) {
    if (!(key in d) || d[key] == null) return;
    if (typeof d[key] !== "number") reasons.push(`${key} must be a number`);
    else if (d[key] < min) reasons.push(`${key} (${d[key]}) must be >= ${min}`);
    else if (max != null && d[key] > max) reasons.push(`${key} (${d[key]}) must be <= ${max}`);
}

export function bucketLabel(raw) {
    // Firestore doc paths carry slashes and ids that would explode the
    // perLabel map — normalize to the "collection[/subcoll]" prefix.
    const str = String(raw || "unknown");
    const parts = str.split("/").filter(Boolean);
    if (parts.length <= 1) return parts[0] || "unknown";
    // For paths like "clans/xyz" → "clans"; for "clans/xyz/members/abc" → "clans/members"
    const buckets = [];
    for (let i = 0; i < parts.length; i += 2) buckets.push(parts[i]);
    return buckets.join("/").slice(0, 80);
}
