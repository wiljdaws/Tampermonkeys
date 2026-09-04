import {
  clanHasDeviceId,
} from "./members.js";

export function normalizeClanName(value) {
    return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function clanMembershipRecord(clanId, role, deviceIds) {
    return {
        clanId,
        role,
        deviceIds: [...new Set((deviceIds ?? []).filter(Boolean))].sort(),
        updatedAt: new Date().toISOString(),
    };
}

export function clanDeviceLinkPlan({
    clan,
    uid,
    deviceId,
    membership = null,
    device = null,
    directoryEntry = null,
    useReservations = false,
}) {
    const clanId = clan?.id;
    const membershipClanId = membership?.clanId || null;
    const deviceClanId = device?.clanId || null;
    const legacyClanId = directoryEntry?.id || null;
    const deviceInClan = clanHasDeviceId(clan, uid, deviceId);
    const sameClanDeviceConflict = useReservations
        ? deviceClanId === clanId
            && device?.userId
            && device.userId !== uid
        : legacyClanId === clanId
            && (directoryEntry?.deviceIds ?? []).includes(deviceId)
            && !deviceInClan;
    const conflictClanId = sameClanDeviceConflict
        ? clanId
        : (
            useReservations
                ? ([membershipClanId, deviceClanId].find(
                    value => value && value !== clanId
                ) || null)
                : (legacyClanId && legacyClanId !== clanId
                    ? legacyClanId
                    : null)
        );
    const pointerHasDevice = useReservations
        ? membershipClanId === clanId
            && deviceClanId === clanId
            && directoryEntry?.id === clanId
            && (directoryEntry?.memberIds ?? []).includes(uid)
            && (directoryEntry?.deviceIds ?? []).includes(deviceId)
        : legacyClanId === clanId
            && (directoryEntry?.memberIds ?? []).includes(uid)
            && (directoryEntry?.deviceIds ?? []).includes(deviceId);
    return {
        conflictClanId,
        repairClan: !deviceInClan,
        repairPointer: !pointerHasDevice,
    };
}

// Use the directory to check clan membership.
// Hide duplicate clans without deleting anything.
export function canonicalClanDirectory(clans) {
    const chosen = new Map();
    for (const clan of Array.isArray(clans) ? clans : []) {
        if (!clan || typeof clan.id !== "string") continue;
        const name = String(clan.name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
        const tag = String(clan.tag ?? "").trim().toLowerCase();
        const key = name && tag ? `${tag}\u0000${name}` : `id\u0000${clan.id}`;
        const current = chosen.get(key);
        if (!current) {
            chosen.set(key, clan);
            continue;
        }
        // Keep the lowest id so changing scores can't swap the chosen copy.
        if (clan.id.localeCompare(current.id) < 0) chosen.set(key, clan);
    }
    return [...chosen.values()];
}

export function findDirectoryMembership(clans, identity, exceptClanId = null) {
    const uid = typeof identity === "string" ? identity : identity?.userId;
    const deviceId = typeof identity === "object" ? identity?.deviceId : null;
    if (!uid && !deviceId) return null;
    const matches = (Array.isArray(clans) ? clans : []).filter(clan =>
        clan?.id !== exceptClanId
        && ((uid && (clan?.memberIds ?? []).includes(uid))
            || (deviceId && (clan?.deviceIds ?? []).includes(deviceId)))
    );
    const match = canonicalClanDirectory(matches)[0] ?? null;
    if (!match) return null;
    return {
        ...match,
        membershipMatch: uid && (match.memberIds ?? []).includes(uid)
            ? "player"
            : "device",
    };
}

export function putClanInDirectory(clans, entry) {
    return canonicalClanDirectory([
        ...(Array.isArray(clans) ? clans : []).filter(clan => clan?.id !== entry.id),
        entry,
    ]);
}

export function removeClanFromDirectory(clans, clanId) {
    return canonicalClanDirectory(
        (Array.isArray(clans) ? clans : []).filter(clan => clan?.id !== clanId)
    );
}

export function clanMembershipMessage(displayName, clan, isCurrentPlayer = false) {
    const label = clan
        ? `${clan.tag ? `[${clan.tag}] ` : ""}${clan.name || "another clan"}`
        : "another clan";
    const instruction = isCurrentPlayer ? "You must" : "They must";
    if (clan?.membershipMatch === "device") {
        return `This ATLAS device is already linked to ${label}. ${displayName || "This account"} cannot join or create a clan until the account in that clan leaves.`;
    }
    return `${displayName || "This player"} is already in ${label}. ${instruction} leave that clan before joining or creating another clan.`;
}
