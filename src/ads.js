
// ---------- Ad blocker ----------
//
// Runs first so ads don't flash before the HUD is ready. Baseline
// rules cover the ad providers rocketgoal.io tends to use (Google
// AdSense/DoubleClick, DFP, Unity Ads, Applovin, IMA video). When a
// new ad slot slips through, inspect it in DevTools, grab its class
// or id, and add the selector to ATLAS_AD_SELECTORS below.

export const ATLAS_AD_SELECTORS = [
    // Google AdSense / DFP
    'ins.adsbygoogle',
    '.adsbygoogle',
    '[id^="google_ads_iframe"]',
    '[id^="google_ads_frame"]',
    '[id^="div-gpt-ad"]',
    'iframe[id^="google_ads"]',
    'iframe[src*="doubleclick.net"]',
    'iframe[src*="googlesyndication"]',
    'iframe[src*="googleadservices"]',
    'iframe[src*="googletagservices"]',
    'iframe[src*="adservice.google"]',
    '[data-ad-slot]',
    '[data-ad-client]',
    // Google IMA (interstitial video)
    '.videoAdUi',
    '.ima-ad-container',
    'iframe[src*="imasdk.googleapis.com"]',
    // Unity Ads / Applovin
    'iframe[src*="unityads"]',
    'iframe[src*="applovin"]',
    // Generic containers
    '[class*="ad-container"]',
    '[class*="ad-slot"]',
    '[class*="ad-wrapper"]',
    '[class*="ad-banner"]',
    '[id*="ad-container"]',
    '[id*="ad-slot"]',
    // Content recommendation widgets
    '[id*="taboola"]',
    '[class*="taboola"]',
    '[id*="outbrain"]',
    '[class*="outbrain"]',
];


export const ATLAS_AD_SCRIPT_HOSTS = [
    "doubleclick.net",
    "googlesyndication.com",
    "googletagservices.com",
    "googleadservices.com",
    "adservice.google.com",
    "imasdk.googleapis.com",
    "unityads.unity3d.com",
    "applovin.com",
];


export function isAtlasAdSrc(src) {
    if (!src || typeof src !== "string") return false;
    for (let i = 0; i < ATLAS_AD_SCRIPT_HOSTS.length; i++) {
        if (src.indexOf(ATLAS_AD_SCRIPT_HOSTS[i]) >= 0) return true;
    }
    return false;
}


export function tryDismissAdVideo(v) {
    if (!v || v.__atlasAdHandled) return;
    // A legit video on rocketgoal.io is unlikely (WebGL game). Any
    // large video element that renders on top is treated as an ad.
    let rect = null;
    try { rect = v.getBoundingClientRect(); } catch (e) {}
    if (!rect || rect.width < 200 || rect.height < 150) return;
    v.__atlasAdHandled = true;
    try {
        v.muted = true;
        v.pause();
        if (isFinite(v.duration) && v.duration > 0) v.currentTime = v.duration;
        v.dispatchEvent(new Event("ended"));
        v.dispatchEvent(new Event("timeupdate"));
        let parent = v.parentElement;
        let hops = 0;
        while (parent && hops < 5) {
            let cs = null;
            try { cs = getComputedStyle(parent); } catch (e) {}
            if (cs && (cs.position === "fixed" || cs.position === "absolute") && parseInt(cs.zIndex || "0", 10) > 100) {
                parent.remove();
                return;
            }
            parent = parent.parentElement;
            hops++;
        }
        v.remove();
    } catch (e) {}
}
