// ---- Utilities ----
// Tampermonkey storage survives a rocketgoal.io site-data wipe.
// Origin localStorage does not. Read TM first, then localStorage, and
// write both so a wipe still leaves presets / last name / history.
export function saveJSON(key, val) {
  const raw = JSON.stringify(val);
  try { localStorage.setItem(key, raw); } catch (e) { /* ignore */ }
  try {
    const tm = typeof atlasTmStorage === "function" ? atlasTmStorage() : null;
    if (tm) tm.set(key, raw);
  } catch (e) { /* ignore */ }
}

export function loadJSON(key, fallback) {
  try {
    let raw = null;
    try {
      const tm = typeof atlasTmStorage === "function" ? atlasTmStorage() : null;
      const fromTm = tm && tm.get(key);
      if (typeof fromTm === "string" && fromTm) raw = fromTm;
      else if (fromTm && typeof fromTm === "object") raw = JSON.stringify(fromTm);
    } catch (e) { /* ignore */ }
    if (raw == null) {
      try { raw = localStorage.getItem(key); } catch (e) { /* ignore */ }
    }
    if (!raw) return fallback;
    const val = JSON.parse(raw);
    saveJSON(key, val);
    return val;
  } catch (e) {
    return fallback;
  }
}
