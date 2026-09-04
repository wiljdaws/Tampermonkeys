import { nickSafeColor } from "../shared/nickname-color.js";

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }) {
  const c = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0').toUpperCase();
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function lerp(a, b, t) { return a + (b - a) * t; }

export function lerpColor(c1, c2, t) {
  const a = hexToRgb(c1), b = hexToRgb(c2);
  return rgbToHex({ r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) });
}

export function normalizeColorSpans(spans, textLen) {
  const len = Math.max(0, Math.trunc(Number(textLen) || 0));
  return (Array.isArray(spans) ? spans : [])
    .map((span) => ({
      start: Math.max(0, Math.min(len, Math.trunc(Number(span?.start) || 0))),
      end: Math.max(0, Math.min(len, Math.trunc(Number(span?.end) || 0))),
      mode: ["none", "solid", "gradient"].includes(span?.mode) ? span.mode : "gradient",
      solid: typeof span?.solid === "string" ? span.solid : "#22d3ee",
      stops: Array.isArray(span?.stops) ? span.stops.filter((c) => typeof c === "string") : [],
      solidAlpha: Number.isFinite(Number(span?.solidAlpha)) ? Number(span.solidAlpha) : 255,
    }))
    .filter((span) => span.end > span.start);
}

export function colorStyleAt(index, spans, fallback) {
  for (let i = (spans || []).length - 1; i >= 0; i -= 1) {
    const span = spans[i];
    if (index >= span.start && index < span.end) return span;
  }
  return fallback;
}

export function splitByColorSpans(text, spans, fallback) {
  const value = String(text ?? "");
  const marks = normalizeColorSpans(spans, value.length);
  if (!marks.length) return [{ text: value, style: fallback }];
  const bounds = new Set([0, value.length]);
  for (const mark of marks) {
    bounds.add(mark.start);
    bounds.add(mark.end);
  }
  const cuts = [...bounds].sort((a, b) => a - b);
  const runs = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const start = cuts[i];
    const end = cuts[i + 1];
    if (end <= start) continue;
    runs.push({
      text: value.slice(start, end),
      style: colorStyleAt(start, marks, fallback),
    });
  }
  return runs;
}

export function cloneColorStyle(style) {
  return {
    mode: ["none", "solid", "gradient"].includes(style?.mode) ? style.mode : "gradient",
    solid: typeof style?.solid === "string" ? style.solid : "#22d3ee",
    stops: Array.isArray(style?.stops) ? style.stops.filter((c) => typeof c === "string") : [],
    solidAlpha: Number.isFinite(Number(style?.solidAlpha)) ? Number(style.solidAlpha) : 255,
  };
}

export function snapshotNameColorStyle() {
  return cloneColorStyle({
    mode: state.colorMode,
    solid: state.solidColor,
    stops: state.stops,
    solidAlpha: state.solidAlpha ?? 255,
  });
}

export function bakeUncoveredColorSpans(spans, len, style) {
  const marks = normalizeColorSpans(spans, len);
  const used = new Array(Math.max(0, len)).fill(false);
  for (const mark of marks) {
    for (let i = mark.start; i < mark.end; i += 1) used[i] = true;
  }
  const baked = marks.map((mark) => ({ ...mark, ...cloneColorStyle(mark) }));
  const fill = cloneColorStyle(style);
  let i = 0;
  while (i < len) {
    if (used[i]) { i += 1; continue; }
    let j = i + 1;
    while (j < len && !used[j]) j += 1;
    baked.push({ start: i, end: j, ...cloneColorStyle(fill) });
    i = j;
  }
  return baked;
}

export function subtractColorRange(spans, start, end) {
  const out = [];
  for (const span of spans || []) {
    if (span.end <= start || span.start >= end) {
      out.push({ ...span, ...cloneColorStyle(span) });
      continue;
    }
    if (span.start < start) {
      out.push({ ...span, start: span.start, end: start, ...cloneColorStyle(span) });
    }
    if (span.end > end) {
      out.push({ ...span, start: end, end: span.end, ...cloneColorStyle(span) });
    }
  }
  return out;
}

export function applySliceColor(spans, len, range, beforeStyle, afterStyle) {
  const next = subtractColorRange(
    bakeUncoveredColorSpans(spans, len, beforeStyle),
    range.start,
    range.end,
  );
  next.push({
    start: range.start,
    end: range.end,
    ...cloneColorStyle(afterStyle),
  });
  return normalizeColorSpans(next, len);
}

