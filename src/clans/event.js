
// event-time perms, edit events/current in Firestore, no redeploy.
// missing keys fall back to these defaults.
//   allowJoin/Leave/Kick/Approve/Disband/RoleChange/Transfer/RenameClan/ClanCreate
export const EVENT_PERM_DEFAULTS = {
    allowJoin:        true,   // opened mid-event per feedback
    allowLeave:       false,  // can't dodge a losing team
    allowKick:        true,
    allowApprove:     true,
    allowDisband:     false,  // freeze rosters
    allowRoleChange:  false,  // role changes shift attribution — freeze
    allowTransfer:    false,
    allowRenameClan:  false,
    allowClanCreate:  true,   // new clans don't affect anyone else
    useBench:         false,  // when true: clans hold 6, only starting 5 score
    allowBenchSwapDuringEvent: false, // freeze lineup once event goes active
};


// true = allowed now. outside an active event, everything is allowed.
export function eventPerm(key) {
    if (eventPhase() !== "active") return true;
    const p = eventConfig?.perms || EVENT_PERM_DEFAULTS;
    return p[key] !== false;
}


// offset learned from serverTimestamp round-trips. cosmetic countdowns only,
// never scoring.
export function serverNow() {
    return Date.now() + (serverNowOffset ?? 0);
}

export function learnServerTime(serverMs) {
    if (typeof serverMs === "number") serverNowOffset = serverMs - Date.now();
}


export function eventPhase() {
    if (!eventConfig) return "none";
    const now = serverNow();
    if (now < eventConfig.startTime) return "upcoming";
    if (now > eventConfig.endTime) return "ended";
    return "active";
}


// startTime doubles as an event id so old baselines are recognized as stale.
export function currentEventId() {
    return eventConfig ? String(eventConfig.startTime) : null;
}


export function clanBaselineForCurrentEvent(clan) {
    if (!clan) return null;
    if (clan.eventId !== currentEventId()) return null; // stale -> no score yet
    const hasPerMemberBaseline = clanMembers(clan).some(
        member => member?.eventBaseline != null
    );
    if (!clan.eventBaseline && !hasPerMemberBaseline) return null;
    return clan.eventBaseline ?? {};
}


export function memberEventBaseline(clan, memberOrUid) {
    const member = typeof memberOrUid === "string"
        ? clanMembers(clan).find(candidate => candidate.userId === memberOrUid)
        : memberOrUid;
    if (member?.eventBaseline != null) return member.eventBaseline;
    const uid = typeof memberOrUid === "string"
        ? memberOrUid
        : member?.userId;
    return uid ? clan?.eventBaseline?.[uid] ?? null : null;
}


export function computeClanEventScore(clan) {
    const baseline = clanBaselineForCurrentEvent(clan);
    if (!baseline) return 0;
    // Only starters count toward event score. Bench MMR is still tracked
    // (so a mid-event swap has a real baseline) but doesn't contribute.
    const starters = new Set(startingLineupUids(clan));
    return clanMembers(clan).reduce((sum, m) => {
        if (starters.size && !starters.has(m.userId)) return sum;
        const base = memberEventBaseline(clan, m);
        const mmr = effectiveClanMemberStat(clan, m).mmr;
        if (base == null || typeof mmr !== "number") return sum;
        return sum + (mmr - base);
    }, 0);
}


export function myEventContribution(clan, uid) {
    const baseline = clanBaselineForCurrentEvent(clan);
    if (!baseline) return null;
    const me = clanMembers(clan).find(m => m.userId === uid);
    const base = memberEventBaseline(clan, me ?? uid);
    const mmr = effectiveClanMemberStat(clan, me).mmr;
    if (base == null || !me || typeof mmr !== "number") return null;
    if (isMemberBenched(clan, uid)) return 0;
    return mmr - base;
}


