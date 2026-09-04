
export function nextFirestoreBudgetWindow(window, now = Date.now()) {
    const startedAt = Number(window?.startedAt);
    if (Number.isFinite(startedAt)
        && now >= startedAt
        && now - startedAt < FIRESTORE_BUDGET_WINDOW_MS) {
        return window;
    }
    return {
        startedAt: now,
        reads: 0,
        writes: 0,
        readWarned: false,
        writeWarned: false,
    };
}


export function hudStatsToday() {
    return new Date().toISOString().slice(0, 10);
}