export function expandPaintHex(hex) {
  const m = String(hex || "").match(/^#([0-9A-Fa-f]{3,8})$/);
  if (!m) return null;
  let body = m[1];
  if (body.length === 3 || body.length === 4) {
    body = [...body].map((c) => c + c).join("");
  }
  const alpha = body.length >= 8 ? parseInt(body.slice(6, 8), 16) : 255;
  return {
    solid: nickSafeColor("#" + body.slice(0, 6).toUpperCase()),
    solidAlpha: Number.isFinite(alpha) ? alpha : 255,
  };
}

// Packed TMP (`<#7A4E08>.`) has no colorSpans. Paint needs those spans,
// so turn visible hex runs into slice marks aligned to state.name.
export function colorSpansFromRawName(raw, name) {
  const target = String(name ?? "");
  const src = String(raw ?? "");
  let color = null;
  const colorStack = [];
  let nameIndex = 0;
  let i = 0;
  const spans = [];
  let runStart = -1;
  let runColor = null;
  let runAlpha = 255;

  const flush = (end) => {
    if (runStart >= 0 && end > runStart && runColor) {
      spans.push({
        start: runStart,
        end,
        mode: "solid",
        solid: runColor,
        stops: [runColor],
        solidAlpha: runAlpha,
      });
    }
    runStart = -1;
    runColor = null;
    runAlpha = 255;
  };

  const takeVisible = (len) => {
    if (nameIndex >= target.length) return;
    const parsed = color ? expandPaintHex(color) : null;
    const hex = parsed?.solid || null;
    const alpha = parsed?.solidAlpha ?? 255;
    if (hex !== runColor || alpha !== runAlpha) {
      flush(nameIndex);
      if (hex) {
        runStart = nameIndex;
        runColor = hex;
        runAlpha = alpha;
      }
    }
    nameIndex += len;
  };

  while (i < src.length && nameIndex < target.length) {
    const rest = src.slice(i);
    let m;
    if ((m = rest.match(/^<br\s*\/?\s*>/i)) || rest[0] === "\n") {
      if (target[nameIndex] === "\n") takeVisible(1);
      i += m ? m[0].length : 1;
      continue;
    }
    if (rest[0] === "\r") { i += 1; continue; }
    if ((m = rest.match(/^<color=#00000000>\.*<\/color>/i)) || (m = rest.match(/^<#00000000>\./))) {
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^<(#(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8}))>/))) {
      color = m[1];
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^<color\s*=\s*(["']?)(#[0-9A-Fa-f]{3,8})\1\s*>/i))) {
      colorStack.push(color);
      color = m[2];
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^<\/color\s*>/i))) {
      color = colorStack.length ? colorStack.pop() : null;
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^<sprite=\d+\s*>/i))) {
      const glen = target.startsWith("<sprite=", nameIndex)
        ? Math.max(1, target.indexOf(">", nameIndex) - nameIndex + 1)
        : 1;
      takeVisible(glen);
      i += m[0].length;
      continue;
    }
    if (rest[0] === "<") {
      const close = rest.indexOf(">");
      if (close >= 0) { i += close + 1; continue; }
    }
    const ch = String.fromCodePoint(src.codePointAt(i));
    // Pack padding (nbsp / extra end-of-line spaces) is not in state.name.
    // Consuming name indices for those pads is what made a slice paint
    // the whole piece.
    if (ch === "\u00A0" || ch === " ") {
      const at = target[nameIndex];
      if (at === " " || at === "\u00A0") takeVisible(1);
      i += ch.length;
      continue;
    }
    takeVisible(ch.length);
    i += ch.length;
  }
  flush(nameIndex);
  return normalizeColorSpans(spans, target.length);
}

// multi-stop gradient sample at t in [0,1]
export function gradientAt(stops, t) {
  if (stops.length === 1) return nickSafeColor(stops[0].toUpperCase());
  const seg = 1 / (stops.length - 1);
  const idx = Math.min(Math.floor(t / seg), stops.length - 2);
  const localT = (t - idx * seg) / seg;
  return nickSafeColor(lerpColor(stops[idx], stops[idx + 1], localT));
}

export function alphaHex(n) {
  return Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0').toUpperCase();
}

export function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex({ r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 });
}

export function randomStops() {
  const h = Math.floor(Math.random() * 360);
  const spread = 80 + Math.floor(Math.random() * 160);
  return [h, h + spread / 2, h + spread].map((x) => hslToHex(((x % 360) + 360) % 360, 95, 55));
}

export function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
