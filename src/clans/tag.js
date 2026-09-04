// uppercase letters only. enforced on input and submit.
export function sanitizeClanTag(raw) {
    return String(raw || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
}

// ---------- Clan tag styling ----------
// leader owns clan.tagStyle. members opt in via localStorage so the clan
// doc doesn't balloon. getClanTagPrefix() returns TMP markup for Apply.

export const CLAN_TAG_OPTIN_KEY = "rgHudUseClanTag";

export const CLAN_TAG_POSITION_KEY = "rgHudClanTagPosition"; // "name" | "title"

export function useClanTagPref() {
    try { return localStorage.getItem(CLAN_TAG_OPTIN_KEY) === "1"; } catch { return false; }
}

export function setUseClanTagPref(on) {
    try { localStorage.setItem(CLAN_TAG_OPTIN_KEY, on ? "1" : "0"); } catch {}
}

export function clanTagPositionPref() {
    try { return localStorage.getItem(CLAN_TAG_POSITION_KEY) === "title" ? "title" : "name"; } catch { return "name"; }
}

export function setClanTagPositionPref(pos) {
    try { localStorage.setItem(CLAN_TAG_POSITION_KEY, pos === "title" ? "title" : "name"); } catch {}
}

export function _interpHex(a, b, t) {
    const ar = parseInt(a.slice(1,3),16), ag = parseInt(a.slice(3,5),16), ab_ = parseInt(a.slice(5,7),16);
    const br = parseInt(b.slice(1,3),16), bg = parseInt(b.slice(3,5),16), bb = parseInt(b.slice(5,7),16);
    const r = Math.round(ar + (br-ar)*t), g = Math.round(ag + (bg-ag)*t), bl = Math.round(ab_ + (bb-ab_)*t);
    return '#' + r.toString(16).padStart(2,'0') + g.toString(16).padStart(2,'0') + bl.toString(16).padStart(2,'0');
}

// same math Name Forge uses so tag/name gradients look the same
export function _sampleStops(stops, t) {
    if (!stops || stops.length === 0) return "#ffffff";
    if (stops.length === 1) return stops[0];
    const scaled = t * (stops.length - 1);
    const i = Math.min(Math.floor(scaled), stops.length - 2);
    return _interpHex(stops[i], stops[i + 1], scaled - i);
}

// mirrors Name Forge palettes
export const CLAN_TAG_PALETTES = [
    { key: 'fire',     label: '🔥 Fire',     stops: ['#FF4D00', '#FFB800', '#FF0000'] },
    { key: 'ocean',    label: '🌊 Ocean',    stops: ['#00FFFF', '#00CFFF'] }, // exact [KING] shimmer: K,I,N,G sample to #00FFFF,#00EFFF,#00DFFF,#00CFFF
    { key: 'rainbow',  label: '🌈 Rainbow',  stops: ['#FF0000', '#FFFF00', '#00FF00', '#00BFFF', '#8B00FF'] },
    { key: 'sunset',   label: '🌇 Sunset',   stops: ['#FF6B6B', '#FFB347', '#8E44AD'] },
    { key: 'toxic',    label: '☢️ Toxic',    stops: ['#39FF14', '#CCFF00', '#00FF9F'] },
    { key: 'ice',      label: '❄️ Ice',      stops: ['#E0FFFF', '#7DD3FC', '#2563EB'] },
    { key: 'crown',    label: '👑 Crown',    stops: ['#7A4E00', '#E6B422', '#FFF4C2', '#C9A227'] },
    { key: 'blush',    label: '🌸 Blush',    stops: ['#FF4D8D', '#FFB6D9', '#C026D3'] },
    { key: 'galaxy',   label: '🌌 Galaxy',   stops: ['#312E81', '#7C3AED', '#F472B6', '#38BDF8'] },
    { key: 'emerald',  label: '🍀 Emerald',  stops: ['#064E3B', '#10B981', '#A7F3D0'] },
    { key: 'crimson',  label: '🩸 Crimson',  stops: ['#7F1D1D', '#EF4444', '#FCA5A5'] },
    { key: 'neon',     label: '⚡ Neon',     stops: ['#22D3EE', '#E879F9', '#F472B6'] },
    { key: 'bronze',   label: '🪙 Bronze',   stops: ['#5C3317', '#CD7F32', '#F5D0A9'] },
    { key: 'steel',    label: '🩶 Steel',    stops: ['#334155', '#94A3B8', '#F8FAFC'] },
];

// palette stops if picked, else user-picked endpoints. null if not gradient.
export function _tagStops(st) {
    if (!st) return null;
    if (st.paletteKey) {
        const p = CLAN_TAG_PALETTES.find(x => x.key === st.paletteKey);
        if (p) return p.stops;
    }
    if (Array.isArray(st.stops) && st.stops.length >= 2) return st.stops;
    if (/^#[0-9a-fA-F]{6}$/.test(st.gradientStart || "") && /^#[0-9a-fA-F]{6}$/.test(st.gradientEnd || "")) {
        return [st.gradientStart, st.gradientEnd];
    }
    return null;
}

// Strip a matching plain or styled [TAG] from the start.
export function stripClanTagPrefix(raw, clanTag) {
    const tag = String(clanTag ?? "").trim();
    if (!raw || !tag) return raw || "";
    const anyTags = "(?:<[^>]*>)*";
    const escaped = [...tag.toUpperCase()].map(ch => ch.replace(/[\\^$.*+?()[\]|]/g, "\\$&"));
    const letters = escaped.map(ch => ch + anyTags).join("");
    const re = new RegExp("^" + anyTags + "\\[" + anyTags + letters + "\\]" + anyTags + "\\s*", "i");
    return raw.replace(re, "");
}

export function stripLeadingClanTagMarkup(raw) {
    return stripClanTagPrefix(raw, myClan?.tag);
}
