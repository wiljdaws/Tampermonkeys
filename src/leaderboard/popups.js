export function normalizePopupPreferences(raw) {
    raw = raw || {};
    const positions = ["top-right", "top-left", "bottom-right", "bottom-left"];
    const durations = [0, 3000, 6000, 10000];
    const rank = Math.round(Number(raw.popupMaxRank));
    const duration = Number(raw.popupDurationMs);
    return {
        showOpponents: raw.popupShowOpponents !== false,
        showTeammates: raw.popupShowTeammates !== false,
        maxRank: Number.isFinite(rank) ? Math.max(1, Math.min(100, rank)) : 100,
        durationMs: durations.includes(duration) ? duration : 0,
        position: positions.includes(raw.popupPosition) ? raw.popupPosition : "top-right",
    };
}

export function rankedPopupAllowed(rank, isTeammate, config, preferences) {
    config = config || {};
    preferences = preferences || {};
    if (config.popupEnabled === false) return false;
    const prefs = normalizePopupPreferences(preferences);
    const remoteRank = Number(config.minRankToShow);
    const remoteLimit = Number.isFinite(remoteRank)
        ? Math.max(1, Math.min(100, remoteRank))
        : 100;
    if (!Number.isFinite(rank) || rank > Math.min(remoteLimit, prefs.maxRank)) return false;
    if (isTeammate === true) return prefs.showTeammates;
    if (isTeammate === false) return prefs.showOpponents;
    return prefs.showTeammates || prefs.showOpponents;
}

export function rankedPopupDuration(config, preferences) {
    config = config || {};
    preferences = preferences || {};
    const prefs = normalizePopupPreferences(preferences);
    if (prefs.durationMs) return prefs.durationMs;
    const remoteDuration = Number(config.popupDurationMs);
    return Number.isFinite(remoteDuration)
        ? Math.max(1500, Math.min(15000, remoteDuration))
        : 6000;
}

export function popupStackPositionStyle(position) {
    const selected = normalizePopupPreferences({ popupPosition: position }).position;
    return {
        top: selected.startsWith("top-") ? "20px" : "auto",
        bottom: selected.startsWith("bottom-") ? "20px" : "auto",
        left: selected.endsWith("-left") ? "20px" : "auto",
        right: selected.endsWith("-right") ? "20px" : "auto",
        flexDirection: selected.startsWith("bottom-") ? "column-reverse" : "column",
    };
}

export function prefersReducedPopupMotion() {
    return typeof window !== "undefined"
        && typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function streakSnipeCandidates(prevRatings, nextRatings, opponents, minimum = STREAK_SNIPE_MIN) {
    const changed = RG_LB_MODES.filter(mode => {
        const before = prevRatings?.[mode];
        const after = nextRatings?.[mode];
        return typeof before === "number"
            && typeof after === "number"
            && before !== after;
    });
    if (changed.length !== 1) return [];
    const mode = changed[0];
    if (nextRatings[mode] <= prevRatings[mode]) return [];
    const threshold = Math.max(1, Math.trunc(Number(minimum) || STREAK_SNIPE_MIN));
    return (Array.isArray(opponents) ? opponents : [])
        .filter(entry =>
            entry?.isTeammate === false
            && entry.confident === true
            && Number(entry.streak) >= threshold)
        .sort((a, b) => Number(b.streak) - Number(a.streak));
}

export function streakSnipeMinimum(config) {
    const configured = Math.trunc(Number(config?.streakSnipeMin));
    return Number.isFinite(configured)
        ? Math.max(1, Math.min(100, configured))
        : STREAK_SNIPE_MIN;
}
