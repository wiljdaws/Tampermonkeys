export function getErrMsg(e) {
    return e && e.message ? e.message : String(e);
}

export function formatStackTrace(err) {
    if (!err?.stack) return null;
    return String(err.stack).split("\n").slice(0, 6).join(" | ");
}

export function showTempFeedback(el, tempText, ms = 1500, originalText) {
    const prev = originalText != null ? originalText : el.textContent;
    el.textContent = tempText;
    setTimeout(() => { el.textContent = prev; }, ms);
}

export function isVisible(el) { return !!(el && el.style.display !== "none"); }

export function isFlexVisible(el) { return !!(el && el.style.display === "flex"); }

export function isDeny(err) { return err && String(err.code || "").includes("permission-denied"); }

export function redactSupportText(value, secrets = []) {
    let safe = String(value ?? "");
    const unique = [...new Set(secrets.map(secret => String(secret ?? "")).filter(secret => secret.length >= 3))];
    for (const secret of unique) safe = safe.split(secret).join("[redacted]");
    return safe;
}


export function medianPingSample(samples) {
    const sorted = samples.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? null;
}
