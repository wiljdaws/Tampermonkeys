import { preserveForgeNewlines } from "./art.js";
import { alphaHex, gradientAt, splitByColorSpans } from "./paint.js";

// ------------------------------------------------------------------
// TMP code generation
// ------------------------------------------------------------------
export function colorizeText(text, mode, solid, stops, skipSpaces, waveAmp = 0, solidAlpha = 255) {
  const wave = waveAmp !== 0;
  const aaSolid = solidAlpha < 255 ? alphaHex(solidAlpha) : '';

  // fast paths when no per-letter work is needed
  if (!wave && mode === 'none') return preserveForgeNewlines(text);
  if (!wave && mode === 'solid') return `<${solid.toUpperCase()}${aaSolid}>` + preserveForgeNewlines(text);

  const tokens = tokenize(text);
  const paintable = tokens.filter(t => t.type === 'char' && !(skipSpaces && t.value === ' '));
  const n = paintable.length;
  if (n === 0) return mode === 'solid' ? `<${solid.toUpperCase()}>` + preserveForgeNewlines(text) : preserveForgeNewlines(text);

  let i = 0;
  let lastColor = null;
  let out = '';
  if (mode === 'solid') {
    out += `<${solid.toUpperCase()}${aaSolid}>`;
  }
  for (const tok of tokens) {
    if (tok.type === 'sprite') { out += tok.value; continue; }
    if (tok.type === 'br') { out += '<br>'; continue; }
    if (skipSpaces && tok.value === ' ') { out += ' '; continue; }
    if (wave) out += `<rotate=${i % 2 === 0 ? waveAmp : -waveAmp}>`;
    if (mode === 'gradient') {
      const t = n === 1 ? 0 : i / (n - 1);
      const col = gradientAt(stops, t);
      if (col !== lastColor) { out += `<${col}>`; lastColor = col; }
    }
    out += tok.value;
    i++;
  }
  if (wave) out += '<rotate=0>'; // reset so trailing title/Scored! stays level
  return out;
}

export function colorizeNamedArt(artName, s) {
  // Preview draws uncolored glyphs in light text. The nameplate default
  // is a solid accent, so "none" has to be an explicit white in-game.
  const previewMatch = (style) => {
    if (!style || style.mode === "none") {
      return {
        mode: "solid",
        solid: "#FFFFFF",
        stops: ["#FFFFFF"],
        solidAlpha: 255,
      };
    }
    return style;
  };
  const fallback = previewMatch({
    mode: s.colorMode,
    solid: s.solidColor,
    stops: s.stops,
    solidAlpha: s.solidAlpha ?? 255,
  });
  const spans = String(s.name || "").length === String(artName || "").length
    ? s.colorSpans
    : [];
  return splitByColorSpans(artName, spans, fallback).map((run) => {
    const style = previewMatch(run.style);
    return colorizeText(
      run.text,
      style.mode,
      style.solid,
      style.stops,
      s.skipSpaces,
      s.waveOn ? s.waveAmp : 0,
      style.solidAlpha ?? 255,
    );
  }).join("");
}

// chars, but <sprite=N> tags stay as single tokens
export function tokenize(text) {
  const tokens = [];
  const re = /<sprite=\d+\s*>/gi;
  let lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    for (const ch of text.slice(lastIndex, m.index)) {
      if (ch === '\r') continue;
      if (ch === '\n') tokens.push({ type: 'br', value: '<br>' });
      else tokens.push({ type: 'char', value: ch });
    }
    tokens.push({ type: 'sprite', value: m[0] });
    lastIndex = m.index + m[0].length;
  }
  for (const ch of text.slice(lastIndex)) {
    if (ch === '\r') continue;
    if (ch === '\n') tokens.push({ type: 'br', value: '<br>' });
    else tokens.push({ type: 'char', value: ch });
  }
  return tokens;
}

export function resolveTitleColorStyle(s) {
  if (s.titleColorMode === 'inherit') {
    return {
      mode: s.colorMode,
      solid: s.solidColor,
      stops: s.stops,
      alpha: s.colorMode === 'solid' ? (s.solidAlpha ?? 255) : 255,
    };
  }
  return {
    mode: s.titleColorMode,
    solid: s.titleColor,
    stops: s.titleStops,
    alpha: s.titleAlpha ?? 255,
  };
}

export function resolveSubtitleColorStyle(s) {
  if (s.subtitleColorMode === 'inherit') {
    return {
      mode: s.colorMode,
      solid: s.solidColor,
      stops: s.stops,
      alpha: s.colorMode === 'solid' ? (s.solidAlpha ?? 255) : 255,
    };
  }
  return {
    mode: s.subtitleColorMode,
    solid: s.subtitleColor,
    stops: s.subtitleStops,
    alpha: s.subtitleAlpha ?? 255,
  };
}
