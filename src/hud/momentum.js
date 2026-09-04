
// ---------- Momentum system ----------
// net MMR gained/lost this session. only tweaks title + glow speed/intensity,
// never the user's chosen colors.

export const MOMENTUM_TIERS = {
    flowState: 250,
    onFire:    150,
    heatingUp: 75,
    cold:      -20,
    shutEye:   -75,
};


export function computeMomentumState(net) {
    if (net <= MOMENTUM_TIERS.shutEye) return "shutEye";
    if (net <= MOMENTUM_TIERS.cold) return "cold";
    if (net >= MOMENTUM_TIERS.flowState) return "flowState";
    if (net >= MOMENTUM_TIERS.onFire) return "onFire";
    if (net >= MOMENTUM_TIERS.heatingUp) return "heatingUp";
    return "neutral";
}
