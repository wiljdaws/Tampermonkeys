export function nameForgePresetKey(userId) {
  return "rgNameForge.presets.v2." + (userId || "anon");
}

export function nameForgeHistoryKey(userId) {
  return "rgNameForge.history.v2." + (userId || "anon");
}

export const PALETTES = [
  { label: '🔥 Fire', stops: ['#FF4D00', '#FFB800', '#FF0000'] },
  { label: '🌊 Ocean', stops: ['#00FFFF', '#0000FF'] }, // matches RootedEngineering ramp
  { label: '🌈 Rainbow', stops: ['#FF0000', '#FFFF00', '#00FF00', '#00BFFF', '#8B00FF'] },
  { label: '🌇 Sunset', stops: ['#FF6B6B', '#FFB347', '#8E44AD'] },
  { label: '☢️ Toxic', stops: ['#39FF14', '#CCFF00', '#00FF9F'] },
  { label: '❄️ Ice', stops: ['#E0FFFF', '#7DD3FC', '#2563EB'] },
  { label: '👑 Crown', stops: ['#7A4E00', '#E6B422', '#FFF4C2', '#C9A227'] },
  { label: '🌸 Blush', stops: ['#FF4D8D', '#FFB6D9', '#C026D3'] },
  { label: '🌌 Galaxy', stops: ['#312E81', '#7C3AED', '#F472B6', '#38BDF8'] },
  { label: '🍀 Emerald', stops: ['#064E3B', '#10B981', '#A7F3D0'] },
  { label: '🩸 Crimson', stops: ['#7F1D1D', '#EF4444', '#FCA5A5'] },
  { label: '⚡ Neon', stops: ['#22D3EE', '#E879F9', '#F472B6'] },
  { label: '🪙 Bronze', stops: ['#5C3317', '#CD7F32', '#F5D0A9'] },
  { label: '🩶 Steel', stops: ['#334155', '#94A3B8', '#F8FAFC'] },
];

export const SPRITES = [
  { n: 0,  e: '😊', label: 'Blush smile' },
  { n: 1,  e: '😋', label: 'Tongue-savoring' },
  { n: 2,  e: '😍', label: 'Heart eyes' },
  { n: 3,  e: '😎', label: 'Sunglasses' },
  { n: 4,  e: '😀', label: 'Grinning' },
  { n: 5,  e: '😄', label: 'Smile eyes' },
  { n: 6,  e: '😅', label: 'Sweat smile' },
  { n: 7,  e: '😁', label: 'Beaming' },
  { n: 8,  e: '😆', label: 'Big laugh' },
  { n: 9,  e: '😂', label: 'Tears of joy' },
  { n: 10, e: '😤', label: 'Frustrated' },
  { n: 11, e: '🤪', label: 'Zany wink' },
  { n: 12, e: '❓', label: 'Broken sprite (renders as ? box in-game)', broken: true },
  { n: 13, e: '🤣', label: 'Rolling (renders tilted in-game)' },
  { n: 14, e: '🙂', label: 'Slight smile' },
  { n: 15, e: '😕', label: 'Confused' },
];

export const spriteEmoji = (n) => (SPRITES.find(s => s.n === n) || { e: '☺' }).e;
