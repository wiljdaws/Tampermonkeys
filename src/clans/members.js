export function clanMembers(clan) {
    if (Array.isArray(clan?.members)) return clan.members;
    if (!clan?.members || typeof clan.members !== "object") return [];
    return Object.entries(clan.members).map(([userId, member]) => ({
        ...(member && typeof member === "object" ? member : {}),
        userId: member?.userId || userId,
    }));
}

export function clanMembersField(liveClan, members) {
    if (!Array.isArray(liveClan?.members)
        && liveClan?.members
        && typeof liveClan.members === "object") {
        return {
            members: Object.fromEntries(
                members
                    .filter(member => member?.userId)
                    .map(member => {
                        const stats = liveClan.memberStats?.[member.userId];
                        const deviceIds = [...new Set([
                            ...(Array.isArray(member.deviceIds)
                                ? member.deviceIds
                                : []),
                            member.deviceId,
                            ...(Array.isArray(stats?.deviceIds)
                                ? stats.deviceIds
                                : []),
                            stats?.deviceId,
                        ].filter(Boolean))].sort();
                        return [
                            member.userId,
                            { ...member, deviceIds },
                        ];
                    })
            ),
        };
    }
    return { members };
}

// Current clients keep per-player MMR in a map that legacy whole-array
// writes do not touch. Prefer whichever representation has the newer
// timestamp so downgrades and mixed-version clans remain compatible.
export function effectiveClanMemberStat(clan, memberOrUid) {
    const member = typeof memberOrUid === "string"
        ? clanMembers(clan).find(m => m.userId === memberOrUid)
        : memberOrUid;
    const uid = typeof memberOrUid === "string" ? memberOrUid : member?.userId;
    const mapped = uid ? clan?.memberStats?.[uid] : null;
    const legacyValid = typeof member?.mmr === "number";
    const mappedValid = typeof mapped?.mmr === "number";
    if (!mappedValid) {
        return {
            mmr: legacyValid ? member.mmr : null,
            syncedAt: typeof member?.syncedAt === "number" ? member.syncedAt : null,
        };
    }
    const mappedAt = typeof mapped.syncedAt === "number" ? mapped.syncedAt : 0;
    const legacyAt = typeof member?.syncedAt === "number" ? member.syncedAt : 0;
    if (!legacyValid || mappedAt >= legacyAt) {
        return { mmr: mapped.mmr, syncedAt: mappedAt || null };
    }
    return { mmr: member.mmr, syncedAt: legacyAt || null };
}

export function effectiveClanTotalMMR(clan) {
    return clanMembers(clan).reduce((sum, member) => {
        const mmr = effectiveClanMemberStat(clan, member).mmr;
        return sum + (typeof mmr === "number" ? mmr : 0);
    }, 0);
}

export function clanHasDeviceId(clan, uid, deviceId) {
    if (!deviceId) return true;
    const member = clanMembers(clan).find(candidate => candidate.userId === uid);
    const mapped = clan?.memberStats?.[uid];
    return member?.deviceId === deviceId
        || (Array.isArray(member?.deviceIds) && member.deviceIds.includes(deviceId))
        || mapped?.deviceId === deviceId
        || (Array.isArray(mapped?.deviceIds) && mapped.deviceIds.includes(deviceId));
}

export function clanMMRWriteFields(liveClan, uid, myMMR, syncedAt, deviceId = null) {
    const liveMembers = clanMembers(liveClan);
    if (!liveMembers.some(m => m.userId === uid)) return null;
    const members = liveMembers.map(m =>
        m.userId === uid
            ? { ...m, mmr: myMMR, syncedAt, ...(deviceId ? { deviceId } : {}) }
            : m
    );
    const existingStats = liveClan.memberStats?.[uid] ?? {};
    const deviceIds = deviceId
        ? [...new Set([
            ...(Array.isArray(existingStats.deviceIds) ? existingStats.deviceIds : []),
            deviceId,
        ])]
        : existingStats.deviceIds;
    const memberStats = {
        ...(liveClan.memberStats && typeof liveClan.memberStats === "object"
            ? liveClan.memberStats
            : {}),
        [uid]: {
            ...existingStats,
            mmr: myMMR,
            syncedAt,
            ...(deviceIds ? { deviceIds } : {}),
        },
    };
    const membersField = clanMembersField(liveClan, members);
    const mergedClan = { ...liveClan, ...membersField, memberStats };
    return {
        ...membersField,
        memberStats,
        totalMMR: effectiveClanTotalMMR(mergedClan),
    };
}

export function clanMemberDeviceIds(clan, uid) {
    const ids = new Set();
    const member = clanMembers(clan).find(candidate => candidate.userId === uid);
    const stats = clan?.memberStats?.[uid];
    if (member?.deviceId) ids.add(member.deviceId);
    for (const deviceId of Array.isArray(member?.deviceIds) ? member.deviceIds : []) {
        if (deviceId) ids.add(deviceId);
    }
    if (stats?.deviceId) ids.add(stats.deviceId);
    for (const deviceId of Array.isArray(stats?.deviceIds) ? stats.deviceIds : []) {
        if (deviceId) ids.add(deviceId);
    }
    return [...ids].sort();
}

export function clanDeviceIds(clan) {
    const ids = new Set();
    for (const member of clanMembers(clan)) {
        for (const deviceId of clanMemberDeviceIds(clan, member.userId)) {
            if (deviceId) ids.add(deviceId);
        }
    }
    return [...ids].sort();
}