// always includes seconds so the 1s tick has something to change
export function formatCountdown(targetMs) {
    let ms = targetMs - serverNow();
    if (ms < 0) ms = 0;
    const d = Math.floor(ms / 86400000);
    const h = Math.floor((ms % 86400000) / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    if (d > 0) return `${d}d ${h}h ${m}m ${s}s`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}


// sorted by eventScore desc. only clans with a baseline in this event count.
export function eventStandings() {
    const evId = currentEventId();
    return clanDirectory
        .filter(c => c.eventId === evId)
        .slice()
        .sort((a, b) => (b.eventScore ?? 0) - (a.eventScore ?? 0));
}


// drives the "👑 Leading the Clash" title (clan-version of KING)
export function isMyClanLeadingClash() {
    if (eventPhase() !== "active") return false;
    if (!myClan) return false;
    const standings = eventStandings();
    return standings.length > 0 && standings[0].id === myClan.id;
}


// ---------- HUD content ----------

// renders only when event is active + we're in a clan with a baseline.
// returns "" so callers can splice unconditionally.
export function clashMiniBarHtml() {
    try {
        if (typeof eventPhase !== "function" || eventPhase() !== "active") return "";
        if (!myClan) return "";
        const uid = myUserId();
        const contrib = myEventContribution(myClan, uid);
        const clanScore = computeClanEventScore(myClan);
        const standings = eventStandings();
        const rank = standings.findIndex(c => c.id === myClan.id) + 1;
        if (!rank) return ""; // baseline not landed yet
        const cSign = (contrib ?? 0) >= 0 ? "+" : "";
        const cColor = (contrib ?? 0) >= 0 ? "#00ff66" : "#ff6b6b";
        const clanSign = clanScore >= 0 ? "+" : "";
        const clanColor = clanScore >= 0 ? "#00ff66" : "#ff6b6b";
        const rankColor = rank === 1 ? "#ffd700" : (rank <= 3 ? "#00bfff" : "#ffffff");
        return `
            <hr style="border:none;border-top:1px solid #00bfff44;margin:8px 0 6px;">
            <div style="font-size:11px;line-height:1.4;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span><b>👑 Clash</b> <span style="color:${rankColor};">#${rank}/${standings.length}</span></span>
                    <span style="opacity:.7;">${escapeHtml(String(eventConfig?.name || ""))}</span>
                </div>
                <div style="opacity:.9;margin-top:2px;">
                    You <span style="color:${cColor};">${cSign}${typeof contrib === "number" ? contrib : "—"}</span>
                    <span style="opacity:.4;">•</span>
                    Clan <span style="color:${clanColor};">${clanSign}${clanScore}</span>
                </div>
            </div>
        `;
    } catch (e) {
        // decorative, never break render for this
        dbg("clashMiniBarHtml threw: " + getErrMsg(e));
        return "";
    }
}


// reads events/current.maxMembers so the cap can be changed live
export const DEFAULT_CLAN_MAX_MEMBERS = 5;

export const BENCH_CLAN_MAX_MEMBERS = 6;

export const DEFAULT_STARTING_LINEUP_SIZE = 5;

export function benchFeatureEnabled() {
    // Read the raw perm value — eventPerm() returns true outside active
    // events, which would flip the cap when we don't want it to.
    const p = eventConfig?.perms;
    return p?.useBench === true;
}

export function startingLineupSize() {
    const n = eventConfig?.startingLineupSize;
    return (typeof n === "number" && n > 0 && n <= 20) ? n : DEFAULT_STARTING_LINEUP_SIZE;
}

export function clanMaxMembers() {
    const n = eventConfig?.maxMembers;
    if (typeof n === "number" && n > 0 && n <= 50) return n;
    return benchFeatureEnabled() ? BENCH_CLAN_MAX_MEMBERS : DEFAULT_CLAN_MAX_MEMBERS;
}


// The uids of the starting-5 for the current event. Uses the clan's
// explicit startingLineup when set (leader/co-lead selection), else
// defaults to the first 5 members by joinedAt (oldest first). Returns
// all member uids when bench feature is off — everyone is a "starter"
// in that mode.
export function startingLineupUids(clan) {
    const members = clanMembers(clan);
    if (!benchFeatureEnabled()) return members.map(m => m.userId).filter(Boolean);
    const explicit = Array.isArray(clan?.startingLineup)
        ? clan.startingLineup.filter(uid => members.some(m => m.userId === uid))
        : [];
    if (explicit.length) return explicit.slice(0, startingLineupSize());
    // Default: oldest-first fill of the 5 starter slots.
    return [...members]
        .sort((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0))
        .slice(0, startingLineupSize())
        .map(m => m.userId)
        .filter(Boolean);
}


export function isMemberBenched(clan, uidOrMember) {
    if (!benchFeatureEnabled()) return false;
    const uid = typeof uidOrMember === "string" ? uidOrMember : uidOrMember?.userId;
    if (!uid) return false;
    return !startingLineupUids(clan).includes(uid);
}


export function clanReservationsEnabled() {
    return eventConfig?.useClanReservations === true;
}


export function clanDirectoryEntry(id, clan) {
    const members = clanMembers(clan);
    const deviceIds = clanDeviceIds(clan);
    return {
        id,
        clanId: id,
        name: clan.name,
        tag: clan.tag ?? "",
        tagStyle: clan.tagStyle || null,
        leaderId: clan.leaderId ?? null,
        createdAt: clan.createdAt ?? null,
        memberCount: members.length,
        memberIds: members.map(member => member.userId),
        deviceIds,
        totalMMR: effectiveClanTotalMMR(clan),
        eventScore: computeClanEventScore(clan),
        eventId: clan.eventId ?? null,
    };
}
