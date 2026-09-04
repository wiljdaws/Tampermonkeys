
export function glickoOf(data, mode) {
    const g = data?.ModesGlicko?.[mode] || {};
    return {
        rating: typeof g.rating === "number" ? g.rating : null,
        displayRating: typeof g.displayRating === "number" ? g.displayRating : null,
        rd: typeof g.rd === "number" ? g.rd : null,
        vol: typeof g.vol === "number" ? g.vol : null,
    };
}

export function statsOf(data, mode) {
    const s = data?.ModesData?.[mode] || {};
    return {
        wins: typeof s.wins === "number" ? s.wins : 0,
        loses: typeof s.loses === "number" ? s.loses : 0,
        matches: typeof s.matchesPlayed === "number" ? s.matchesPlayed : 0,
    };
}

export function outcomeFromDelta(beforeStats, afterStats) {
    if (afterStats.wins > beforeStats.wins) return "W";
    if (afterStats.loses > beforeStats.loses) return "L";
    if (afterStats.matches > beforeStats.matches) return "T";
    return null;
}
