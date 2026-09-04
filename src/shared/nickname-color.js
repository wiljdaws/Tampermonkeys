// 6-as-g makes FA6 → fag. Fire oranges like #FFA600 trip the nickname API.
export function nickSafeColor(hex) {
  const raw = String(hex || "");
  const m = raw.match(/^(#?)([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?$/);
  if (!m) return raw;
  return `${m[1] || "#"}${m[2].toUpperCase().replace(/FA6/g, "FA7")}${m[3] || ""}`;
}

export function sanitizeNicknameColors(code) {
  return String(code ?? "").replace(/<#([0-9A-Fa-f]{6})>/g, (_, h) => `<${nickSafeColor("#" + h)}>`);
}
