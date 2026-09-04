// sanitize user-editable style fields at the trust boundary. a modified
// client could push HTML-shaped strings into tagStyle.color and land
// stored XSS in every member's browser via the snapshot listener.
export function sanitizeClanDoc(clan) {
    if (!clan) return clan;
    const hexOk = v => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
    if (clan.tagStyle && typeof clan.tagStyle === "object") {
        const st = clan.tagStyle;
        const cleanMode = (["none", "solid", "gradient"].includes(st.mode)) ? st.mode : null;
        const cleanPalette = (typeof st.paletteKey === "string" && st.paletteKey.length < 40 && /^[A-Za-z0-9_-]+$/.test(st.paletteKey)) ? st.paletteKey : null;
        clan.tagStyle = {
            mode: cleanMode,
            color: hexOk(st.color) ? st.color : null,
            gradientStart: hexOk(st.gradientStart) ? st.gradientStart : null,
            gradientEnd: hexOk(st.gradientEnd) ? st.gradientEnd : null,
            bracketColor: hexOk(st.bracketColor) ? st.bracketColor : null,
            paletteKey: cleanPalette,
            bold: !!st.bold,
            italic: !!st.italic,
            waveOn: !!st.waveOn,
            waveAmp: (typeof st.waveAmp === "number" && st.waveAmp >= 0 && st.waveAmp <= 60) ? st.waveAmp : 8,
            rotateDeg: (typeof st.rotateDeg === "number" && st.rotateDeg >= -45 && st.rotateDeg <= 45) ? st.rotateDeg : 0,
        };
    }
    return clan;
}
