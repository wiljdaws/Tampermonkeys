
// strips TMP tags (<#rrggbb>, <br>, etc.)
export function cleanName(name) {
    return (name ?? "")
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " ")
        .trim();
}


// not exhaustive. \b avoids catching "classic" / "assassin".
export const PROFANITY_LIST = [
    // common curses
    "fuck", "fuk", "fvck", "fck", "shit", "sh1t", "shyt", "bitch", "b1tch",
    "cunt", "asshole", "ass hole", "dick", "d1ck", "cock", "pussy", "pu55y",
    "bastard", "damn", "piss", "twat", "wanker", "bollocks", "arse",
    // slurs (racial / ethnic)
    "nigger", "nigga", "n1gger", "n1gga", "chink", "spic", "wetback",
    "gook", "kike", "beaner", "coon", "paki",
    // slurs (homophobic / transphobic)
    "faggot", "fag", "f4g", "dyke", "tranny", "shemale",
    // slurs (ableist / other)
    "retard", "retarded", "r3tard", "spastic", "cripple",
    // sexual / degrading
    "whore", "slut", "hoe", "rape", "rapist", "molest", "pedo", "pedophile",
    // hate groups / extremist terms
    "nazi", "hitler", "kkk",
];

export const PROFANITY_REGEX = new RegExp(`\\b(${PROFANITY_LIST.join("|")})\\b`, "i");


export function containsProfanity(text) {
    return PROFANITY_REGEX.test(text);
}


// rejects any emoji / pictographic incl. flag sequences
export const EMOJI_REGEX = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}|[\u{1F1E6}-\u{1F1FF}\u{1F3F3}\u{1F3F4}\u{E0020}-\u{E007F}\u{200D}]/u;

export function containsEmoji(text) {
    return EMOJI_REGEX.test(text);
}


export function hasPlayedAnything(data) {
    const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
    return modes.some(m => (data.ModesData?.[m]?.matchesPlayed ?? 0) > 0);
}


export function displayNameStorageKey(rgPlayerId) {
    return "atlasDisplayName:" + String(rgPlayerId || "").trim();
}


export function readStoredDisplayName(storage, rgPlayerId) {
    if (!storage || typeof storage.get !== "function" || !rgPlayerId) return "";
    try {
        const name = storage.get(displayNameStorageKey(rgPlayerId));
        return typeof name === "string" ? name.trim() : "";
    } catch (e) {
        return "";
    }
}


export function writeStoredDisplayName(storage, rgPlayerId, name) {
    if (!storage || typeof storage.set !== "function" || !rgPlayerId || !name) return;
    try { storage.set(displayNameStorageKey(rgPlayerId), String(name).trim()); } catch (e) {}
}


export function boardNameWithoutClanTag(name) {
    return String(name || "").trim().replace(/^\[[^\]]+\]\s*/, "").trim();
}


export function nameRowBelongsToPlayer(row, firebaseUid, rgPlayerId) {
    if (!row || typeof row !== "object") return false;
    if (firebaseUid && row.sourceUserId === firebaseUid) return true;
    if (rgPlayerId && row.rgPlayerId === rgPlayerId) return true;
    return false;
}


export function isNameTakenByOthers(rows, firebaseUid, rgPlayerId) {
    return (rows || []).some((row) => !nameRowBelongsToPlayer(row, firebaseUid, rgPlayerId));
}


export function displayNameFromLeaderboardDocs(rows, rgPlayerId) {
    return boardIdentityFromDocs(rows, rgPlayerId).displayName;
}


export function boardIdentityFromDocs(rows, rgPlayerId) {
    for (const row of rows || []) {
        if (!row || row.rgPlayerId !== rgPlayerId) continue;
        if (row.playlist === "tombstone") continue;
        return {
            displayName: boardNameWithoutClanTag(row.name).slice(0, 15),
            sourceUserId: typeof row.sourceUserId === "string" ? row.sourceUserId : "",
        };
    }
    return { displayName: "", sourceUserId: "" };
}


export function shouldPublishLeaderboardRow(existingSourceUserIds, firebaseUid) {
    const ids = Array.isArray(existingSourceUserIds)
        ? existingSourceUserIds.filter(Boolean)
        : (existingSourceUserIds ? [existingSourceUserIds] : []);
    if (ids.includes(firebaseUid)) return true;
    return ids.length === 0;
}
