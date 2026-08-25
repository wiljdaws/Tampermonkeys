// ==UserScript==
// @name         ATLAS
// @namespace    https://rocketgoal.io
// @version      25.0
// @description  The community-run live service for Rocket Goal — bearing the weight of a game the devs left behind. Full stats HUD, clan system with Clan Clash events, Name Forge for custom in-game names, leaderboard opponent popup, and anti-cheat that actually works.
// @author       JesusDied4U
// @icon         https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/atlas/atlas.png
// @match        https://rocketgoal.io/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @inject-into  page
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/rg_hud.user.js
// @downloadURL  https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/rg_hud.user.js
// @supportURL   https://github.com/wiljdaws/Tampermonkeys/issues
// ==/UserScript==

(function () {
    'use strict';

    // @grant puts Tampermonkey in the isolated world on Chrome. Game
    // fetch / console.log live on the page. Always hook that window.
    function pageWindow() {
        try {
            if (typeof unsafeWindow !== "undefined" && unsafeWindow) return unsafeWindow;
        } catch (e) {}
        return window;
    }

    // dbg() defined up top so early localStorage try/catches can call it
    const oldLog = console.log;
    const RG_DEBUG = true;
    const _rgLogBuf = [];
    const _rgWarnBuf = [];
    const _rgErrorBuf = [];
    // Ring buffer of Firestore write attempts. When a user reports a sync
    // error, this tells us the exact payload, the rule-error code, and
    // Firestore's serverResponse — everything needed to diagnose without
    // having to guess.
    const _rgWriteBuf = [];
    function _sanitizeWriteValue(v) {
        if (v === null || v === undefined) return v;
        if (typeof v === "number" || typeof v === "boolean") return v;
        if (typeof v === "string") return v.length > 512 ? `<str:len=${v.length}>` : v;
        if (Array.isArray(v)) return `<array:len=${v.length}>`;
        if (typeof v === "object") {
            // serverTimestamp() etc are SDK sentinels — mark them so we can see they were used
            if (v.constructor && v.constructor.name && v.constructor.name !== "Object") {
                return `<${v.constructor.name}>`;
            }
            const out = {};
            for (const k of Object.keys(v)) out[k] = _sanitizeWriteValue(v[k]);
            return out;
        }
        return `<${typeof v}>`;
    }
    function _pushWriteAttempt(entry) {
        _rgWriteBuf.push(entry);
        if (_rgWriteBuf.length > 40) _rgWriteBuf.shift();
    }
    function dbg(msg) {
        const line = `[RG HUD ${(performance.now() / 1000).toFixed(2)}s] ${msg}`;
        _rgLogBuf.push(line);
        if (_rgLogBuf.length > 300) _rgLogBuf.shift();
        if (RG_DEBUG) oldLog.call(console, line);
    }
    function dbgWarn(msg) {
        dbg("[WARN] " + msg);
        _rgWarnBuf.push({ msg, at: Date.now() });
        if (_rgWarnBuf.length > 5) _rgWarnBuf.shift();
        const dot = typeof document !== "undefined" && document.getElementById("rgWarnDot");
        if (dot) {
            dot.style.display = "inline";
            dot.title = _rgWarnBuf.map(w => new Date(w.at).toLocaleTimeString() + " — " + w.msg).join("\n");
        }
    }
    function getErrMsg(e) {
        return e && e.message ? e.message : String(e);
    }
    function formatStackTrace(err) {
        if (!err?.stack) return null;
        return String(err.stack).split("\n").slice(0, 6).join(" | ");
    }
    function showTempFeedback(el, tempText, ms = 1500, originalText) {
        const prev = originalText != null ? originalText : el.textContent;
        el.textContent = tempText;
        setTimeout(() => { el.textContent = prev; }, ms);
    }
    function isVisible(el) { return !!(el && el.style.display !== "none"); }
    function isFlexVisible(el) { return !!(el && el.style.display === "flex"); }
    function isDeny(err) { return err && String(err.code || "").includes("permission-denied"); }
    function currentUidForDeny() {
        try { return (typeof myUserId === "function" && myUserId()) || ""; }
        catch { return ""; }
    }
    function pushError(err, origin) {
        try {
            const message = getErrMsg(err);
            const stack = formatStackTrace(err) || "";
            _rgErrorBuf.push({ origin, msg: message, stack, at: Date.now() });
            if (_rgErrorBuf.length > 20) _rgErrorBuf.shift();
            dbg(`[ERROR:${origin}] ${message}${stack ? " :: " + stack : ""}`);
        } catch (loggingFailed) {
            try { oldLog.call(console, "[RG HUD] pushError failed:", loggingFailed); } catch (e) {}
        }
    }
    function redactSupportText(value, secrets = []) {
        let safe = String(value ?? "");
        const unique = [...new Set(secrets.map(secret => String(secret ?? "")).filter(secret => secret.length >= 3))];
        for (const secret of unique) safe = safe.split(secret).join("[redacted]");
        return safe;
    }
    // trace focus + first keystroke on an input so "can't type" bugs leave a trail
    function probeInput(el, label) {
        if (!el) { dbg(`probeInput(${label}): element missing`); return; }
        setTimeout(() => {
            try {
                const active = document.activeElement;
                const cs = window.getComputedStyle(el);
                dbg(`${label} probe: activeId=${active?.id || "none"} focused=${active === el} disabled=${el.disabled} readOnly=${el.readOnly} display=${cs.display} visibility=${cs.visibility} pointerEvents=${cs.pointerEvents}`);
            } catch (e) { pushError(e, `probeInput:${label}`); }
        }, 120);
        const onFirstInput = () => {
            dbg(`${label} first keystroke received (len=${el.value.length})`);
            el.removeEventListener("input", onFirstInput);
        };
        const onFirstBlur = () => {
            const active = document.activeElement;
            dbg(`${label} focus lost -> ${active?.id || active?.tagName || "unknown"}`);
            el.removeEventListener("focusout", onFirstBlur);
        };
        el.addEventListener("input", onFirstInput);
        el.addEventListener("focusout", onFirstBlur);
    }

    // expose on page window so DevTools "top" context can call rgDump()
    pageWindow().rgDump =
        () => oldLog.call(console, _rgLogBuf.join("\n"));

    // raw console.log/warn from the game, not just our own dbg. lets us hunt
    // for signals (team assignment, room events) without fragile snippets.
    const _rawLogBuf = [];
    function _rawPush(kind, args) {
        try {
            const parts = [];
            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if (typeof a === "string") parts.push(a);
                else { try { parts.push(JSON.stringify(a)); } catch (e) { parts.push(String(a)); } }
            }
            const line = "[" + (performance.now() / 1000).toFixed(2) + "s " + kind + "] " + parts.join(" ").slice(0, 1200);
            _rawLogBuf.push(line);
            if (_rawLogBuf.length > 800) _rawLogBuf.shift();
        } catch (e) {}
    }
    const _rawOldWarn = pageWindow().console.warn;
    pageWindow().console.warn = function () { _rawPush("warn", arguments); _rawOldWarn.apply(pageWindow().console, arguments); };
    // console.log wrapper gets set later; we install a passthrough hook via oldLog above at line 21
    // by wrapping _rawPush into the existing console.log override at the bottom of the script.

    // fullscreen textarea dump so users can select-copy the raw buffer without
    // clipboard perms or console truncation
    pageWindow().atlasCap = function () {
        const out = _rawLogBuf.join("\n");
        const t = document.createElement("textarea");
        t.value = out;
        t.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999999999;background:#000;color:#0f0;font:12px monospace;padding:8px;";
        const c = document.createElement("button");
        c.textContent = "Close";
        c.style.cssText = "position:fixed;top:8px;right:8px;z-index:9999999999;padding:6px 12px;font-size:14px;";
        c.onclick = function () { t.remove(); c.remove(); };
        document.body.appendChild(t);
        document.body.appendChild(c);
        t.focus();
        t.select();
        return "dumped " + _rawLogBuf.length + " lines";
    };
    pageWindow().atlasCapReset = function () { _rawLogBuf.length = 0; };
    // catch anything a handler throws so it lands in the debug bundle
    if (typeof window !== "undefined") {
        window.addEventListener("error", ev => {
            pushError(ev.error || ev.message || "unknown error", "window.error");
        });
        window.addEventListener("unhandledrejection", ev => {
            pushError(ev.reason || "unhandled rejection", "unhandledrejection");
        });
    }

    let hud;

    // img not emoji, stays crisp cross-OS
    const ATLAS_ICON_URL = 'https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/atlas/atlas.png';
    const atlasIconHtml = () => `<img src="${ATLAS_ICON_URL}" alt="" style="height:16px;width:16px;vertical-align:middle;margin-right:4px;object-fit:contain;">`;


    // ---------- Settings (persisted in localStorage) ----------

    const DEFAULT_SETTINGS = {
        glowEnabled: true,
        glowSpeed: 5,        // 1-10, higher = faster
        glowOpacity: 0.6,    // vibrancy
        glowColor1: "#ff7a00",
        glowColor2: "#00d4ff",
        // brings back the old 🚀 Rocket Goal HUD title
        ogTitle: false,
        // coarse browser estimate; never presented as exact Photon ping
        pingTrackerEnabled: false,
        streakSnipeEnabled: true,
    };

    let settings = { ...DEFAULT_SETTINGS };
    try {
        settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("rgHudSettings") ?? "{}") };
    } catch (e) {
        pushError(e, "loadSettings");
    }

    function saveSettings() {
        try { localStorage.setItem("rgHudSettings", JSON.stringify(settings)); }
        catch (e) { pushError(e, "saveSettings"); }
    }

    const PING_PROBE_INTERVAL_MS = 3000;
    const PING_PROBE_TIMEOUT_MS = 2500;
    let pingTrackerIntervalId = null;
    let pingTrackerProbeInFlight = false;
    let pingTrackerProbeGeneration = 0;
    let pingTrackerSamples = [];
    let pingTrackerLastRtt = null;
    function browserConnection() {
        if (typeof navigator === "undefined") return null;
        return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
    }

    function ensurePingTracker() {
        let tracker = document.getElementById("rgPingTracker");
        if (tracker || !document.body) return tracker;
        tracker = document.createElement("div");
        tracker.id = "rgPingTracker";
        tracker.setAttribute("aria-live", "off");
        tracker.style.cssText = `
            display:none;
            position:fixed;
            top:12px;
            left:12px;
            z-index:999999997;
            pointer-events:none;
            user-select:none;
            align-items:center;
            gap:5px;
            padding:0;
            border:0;
            background:transparent;
            color:#cbd5e1;
            font:600 11px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
            font-variant-numeric:tabular-nums;
            letter-spacing:.04em;
            opacity:.78;
            text-shadow:0 1px 2px #000,0 0 5px rgba(0,0,0,.85);
        `;
        tracker.innerHTML = `
            <span data-rg-rtt-dot style="width:5px;height:5px;border-radius:50%;background:#94a3b8;box-shadow:0 0 4px currentColor;"></span>
            <span data-rg-rtt-value>NET —</span>
        `;
        document.body.appendChild(tracker);
        return tracker;
    }

    function renderPingTracker(rtt = pingTrackerLastRtt, source = "active site probe") {
        const tracker = ensurePingTracker();
        if (!tracker) return;
        if (!settings.pingTrackerEnabled || !_inMatch) {
            tracker.style.display = "none";
            return;
        }
        const dot = tracker.querySelector("[data-rg-rtt-dot]");
        const value = tracker.querySelector("[data-rg-rtt-value]");
        tracker.style.display = "flex";
        if (!Number.isFinite(rtt) || rtt <= 0) {
            if (value) value.textContent = "NET —";
            if (dot) dot.style.background = "#94a3b8";
            tracker.style.color = "#cbd5e1";
            tracker.title = "Network RTT estimate is unavailable";
            return;
        }
        const rounded = Math.round(rtt);
        const color = rounded <= 60 ? "#4ade80" : rounded <= 120 ? "#facc15" : "#fb7185";
        if (value) value.textContent = `${rounded} ms`;
        if (dot) dot.style.background = color;
        tracker.style.color = color;
        tracker.title = `${source}; not exact Photon server ping`;
    }

    function medianPingSample(samples) {
        const sorted = samples.slice().sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)] ?? null;
    }

    async function probePingTracker(generation) {
        if (pingTrackerProbeInFlight || generation !== pingTrackerProbeGeneration
            || !settings.pingTrackerEnabled || !_inMatch) return;
        pingTrackerProbeInFlight = true;
        let timeoutId = null;
        try {
            const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
            if (controller) {
                timeoutId = setTimeout(() => controller.abort(), PING_PROBE_TIMEOUT_MS);
            }
            const startedAt = performance.now();
            const target = new URL("/favicon.ico", location.origin);
            target.searchParams.set("atlas_rtt", Date.now().toString(36));
            await fetch(target.href, {
                method: "HEAD",
                cache: "no-store",
                credentials: "omit",
                signal: controller?.signal,
            });
            if (generation !== pingTrackerProbeGeneration
                || !settings.pingTrackerEnabled || !_inMatch) return;
            const sample = Math.max(1, Math.round(performance.now() - startedAt));
            pingTrackerSamples.push(sample);
            if (pingTrackerSamples.length > 3) pingTrackerSamples.shift();
            pingTrackerLastRtt = medianPingSample(pingTrackerSamples);
            renderPingTracker(pingTrackerLastRtt, "Active RTT estimate to rocketgoal.io");
        } catch (e) {
            if (generation !== pingTrackerProbeGeneration
                || !settings.pingTrackerEnabled || !_inMatch) return;
            const fallback = Number(browserConnection()?.rtt);
            pingTrackerLastRtt = Number.isFinite(fallback) && fallback > 0 ? fallback : null;
            renderPingTracker(pingTrackerLastRtt, "Browser connection RTT fallback");
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
            pingTrackerProbeInFlight = false;
        }
    }

    function syncPingTracker() {
        pingTrackerProbeGeneration++;
        pingTrackerSamples = [];
        pingTrackerLastRtt = null;
        renderPingTracker();
        if (pingTrackerIntervalId) {
            clearInterval(pingTrackerIntervalId);
            pingTrackerIntervalId = null;
        }
        if (settings.pingTrackerEnabled && _inMatch) {
            const generation = pingTrackerProbeGeneration;
            probePingTracker(generation);
            pingTrackerIntervalId = setInterval(
                () => probePingTracker(generation),
                PING_PROBE_INTERVAL_MS,
            );
        }
    }

    function hexToRgba(hex, alpha) {
        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        if (!m) return hex;
        return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
    }

    function applyGlowSettings() {
        if (!hud) return;
        let styleEl = document.getElementById("rgGlowStyle");
        if (!styleEl) {
            styleEl = document.createElement("style");
            styleEl.id = "rgGlowStyle";
            document.head.appendChild(styleEl);
        }

        if (!settings.glowEnabled) {
            styleEl.textContent = "";
            hud.style.animation = "none";
            hud.style.boxShadow = "0 0 15px #00bfff55";
            return;
        }

        const c1 = hexToRgba(settings.glowColor1, Math.min(1, settings.glowOpacity * momentumGlow.intensity));
        const c2 = hexToRgba(settings.glowColor2, Math.min(1, settings.glowOpacity * momentumGlow.intensity));
        const R = 8, BLUR = 14 * momentumGlow.intensity, SPREAD = 3 * momentumGlow.intensity;

        let frames = "";
        for (let i = 0; i <= 8; i++) {
            const pct = (i * 12.5).toFixed(1);
            const angle = (i / 8) * 2 * Math.PI;
            const x = (Math.cos(angle) * R).toFixed(1);
            const y = (Math.sin(angle) * R).toFixed(1);
            frames += `${pct}% { box-shadow: ${x}px ${y}px ${BLUR.toFixed(1)}px ${SPREAD.toFixed(1)}px ${c1}, ${-x}px ${-y}px ${BLUR.toFixed(1)}px ${SPREAD.toFixed(1)}px ${c2}; }\n`;
        }

        styleEl.textContent = `@keyframes rgGlowSpin {\n${frames}}`;
        // speed 1-10 -> ~20s..1.5s
        const baseDuration = 22 - (settings.glowSpeed * 2.05);
        const duration = baseDuration / momentumGlow.speedMult;
        hud.style.boxShadow = "";
        hud.style.animation = `rgGlowSpin ${duration.toFixed(2)}s linear infinite`;
    }

    // ---------- Device ID ----------
    // Per-install UUID. Tampermonkey storage keeps it across a site-data
    // wipe so the allow-list bind does not break when Auth is restored.

    const DEVICE_ID_KEY = "rgHudDeviceId";

    function readStoredDeviceId(storage) {
        if (!storage || typeof storage.get !== "function") return "";
        try {
            const id = storage.get(DEVICE_ID_KEY);
            return typeof id === "string" ? id.trim() : "";
        } catch (e) {
            return "";
        }
    }

    function writeStoredDeviceId(storage, id) {
        if (!storage || typeof storage.set !== "function" || !id) return;
        try { storage.set(DEVICE_ID_KEY, id); } catch (e) {}
    }

    function mintDeviceId() {
        return crypto.randomUUID?.()
            || (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12));
    }

    function originDeviceStorage() {
        try {
            if (!localStorage) return null;
            return {
                get: (key) => localStorage.getItem(key),
                set: (key, value) => { localStorage.setItem(key, value); },
            };
        } catch (e) {
            return null;
        }
    }

    function getDeviceId() {
        const tm = atlasTmStorage();
        const origin = originDeviceStorage();
        let id = readStoredDeviceId(tm) || readStoredDeviceId(origin);
        if (!id) id = mintDeviceId();
        writeStoredDeviceId(origin, id);
        writeStoredDeviceId(tm, id);
        return id;
    }

    // num form lets server rules do >= checks. never write 11.10 (parseFloat).
    const SCRIPT_VERSION = (typeof GM_info !== "undefined" && GM_info?.script?.version) || "25.0";
    const SCRIPT_VERSION_NUM = parseFloat(SCRIPT_VERSION) || 0;

    // ---------- HUD ----------

    function createHUD() {
        if (hud) return;

        hud = document.createElement("div");
        hud.id = "rgHUD";

        let pos = { top: "110px", left: "", right: "20px" };
        try {
            const saved = JSON.parse(localStorage.getItem("rgHudPos") ?? "null");
            if (saved && saved.top && saved.left) {
                pos = { top: saved.top, left: saved.left, right: "auto" };
            }
        } catch (e) {
            dbg("rgHudPos parse failed, falling back to default");
        }

        hud.style.cssText = `
            position:fixed;
            top:${pos.top};
            ${pos.left ? `left:${pos.left};` : ""}
            right:${pos.right};
            width:max-content;
            min-width:250px;
            max-width:340px;
            background:rgba(18,18,22,.88);
            color:white;
            border:2px solid #00bfff;
            border-radius:12px;
            font-family:Arial,sans-serif;
            padding:10px;
            z-index:999999999;
            user-select:none;
        `;

        hud.innerHTML = `
            <style>
                #rgHUD .rgBtn {
                    flex: 1;
                    font-size: 11px;
                    padding: 6px 2px;
                    background: linear-gradient(180deg, #1c2b3a, #10181f);
                    color: #d7f3ff;
                    border: 1px solid #00bfff88;
                    border-radius: 6px;
                    cursor: pointer;
                    white-space: nowrap;
                    transition: background 0.15s ease, border-color 0.15s ease, transform 0.05s ease;
                }
                #rgHUD .rgBtn:hover {
                    background: linear-gradient(180deg, #26405a, #16222c);
                    border-color: #00bfff;
                }
                #rgHUD .rgBtn:active { transform: scale(0.96); }
                #rgHUD .rgIconBtn {
                    background: none;
                    border: 1px solid #00bfff88;
                    color: #00bfff;
                    border-radius: 4px;
                    width: 22px;
                    height: 22px;
                    font-size: 13px;
                    line-height: 1;
                    cursor: pointer;
                    flex-shrink: 0;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    padding: 0;
                    text-align: center;
                }
                #rgHUD .rgSettingRow {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 6px;
                    margin: 5px 0;
                    font-size: 12px;
                }
                #rgHUD input[type="range"] { width: 110px; }
                /* scroll inside the HUD so buttons don't fall off the bottom */
                #rgBody { max-height: calc(100vh - 170px); overflow-y: auto; overflow-x: hidden; }
                #rgHUD input[type="color"] {
                    width: 30px; height: 20px; padding: 0; border: none; background: none; cursor: pointer;
                }
                #rgNameModal {
                    position: absolute;
                    inset: 0;
                    background: rgba(10,14,18,0.96);
                    border-radius: 10px;
                    display: none;
                    flex-direction: column;
                    justify-content: center;
                    gap: 8px;
                    padding: 14px;
                    z-index: 10;
                }
                #rgNameModal input[type="text"] {
                    background: #10181f;
                    border: 1px solid #00bfff88;
                    border-radius: 6px;
                    color: #d7f3ff;
                    padding: 6px 8px;
                    font-size: 13px;
                    outline: none;
                    user-select: text;
                    -webkit-user-select: text;
                }
                #rgNameError { color: #ff6b6b; font-size: 11px; min-height: 14px; }
                #rgToast {
                    position: absolute;
                    left: 10px; right: 10px; bottom: 10px;
                    background: linear-gradient(180deg, #1c2b3a, #0d141b);
                    border: 1px solid #00bfff;
                    border-radius: 8px;
                    color: #d7f3ff;
                    font-size: 12px;
                    text-align: center;
                    padding: 8px 10px;
                    opacity: 0;
                    transition: opacity 0.2s ease, transform 0.2s ease;
                    transform: translateY(8px);
                    pointer-events: none;
                    z-index: 20;
                }
                #rgDialog {
                    position: absolute;
                    inset: 0;
                    background: rgba(10,14,18,0.96);
                    border-radius: 10px;
                    display: none;
                    flex-direction: column;
                    justify-content: center;
                    gap: 8px;
                    padding: 14px;
                    z-index: 30;
                }
                #rgDialog .rgDlgMsg { font-size: 13px; color: #d7f3ff; }
                #rgDialog input[type="text"] {
                    background: #10181f; border: 1px solid #00bfff88; border-radius: 6px;
                    color: #d7f3ff; padding: 6px 8px; font-size: 13px; outline: none;
                    user-select: text; -webkit-user-select: text;
                }
                #rgTooltip {
                    position: fixed;
                    z-index: 9999999999;
                    background: linear-gradient(180deg, #1c2b3a, #0d141b);
                    color: #d7f3ff;
                    border: 1px solid #00bfff;
                    border-radius: 6px;
                    padding: 5px 9px;
                    font-family: Arial, sans-serif;
                    font-size: 11px;
                    font-weight: bold;
                    white-space: nowrap;
                    pointer-events: none;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.5);
                    opacity: 0;
                    transition: opacity 0.12s ease;
                }
                #rgHUD .rgHasTip { cursor: help; border-bottom: 1px dotted currentColor; }
                #rgHUD .rgNoUnderline { border-bottom: none; }
            </style>
            <div style="display:flex;align-items:center;justify-content:space-between;cursor:move;gap:8px;" id="rgDragHandle">
                <span id="rgTitle" style="font-size:16px;font-weight:bold;color:#00bfff;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><img src="${ATLAS_ICON_URL}" alt="" style="height:16px;width:16px;vertical-align:middle;margin-right:4px;object-fit:contain;">ATLAS</span>
                <div style="display:flex;align-items:center;gap:5px;flex-shrink:0;">
                    <span id="rgErrDot" title="" style="display:none;color:#ff5555;font-weight:bold;font-size:14px;cursor:help;">⚠</span>
                    <span id="rgWarnDot" title="" style="display:none;color:#ffbb33;font-weight:bold;font-size:14px;cursor:help;" data-tip="ATLAS saw something unexpected (hover for details, or run rgDump() for full log)">⚑</span>
                    <button id="rgClanBtn" class="rgIconBtn" title="Clans">🛡️</button>
                    <button id="rgForgeBtn" class="rgIconBtn" title="Name Forge">🎨</button>
                    <button id="rgSettingsBtn" class="rgIconBtn" title="Settings">⚙</button>
                    <button id="rgMinimize" class="rgIconBtn" title="Minimize">–</button>
                </div>
            </div>
            <hr>
            <div id="rgBody">
                <div id="rgStatsView">
                    <div id="rgContent">Waiting for data...</div>
                    <div id="rgSettingsPanel" style="display:none;border-top:1px solid #00bfff44;margin-top:8px;padding-top:6px;">
                        <div class="rgSettingRow"><span title="Bring back the original 🚀 Rocket Goal HUD title">OG Title</span><input type="checkbox" id="rgSetOgTitle"></div>
                        <div class="rgSettingRow"><span title="Active RTT estimate to rocketgoal.io every 3 seconds; not exact Photon server ping">Network RTT</span><input type="checkbox" id="rgSetPingTracker"></div>
                        <div class="rgSettingRow"><span>Glow</span><input type="checkbox" id="rgSetGlow"></div>
                        <div class="rgSettingRow"><span>Speed</span><input type="range" id="rgSetSpeed" min="1" max="10" step="0.5"></div>
                        <div class="rgSettingRow"><span>Vibrancy</span><input type="range" id="rgSetOpacity" min="0.1" max="1" step="0.05"></div>
                        <div class="rgSettingRow"><span>Color 1</span><input type="color" id="rgSetColor1"></div>
                        <div class="rgSettingRow"><span>Color 2</span><input type="color" id="rgSetColor2"></div>
                        <div class="rgSettingRow"><span title="Show the animation after you end a tracked opponent streak">Streak snipe</span><input type="checkbox" id="rgSetStreakSnipe"></div>
                        <div class="rgSettingRow" style="flex-wrap:wrap;gap:6px;">
                            <span title="Send this to Pal or JesusDied4U if you need to be added to the board">Firebase id</span>
                            <code id="rgSetAuthUid" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:#8E9BC2;">signing in…</code>
                        </div>
                        <div class="rgSettingRow" style="flex-wrap:wrap;gap:6px;">
                            <span title="Tied to your Firebase id. Writes from another device are denied.">Device id</span>
                            <code id="rgSetDeviceId" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:#8E9BC2;"></code>
                        </div>
                        <button type="button" id="rgSetCopyIds" class="rgBtn" style="width:100%;margin-top:4px;">Copy ids</button>
                        <button id="rgSetReset" class="rgBtn" style="width:100%;margin-top:4px;">Reset to defaults</button>
                        <button id="rgSetCopyDebug" class="rgBtn" style="width:100%;margin-top:4px;">⬇ Download debug bundle</button>
                    </div>
                </div>
                <div id="rgClanView" style="display:none;">Loading clans...</div>
                <div id="rgForgeView" style="display:none;max-height:min(70vh,640px);overflow-y:auto;overflow-x:hidden;"></div>
                <div id="rgActionRow" style="margin-top:6px;display:flex;gap:4px;">
                    <button id="rgRename" class="rgBtn" style="flex:1;">✏️ Rename</button>
                    <button id="rgSub" class="rgBtn" style="flex:1;">📺 Sub</button>
                    <button id="rgLeaderboard" class="rgBtn" style="flex:2;">🏆 Leaderboard</button>
                </div>
            </div>
            <div id="rgNameModal">
                <div id="rgNameTitle" style="font-size:13px;font-weight:bold;color:#00bfff;"></div>
                <input type="text" id="rgNameInput" maxlength="15">
                <div id="rgNameError"></div>
                <div style="display:flex;gap:6px;">
                    <button id="rgNameSave" class="rgBtn">Save</button>
                    <button id="rgNameCancel" class="rgBtn">Cancel</button>
                </div>
            </div>
            <div id="rgDialog" role="dialog" aria-modal="true" aria-labelledby="rgDialogMsg">
                <div id="rgDialogMsg" class="rgDlgMsg"></div>
                <input type="text" id="rgDialogInput" style="display:none;" maxlength="200">
                <div style="display:flex;gap:6px;">
                    <button id="rgDialogOk" class="rgBtn">OK</button>
                    <button id="rgDialogCancel" class="rgBtn">Cancel</button>
                </div>
            </div>
            <div id="rgToast" role="status" aria-live="polite" aria-atomic="true"></div>
        `;

        document.body.appendChild(hud);
        clampHudOnScreen();
        window.addEventListener("resize", clampHudOnScreen);
        dragElement(hud, document.getElementById("rgDragHandle"));
        applyGlowSettings();

        // one shared tooltip, replaces native title=
        let tooltipEl = document.getElementById("rgTooltip");
        if (!tooltipEl) {
            tooltipEl = document.createElement("div");
            tooltipEl.id = "rgTooltip";
            document.body.appendChild(tooltipEl);
        }
        hud.addEventListener("mouseover", e => {
            const target = e.target.closest("[data-tip]");
            if (!target) return;
            tooltipEl.textContent = target.getAttribute("data-tip");
            tooltipEl.style.opacity = "1";
        });
        hud.addEventListener("mousemove", e => {
            if (tooltipEl.style.opacity !== "1") return;
            // above-right of cursor, kept on-screen
            const pad = 14;
            let x = e.clientX + pad;
            let y = e.clientY - tooltipEl.offsetHeight - 6;
            if (x + tooltipEl.offsetWidth > window.innerWidth) x = e.clientX - tooltipEl.offsetWidth - pad;
            if (y < 0) y = e.clientY + pad;
            tooltipEl.style.left = x + "px";
            tooltipEl.style.top = y + "px";
        });
        hud.addEventListener("mouseout", e => {
            const target = e.target.closest("[data-tip]");
            if (target) tooltipEl.style.opacity = "0";
        });
        // re-renders can yank the hovered element mid-hover
        hud.addEventListener("mouseleave", () => {
            tooltipEl.style.opacity = "0";
        });

        // blur on mouse click so spacebar in queue reaches the game, not the
        // last tabbed button. keyboard clicks (detail === 0) keep focus.
        hud.addEventListener("click", (e) => {
            const btn = e.target.closest("button");
            if (btn && e.detail !== 0) btn.blur();
        });

        document.getElementById("rgMinimize").onclick = () => manualToggle();
        document.getElementById("rgSub").onclick = () => {
            window.open("https://www.youtube.com/@RootedEngineering", "_blank", "noopener");
        };
        document.getElementById("rgLeaderboard").onclick = () => {
            const onClanTab = isVisible(document.getElementById("rgClanView"));
            const url = onClanTab
                ? "https://wiljdaws.github.io/RG_Clan_Leaderboard/"
                : "https://wiljdaws.github.io/rg_player_leaderboard/";
            window.open(url, "_blank", "noopener");
        };
        document.getElementById("rgRename").onclick = () => {
            dbg(`Rename me clicked (hasPlayer=${!!lastKnownPlayerData})`);
            if (!lastKnownPlayerData) {
                showNameModal("Play a match or log in first!", "", false, () => {});
                hideNameModalSoon();
                return;
            }
            forceRenamePrompt = true;
            submitToLeaderboard(lastKnownPlayerData);
        };

        const statsView = document.getElementById("rgStatsView");
        const clanView = document.getElementById("rgClanView");
        const panel = document.getElementById("rgSettingsPanel");
        const forgeView = document.getElementById("rgForgeView");
        const body = document.getElementById("rgBody");
        const actionRow = document.getElementById("rgActionRow");
        function showStatsOnly() {
            clanView.style.display = "none";
            forgeView.style.display = "none";
            panel.style.display = "none";
            statsView.style.display = "block";
            actionRow.style.display = "flex";
            body.scrollTop = 0;
            // drop clan listener when nobody's looking
            detachClanListener();
        }
        document.getElementById("rgClanBtn").onclick = () => {
            const showingClan = isVisible(clanView);
            dbg(`Clan panel ${showingClan ? "closed" : "opened"}`);
            if (showingClan) { showStatsOnly(); return; }
            showStatsOnly();
            statsView.style.display = "none";
            clanView.style.display = "block";
            renderClanView(); // listener attaches once myClan is known
        };

        document.getElementById("rgForgeBtn").onclick = () => {
            const showingForge = isVisible(forgeView);
            dbg(`Forge panel ${showingForge ? "closed" : "opened"}`);
            if (showingForge) { showStatsOnly(); return; }
            showStatsOnly();
            statsView.style.display = "none";
            forgeView.style.display = "block";
            actionRow.style.display = "none"; // hide leaderboard/sub in forge
            if (RGNF.setPrefixProvider) RGNF.setPrefixProvider(getClanTagPrefix);
    if (RGNF.setPrefixTargetProvider) RGNF.setPrefixTargetProvider(clanTagPositionPref);
            if (RGNF.setTagStripper) RGNF.setTagStripper(stripLeadingClanTagMarkup);
            // tag prefix needs myClan; a prior failed reload used to wipe it
            loadClanData().then(() => { if (RGNF.refresh) RGNF.refresh(); }).catch(() => {});
            // imposter roster: last game's players minus you, minus profanity
            if (RGNF.setRosterProvider) RGNF.setRosterProvider(
                () => lastGamePlayers
                    .filter(p => !p.uid || p.uid !== myUserId())
                    .filter(p => p.name !== (lastKnownPlayerData?.Nickname ?? ""))
                    .filter(p => !containsProfanity(p.name.replace(/<[^>]*>/g, "")))
                    .map(p => p.name)
            );
            // fresh install / cached state can otherwise greet the wrong name
            if (RGNF.syncToCurrentPlayer) RGNF.syncToCurrentPlayer(myUserId(), myGameNamePlain() || myName(), stripLeadingClanTagMarkup(lastKnownPlayerData?.Nickname ?? ""));
            RGNF.mountIn(forgeView);
            // syncToCurrentPlayer only renders on account change
            if (RGNF.refresh) RGNF.refresh();
        };

        // route through showStatsOnly so opening from Forge doesn't stack views
        document.getElementById("rgSettingsBtn").onclick = () => {
            const opening = !isVisible(panel);
            dbg(`Settings panel ${opening ? "opened" : "closed"}`);
            showStatsOnly();
            if (opening) {
                panel.style.display = "block";
                paintAuthUid();
                initFirebase().then(paintAuthUid).catch(() => paintAuthUid());
            }
        };

        const setGlow = document.getElementById("rgSetGlow");
        const setSpeed = document.getElementById("rgSetSpeed");
        const setOpacity = document.getElementById("rgSetOpacity");
        const setColor1 = document.getElementById("rgSetColor1");
        const setColor2 = document.getElementById("rgSetColor2");

        const setOgTitle = document.getElementById("rgSetOgTitle");
        const setPingTracker = document.getElementById("rgSetPingTracker");
        const setStreakSnipe = document.getElementById("rgSetStreakSnipe");
        function syncSettingInputs() {
            setOgTitle.checked = !!settings.ogTitle;
            setPingTracker.checked = !!settings.pingTrackerEnabled;
            setStreakSnipe.checked = settings.streakSnipeEnabled !== false;
            setGlow.checked = settings.glowEnabled;
            setSpeed.value = settings.glowSpeed;
            setOpacity.value = settings.glowOpacity;
            setColor1.value = settings.glowColor1;
            setColor2.value = settings.glowColor2;
        }
        syncSettingInputs();

        setOgTitle.onchange = () => {
            settings.ogTitle = setOgTitle.checked;
            saveSettings();
            applyTitle();
        };
        setPingTracker.onchange = () => {
            settings.pingTrackerEnabled = setPingTracker.checked;
            saveSettings();
            syncPingTracker();
        };
        setStreakSnipe.onchange = () => {
            settings.streakSnipeEnabled = setStreakSnipe.checked;
            saveSettings();
        };
        const bindGlow = (el, key, readValue, evt = "oninput") => {
            el[evt] = () => { settings[key] = readValue(el); saveSettings(); applyGlowSettings(); };
        };
        bindGlow(setGlow, "glowEnabled", el => el.checked, "onchange");
        bindGlow(setSpeed, "glowSpeed", el => parseFloat(el.value));
        bindGlow(setOpacity, "glowOpacity", el => parseFloat(el.value));
        bindGlow(setColor1, "glowColor1", el => el.value);
        bindGlow(setColor2, "glowColor2", el => el.value);
        const copyIds = document.getElementById("rgSetCopyIds");
        paintAuthUid();
        if (copyIds) {
            copyIds.onclick = async () => {
                if (!firebaseAuthUid) {
                    showToast("Wait until Firebase id finishes signing in.");
                    return;
                }
                const deviceId = getDeviceId();
                if (!deviceId) return;
                try {
                    await navigator.clipboard.writeText(
                        `Firebase ID: ${firebaseAuthUid}\nDevice ID: ${deviceId}`
                    );
                    showTempFeedback(copyIds, "Copied", 1600, "Copy ids");
                } catch (e) {
                    showTempFeedback(copyIds, "Fail", 1600, "Copy ids");
                }
            };
        }

        document.getElementById("rgSetReset").onclick = () => {
            dbg("Settings reset to defaults");
            settings = { ...DEFAULT_SETTINGS };
            saveSettings();
            syncSettingInputs();
            applyGlowSettings();
            applyTitle();
            syncPingTracker();
        };

        // trim player data, don't dump the whole login blob
        document.getElementById("rgSetCopyDebug").onclick = () => {
            dbg("Download debug bundle clicked");
            try {
                const trimmedPlayer = lastKnownPlayerData ? {
                    Id: lastKnownPlayerData.Id,
                    Nickname: lastKnownPlayerData.Nickname,
                    ModesGlicko: lastKnownPlayerData.ModesGlicko,
                    ModesData: lastKnownPlayerData.ModesData,
                } : null;
                // snapshot of what the user is looking at, so "click didn't work"
                // bugs show whether the dialog was even visible.
                const ui = (() => {
                    const q = id => document.getElementById(id);
                    const dlg = q("rgDialog");
                    return {
                        hudExists: !!q("rgHUD"),
                        clanViewOpen: isVisible(q("rgClanView")),
                        forgeViewOpen: isVisible(q("rgForgeView")),
                        settingsOpen: isVisible(q("rgSettingsPanel")),
                        dialogOpen: isFlexVisible(dlg),
                    };
                })();
                // Enough layout detail to reproduce UI bugs without a device fingerprint.
                const device = (() => {
                    const n = typeof navigator !== "undefined" ? navigator : {};
                    const s = typeof screen !== "undefined" ? screen : {};
                    return {
                        deviceClass: (n.maxTouchPoints ?? 0) > 0 ? "touch" : "pointer",
                        touch: (n.maxTouchPoints ?? 0) > 0,
                        screen: `${s.width || 0}x${s.height || 0}`,
                        viewport: `${window.innerWidth || 0}x${window.innerHeight || 0}`,
                        pixelRatio: window.devicePixelRatio || 1,
                    };
                })();
                const bundle = {
                    version: SCRIPT_VERSION,
                    versionNum: SCRIPT_VERSION_NUM,
                    firebaseId: firebaseAuthUid || "",
                    deviceId: getDeviceId() || "",
                    device,
                    timestamp: new Date().toISOString(),
                    settings: settings,
                    player: trimmedPlayer,
                    state: {
                        _inMatch,
                        _liveRoster: _liveRoster.length,
                        lastGamePlayers: lastGamePlayers.length,
                        _lastInitLineAt,
                        _lastRecoverySignalAt,
                        _lastValidRatingsAt,
                        networkRttEstimateMs: pingTrackerLastRtt,
                    },
                    firestore: {
                        reads: firestoreReadCount,
                        writes: firestoreWriteCount,
                        windowReads: firestoreBudgetWindow.reads,
                        windowWrites: firestoreBudgetWindow.writes,
                        windowMinutes: FIRESTORE_BUDGET_WINDOW_MS / 60000,
                        readBudget: FIRESTORE_READ_BUDGET,
                        writeBudget: FIRESTORE_WRITE_BUDGET,
                    },
                    ui,
                    clan: myClan ? {
                        id: myClan.id,
                        name: myClan.name,
                        tag: myClan.tag,
                        role: myClanRole?.(),
                        memberCount: clanMembers(myClan).length,
                        eventScore: computeClanEventScore(myClan),
                    } : null,
                    event: eventConfig ? {
                        name: eventConfig.name,
                        phase: eventPhase(),
                    } : null,
                    warnings: _rgWarnBuf,
                    errors: _rgErrorBuf,
                    firestoreWrites: _rgWriteBuf,
                    log: _rgLogBuf.slice(-100),
                };
                const redactions = [
                    typeof navigator !== "undefined" ? navigator.userAgent : "",
                    lastKnownPlayerData?.Id,
                ];
                const stamp = new Date().toISOString().replace(/[:.]/g, "-");
                const filename = `atlas-debug-${stamp}.txt`;
                const payload = {
                    bundle,
                    rgDump: _rgLogBuf.slice(),
                };
                const text = JSON.stringify(payload, null, 2);
                const safeText = redactSupportText(text, redactions);
                const url = URL.createObjectURL(new Blob([safeText], {
                    type: "text/plain;charset=utf-8",
                }));
                const link = document.createElement("a");
                link.href = url;
                link.download = filename;
                link.style.display = "none";
                document.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 0);
                showToast(`Downloaded ${filename}`);
            } catch (e) {
                pushError(e, "downloadDebugBundle");
                console.error("[RG HUD] Download debug bundle failed:", e);
                showToast("Download failed — see console");
            }
        };

        // handler early-returns when no banner is up
        if (!countdownIntervalId) {
            countdownIntervalId = setInterval(tickCountdown, 1000);
        }
    }

    function clampHudOnScreen() {
        if (!hud) return;
        // hidden HUD returns zeros from getBoundingClientRect and we'd
        // persist top-left as the "corrected" pos. re-clamps on show.
        if (!isVisible(hud) || hud.offsetWidth === 0) return;
        const rect = hud.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const MARGIN = 40;

        let left = rect.left;
        let top = rect.top;

        if (left + rect.width < MARGIN) left = MARGIN - rect.width;
        if (left > vw - MARGIN) left = vw - MARGIN;
        if (top < 0) top = 0;
        if (top > vh - MARGIN) top = vh - MARGIN;

        if (left !== rect.left || top !== rect.top) {
            hud.style.left = left + "px";
            hud.style.top = top + "px";
            hud.style.right = "auto";
            try {
                localStorage.setItem("rgHudPos", JSON.stringify({
                    top: hud.style.top,
                    left: hud.style.left,
                }));
            } catch (e) {}
        }
    }

    function dragElement(el, handle) {
        let dx = 0, dy = 0;

        // addEventListener instead of document.onmousemove= so we don't
        // clobber any other drag handler the page or game already set.
        handle.onmousedown = e => {
            if (e.target.closest(".rgIconBtn")) return;
            e.preventDefault();
            dx = e.clientX;
            dy = e.clientY;
            const onUp = () => {
                document.removeEventListener("mousemove", drag);
                document.removeEventListener("mouseup", onUp);
                try {
                    localStorage.setItem("rgHudPos", JSON.stringify({
                        top: el.style.top,
                        left: el.style.left,
                    }));
                } catch (err) {
                    dbg("rgHudPos save on drag-end failed");
                }
            };
            document.addEventListener("mousemove", drag);
            document.addEventListener("mouseup", onUp);
        };

        function drag(e) {
            e.preventDefault();
            const moveX = dx - e.clientX;
            const moveY = dy - e.clientY;
            dx = e.clientX;
            dy = e.clientY;
            // clamp: title bar is the only drag handle, off-screen strands the HUD
            const MARGIN = 40;
            let newTop = el.offsetTop - moveY;
            let newLeft = el.offsetLeft - moveX;
            newTop = Math.max(0, Math.min(newTop, window.innerHeight - MARGIN));
            newLeft = Math.max(MARGIN - el.offsetWidth, Math.min(newLeft, window.innerWidth - MARGIN));
            el.style.top = newTop + "px";
            el.style.left = newLeft + "px";
            el.style.right = "auto";
        }
    }

    function manualToggle() {
        const body = document.getElementById("rgBody");
        const visible = isVisible(body);
        body.style.display = visible ? "none" : "block";
        document.getElementById("rgMinimize").textContent = visible ? "+" : "–";
        document.getElementById("rgMinimize").title = visible ? "Restore" : "Minimize";
    }

    function setAutoVisible(visible) {
        if (!hud) return;
        // Private-match → main-menu tears down our parent. Re-attach if
        // we got orphaned, otherwise setting display on it is a no-op.
        if (!hud.isConnected) {
            try { document.body.appendChild(hud); } catch { /* ignore */ }
        }
        hud.style.display = visible ? "block" : "none";
        if (!visible) {
            // tooltip lives on body, kill it or it strands over the game
            const tip = document.getElementById("rgTooltip");
            if (tip) tip.style.opacity = "0";
        }
        // re-clamp on show, window may have resized while hidden
        if (visible) clampHudOnScreen();
    }

    // ---------- Error indicator ----------

    function formatAtlasError(message) {
        const raw = String(message || "Something failed").trim()
            .replace(/\s*(?:—|--).*$/, "")
            .replace(/\.+$/, "");
        const head = /fail/i.test(raw) ? raw : `${raw} failed`;
        if (/JesusDied4U/i.test(head)) return head;
        return `${head}, message JesusDied4U in Discord`;
    }

    function showError(message) {
        const text = formatAtlasError(message);
        const dot = document.getElementById("rgErrDot");
        if (dot) {
            dot.style.display = "inline";
            const fromBuf = _rgErrorBuf.slice(-5).map(e => {
                const when = e.at ? new Date(e.at).toLocaleTimeString() + " — " : "";
                return when + (e.origin ? `[${e.origin}] ` : "") + (e.msg || "");
            }).filter(Boolean);
            const lines = [text, ...fromBuf].filter(Boolean);
            dot.title = lines.join("\n") || text;
        }
    }

    function clearError() {
        const dot = document.getElementById("rgErrDot");
        if (dot) dot.style.display = "none";
    }

    // ---------- Win/loss streak tracking ----------
    // game only gives cumulative totals — diff between updates for per-match.
    // +ve = win streak, -ve = loss streak. resets on account change / session end.

    let streakData = null;
    try { streakData = JSON.parse(localStorage.getItem("rgHudStreak") ?? "null"); }
    catch (e) { pushError(e, "loadStreak"); }

    function saveStreak() {
        try { localStorage.setItem("rgHudStreak", JSON.stringify(streakData)); }
        catch (e) { pushError(e, "saveStreak"); }
    }

    function resetStreak(accountId, totalWins, totalMatches) {
        streakData = { accountId, streak: 0, lastWins: totalWins, lastMatches: totalMatches };
        saveStreak();
    }

    function updateStreak(data) {
        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        const totalWins = modes.reduce((s, m) => s + (data.ModesData?.[m]?.wins ?? 0), 0);
        const totalMatches = modes.reduce((s, m) => s + (data.ModesData?.[m]?.matchesPlayed ?? 0), 0);

        // first observation, baseline only
        if (!streakData || streakData.accountId !== data.Id) {
            resetStreak(data.Id, totalWins, totalMatches);
            return;
        }

        const matchDiff = totalMatches - streakData.lastMatches;
        const winDiff = totalWins - streakData.lastWins;

        if (matchDiff <= 0) return;

        // no way to know interleaving. pure win/loss block extends the streak,
        // mixed collapses to net sign, magnitude 1
        const losses = matchDiff - winDiff;
        if (winDiff > 0 && losses === 0) {
            streakData.streak = streakData.streak > 0 ? streakData.streak + winDiff : winDiff;
        } else if (losses > 0 && winDiff === 0) {
            streakData.streak = streakData.streak < 0 ? streakData.streak - losses : -losses;
        } else {
            streakData.streak = winDiff >= losses ? 1 : -1;
        }

        streakData.lastWins = totalWins;
        streakData.lastMatches = totalMatches;
        saveStreak();
        return {
            matches: matchDiff,
            wins: Math.max(0, Math.min(matchDiff, winDiff)),
            losses: Math.max(0, Math.min(matchDiff, losses)),
            streak: streakData.streak,
        };
    }

    function streakBadge() {
        if (!streakData || streakData.streak === 0) return "";
        const n = streakData.streak;
        if (n > 0) {
            return `<span class="rgHasTip rgNoUnderline" data-tip="${n}-win streak this session" style="color:#ff7a00;font-weight:bold;">🔥x${n}</span>`;
        }
        return `<span class="rgHasTip rgNoUnderline" data-tip="${-n}-loss streak this session" style="color:#7ec8ff;font-weight:bold;">❄️x${-n}</span>`;
    }

    // ---------- Session deltas ----------

    // one continuous play run. resets on account change or SESSION_IDLE_MS.
    // localStorage + timestamp: refresh keeps it, overnight starts fresh.
    const SESSION_IDLE_MS = 2 * 60 * 60 * 1000; // 2h

    let sessionStart = null;
    try { sessionStart = JSON.parse(localStorage.getItem("rgHudSessionStart") ?? "null"); }
    catch (e) { pushError(e, "loadSessionStart"); }

    function captureSessionStart(data) {
        const now = Date.now();
        const sameAccount = sessionStart && sessionStart.accountId === data.Id;
        const idledOut = sessionStart && (now - (sessionStart.lastSeen ?? 0)) > SESSION_IDLE_MS;

        if (sameAccount && !idledOut) {
            // same session, bump timestamp
            sessionStart.lastSeen = now;
            try { localStorage.setItem("rgHudSessionStart", JSON.stringify(sessionStart)); }
            catch (e) { pushError(e, "saveSessionStart"); }
            return;
        }

        // new session, fresh baseline, drop inherited momentum
        sessionStart = {
            accountId: data.Id,
            startedAt: now,
            lastSeen: now,
            Competitive3v3: data.ModesGlicko?.Competitive3v3?.displayRating ?? null,
            Competitive2v2: data.ModesGlicko?.Competitive2v2?.displayRating ?? null,
            Competitive1v1: data.ModesGlicko?.Competitive1v1?.displayRating ?? null,
            Casual: data.ModesGlicko?.Casual?.displayRating ?? null,
        };
        try { localStorage.setItem("rgHudSessionStart", JSON.stringify(sessionStart)); } catch (e) {}
        currentMomentumState = "neutral";
        resetAccountRankState();

        // reset streak, don't count pre-session matches
        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        const tw = modes.reduce((s, m) => s + (data.ModesData?.[m]?.wins ?? 0), 0);
        const tm = modes.reduce((s, m) => s + (data.ModesData?.[m]?.matchesPlayed ?? 0), 0);
        resetStreak(data.Id, tw, tm);

        // bust clan cache on account change
        clanLoaded = false;
        clanLoadedForAccount = null;
        myClan = null;
        scheduleClanNoticeCheck();
        const clanView = document.getElementById("rgClanView");
        if (isVisible(clanView)) {
            renderClanView();
        }
    }

    function deltaBadge(mode, current) {
        if (!sessionStart || typeof current !== "number" || typeof sessionStart[mode] !== "number") return "";
        const diff = current - sessionStart[mode];
        if (diff === 0) return "";
        const color = diff > 0 ? "#00ff66" : "#ff6b6b";
        const sign = diff > 0 ? "+" : "";
        return ` <span style="color:${color};font-size:10px;">(${sign}${diff})</span>`;
    }


    // ---------- Ranks ----------

    const cachedRanks = new Map();      // playlist -> rank
    const cachedMmrToNext = new Map();  // playlist -> mmr gap to next rank (null if #1)

    function rankBadge(playlist) {
        const r = cachedRanks.get(playlist);
        if (!r) return "";

        // gold top 3, purple top 10, cyan top 25, gray beyond
        let color;
        if (r <= 3) color = "#ffd700";
        else if (r <= 10) color = "#c77dff";
        else if (r <= 25) color = "#00d4ff";
        else color = "#9aa5ad";

        const gap = cachedMmrToNext.get(playlist);
        let tip;
        if (r === 1) tip = "You're #1! 👑";
        else if (typeof gap === "number") tip = `+${gap} MMR to reach #${r - 1}`;
        else tip = `Rank #${r}`;

        return ` <span class="rgHasTip" data-tip="${tip}" style="color:${color};font-size:10px;font-weight:bold;">#${r}</span>`;
    }

    // ---------- Crown system ----------
    // KING title while holding any #1. banners on coronation + dethrone.

    const prevRanks = new Map(); // playlist -> last known rank

    // ---------- Momentum system ----------
    // net MMR gained/lost this session. only tweaks title + glow speed/intensity,
    // never the user's chosen colors.

    const MOMENTUM_TIERS = {
        flowState: 250,
        onFire:    150,
        heatingUp: 75,
        cold:      -20,
        shutEye:   -75,
    };

    const SHUT_EYE_MESSAGES = [
        "😴 Maybe it's time for some shut-eye?",
        "😴 The ball will still be here tomorrow...",
        "🛌 Consider: a strategic nap.",
        "☕ Touch grass? Or at least grab a coffee.",
        "😅 Rough one. Shake it off, champ.",
    ];
    let shutEyeMessage = SHUT_EYE_MESSAGES[Math.floor(Math.random() * SHUT_EYE_MESSAGES.length)];

    // read by applyGlowSettings
    let momentumGlow = { speedMult: 1, intensity: 1 };
    let currentMomentumState = "neutral";

    function netSessionMMR() {
        if (!sessionStart || !lastKnownPlayerData) return 0;
        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        let net = 0;
        for (const m of modes) {
            const cur = lastKnownPlayerData.ModesGlicko?.[m]?.displayRating;
            const start = sessionStart[m];
            if (typeof cur === "number" && typeof start === "number") net += cur - start;
        }
        return net;
    }

    function computeMomentumState(net) {
        if (net <= MOMENTUM_TIERS.shutEye) return "shutEye";
        if (net <= MOMENTUM_TIERS.cold) return "cold";
        if (net >= MOMENTUM_TIERS.flowState) return "flowState";
        if (net >= MOMENTUM_TIERS.onFire) return "onFire";
        if (net >= MOMENTUM_TIERS.heatingUp) return "heatingUp";
        return "neutral";
    }

    // priority: crown > clash lead > momentum > default
    function resolveTitle() {
        const holdingAnyFirst = [...cachedRanks.values()].some(r => r === 1);
        if (holdingAnyFirst) return { text: "👑 Rocket Goal KING", color: "#ffd700" };
        if (isMyClanLeadingClash()) return { text: "👑 Leading the Clash", color: "#ffd700" };

        switch (currentMomentumState) {
            case "shutEye":   return { text: shutEyeMessage, color: "#9aa5ad" };
            case "cold":      return { text: "❄️ Ice Cold", color: "#7ec8ff" };
            case "flowState": return { text: "🏄 Flow State", color: "#b14bff" };
            case "onFire":    return { text: "🔥 ON FIRE", color: "#ff5b1f" };
            case "heatingUp": return { text: "🔥 Heating Up", color: "#ff9a3c" };
            default:
                if (settings.ogTitle) return { text: "🚀 Rocket Goal HUD", color: "#00bfff" };
                return { text: atlasIconHtml() + "ATLAS", color: "#00bfff", html: true };
        }
    }

    function applyTitle() {
        const titleEl = document.getElementById("rgTitle");
        if (!titleEl) return;
        const { text, color, html } = resolveTitle();
        // html:true only for the ATLAS default (own img)
        if (html) titleEl.innerHTML = text;
        else titleEl.textContent = text;
        titleEl.style.color = color;
    }

    function updateMomentum(forceState = null) {
        const newState = forceState ?? computeMomentumState(netSessionMMR());
        const changed = newState !== currentMomentumState;
        currentMomentumState = newState;

        switch (newState) {
            case "flowState": momentumGlow = { speedMult: 3.0, intensity: 1.8 }; break;
            case "onFire":    momentumGlow = { speedMult: 2.2, intensity: 1.5 }; break;
            case "heatingUp": momentumGlow = { speedMult: 1.5, intensity: 1.2 }; break;
            case "cold":      momentumGlow = { speedMult: 0.5, intensity: 0.7 }; break;
            case "shutEye":   momentumGlow = { speedMult: 0.35, intensity: 0.55 }; break;
            default:          momentumGlow = { speedMult: 1, intensity: 1 };
        }

        applyGlowSettings();
        applyTitle();

        if (changed) {
            if (newState === "flowState") showBanner("🏄 FLOW STATE ACHIEVED!", "#b14bff");
            else if (newState === "onFire") showBanner("🔥 YOU'RE ON FIRE!", "#ff5b1f");
            else if (newState === "shutEye") {
                shutEyeMessage = SHUT_EYE_MESSAGES[Math.floor(Math.random() * SHUT_EYE_MESSAGES.length)];
                showBanner(shutEyeMessage, "#9aa5ad");
            }
        }
    }

    let bannerTimeout = null;

    function showBanner(text, color) {
        createHUD();
        let banner = document.getElementById("rgBanner");
        if (!banner) {
            banner = document.createElement("div");
            banner.id = "rgBanner";
            banner.style.cssText = `
                position:absolute;
                top:-38px;
                left:0;
                right:0;
                text-align:center;
                font-weight:bold;
                font-size:13px;
                padding:6px 8px;
                border-radius:8px;
                background:rgba(10,14,18,0.95);
                border:1px solid;
                opacity:0;
                transition:opacity 0.4s ease, transform 0.4s ease;
                transform:translateY(6px);
                pointer-events:none;
            `;
            hud.appendChild(banner);
        }

        banner.textContent = text;
        banner.style.color = color;
        banner.style.borderColor = color;

        requestAnimationFrame(() => {
            banner.style.opacity = "1";
            banner.style.transform = "translateY(0)";
        });

        clearTimeout(bannerTimeout);
        bannerTimeout = setTimeout(() => {
            banner.style.opacity = "0";
            banner.style.transform = "translateY(6px)";
        }, 3500);
    }

    function checkRankTransitions() {
        for (const [playlist, rank] of cachedRanks) {
            const prev = prevRanks.get(playlist);

            // need a prior non-#1 baseline, else this fires on session start
            if (rank === 1 && typeof prev === "number" && prev !== 1) {
                showBanner(`👑 NEW #1 IN ${playlist.toUpperCase()}!`, "#ffd700");
            }

            if (prev === 1 && rank !== 1) {
                showBanner(`⚔️ Dethroned in ${playlist.toUpperCase()}!`, "#ff6b6b");
            }

            prevRanks.set(playlist, rank);
        }

        applyTitle();
    }

    // ---------- HUD content ----------

    // renders only when event is active + we're in a clan with a baseline.
    // returns "" so callers can splice unconditionally.
    function clashMiniBarHtml() {
        try {
            if (typeof eventPhase !== "function" || eventPhase() !== "active") return "";
            if (!myClan) return "";
            const uid = myUserId();
            const contrib = myEventContribution(myClan, uid);
            const clanScore = computeClanEventScore(myClan);
            const standings = eventStandings();
            const rank = standings.findIndex(c => c.id === myClan.id) + 1;
            if (!rank) return ""; // baseline not landed yet
            const cSign = (contrib ?? 0) >= 0 ? "+" : "";
            const cColor = (contrib ?? 0) >= 0 ? "#00ff66" : "#ff6b6b";
            const clanSign = clanScore >= 0 ? "+" : "";
            const clanColor = clanScore >= 0 ? "#00ff66" : "#ff6b6b";
            const rankColor = rank === 1 ? "#ffd700" : (rank <= 3 ? "#00bfff" : "#ffffff");
            return `
                <hr style="border:none;border-top:1px solid #00bfff44;margin:8px 0 6px;">
                <div style="font-size:11px;line-height:1.4;">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <span><b>👑 Clash</b> <span style="color:${rankColor};">#${rank}/${standings.length}</span></span>
                        <span style="opacity:.7;">${escapeHtml(String(eventConfig?.name || ""))}</span>
                    </div>
                    <div style="opacity:.9;margin-top:2px;">
                        You <span style="color:${cColor};">${cSign}${typeof contrib === "number" ? contrib : "—"}</span>
                        <span style="opacity:.4;">•</span>
                        Clan <span style="color:${clanColor};">${clanSign}${clanScore}</span>
                    </div>
                </div>
            `;
        } catch (e) {
            // decorative, never break render for this
            dbg("clashMiniBarHtml threw: " + getErrMsg(e));
            return "";
        }
    }

    // ------------------------------------------------------------------
    // Match snapshots — record before/after Glicko + roster per match end
    // so we can reverse-engineer the game's display-rating formula.
    // ------------------------------------------------------------------
    const RECENT_MATCHES_CAP = 5;        // shipped in script_submissions
    const MATCH_HISTORY_CAP = 50;        // localStorage personal history
    const MATCH_HISTORY_STORAGE_PREFIX = "rgAtlas.matchHistory.v1.";
    const MODES_FOR_SNAPSHOTS = [
        "Competitive1v1", "Competitive2v2", "Competitive3v3", "Casual",
    ];
    // In-memory ring; hydrated from localStorage on first use.
    let _recentMatchesRing = null;
    // Guard against writing the same matchId twice (rehydration / re-fetch).
    const _seenMatchIds = new Set();

    function loadMatchHistory(uid) {
        if (!uid) return [];
        try {
            const raw = localStorage.getItem(MATCH_HISTORY_STORAGE_PREFIX + uid);
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
    }
    function saveMatchHistory(uid, ring) {
        if (!uid) return;
        try {
            const trimmed = ring.slice(-MATCH_HISTORY_CAP);
            localStorage.setItem(MATCH_HISTORY_STORAGE_PREFIX + uid, JSON.stringify(trimmed));
        } catch { /* full storage or private mode — non-fatal */ }
    }
    function ensureRingHydrated(uid) {
        if (_recentMatchesRing === null) _recentMatchesRing = loadMatchHistory(uid);
    }

    function glickoOf(data, mode) {
        const g = data?.ModesGlicko?.[mode] || {};
        return {
            rating: typeof g.rating === "number" ? g.rating : null,
            displayRating: typeof g.displayRating === "number" ? g.displayRating : null,
            rd: typeof g.rd === "number" ? g.rd : null,
            vol: typeof g.vol === "number" ? g.vol : null,
        };
    }
    function statsOf(data, mode) {
        const s = data?.ModesData?.[mode] || {};
        return {
            wins: typeof s.wins === "number" ? s.wins : 0,
            loses: typeof s.loses === "number" ? s.loses : 0,
            matches: typeof s.matchesPlayed === "number" ? s.matchesPlayed : 0,
        };
    }
    function outcomeFromDelta(beforeStats, afterStats) {
        if (afterStats.wins > beforeStats.wins) return "W";
        if (afterStats.loses > beforeStats.loses) return "L";
        if (afterStats.matches > beforeStats.matches) return "T";
        return null;
    }
    function rosterSnapshot(selfUid) {
        // Opponent display MMR is best-effort — only known when they're
        // in the top ~100 leaderboard cache the HUD already keeps warm.
        // Sync read from the in-memory memo, no Firestore call.
        const seenTop = new Map();
        try {
            for (const memo of _lbCacheMemo.values()) {
                const modes = memo?.modes || {};
                for (const entries of Object.values(modes)) {
                    if (!Array.isArray(entries)) continue;
                    for (const e of entries) {
                        if (e?.uid && typeof e.mmr === "number") seenTop.set(e.uid, e.mmr);
                    }
                }
            }
        } catch { /* cache may be off */ }
        return _liveRoster.map(p => {
            const entry = { uid: p.uid || "", name: (p.name || "").slice(0, 40), team: p.team || null };
            const dr = seenTop.get(p.uid);
            if (typeof dr === "number") entry.dr = dr;
            return entry;
        });
    }

    function captureMatchSnapshotsIfAny(before, after) {
        if (!before || !after || !after.Id) return [];
        const uid = after.Id;
        const matchId = String(after.CurrentGameId || "").trim();
        if (!matchId || _seenMatchIds.has(matchId)) return [];
        const roster = rosterSnapshot(uid);
        const myTeam = (roster.find(r => r.uid === uid) || {}).team || null;
        const created = [];
        for (const mode of MODES_FOR_SNAPSHOTS) {
            const bs = statsOf(before, mode);
            const as = statsOf(after, mode);
            if (as.matches <= bs.matches) continue; // no new match this mode
            const outcome = outcomeFromDelta(bs, as);
            if (!outcome) continue;
            created.push({
                at: new Date().toISOString(),
                mode,
                outcome,
                matchId,
                team: myTeam,
                before: glickoOf(before, mode),
                after: glickoOf(after, mode),
                roster,
            });
        }
        if (created.length) _seenMatchIds.add(matchId);
        return created;
    }

    async function writeMatchSnapshotDoc(uid, snap) {
        const fb = firestoreReady;
        if (!fb || !uid || !snap?.matchId) return;
        if (!firebaseAuthUid) {
            dbg("writeMatchSnapshotDoc skipped: firebaseAuthUid not ready");
            return;
        }
        if (snap.team !== "Blue" && snap.team !== "Orange") {
            dbg("writeMatchSnapshotDoc skipped: team unknown");
            return;
        }
        try {
            const docId = `${firebaseAuthUid}_${snap.matchId}`;
            const ref = fb.doc(fb.db, "match_snapshots", docId);
            await atlasSetDoc(fb, "match_snapshots", ref, {
                sourceUserId: firebaseAuthUid,
                deviceId: getDeviceId(),
                matchId: snap.matchId,
                mode: snap.mode,
                outcome: snap.outcome,
                team: snap.team,
                at: snap.at,
                before: snap.before,
                after: snap.after,
                roster: snap.roster,
            }, { merge: true });
        } catch (err) {
            dbg("writeMatchSnapshotDoc failed (non-fatal): " + getErrMsg(err));
        }
    }

    function handleMatchSnapshots(before, after) {
        try {
            const uid = after?.Id;
            if (!uid) return;
            ensureRingHydrated(uid);
            const snapshots = captureMatchSnapshotsIfAny(before, after);
            if (!snapshots.length) return;
            for (const snap of snapshots) {
                _recentMatchesRing.push(snap);
                writeMatchSnapshotDoc(uid, snap); // fire-and-forget
            }
            if (_recentMatchesRing.length > MATCH_HISTORY_CAP) {
                _recentMatchesRing = _recentMatchesRing.slice(-MATCH_HISTORY_CAP);
            }
            saveMatchHistory(uid, _recentMatchesRing);
        } catch (err) {
            dbg("handleMatchSnapshots threw: " + getErrMsg(err));
        }
    }

    function updateHUD(data) {
        createHUD();
        handleMatchSnapshots(lastKnownPlayerData, data);
        lastKnownPlayerData = data;
        // Login/ratings can arrive after Photon roster lines. Resume popup
        // detection now that the local user's uid is finally available.
        if (_inMatch && _liveRoster.length) scheduleRankedRosterPopups();
        captureSessionStart(data);
        updateStreak(data);
        updateMomentum();

        const ratingVal = mode => data.ModesGlicko?.[mode]?.displayRating;
        const rating = mode => {
            const v = ratingVal(mode);
            return typeof v === "number" ? v : "—";
        };

        const wr = mode => {
            const d = data.ModesData?.[mode];
            if (!d || !d.matchesPlayed) return "0.0";
            return (100 * d.wins / d.matchesPlayed).toFixed(1);
        };

        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        const totalWins = modes.reduce((sum, m) => sum + (data.ModesData?.[m]?.wins ?? 0), 0);
        const totalMatches = modes.reduce((sum, m) => sum + (data.ModesData?.[m]?.matchesPlayed ?? 0), 0);

        document.getElementById("rgContent").innerHTML = `
            <div style="display:flex;gap:12px;">
                <div style="white-space:nowrap;">
                    <b>🏆 Ratings</b><br>
                    3v3: <span style="color:#00ff66">${rating("Competitive3v3")}</span>${rankBadge("3v3")}${deltaBadge("Competitive3v3", ratingVal("Competitive3v3"))}<br>
                    2v2: <span style="color:#00ff66">${rating("Competitive2v2")}</span>${rankBadge("2v2")}${deltaBadge("Competitive2v2", ratingVal("Competitive2v2"))}<br>
                    1v1: <span style="color:#00ff66">${rating("Competitive1v1")}</span>${rankBadge("1v1")}${deltaBadge("Competitive1v1", ratingVal("Competitive1v1"))}<br>
                    Casual: <span style="color:#00ff66">${rating("Casual")}</span>${deltaBadge("Casual", ratingVal("Casual"))}
                </div>
                <div style="width:1px;background:#00bfff88;flex-shrink:0;"></div>
                <div style="white-space:nowrap;">
                    <b>📊 Win Rates</b><br>
                    3v3 <span style="color:#00ff66">${wr("Competitive3v3")}%</span><br>
                    2v2 <span style="color:#00ff66">${wr("Competitive2v2")}%</span><br>
                    1v1 <span style="color:#00ff66">${wr("Competitive1v1")}%</span><br>
                    Casual <span style="color:#00ff66">${wr("Casual")}%</span>
                </div>
            </div>

            <hr style="border:none;border-top:1px solid #00bfff88;margin:10px 0;">

            <div style="display:flex;justify-content:space-between;align-items:center;">
                <div>
                    Wins: <span style="color:#00ff66">${totalWins}</span><br>
                    Matches Played: <span style="color:#00ff66">${totalMatches}</span>
                </div>
                <div style="font-size:15px;">${streakBadge()}</div>
            </div>
            ${clashMiniBarHtml()}
        `;

        // Render ATLAS Enterprise Suite™ widgets after stats
        try {
            const existingEnterprise = document.getElementById("rgEnterpriseSuite");
            if (existingEnterprise) existingEnterprise.remove();
            const existingScoring = document.getElementById("rgScoringWidget");
            if (existingScoring) existingScoring.remove();
            const rgBody = document.getElementById("rgBody");
            if (rgBody) {
                // Score widget
                const scoreWidget = document.createElement("div");
                scoreWidget.id = "rgScoringWidget";
                rgBody.appendChild(scoreWidget);
                _renderScoringWidget(scoreWidget);
                // Enterprise suite tabs
                const enterpriseDiv = document.createElement("div");
                enterpriseDiv.id = "rgEnterpriseSuite";
                rgBody.appendChild(enterpriseDiv);
                const tabRow = document.createElement("div");
                tabRow.style.cssText = "display:flex; gap:3px; flex-wrap:wrap; margin:6px 0 4px; border-top:1px solid #00bfff33; padding-top:6px;";
                const panels = {};
                const tabDefs = [
                    { key: "pet", label: "🐾 Pet", color: "#4ade80" },
                    { key: "miner", label: "⛏ Mine", color: "#ffd700" },
                    { key: "astro", label: "🔮 Stars", color: "#c084fc" },
                    { key: "weather", label: "🌦 Weather", color: "#00d4ff" },
                    { key: "snake", label: "🐍 Snake", color: "#4ade80" },
                    { key: "ai", label: "🤖 AI", color: "#f472b6" },
                    { key: "todo", label: "📋 Todo", color: "#facc15" },
                ];
                tabDefs.forEach(({ key, label, color }) => {
                    const btn = document.createElement("button");
                    btn.className = "rgBtn";
                    btn.style.cssText = `font-size:9px; padding:3px 5px; border-color:${color}44; color:${color}; flex:0 0 auto;`;
                    btn.textContent = label;
                    const panel = document.createElement("div");
                    panel.style.cssText = "display:none; font-size:11px; line-height:1.4; max-height:220px; overflow-y:auto; padding:4px; background:rgba(0,0,0,.3); border-radius:6px; margin-top:4px;";
                    panels[key] = panel;
                    btn.onclick = () => {
                        _enterpriseActiveTab = key;
                        Object.values(panels).forEach(p => p.style.display = "none");
                        panel.style.display = "block";
                        _renderEnterpriseTab(key, panel);
                    };
                    tabRow.appendChild(btn);
                    enterpriseDiv.appendChild(panel);
                });
                // extension tabs (Cookie/Zen/Dice/Units/Roman/DVD/Nyan) —
                // self-contained modules registered in _enterpriseTabExtensions
                if (typeof _enterpriseTabExtensions !== "undefined") {
                    _enterpriseTabExtensions.forEach(({ key, label, color, render }) => {
                        const btn = document.createElement("button");
                        btn.className = "rgBtn";
                        btn.style.cssText = `font-size:9px; padding:3px 5px; border-color:${color}44; color:${color}; flex:0 0 auto;`;
                        btn.textContent = label;
                        const panel = document.createElement("div");
                        panel.style.cssText = "display:none; font-size:11px; line-height:1.4; max-height:220px; overflow-y:auto; padding:4px; background:rgba(0,0,0,.3); border-radius:6px; margin-top:4px;";
                        panels[key] = panel;
                        btn.onclick = () => {
                            _enterpriseActiveTab = key;
                            Object.values(panels).forEach(p => p.style.display = "none");
                            panel.style.display = "block";
                            render(panel);
                        };
                        tabRow.appendChild(btn);
                        enterpriseDiv.appendChild(panel);
                        _enterpriseTabRenderMap[key] = render;
                    });
                }
                enterpriseDiv.appendChild(tabRow);
                // restore whatever tab was open before this re-render nuked the DOM
                if (_enterpriseActiveTab && panels[_enterpriseActiveTab]) {
                    panels[_enterpriseActiveTab].style.display = "block";
                    _renderEnterpriseTab(_enterpriseActiveTab, panels[_enterpriseActiveTab]);
                }
            }
        } catch (e) { dbg("Enterprise suite render error: " + getErrMsg(e)); }
    }

    let lastProcessedText = null;
    let lastProcessedKey = null;

    function tryParseAndUpdate(text) {
        // fast path: identical string
        if (text === lastProcessedText) return;

        try {
            const data = JSON.parse(text);
            if (!(data && data.ModesGlicko)) return;

            // fetch + console hooks can emit byte-different strings for the same
            // event. stable key on the ratings themselves. set BEFORE submit
            // fires or the two paths race.
            const key = data.Id + "|"
                + (data.ModesGlicko?.Competitive3v3?.displayRating ?? "") + "|"
                + (data.ModesGlicko?.Competitive2v2?.displayRating ?? "") + "|"
                + (data.ModesGlicko?.Competitive1v1?.displayRating ?? "") + "|"
                + (data.ModesGlicko?.Casual?.displayRating ?? "") + "|"
                + (data.ModesData?.Competitive3v3?.matchesPlayed ?? "") + "|"
                + (data.ModesData?.Competitive2v2?.matchesPlayed ?? "") + "|"
                + (data.ModesData?.Competitive1v1?.matchesPlayed ?? "") + "|"
                + (data.ModesData?.Casual?.matchesPlayed ?? "");
            if (key === lastProcessedKey) return;

            lastProcessedText = text;
            lastProcessedKey = key;
            _lastValidRatingsAt = performance.now(); // watchdog signal
            updateHUD(data);
            submitToLeaderboard(data);
        } catch (e) {
            dbg("tryParseAndUpdate threw: " + getErrMsg(e));
        }
    }

    // ---------- Leaderboard submission ----------

    // public client config, not a secret. null to disable submissions.
    const FIREBASE_CONFIG = {
        apiKey: "AIzaSyD29s2Jku_DZ42keIQAETgKg7HWt__QEwY",
        authDomain: "rgleaderboard.firebaseapp.com",
        projectId: "rgleaderboard",
        storageBucket: "rgleaderboard.firebasestorage.app",
        messagingSenderId: "247848634543",
        appId: "1:247848634543:web:6a7e506d60544d46cc6c5a",
        measurementId: "G-JW3Q972P9T",
    };

    // full dump. site reads the trimmed "leaderboard" collection that
    // syncToRealLeaderboard writes to.
    const LEADERBOARD_COLLECTION = "script_submissions";

    let firestoreReady = null;
    let firestoreInitPromise = null;
    let atlasFirebaseAuth = null;
    // Set by initFirebase() after anon sign-in. Rules bind writes to this.
    let firebaseAuthUid = null;
    let firebaseAuthError = null;
    const ATLAS_FIREBASE_APP_NAME = "atlas";

    // 19.9 used the default app. 20.0 always created a named "atlas" app,
    // which cannot see the existing anonymous session and then treated a
    // failed sign-in as "ready", so Settings retry was a no-op.
    function resolveAtlasFirebaseApp(existingApps, config, initializeApp) {
        const apps = Array.isArray(existingApps) ? existingApps : [];
        const named = apps.find((app) => app && app.name === ATLAS_FIREBASE_APP_NAME);
        if (named) return named;
        const def = apps.find((app) => app && app.name === "[DEFAULT]");
        if (!def) return initializeApp(config);
        if (def.options && def.options.projectId === config.projectId) return def;
        return initializeApp(config, ATLAS_FIREBASE_APP_NAME);
    }

    function firebaseAuthShouldRetry(uid) {
        return !uid;
    }

    function paintAuthUid() {
        const uidLabel = document.getElementById("rgSetAuthUid");
        if (uidLabel) {
            if (firebaseAuthUid) uidLabel.textContent = firebaseAuthUid;
            else if (firebaseAuthError) uidLabel.textContent = "sign-in failed — tap Settings to retry";
            else uidLabel.textContent = "signing in…";
        }
        const deviceLabel = document.getElementById("rgSetDeviceId");
        if (deviceLabel) deviceLabel.textContent = getDeviceId();
    }
    let firestoreReadCount = 0;
    let firestoreWriteCount = 0;
    const FIRESTORE_READ_BUDGET = 120;
    const FIRESTORE_WRITE_BUDGET = 40;
    const FIRESTORE_BUDGET_WINDOW_MS = 10 * 60 * 1000;
    let firestoreBudgetWindow = {
        startedAt: Date.now(),
        reads: 0,
        writes: 0,
        readWarned: false,
        writeWarned: false,
    };
    // Per-session tallies uploaded to hud_read_stats so we can attribute
    // reads/writes back to specific HUD features without shipping a new
    // build. Session start is fixed for the life of the userscript instance;
    // resets happen when the browser reloads the game page.
    const HUD_STATS_SESSION_STARTED_AT = new Date().toISOString();
    const hudSessionReadsByLabel = new Map();
    const hudSessionWritesByLabel = new Map();
    // Per-label deny count, uploaded with the read-stats payload.
    const hudSessionDeniesByLabel = new Map();
    // Recent deny records so the admin panel can show who/what/which rule,
    // not just a bucket count.
    const HUD_DENY_RECORD_MAX = 25;
    const hudSessionDenies = [];
    function truncateForDeny(value, max) {
        return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
    }
    function guessDenyRule(message) {
        const m = String(message || "").toLowerCase();
        if (!m) return "";
        if (m.includes("blacklist")) return "blacklisted";
        if (m.includes("version") || m.includes("minversion")) return "version-gate";
        if (m.includes("device")) return "device-id";
        if (m.includes("stamp") || m.includes("lastwriteat")) return "write-stamp";
        if (m.includes("member") || m.includes("clan")) return "clan-membership";
        if (m.includes("profan") || m.includes("emoji") || m.includes("name")) return "name-blocklist";
        return "";
    }

    const RULE_MODES = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
    const RULE_PLAYLISTS = ["1v1", "2v2", "3v3", "wins"];
    const RULE_OUTCOMES = ["W", "L", "T"];
    function describeDenyReasons(bucket, data, opts = {}) {
        const b = String(bucket || "").split("/")[0];
        const reasons = [];
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            return ["payload missing or not a map"];
        }
        // deviceId is required by hasValidDeviceId() on leaderboard,
        // script_submissions, and match_snapshots.
        const needsDeviceId = b === "leaderboard" || b === "script_submissions" || b === "match_snapshots";
        if (needsDeviceId) {
            if (!("deviceId" in data)) reasons.push("missing field: deviceId");
            else if (typeof data.deviceId !== "string" || data.deviceId.length === 0) {
                reasons.push("deviceId must be a non-empty string");
            }
        }
        if (b === "leaderboard") describeLeaderboardReasons(data, reasons);
        else if (b === "script_submissions") describeScriptSubmissionReasons(data, reasons);
        else if (b === "match_snapshots") describeMatchSnapshotReasons(data, reasons, opts);
        return reasons;
    }

    function describeLeaderboardReasons(d, reasons) {
        if (!("sourceUserId" in d)) reasons.push("missing field: sourceUserId");
        else if (typeof d.sourceUserId !== "string" || !d.sourceUserId.length) {
            reasons.push("sourceUserId must be a non-empty string");
        }
        if (!RULE_PLAYLISTS.includes(d.playlist)) {
            reasons.push(`playlist must be one of [${RULE_PLAYLISTS.join(", ")}] (got ${JSON.stringify(d.playlist)})`);
        }
        if (typeof d.name !== "string") reasons.push("name must be a string");
        else if (d.name.length === 0) reasons.push("name is empty");
        else if (d.name.length > 22) reasons.push(`name too long: ${d.name.length} chars > 22`);
        if (d.playlist === "wins") {
            if (typeof d.wins !== "number") reasons.push("wins must be a number");
            if (typeof d.matches !== "number") reasons.push("matches must be a number");
            if (typeof d.wins === "number" && d.wins < 0) reasons.push(`wins (${d.wins}) < 0`);
            if (typeof d.matches === "number" && d.matches < 0) reasons.push(`matches (${d.matches}) < 0`);
            if (typeof d.wins === "number" && typeof d.matches === "number" && d.wins > d.matches) {
                reasons.push(`wins (${d.wins}) > matches (${d.matches})`);
            }
            if (typeof d.matches === "number" && d.matches > 100000) {
                reasons.push(`matches (${d.matches}) > 100000 cap`);
            }
        } else if (RULE_PLAYLISTS.includes(d.playlist)) {
            if (typeof d.mmr !== "number") reasons.push("mmr must be a number");
            else if (d.mmr < 0) reasons.push(`mmr (${d.mmr}) must be non-negative`);
        }
        checkOptionalGlickoField(d, "rating", 0, null, reasons);
        checkOptionalGlickoField(d, "rd", 0, 350, reasons);
        checkOptionalGlickoField(d, "vol", 0, 1, reasons);
    }

    function describeScriptSubmissionReasons(d, reasons) {
        if (typeof d.nickname !== "string") reasons.push("nickname must be a string");
        else if (!d.nickname.length) reasons.push("nickname is empty");
        else if (d.nickname.length > 500) reasons.push(`nickname too long: ${d.nickname.length} > 500`);
        if ("displayName" in d && d.displayName != null) {
            if (typeof d.displayName !== "string") reasons.push("displayName must be a string");
            else if (!d.displayName.length) reasons.push("displayName is empty");
            else if (d.displayName.length > 15) reasons.push(`displayName too long: ${d.displayName.length} > 15`);
        }
        if ("xp" in d && d.xp != null) {
            if (typeof d.xp !== "number") reasons.push("xp must be a number");
            else if (d.xp < 0 || d.xp > 1000000) reasons.push(`xp (${d.xp}) outside [0, 1000000]`);
        }
        if ("ratings" in d && d.ratings != null) {
            if (typeof d.ratings !== "object" || Array.isArray(d.ratings)) {
                reasons.push("ratings must be a map");
            } else {
                for (const mode of RULE_MODES) {
                    const r = d.ratings[mode];
                    if (r == null) continue;
                    if (typeof r !== "number") reasons.push(`ratings.${mode} must be a number`);
                    else if (r < 0) reasons.push(`ratings.${mode} (${r}) must be non-negative`);
                }
            }
        }
        if ("glicko" in d && d.glicko != null && (typeof d.glicko !== "object" || Array.isArray(d.glicko))) {
            reasons.push("glicko must be a map");
        }
        if ("stats" in d && d.stats != null && typeof d.stats === "object") {
            for (const mode of RULE_MODES) {
                const s = d.stats[mode];
                if (s == null) continue;
                if (typeof s.wins !== "number") reasons.push(`stats.${mode}.wins must be a number`);
                if (typeof s.matchesPlayed !== "number") reasons.push(`stats.${mode}.matchesPlayed must be a number`);
                if (typeof s.wins === "number" && s.wins < 0) reasons.push(`stats.${mode}.wins (${s.wins}) < 0`);
                if (typeof s.matchesPlayed === "number" && s.matchesPlayed < 0) reasons.push(`stats.${mode}.matchesPlayed < 0`);
                if (typeof s.wins === "number" && typeof s.matchesPlayed === "number" && s.wins > s.matchesPlayed) {
                    reasons.push(`stats.${mode}: wins (${s.wins}) > matchesPlayed (${s.matchesPlayed})`);
                }
                if (typeof s.matchesPlayed === "number" && s.matchesPlayed > 100000) {
                    reasons.push(`stats.${mode}.matchesPlayed (${s.matchesPlayed}) > 100000`);
                }
            }
        }
        if ("recentMatches" in d && d.recentMatches != null) {
            if (!Array.isArray(d.recentMatches)) reasons.push("recentMatches must be a list");
            else if (d.recentMatches.length > 25) reasons.push(`recentMatches size ${d.recentMatches.length} > 25`);
        }
    }

    function describeMatchSnapshotReasons(d, reasons, opts) {
        if (typeof d.sourceUserId !== "string" || !d.sourceUserId.length) {
            reasons.push("sourceUserId must be a non-empty string");
        }
        if (typeof d.matchId !== "string" || !d.matchId.length) {
            reasons.push("matchId must be a non-empty string");
        } else if (d.matchId.length > 100) {
            reasons.push(`matchId too long: ${d.matchId.length} > 100`);
        }
        if (opts.docId && d.sourceUserId && d.matchId) {
            const expected = `${d.sourceUserId}_${d.matchId}`;
            if (opts.docId !== expected) {
                reasons.push(`docId "${opts.docId}" must equal "${expected}" (sourceUserId + "_" + matchId)`);
            }
        }
        if (!RULE_MODES.includes(d.mode)) {
            reasons.push(`mode must be one of [${RULE_MODES.join(", ")}] (got ${JSON.stringify(d.mode)})`);
        }
        if (!RULE_OUTCOMES.includes(d.outcome)) {
            reasons.push(`outcome must be one of [${RULE_OUTCOMES.join(", ")}] (got ${JSON.stringify(d.outcome)})`);
        }
        if (!d.before || typeof d.before !== "object" || Array.isArray(d.before)) reasons.push("before must be a map");
        if (!d.after || typeof d.after !== "object" || Array.isArray(d.after)) reasons.push("after must be a map");
        if (!Array.isArray(d.roster)) reasons.push("roster must be a list");
        else if (d.roster.length > 8) reasons.push(`roster size ${d.roster.length} > 8 cap`);
    }

    function checkOptionalGlickoField(d, key, min, max, reasons) {
        if (!(key in d) || d[key] == null) return;
        if (typeof d[key] !== "number") reasons.push(`${key} must be a number`);
        else if (d[key] < min) reasons.push(`${key} (${d[key]}) must be >= ${min}`);
        else if (max != null && d[key] > max) reasons.push(`${key} (${d[key]}) must be <= ${max}`);
    }
    function logDeny(label, detail = null) {
        const bucket = bucketLabel(label);
        hudSessionDeniesByLabel.set(bucket, (hudSessionDeniesByLabel.get(bucket) || 0) + 1);
        const err = detail?.err;
        const rawReasons = Array.isArray(detail?.reasons) ? detail.reasons : [];
        const reasons = rawReasons.slice(0, 6).map(r => truncateForDeny(r, 160));
        const record = {
            at: new Date().toISOString(),
            bucket,
            path: truncateForDeny(detail?.path ?? label, 120),
            op: truncateForDeny(detail?.op, 10),
            code: truncateForDeny(err?.code, 40),
            msg: truncateForDeny(err?.message, 160),
            subject: truncateForDeny(detail?.subject, 120),
            rule: truncateForDeny(detail?.rule || guessDenyRule(err?.message), 40),
            reasons,
        };
        hudSessionDenies.push(record);
        if (hudSessionDenies.length > HUD_DENY_RECORD_MAX) hudSessionDenies.shift();
        // Browser console only — do not write a Firestore security
        // collection from the HUD. An attacker would skip or flood it.
        console.warn(`[RG HUD][security] ${JSON.stringify(record)}`);
    }
    function bucketLabel(raw) {
        // Firestore doc paths carry slashes and ids that would explode the
        // perLabel map — normalize to the "collection[/subcoll]" prefix.
        const str = String(raw || "unknown");
        const parts = str.split("/").filter(Boolean);
        if (parts.length <= 1) return parts[0] || "unknown";
        // For paths like "clans/xyz" → "clans"; for "clans/xyz/members/abc" → "clans/members"
        const buckets = [];
        for (let i = 0; i < parts.length; i += 2) buckets.push(parts[i]);
        return buckets.join("/").slice(0, 80);
    }

    function nextFirestoreBudgetWindow(window, now = Date.now()) {
        const startedAt = Number(window?.startedAt);
        if (Number.isFinite(startedAt)
            && now >= startedAt
            && now - startedAt < FIRESTORE_BUDGET_WINDOW_MS) {
            return window;
        }
        return {
            startedAt: now,
            reads: 0,
            writes: 0,
            readWarned: false,
            writeWarned: false,
        };
    }

    function firestoreReadBudgetPassed() {
        firestoreBudgetWindow = nextFirestoreBudgetWindow(firestoreBudgetWindow);
        return firestoreBudgetWindow.reads > FIRESTORE_READ_BUDGET;
    }

    function logRead(label, count = 1) {
        const charged = Math.max(1, Number(count) || 1);
        firestoreBudgetWindow = nextFirestoreBudgetWindow(firestoreBudgetWindow);
        firestoreReadCount += charged;
        firestoreBudgetWindow.reads += charged;
        const bucket = bucketLabel(label);
        hudSessionReadsByLabel.set(bucket, (hudSessionReadsByLabel.get(bucket) || 0) + charged);
        console.log(`[RG HUD] Firestore read +${charged} #${firestoreReadCount} (${label}; ${firestoreBudgetWindow.reads}/${FIRESTORE_READ_BUDGET} in 10m)`);
        if (!firestoreBudgetWindow.readWarned
            && firestoreBudgetWindow.reads > FIRESTORE_READ_BUDGET) {
            firestoreBudgetWindow.readWarned = true;
            dbgWarn(`Firestore read budget passed (${firestoreBudgetWindow.reads}/${FIRESTORE_READ_BUDGET} in 10m)`);
        }
    }

    function logWrite(label) {
        firestoreBudgetWindow = nextFirestoreBudgetWindow(firestoreBudgetWindow);
        firestoreWriteCount++;
        firestoreBudgetWindow.writes++;
        const bucket = bucketLabel(label);
        hudSessionWritesByLabel.set(bucket, (hudSessionWritesByLabel.get(bucket) || 0) + 1);
        console.log(`[RG HUD] Firestore write #${firestoreWriteCount} (${label}; ${firestoreBudgetWindow.writes}/${FIRESTORE_WRITE_BUDGET} in 10m)`);
        if (!firestoreBudgetWindow.writeWarned
            && firestoreBudgetWindow.writes > FIRESTORE_WRITE_BUDGET) {
            firestoreBudgetWindow.writeWarned = true;
            dbgWarn(`Firestore write budget passed (${firestoreBudgetWindow.writes}/${FIRESTORE_WRITE_BUDGET} in 10m)`);
        }
    }

    // ---------- Persistent read-stats telemetry ----------
    // Every ~5 minutes and on tab unload the HUD uploads its session read/
    // write breakdown to hud_read_stats/{yyyy-mm-dd}_{sourceUserId}. This
    // lets us reconstruct which HUD features drove Firestore reads over
    // a day, not just the aggregate from Firebase's console. Zero-cost
    // when nothing has changed since the last upload.
    const HUD_STATS_UPLOAD_INTERVAL_MS = 5 * 60 * 1000;
    let hudStatsUploadHandle = null;
    let hudStatsUploadInFlight = false;
    let hudStatsLastPayloadKey = "";

    function hudStatsToday() {
        return new Date().toISOString().slice(0, 10);
    }

    async function uploadHudReadStats({ final = false } = {}) {
        if (hudStatsUploadInFlight) return;
        const uid = firebaseAuthUid;
        const rgPlayerId = (typeof myUserId === "function") ? myUserId() : null;
        if (!uid) return; // no identity yet — can't authenticate the write
        const fb = firestoreReady;
        if (!fb) return;
        const totalReads = firestoreReadCount;
        const totalWrites = firestoreWriteCount;
        const perLabelReads = Object.fromEntries(hudSessionReadsByLabel);
        const perLabelWrites = Object.fromEntries(hudSessionWritesByLabel);
        const perLabelDenies = Object.fromEntries(hudSessionDeniesByLabel);
        const deniesRecent = hudSessionDenies.slice(-HUD_DENY_RECORD_MAX);
        // Skip identical payloads (a quiet session doesn't spam writes).
        // A `final` flush always uploads so the last state is captured.
        const key = `${totalReads}:${totalWrites}:${JSON.stringify(perLabelReads)}:${JSON.stringify(perLabelWrites)}:${JSON.stringify(perLabelDenies)}:${deniesRecent.length}`;
        if (!final && key === hudStatsLastPayloadKey) return;
        hudStatsUploadInFlight = true;
        try {
            const date = hudStatsToday();
            const docId = `${date}_${uid}`;
            const payload = {
                date,
                sourceUserId: uid,
                deviceId: getDeviceId(),
                scriptVersion: SCRIPT_VERSION,
                versionNum: SCRIPT_VERSION_NUM,
                startedAt: HUD_STATS_SESSION_STARTED_AT,
                updatedAt: new Date().toISOString(),
                readTotal: totalReads,
                writeTotal: totalWrites,
                perLabelReads,
                perLabelWrites,
                perLabelDenies,
                deniesRecent,
                lastWriteAt: fb.serverTimestamp(),
            };
            if (rgPlayerId) payload.rgPlayerId = rgPlayerId;
            const ref = fb.doc(fb.db, "hud_read_stats", docId);
            // atlasSetDoc goes through the blacklist gate + logWrite, so the
            // telemetry write itself is counted. Small overhead (1 write per
            // 5 min per HUD), well below any budget.
            const wrote = await atlasSetDoc(fb, "hud_read_stats", ref, payload, { merge: true });
            if (wrote) hudStatsLastPayloadKey = key;
        } catch (err) {
            dbg("uploadHudReadStats failed (non-fatal): " + getErrMsg(err));
        } finally {
            hudStatsUploadInFlight = false;
        }
    }

    function scheduleHudStatsUpload() {
        if (hudStatsUploadHandle != null) return;
        // First upload happens after the initial interval, giving the HUD a
        // chance to warm up and produce something worth reporting.
        hudStatsUploadHandle = setInterval(() => {
            uploadHudReadStats().catch(() => {});
        }, HUD_STATS_UPLOAD_INTERVAL_MS);
        if (typeof window !== "undefined") {
            const flush = () => { uploadHudReadStats({ final: true }).catch(() => {}); };
            window.addEventListener("beforeunload", flush);
            window.addEventListener("pagehide", flush);
        }
    }

    // Kick off the uploader after firestoreReady lands. initFirebase() sets
    // firestoreReady synchronously at end-of-init, so a slightly delayed
    // scheduler doesn't miss the boot phase.
    setTimeout(() => scheduleHudStatsUpload(), 15_000);

    async function initFirebase() {
        if (!FIREBASE_CONFIG) return null;
        if (firestoreReady && !firebaseAuthShouldRetry(firebaseAuthUid)) return firestoreReady;
        if (firestoreInitPromise) return firestoreInitPromise;
        firestoreInitPromise = firestoreReady ? retryFirebaseAuth() : initFirebaseInner();
        try {
            return await firestoreInitPromise;
        } finally {
            firestoreInitPromise = null;
        }
    }

    async function retryFirebaseAuth() {
        try {
            await ensureAnonymousAuth(atlasFirebaseAuth);
            updateRequiredChecked = false;
            notAllowlisted = false;
            if (firestoreReady) await isUpdateRequired(firestoreReady);
            if (notAllowlisted) showNotAllowlistedUI();
        } catch (authErr) {
            firebaseAuthUid = null;
            firebaseAuthError = getErrMsg(authErr);
            dbg("retryFirebaseAuth failed: " + firebaseAuthError);
        }
        paintAuthUid();
        return firestoreReady;
    }

    function atlasTmStorage() {
        if (typeof GM_getValue !== "function" || typeof GM_setValue !== "function") return null;
        return {
            get: (key) => GM_getValue(key, null),
            set: (key, value) => { GM_setValue(key, value); },
            remove: (key) => {
                if (typeof GM_deleteValue === "function") GM_deleteValue(key);
                else GM_setValue(key, "");
            },
        };
    }

    // Tampermonkey storage survives a rocketgoal.io cache clear. Origin
    // IndexedDB / localStorage do not. Copy the official Auth blob into
    // localStorage before initializeAuth — Firebase 10 rejects a duck-typed
    // persistence object ("Expected a class definition").
    function hydrateAtlasAuthFromTm(storage, apiKey, appName, localStore) {
        if (!storage || !apiKey || !localStore || typeof localStore.getItem !== "function") return false;
        let raw;
        try { raw = storage.get("atlasFirebaseAuthUser"); } catch (e) { return false; }
        if (raw == null || raw === "") return false;
        const blob = typeof raw === "string" ? raw : JSON.stringify(raw);
        const names = ["[DEFAULT]", "atlas"];
        if (appName && names.indexOf(appName) < 0) names.unshift(appName);
        let wrote = false;
        for (let i = 0; i < names.length; i++) {
            const key = "firebase:authUser:" + apiKey + ":" + names[i];
            try {
                if (!localStore.getItem(key)) {
                    localStore.setItem(key, blob);
                    wrote = true;
                }
            } catch (e) {}
        }
        return wrote;
    }

    function backupAtlasAuthToTm(storage, apiKey, appName, localStore, user) {
        if (!storage || typeof storage.set !== "function") return false;
        let blob = null;
        if (localStore && apiKey && typeof localStore.getItem === "function") {
            const names = ["[DEFAULT]", "atlas"];
            if (appName && names.indexOf(appName) < 0) names.unshift(appName);
            for (let i = 0; i < names.length; i++) {
                try {
                    const fromLs = localStore.getItem("firebase:authUser:" + apiKey + ":" + names[i]);
                    if (fromLs) { blob = fromLs; break; }
                } catch (e) {}
            }
        }
        if (!blob && user && typeof user.toJSON === "function") {
            try { blob = JSON.stringify(user.toJSON()); } catch (e) {}
        }
        if (!blob) return false;
        try { storage.set("atlasFirebaseAuthUser", blob); return true; } catch (e) { return false; }
    }

    async function ensureAnonymousAuth(auth) {
        if (!auth) throw new Error("Firebase auth is not ready");
        // Persistence restore is async. Signing in before it finishes
        // creates a second uid and overwrites the saved session.
        if (typeof auth.authStateReady === "function") {
            await auth.authStateReady();
        }
        if (!auth.currentUser) await signInAnonymouslyFn(auth);
        firebaseAuthUid = auth.currentUser ? auth.currentUser.uid : null;
        firebaseAuthError = firebaseAuthUid ? null : "no-uid";
        if (!firebaseAuthUid) throw new Error("signInAnonymously resolved without a uid");
    }

    let signInAnonymouslyFn = async () => {
        throw new Error("signInAnonymously is not loaded");
    };

    async function initFirebaseInner() {
        try {
            const { initializeApp, getApps } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
            const {
                getFirestore,
                doc,
                setDoc,
                getDoc: rawGetDoc,
                collection,
                query,
                where,
                getDocs: rawGetDocs,
                getCountFromServer: rawGetCountFromServer,
                orderBy,
                limit,
                deleteDoc,
                serverTimestamp,
                onSnapshot: rawOnSnapshot,
                runTransaction,
            } =
                await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
            const {
                getAuth,
                signInAnonymously,
                initializeAuth,
                indexedDBLocalPersistence,
                browserLocalPersistence,
            } =
                await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
            signInAnonymouslyFn = signInAnonymously;

            // App Check via Cloudflare Worker. reCAPTCHA v3 doesn't survive
            // the Unity/userscript context on rocketgoal.io, so the Worker
            // signs App Check tokens for allowlisted anonymous uids instead.
            const { initializeAppCheck, CustomProvider, getToken: getAppCheckToken } =
                await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-check.js");
            const APP_CHECK_WORKER_URL = "https://atlas-appcheck.therootedengineer.workers.dev/mint";

            const app = resolveAtlasFirebaseApp(getApps(), FIREBASE_CONFIG, initializeApp);
            let atlasAppCheckHandle = null;
            try {
                dbg("AppCheck: registering CustomProvider (Worker=" + APP_CHECK_WORKER_URL + ")");
                atlasAppCheckHandle = initializeAppCheck(app, {
                    provider: new CustomProvider({
                        getToken: async () => {
                            const auth = atlasFirebaseAuth;
                            const user = auth && auth.currentUser;
                            if (!user) throw new Error("no auth user yet");
                            const idToken = await user.getIdToken();
                            const resp = await fetch(APP_CHECK_WORKER_URL, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ uid: user.uid, idToken }),
                            });
                            if (!resp.ok) {
                                const errText = await resp.text().catch(() => "");
                                const msg = "Worker " + resp.status + ": " + errText;
                                dbg("AppCheck: token fetch REJECTED — " + msg);
                                throw new Error(msg);
                            }
                            const data = await resp.json();
                            dbg("AppCheck: token minted via Worker (len=" + (data.token?.length || 0) + ")");
                            return { token: data.token, expireTimeMillis: data.expireTimeMillis };
                        },
                    }),
                    isTokenAutoRefreshEnabled: true,
                });
                dbg("AppCheck: CustomProvider registered");
            } catch (err) {
                dbg("AppCheck: init THREW — " + getErrMsg(err));
            }
            const db = getFirestore(app);
            // Sign in before handing firestoreReady out; writes without
            // an auth.uid stamp get denied.
            try {
                const tm = atlasTmStorage();
                const appName = app && app.name ? app.name : "[DEFAULT]";
                hydrateAtlasAuthFromTm(tm, FIREBASE_CONFIG.apiKey, appName, localStorage);
                let auth;
                try {
                    auth = initializeAuth(app, {
                        persistence: [browserLocalPersistence, indexedDBLocalPersistence],
                    });
                } catch (e) {
                    auth = getAuth(app);
                }
                atlasFirebaseAuth = auth;
                await ensureAnonymousAuth(auth);
                backupAtlasAuthToTm(tm, FIREBASE_CONFIG.apiKey, appName, localStorage, auth && auth.currentUser);
            } catch (authErr) {
                firebaseAuthUid = null;
                firebaseAuthError = getErrMsg(authErr);
                dbg("initFirebase: signInAnonymously failed: " + firebaseAuthError);
            }
            paintAuthUid();
            // Force an App Check token fetch now that anon auth is settled,
            // so the debug bundle records success/fail without waiting on
            // the lazy Firestore-triggered path.
            if (atlasAppCheckHandle) {
                getAppCheckToken(atlasAppCheckHandle).then(
                    (result) => {
                        const tokLen = result?.token?.length || 0;
                        if (tokLen > 0) dbg("AppCheck: initial fetch ok (len=" + tokLen + ")");
                        else dbg("AppCheck: initial fetch returned empty");
                    },
                    (err) => dbg("AppCheck: initial fetch failed — " + getErrMsg(err)),
                );
            }
            const denySubject = () => {
                const uid = currentUidForDeny();
                return uid ? `uid=${uid}` : "";
            };
            const getDoc = async ref => {
                try {
                    const snapshot = await rawGetDoc(ref);
                    logRead(ref?.path || "document");
                    return snapshot;
                } catch (err) {
                    if (isDeny(err)) logDeny(ref?.path || "document", {
                        op: "read", path: ref?.path, err,
                        subject: denySubject(),
                    });
                    throw err;
                }
            };
            const getDocs = async target => {
                try {
                    const snapshot = await rawGetDocs(target);
                    logRead("query", Math.max(1, snapshot.size || 0));
                    return snapshot;
                } catch (err) {
                    if (isDeny(err)) logDeny(target?.path || "query", {
                        op: "query", path: target?.path, err,
                        subject: denySubject(),
                    });
                    throw err;
                }
            };
            const getCountFromServer = async target => {
                try {
                    const snapshot = await rawGetCountFromServer(target);
                    logRead("count query");
                    return snapshot;
                } catch (err) {
                    if (isDeny(err)) logDeny(target?.path || "count query", {
                        op: "count", path: target?.path, err,
                        subject: denySubject(),
                    });
                    throw err;
                }
            };
            const onSnapshot = (target, onNext, onError) =>
                rawOnSnapshot(target, snapshot => {
                    logRead(target?.path || "listener", snapshot?.size || 1);
                    onNext(snapshot);
                }, err => {
                    if (isDeny(err)) logDeny(target?.path || "listener", {
                        op: "listener", path: target?.path, err,
                        subject: denySubject(),
                    });
                    if (typeof onError === "function") onError(err);
                });

            firestoreReady = {
                db,
                doc,
                setDoc,
                getDoc,
                collection,
                query,
                where,
                getDocs,
                getCountFromServer,
                orderBy,
                limit,
                deleteDoc,
                serverTimestamp,
                onSnapshot,
                runTransaction,
            };
            isUpdateRequired(firestoreReady).then(() => {
                if (notAllowlisted) showNotAllowlistedUI();
                if (writesPaused) showWritesPausedUI();
            }).catch(() => {});
            return firestoreReady;
        } catch (e) {
            firebaseAuthError = getErrMsg(e);
            paintAuthUid();
            dbg("initFirebase failed: " + firebaseAuthError);
            console.error("[RG HUD] Firebase init failed:", e);
            showError("Firebase failed to load");
            return null;
        }
    }

    // ---------- Force-update gate ----------
    // admin/gate has { minVersion, pauseWrites }. The pin book lives on
    // admin/blacklist and is admin-only. Rules still reject sub-min writes
    // from blacklist.minVersion. Check once per session.

    let updateRequiredChecked = false;
    let updateRequired = false;
    let writesPaused = false;
    let notAllowlisted = false;
    let updateRequiredUiShown = false;
    let writesPausedUiShown = false;
    let notAllowlistedUiShown = false;
    const DISCORD_INVITE = "https://discord.gg/MDz7hsrh9m";

    function showUpdateRequiredUI() {
        if (updateRequiredUiShown) return;
        updateRequiredUiShown = true;
        showBanner("ATLAS update required — Tampermonkey → Check for updates", "#ffcf5b");
    }

    function showWritesPausedUI() {
        if (writesPausedUiShown) return;
        writesPausedUiShown = true;
        showBanner("Writes are paused. Standings are frozen until Pal turns them back on.", "#ffcf5b");
    }

    function showNotAllowlistedUI() {
        if (notAllowlistedUiShown) return;
        notAllowlistedUiShown = true;
        createHUD();
        if (!hud || document.getElementById("rgAllowlistNudge")) return;
        const bar = document.createElement("div");
        bar.id = "rgAllowlistNudge";
        bar.style.cssText = `
            position:absolute;
            top:-38px;
            left:0;
            right:0;
            display:flex;
            align-items:center;
            justify-content:space-between;
            gap:8px;
            padding:6px 10px;
            border:1px solid #ffcf5b;
            border-radius:8px;
            background:rgba(10,14,18,0.95);
            color:#ffcf5b;
            font:600 12px system-ui, sans-serif;
            z-index:5;
        `;
        const link = document.createElement("a");
        link.href = DISCORD_INVITE;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Leaderboard is invite-only — ask Pal or JesusDied4U on Discord to add you";
        link.style.cssText = "color:#ffcf5b;text-decoration:none;flex:1;cursor:pointer";
        const uid = firebaseAuthUid || "";
        if (uid) link.title = `Your Firebase id: ${uid}`;
        bar.appendChild(link);
        hud.appendChild(bar);
    }

    async function isUpdateRequired(fb) {
        if (updateRequiredChecked) return updateRequired || writesPaused;
        try {
            // one read covers version + the halt switch. Pin book stays off
            // this client. A permission-denied here means this uid is not
            // on the allow list — show the invite bar, do not retry the
            // pin doc.
            const snap = await fb.getDoc(fb.doc(fb.db, "admin", "gate"));
            // read went through, so the uid is on the allowlist now
            notAllowlisted = false;
            if (snap.exists()) {
                const data = snap.data() || {};
                if (data.pauseWrites === true) writesPaused = true;
                const minV = data.minVersion;
                if (typeof minV === "number" && SCRIPT_VERSION_NUM < minV) {
                    updateRequired = true;
                }
            }
        } catch (e) {
            if (firebaseAuthUid && isDeny(e)) {
                notAllowlisted = true;
            } else {
                dbg("isUpdateRequired read failed (non-fatal): " + getErrMsg(e));
            }
        }
        updateRequiredChecked = true;
        return updateRequired || writesPaused;
    }

    // ---------- Soft update nudge ----------
    // admin/latest_version is the current recommended release. If we're older
    // (and not already dismissed for this exact version), show a persistent
    // click-to-install banner. Non-blocking — the hard gate lives in
    // admin/gate.minVersion and admin/blacklist.minVersion (writes).
    let updateNudgeChecked = false;
    const DEFAULT_UPDATE_URL =
        "https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/rg_hud.user.js";

    async function maybeShowUpdateNudge() {
        if (updateNudgeChecked) return;
        updateNudgeChecked = true;
        try {
            const fb = await initFirebase();
            if (!fb) return;
            const snap = await fb.getDoc(fb.doc(fb.db, "admin", "latest_version"));
            if (!snap.exists()) return;
            const data = snap.data() || {};
            const latest = Number(data.versionNum);
            if (!Number.isFinite(latest) || SCRIPT_VERSION_NUM >= latest) return;

            const dismissedKey = `rgAtlasUpdateDismissed_v${latest}`;
            try { if (localStorage.getItem(dismissedKey) === "1") return; } catch (e) {}

            const updateUrl = typeof data.updateUrl === "string" && /^https:\/\//.test(data.updateUrl)
                ? data.updateUrl
                : DEFAULT_UPDATE_URL;
            showUpdateNudge(String(latest), updateUrl, dismissedKey);
        } catch (e) {
            dbg("maybeShowUpdateNudge failed (non-fatal): " + getErrMsg(e));
        }
    }

    function showUpdateNudge(version, url, dismissedKey) {
        createHUD();
        if (!hud || document.getElementById("rgUpdateNudge")) return;
        const bar = document.createElement("div");
        bar.id = "rgUpdateNudge";
        bar.style.cssText = `
            position:absolute;
            top:-38px;
            left:0;
            right:0;
            display:flex;
            align-items:center;
            justify-content:space-between;
            gap:8px;
            padding:6px 10px;
            border:1px solid #5bb1ff;
            border-radius:8px;
            background:rgba(10,14,18,0.95);
            color:#5bb1ff;
            font:600 12px system-ui, sans-serif;
            z-index:5;
        `;
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = `↓ ATLAS ${version} available. Click to update.`;
        link.style.cssText = "color:#5bb1ff;text-decoration:none;flex:1;cursor:pointer";
        const dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.textContent = "×";
        dismiss.title = "Dismiss until next release";
        dismiss.style.cssText = "all:unset;cursor:pointer;color:#5bb1ff;font-weight:bold;padding:0 4px";
        dismiss.addEventListener("click", () => {
            try { localStorage.setItem(dismissedKey, "1"); } catch (e) {}
            bar.remove();
        });
        bar.appendChild(link);
        bar.appendChild(dismiss);
        hud.appendChild(bar);
    }

    function isAllowlistGatedLabel(label) {
        const s = String(label || "");
        if (/clan/i.test(s)) return false;
        return /leaderboard|script_submissions|hud_read|submission|upsertPlaylist/i.test(s);
    }

    async function atlasMutationAllowed(fb, label) {
        await isUpdateRequired(fb);
        if (writesPaused) {
            showWritesPausedUI();
            dbg(`blocked paused-writes mutation: ${label}`);
            return false;
        }
        if (updateRequired) {
            showUpdateRequiredUI();
            dbg(`blocked outdated client mutation: ${label}`);
            return false;
        }
        if (notAllowlisted && isAllowlistGatedLabel(label)) {
            showNotAllowlistedUI();
            dbg(`blocked allow-list mutation: ${label}`);
            return false;
        }
        if (notAllowlisted) showNotAllowlistedUI();
        return true;
    }

    function atlasStampedMutationData(ref, data) {
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            return data;
        }
        const deviceId = getDeviceId();
        const stamped = deviceId ? { ...data, deviceId } : { ...data };
        const path = String(ref?.path || "");
        if (!/^clans\/[^/]+$/.test(path)) return stamped;
        return {
            ...stamped,
            scriptVersion: SCRIPT_VERSION,
            versionNum: SCRIPT_VERSION_NUM,
        };
    }

    // Short "who/what" line for the deny record — e.g. Nickname="Xuuya"
    // beats a bare "script_submissions" bucket. Bounded to stay safe.
    function describeWriteSubject(label, data) {
        if (!data || typeof data !== "object") return "";
        const parts = [];
        if (data.playlist) parts.push(`playlist=${String(data.playlist)}`);
        if (data.Nickname) parts.push(`Nickname="${String(data.Nickname).slice(0, 40)}"`);
        else if (data.name) parts.push(`name="${String(data.name).slice(0, 40)}"`);
        if (data.tag) parts.push(`tag=${String(data.tag).slice(0, 16)}`);
        if (data.role) parts.push(`role=${String(data.role).slice(0, 24)}`);
        if (data.clanId) parts.push(`clanId=${String(data.clanId).slice(0, 32)}`);
        if (!parts.length && label) parts.push(`label=${label}`);
        return parts.join(" ").slice(0, 120);
    }

    async function atlasSetDoc(fb, label, ref, data, options) {
        if (!firebaseAuthUid) {
            dbg("atlasSetDoc skipped: firebaseAuthUid not ready");
            return false;
        }
        if (!(await atlasMutationAllowed(fb, label))) return false;
        logWrite(label);
        const stamped = atlasStampedMutationData(ref, data);
        const startedAt = Date.now();
        const attempt = {
            at: startedAt,
            label,
            path: ref && ref.path,
            merge: !!(options && options.merge),
            payloadKeys: Object.keys(stamped),
            payload: _sanitizeWriteValue(stamped),
        };
        try {
            if (options === undefined) await fb.setDoc(ref, stamped);
            else await fb.setDoc(ref, stamped, options);
            _pushWriteAttempt({ ...attempt, ok: true, latencyMs: Date.now() - startedAt });
            return true;
        } catch (e) {
            if (e && String(e.code || "").includes("permission-denied")) {
                const docId = ref && ref.id;
                logDeny(label, {
                    op: "write",
                    path: ref && ref.path,
                    err: e,
                    subject: describeWriteSubject(label, data),
                    reasons: describeDenyReasons(label, data, { docId }),
                });
            }
            _pushWriteAttempt({
                ...attempt,
                ok: false,
                latencyMs: Date.now() - startedAt,
                errCode: e && e.code,
                errName: e && e.name,
                errMsg: e && e.message,
                serverResponse: e && e.customData && e.customData.serverResponse,
                stack: formatStackTrace(e),
            });
            throw e;
        }
    }

    async function atlasDeleteDoc(fb, label, ref) {
        if (!(await atlasMutationAllowed(fb, label))) return false;
        logWrite(label);
        await fb.deleteDoc(ref);
        return true;
    }

    async function runAtlasTransaction(fb, label, callback) {
        if (!(await atlasMutationAllowed(fb, label))) return false;
        await fb.runTransaction(fb.db, async transaction => {
            const counted = {
                get: async ref => {
                    const snapshot = await transaction.get(ref);
                    logRead(ref?.path || `${label} transaction`);
                    return snapshot;
                },
                set: (ref, data, ...args) => {
                    logWrite(label);
                    return transaction.set(
                        ref,
                        atlasStampedMutationData(ref, data),
                        ...args
                    );
                },
                update: (ref, data, ...args) => {
                    logWrite(label);
                    return transaction.update(
                        ref,
                        atlasStampedMutationData(ref, data),
                        ...args
                    );
                },
                delete: (...args) => {
                    logWrite(label);
                    return transaction.delete(...args);
                },
            };
            return callback(counted);
        });
        return true;
    }

    // strips TMP tags (<#rrggbb>, <br>, etc.)
    function cleanName(name) {
        return (name ?? "")
            .replace(/<[^>]*>/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    // not exhaustive. \b avoids catching "classic" / "assassin".
    const PROFANITY_LIST = [
        // common curses
        "fuck", "fuk", "fvck", "fck", "shit", "sh1t", "shyt", "bitch", "b1tch",
        "cunt", "asshole", "ass hole", "dick", "d1ck", "cock", "pussy", "pu55y",
        "bastard", "damn", "piss", "twat", "wanker", "bollocks", "arse",
        // slurs (racial / ethnic)
        "nigger", "nigga", "n1gger", "n1gga", "chink", "spic", "wetback",
        "gook", "kike", "beaner", "coon", "paki",
        // slurs (homophobic / transphobic)
        "faggot", "fag", "f4g", "dyke", "tranny", "shemale",
        // slurs (ableist / other)
        "retard", "retarded", "r3tard", "spastic", "cripple",
        // sexual / degrading
        "whore", "slut", "hoe", "rape", "rapist", "molest", "pedo", "pedophile",
        // hate groups / extremist terms
        "nazi", "hitler", "kkk",
    ];
    const PROFANITY_REGEX = new RegExp(`\\b(${PROFANITY_LIST.join("|")})\\b`, "i");

    // uppercase letters only. enforced on input and submit.
    function sanitizeClanTag(raw) {
        return String(raw || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
    }

        function containsProfanity(text) {
        return PROFANITY_REGEX.test(text);
    }

    // rejects any emoji / pictographic incl. flag sequences
    const EMOJI_REGEX = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}|[\u{1F1E6}-\u{1F1FF}\u{1F3F3}\u{1F3F4}\u{E0020}-\u{E007F}\u{200D}]/u;
    function containsEmoji(text) {
        return EMOJI_REGEX.test(text);
    }

    function hasPlayedAnything(data) {
        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        return modes.some(m => (data.ModesData?.[m]?.matchesPlayed ?? 0) > 0);
    }

    // ---------- In-HUD name modal (replaces window.prompt) ----------

    let nameModalResolve = null;

    function showNameModal(title, defaultValue, isRealPrompt, resolve) {
        createHUD();
        const modal = document.getElementById("rgNameModal");
        const input = document.getElementById("rgNameInput");
        document.getElementById("rgNameTitle").textContent = title;
        document.getElementById("rgNameError").textContent = "";
        input.value = defaultValue;
        modal.style.display = "flex";
        nameModalResolve = isRealPrompt ? resolve : null;
        if (isRealPrompt) {
            setTimeout(() => input.focus(), 50);
            probeInput(input, "rgNameInput");
        }
    }

    function hideNameModal() {
        const modal = document.getElementById("rgNameModal");
        if (modal) modal.style.display = "none";
        nameModalResolve = null;
    }

    function hideNameModalSoon() {
        setTimeout(hideNameModal, 1600);
    }

    // Unity swallows printable keys in capture phase. we intercept earlier
    // and stopImmediatePropagation while a HUD input is focused, so the
    // game never sees the event.
    ["keydown", "keyup", "keypress"].forEach(type => {
        window.addEventListener(type, e => {
            const active = document.activeElement;
            const dialog = document.getElementById("rgDialog");
            const dialogOpen = isFlexVisible(dialog);
            if (dialogOpen) {
                e.stopImmediatePropagation();
                if (type === "keydown" && e.key === "Escape") {
                    e.preventDefault();
                    const btn = document.getElementById("rgDialogCancel");
                    if (isVisible(btn)) btn.click();
                } else if (type === "keydown" && e.key === "Enter"
                    && (active?.id === "rgDialogInput" || active?.id === "rgDialogOk")) {
                    e.preventDefault();
                    document.getElementById("rgDialogOk")?.click();
                } else if (type === "keydown" && e.key === "Enter" && active?.id === "rgDialogCancel") {
                    e.preventDefault();
                    document.getElementById("rgDialogCancel")?.click();
                }
                return;
            }
            const inHud = active && hud && hud.contains(active)
                && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")
                && active.type !== "checkbox" && active.type !== "range" && active.type !== "color";
            if (inHud) {
                e.stopImmediatePropagation();
                // Enter saves the name modal
                if (type === "keydown" && e.key === "Enter" && active.id === "rgNameInput") {
                    const saveBtn = document.getElementById("rgNameSave");
                    if (saveBtn && !saveBtn.disabled) saveBtn.click();
                }
            }
        }, true); // capture — must run before Unity's listener
    });

    function displayNameStorageKey(rgPlayerId) {
        return "atlasDisplayName:" + String(rgPlayerId || "").trim();
    }

    function readStoredDisplayName(storage, rgPlayerId) {
        if (!storage || typeof storage.get !== "function" || !rgPlayerId) return "";
        try {
            const name = storage.get(displayNameStorageKey(rgPlayerId));
            return typeof name === "string" ? name.trim() : "";
        } catch (e) {
            return "";
        }
    }

    function writeStoredDisplayName(storage, rgPlayerId, name) {
        if (!storage || typeof storage.set !== "function" || !rgPlayerId || !name) return;
        try { storage.set(displayNameStorageKey(rgPlayerId), String(name).trim()); } catch (e) {}
    }

    function boardNameWithoutClanTag(name) {
        return String(name || "").trim().replace(/^\[[^\]]+\]\s*/, "").trim();
    }

    function nameRowBelongsToPlayer(row, firebaseUid, rgPlayerId) {
        if (!row || typeof row !== "object") return false;
        if (firebaseUid && row.sourceUserId === firebaseUid) return true;
        if (rgPlayerId && row.rgPlayerId === rgPlayerId) return true;
        return false;
    }

    function isNameTakenByOthers(rows, firebaseUid, rgPlayerId) {
        return (rows || []).some((row) => !nameRowBelongsToPlayer(row, firebaseUid, rgPlayerId));
    }

    function displayNameFromLeaderboardDocs(rows, rgPlayerId) {
        return boardIdentityFromDocs(rows, rgPlayerId).displayName;
    }

    function boardIdentityFromDocs(rows, rgPlayerId) {
        for (const row of rows || []) {
            if (!row || row.rgPlayerId !== rgPlayerId) continue;
            if (row.playlist === "tombstone") continue;
            return {
                displayName: boardNameWithoutClanTag(row.name).slice(0, 15),
                sourceUserId: typeof row.sourceUserId === "string" ? row.sourceUserId : "",
            };
        }
        return { displayName: "", sourceUserId: "" };
    }

    function shouldPublishLeaderboardRow(existingSourceUserIds, firebaseUid) {
        const ids = Array.isArray(existingSourceUserIds)
            ? existingSourceUserIds.filter(Boolean)
            : (existingSourceUserIds ? [existingSourceUserIds] : []);
        if (ids.includes(firebaseUid)) return true;
        return ids.length === 0;
    }

    async function lookupDisplayNameFromBoard(fb, rgPlayerId) {
        if (!fb || !rgPlayerId) return "";
        try {
            const q = fb.query(
                fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
                fb.where("rgPlayerId", "==", rgPlayerId),
                fb.limit(8)
            );
            const snap = await fb.getDocs(q);
            return boardIdentityFromDocs(snap.docs.map((d) => d.data()), rgPlayerId).displayName;
        } catch (e) {
            dbg("lookupDisplayNameFromBoard failed: " + getErrMsg(e));
            return "";
        }
    }

    // best-effort collision check. two simultaneous picks could both pass,
    // but that's rare enough to live with.
    async function isNameTaken(fb, name, firebaseUid, rgPlayerId) {
        try {
            const q = fb.query(
                fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
                fb.where("name", "==", name),
                fb.limit(8)
            );
            const snap = await fb.getDocs(q);
            return isNameTakenByOthers(
                snap.docs.map((d) => d.data()),
                firebaseUid,
                rgPlayerId,
            );
        } catch (e) {
            // don't block on check failure, let it through
            dbg("isNameTaken check failed (letting through): " + getErrMsg(e));
            console.warn("[RG HUD] Name availability check failed:", e);
            return false;
        }
    }

    function askDisplayName(suggestion, isRename, fb, firebaseUid, rgPlayerId) {
        return new Promise(resolve => {
            const title = isRename
                ? "Enter your new leaderboard name:"
                : "Pick your leaderboard name to appear on the board:";
            showNameModal(title, suggestion, true, resolve);

            const input = document.getElementById("rgNameInput");
            const errEl = document.getElementById("rgNameError");
            const saveBtn = document.getElementById("rgNameSave");

            saveBtn.onclick = async () => {
                try {
                    const entered = input.value.trim();
                    if (entered.length === 0 || entered.length > 15) {
                        errEl.textContent = "Name must be 1-15 characters.";
                        return;
                    }
                    if (containsProfanity(entered)) {
                        errEl.textContent = "That name isn't allowed. Pick something else.";
                        return;
                    }
                    if (entered.toLowerCase() === "player") {
                        errEl.textContent = "\"Player\" is reserved. Pick a real name.";
                        return;
                    }
                    if (containsEmoji(entered)) {
                        errEl.textContent = "Names can't contain emojis.";
                        return;
                    }

                    // async availability check
                    errEl.style.color = "#7ec8ff";
                    errEl.textContent = "Checking availability...";
                    saveBtn.disabled = true;
                    const taken = fb ? await isNameTaken(fb, entered, firebaseUid, rgPlayerId) : false;
                    saveBtn.disabled = false;
                    errEl.style.color = "#ff6b6b";

                    if (taken) {
                        errEl.textContent = "That name is already taken. Pick another.";
                        return;
                    }

                    errEl.textContent = "";
                    hideNameModal();
                    resolve(entered);
                } catch (e) {
                    dbg("askDisplayName save handler threw: " + getErrMsg(e));
                    saveBtn.disabled = false;
                    errEl.style.color = "#ff6b6b";
                    errEl.textContent = "Something went wrong. Try again.";
                }
            };

            document.getElementById("rgNameCancel").onclick = () => {
                hideNameModal();
                resolve(null); // cancel -> skip this submission
            };

            // Enter-to-save is wired in the window capture listener above
        });
    }

    // ---------- Write-reduction caches ----------
    // read nothing twice per session, write nothing unchanged.

    const cachedDisplayNames = new Map();  // player -> displayName
    const lastSyncSnapshot = new Map();    // player -> last payload JSON

    const SYNC_COOLDOWN_MS = 20000;
    const lastSyncTime = new Map();

    let forceRenamePrompt = false;

    // serialize per-player so races can't double-prompt or double-write
    const submitLocks = new Map();

    async function submitToLeaderboard(data) {
        try {
            const lockKey = data.Id;
            const previous = submitLocks.get(lockKey) || Promise.resolve();
            // swallow inner rejects so the lock chain keeps working
            const current = previous.then(() => submitToLeaderboardInner(data)).catch(e => {
                dbg("submitToLeaderboardInner threw: " + getErrMsg(e));
            });
            submitLocks.set(lockKey, current);
            await current;
        } catch (e) {
            dbg("submitToLeaderboard threw: " + getErrMsg(e));
        }
    }

    async function submitToLeaderboardInner(data) {
      try {
        if (!hasPlayedAnything(data)) return;

        const fb = await initFirebase();
        if (!fb) return;
        if (!(await atlasMutationAllowed(fb, "leaderboard submission"))) return;
        if (!firebaseAuthUid) {
            dbg("submitToLeaderboardInner skipped: firebaseAuthUid not ready");
            return;
        }

        const docRef = fb.doc(fb.db, LEADERBOARD_COLLECTION, firebaseAuthUid);

        // ask for display name once per player unless Rename forces it.
        // Memory dies on refresh; Tampermonkey storage and the public board
        // keep the same in-game account from getting the first-run prompt
        // after a new Firebase id.
        let existingDisplayName = cachedDisplayNames.get(data.Id) ?? null;
        if (!existingDisplayName) {
            existingDisplayName = readStoredDisplayName(atlasTmStorage(), data.Id) || null;
        }

        if (!existingDisplayName || forceRenamePrompt) {
            try {
                const existing = await fb.getDoc(docRef);
                if (existing.exists() && existing.data().displayName) {
                    existingDisplayName = existing.data().displayName;
                }
            } catch (e) {
                dbg("submitToLeaderboardInner: prior displayName read failed");
            }
        }

        if (!existingDisplayName && !forceRenamePrompt) {
            existingDisplayName = await lookupDisplayNameFromBoard(fb, data.Id) || null;
        }

        let displayName = (!forceRenamePrompt && existingDisplayName) ? existingDisplayName : null;
        const isRename = forceRenamePrompt && !!existingDisplayName;
        forceRenamePrompt = false;

        if (!displayName) {
            const cleaned = cleanName(data.Nickname).slice(0, 15);
            const suggestion = (cleaned && cleaned.toLowerCase() !== "player") ? cleaned : "";
            if (suggestion && !isRename) {
                const taken = await isNameTaken(fb, suggestion, firebaseAuthUid, data.Id);
                if (!taken) displayName = suggestion;
            }
            if (!displayName) {
                displayName = await askDisplayName(suggestion, isRename, fb, firebaseAuthUid, data.Id);
                if (!displayName) return;
            }
        }

        cachedDisplayNames.set(data.Id, displayName);
        writeStoredDisplayName(atlasTmStorage(), data.Id, displayName);

        // Full Glicko snapshot per playlist: rating, displayRating, rd,
        // vol. snapshotKey below only hashes displayRating + stats so
        // this doesn't change how often we sync. `ratings` stays for
        // anything that already reads the flat displayRating map.
        const glickoFor = (mode) => {
            const g = data.ModesGlicko?.[mode] || {};
            return {
                rating: typeof g.rating === "number" ? g.rating : null,
                displayRating: typeof g.displayRating === "number" ? g.displayRating : null,
                rd: typeof g.rd === "number" ? g.rd : null,
                vol: typeof g.vol === "number" ? g.vol : null,
            };
        };
        const payload = {
            nickname: (data.Nickname ?? "").slice(0, 500),
            displayName,
            ratings: {
                Competitive3v3: data.ModesGlicko?.Competitive3v3?.displayRating ?? null,
                Competitive2v2: data.ModesGlicko?.Competitive2v2?.displayRating ?? null,
                Competitive1v1: data.ModesGlicko?.Competitive1v1?.displayRating ?? null,
                Casual: data.ModesGlicko?.Casual?.displayRating ?? null,
            },
            glicko: {
                Competitive3v3: glickoFor("Competitive3v3"),
                Competitive2v2: glickoFor("Competitive2v2"),
                Competitive1v1: glickoFor("Competitive1v1"),
                Casual: glickoFor("Casual"),
            },
            stats: {
                Competitive3v3: data.ModesData?.Competitive3v3 ?? null,
                Competitive2v2: data.ModesData?.Competitive2v2 ?? null,
                Competitive1v1: data.ModesData?.Competitive1v1 ?? null,
                Casual: data.ModesData?.Casual ?? null,
            },
            currentStreak: streakData?.accountId === data.Id
                ? Math.trunc(Number(streakData.streak) || 0)
                : 0,
            xp: data.AccountXp ?? 0,
            equippedSkinId: data.EquippedSkinId ?? null,
            lastUpdated: new Date().toISOString(),
            sourceUserId: firebaseAuthUid,
            rgPlayerId: data.Id,
            deviceId: getDeviceId(),
            scriptVersion: SCRIPT_VERSION,
            versionNum: SCRIPT_VERSION_NUM,
            // Last 5 match snapshots for cheap "recent form" reads. Full
            // per-match history lives in match_snapshots/{authUid}_{matchId}.
            recentMatches: (_recentMatchesRing || []).slice(-RECENT_MATCHES_CAP),
            lastWriteAt: fb.serverTimestamp(),
        };

        // Tag for the snapshot key. Off-event we do not touch clan docs —
        // use whatever is already in memory from the clan panel.
        if (!clanLoaded || clanLoadedForAccount !== data.Id) {
            await loadEventConfig(fb);
            if (eventPhase() === "active") await loadClanData(true);
        }

        // clan tag lives in the snapshot key so a tag change alone forces
        // a resync. Rename always bypasses the "unchanged" skip.
        const currentClanTag = (clanLoadedForAccount === data.Id && myClan) ? (myClan.tag ?? "") : "";
        const snapshotKey = JSON.stringify({
            displayName, ratings: payload.ratings, stats: payload.stats,
            currentStreak: payload.currentStreak,
            xp: payload.xp, equippedSkinId: payload.equippedSkinId,
            clanTag: currentClanTag,
        });
        const now = Date.now();
        const unchanged = lastSyncSnapshot.get(data.Id) === snapshotKey;
        const withinCooldown = (now - (lastSyncTime.get(data.Id) ?? 0)) < SYNC_COOLDOWN_MS;

        if (!isRename && (unchanged || withinCooldown)) {
            // still refresh ranks once per session
            refreshRanks(fb, data);
            return;
        }

        let writeOk = false;
        try {
            writeOk = await atlasSetDoc(
                fb,
                "script_submissions",
                docRef,
                payload,
                { merge: true }
            );
            // cache AFTER success, otherwise a rejected write looks "unchanged"
            // next time and never retries
            if (!writeOk) return;
            lastSyncTime.set(data.Id, now);
            clearError();
        } catch (e) {
            console.error("[RG HUD] Leaderboard submission failed:", e);
            showError("Stats submission failed -- check console");
        }

        // don't publish partial state; leave cooldown open for a retry
        if (!writeOk) return;
        await syncToRealLeaderboard(fb, data, displayName);
        // Cache the snapshot only after the public board write. A
        // submissions-only success used to skip later retries when the
        // board owner check bailed out.
        lastSyncSnapshot.set(data.Id, snapshotKey);
        refreshRanks(fb, data, true);
        refreshClanViewIfOpen();
        applyTitle(); // clan-lead may have flipped since updateMomentum
      } catch (e) {
        dbg("submitToLeaderboardInner threw: " + getErrMsg(e));
      }
    }

    const REAL_LEADERBOARD_COLLECTION = "leaderboard";

    // serialize per player+mode so races can't create duplicate docs
    const upsertLocks = new Map();

    // Sourced rows have one stable id. merge:true preserves hand-set fields on
    // that row, while unrelated manual site rows are never queried or touched.
    async function upsertPlaylistEntry(fb, sourceUserId, playlist, fields) {
        const lockKey = `${sourceUserId}_${playlist}`;
        const previous = upsertLocks.get(lockKey) || Promise.resolve();

        const current = previous.then(async () => {
            // identifying fields on every write so rules can blacklist-check merges
            const fullFields = {
                ...fields,
                sourceUserId,
                playlist,
                deviceId: getDeviceId(),
                scriptVersion: SCRIPT_VERSION,
                versionNum: SCRIPT_VERSION_NUM,
                lastWriteAt: fb.serverTimestamp(),
            };

            try {
                const deterministicId = `${sourceUserId}_${playlist}`;
                const wrote = await atlasSetDoc(
                    fb,
                    `leaderboard/${playlist}`,
                    fb.doc(fb.db, REAL_LEADERBOARD_COLLECTION, deterministicId),
                    fullFields,
                    { merge: true }
                );
                if (!wrote) return false;
                clearError();
                return true;
            } catch (e) {
                pushError(e, `upsertPlaylistEntry:${playlist}`);
                console.error(`[RG HUD] Real leaderboard sync failed for ${playlist}:`, e);
                showError(`Leaderboard sync failed for ${playlist} -- check console`);
                return false;
            }
        });

        upsertLocks.set(lockKey, current);
        return current;
    }

    // last-written state per player+playlist. a 3v3 match only touches 3v3+wins,
    // so 1v1/2v2 skip. sessionStorage-backed so refresh doesn't full-burst.
    const lastEntryState = new Map(
        (() => {
            try { return JSON.parse(sessionStorage.getItem("rgHudEntryState") ?? "[]"); }
            catch (e) {
                dbg("lastEntryState load failed, starting empty");
                return [];
            }
        })()
    );

    function saveEntryState() {
        try {
            sessionStorage.setItem("rgHudEntryState", JSON.stringify([...lastEntryState]));
        } catch (e) {}
    }

    // The public rules deny this collection and there is no retention job.
    // Keep the call site as a no-op until both exist.
    async function writeMatchAudit(prevRatings, opponents) {
        void prevRatings;
        void opponents;
        dbg("match audit disabled");
    }

    // ---------- Leaderboard opponent popup ----------
    // slides in when a match starts against someone in the leaderboard cache.
    // cache + config live in their own localStorage keys so the existing
    // near-real-time rank stuff is untouched.

    const RG_LB_CACHE_KEY_LEGACY = "rgHudLbCache_v1";
    const RG_LB_CACHE_KEY_PREFIX = "rgHudLbCache_v4";
    const RG_LB_CONFIG_KEY = "rgHudRemoteConfig_v1";
    const RG_LB_CONFIG_TTL_MS = 60 * 60 * 1000;
    const RG_LB_MODES = ["Competitive1v1", "Competitive2v2", "Competitive3v3"];
    // leaderboard docs store playlist as "1v1"/"2v2"/"3v3", not the mode name
    const RG_LB_MODE_TO_PLAYLIST = { Competitive1v1: "1v1", Competitive2v2: "2v2", Competitive3v3: "3v3" };
    const RG_LB_TOP_N = 100;
    const STREAK_SNIPE_MIN = 3;
    const RG_LB_DEFAULT_CONFIG = {
        popupDurationMs: 6000,
        popupEnabled: true,
        cacheRefreshHours: 3,
        minRankToShow: 100,
        streakSnipeMin: STREAK_SNIPE_MIN,
        // Remote flag: prefer leaderboard_cache/{playlist} (1 read) when true.
        useLeaderboardCache: false,
    };
    const LEADERBOARD_CACHE_COLLECTION = "leaderboard_cache";
    const RANKED_POPUP_PREFERENCES = Object.freeze({
        popupShowOpponents: true,
        popupShowTeammates: true,
        popupMaxRank: 100,
        popupDurationMs: 0,
        popupPosition: "top-right",
    });
    const OPPONENT_STREAK_CACHE_KEY = "rgHudOpponentStreak_v1";
    let opponentStreakCache = {};
    try {
        opponentStreakCache = JSON.parse(
            localStorage.getItem(OPPONENT_STREAK_CACHE_KEY) || "{}"
        ) || {};
    } catch (e) {
        dbg("opponent streak cache load failed");
    }

    function advanceOpponentStreak(previous, wins, matches, publishedStreak = null, now = Date.now()) {
        const safeWins = Number(wins);
        const safeMatches = Number(matches);
        const published = Number(publishedStreak);
        const base = {
            streak: 0,
            confident: false,
            lastWins: Number.isFinite(safeWins) ? safeWins : 0,
            lastMatches: Number.isFinite(safeMatches) ? safeMatches : 0,
            updatedAt: now,
        };
        if (publishedStreak !== null && Number.isFinite(published)) {
            base.streak = Math.max(-999, Math.min(999, Math.trunc(published)));
            base.confident = true;
            return base;
        }
        if (!Number.isFinite(safeWins)
            || !Number.isFinite(safeMatches)
            || safeWins < 0
            || safeMatches < safeWins) {
            return base;
        }
        const priorWins = Number(previous?.lastWins);
        const priorMatches = Number(previous?.lastMatches);
        if (!Number.isFinite(priorWins)
            || !Number.isFinite(priorMatches)
            || safeWins < priorWins
            || safeMatches < priorMatches) {
            return base;
        }
        const matchDiff = safeMatches - priorMatches;
        const winDiff = safeWins - priorWins;
        if (matchDiff <= 0) {
            base.streak = Math.trunc(Number(previous?.streak) || 0);
            base.confident = previous?.confident === true;
            return base;
        }
        const losses = matchDiff - winDiff;
        const priorStreak = Math.trunc(Number(previous?.streak) || 0);
        if (winDiff > 0 && losses === 0) {
            base.streak = priorStreak > 0 ? priorStreak + winDiff : winDiff;
        } else if (losses > 0 && winDiff === 0) {
            base.streak = priorStreak < 0 ? priorStreak - losses : -losses;
        } else {
            base.streak = winDiff >= losses ? 1 : -1;
        }
        base.streak = Math.max(-999, Math.min(999, base.streak));
        base.confident = true;
        return base;
    }

    function submissionTotals(stats) {
        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        let wins = 0;
        let matches = 0;
        let found = false;
        for (const mode of modes) {
            const row = stats?.[mode];
            if (typeof row?.wins !== "number" || typeof row?.matchesPlayed !== "number") continue;
            wins += row.wins;
            matches += row.matchesPlayed;
            found = true;
        }
        return found ? { wins, matches } : null;
    }

    function saveOpponentStreakCache() {
        try {
            const entries = Object.entries(opponentStreakCache)
                .sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0))
                .slice(0, 200);
            opponentStreakCache = Object.fromEntries(entries);
            localStorage.setItem(
                OPPONENT_STREAK_CACHE_KEY,
                JSON.stringify(opponentStreakCache)
            );
        } catch (e) {
            dbg("opponent streak cache save failed");
        }
    }

    // Same-match streak memo: roster + end-of-match popups often re-resolve
    // the same opponent; skip duplicate script_submissions gets for ~60s.
    const STREAK_READ_MEMO_TTL_MS = 60 * 1000;
    const _streakReadMemo = new Map();
    const _streakInFlight = new Map();

    async function resolveOpponentStreak(uid) {
        if (!uid) return { streak: 0, confident: false };
        const memo = _streakReadMemo.get(uid);
        if (memo && Date.now() - memo.at < STREAK_READ_MEMO_TTL_MS) {
            return memo.value;
        }
        if (_streakInFlight.has(uid)) return _streakInFlight.get(uid);
        const pending = (async () => {
            try {
                const fb = await initFirebase();
                if (!fb) return { streak: 0, confident: false };
                const snap = await fb.getDoc(
                    fb.doc(fb.db, LEADERBOARD_COLLECTION, uid)
                );
                if (!snap.exists()) {
                    const miss = { streak: 0, confident: false };
                    _streakReadMemo.set(uid, { at: Date.now(), value: miss });
                    return miss;
                }
                const data = snap.data() || {};
                const totals = submissionTotals(data.stats);
                if (!totals) {
                    const miss = { streak: 0, confident: false };
                    _streakReadMemo.set(uid, { at: Date.now(), value: miss });
                    return miss;
                }
                // Older clients merge their snapshot and leave unknown fields in
                // place, so only trust a streak when this version wrote the doc.
                const supportsPublishedStreak = Number(data.versionNum) >= 16.3;
                const published = supportsPublishedStreak
                    && Number.isFinite(Number(data.currentStreak))
                    ? Number(data.currentStreak)
                    : null;
                const next = advanceOpponentStreak(
                    opponentStreakCache[uid],
                    totals.wins,
                    totals.matches,
                    published,
                );
                opponentStreakCache[uid] = next;
                saveOpponentStreakCache();
                _streakReadMemo.set(uid, { at: Date.now(), value: next });
                return next;
            } catch (e) {
                dbg("opponent streak read failed: " + getErrMsg(e));
                return { streak: 0, confident: false };
            } finally {
                _streakInFlight.delete(uid);
            }
        })();
        _streakInFlight.set(uid, pending);
        return pending;
    }

    function normalizePopupPreferences(raw) {
        raw = raw || {};
        const positions = ["top-right", "top-left", "bottom-right", "bottom-left"];
        const durations = [0, 3000, 6000, 10000];
        const rank = Math.round(Number(raw.popupMaxRank));
        const duration = Number(raw.popupDurationMs);
        return {
            showOpponents: raw.popupShowOpponents !== false,
            showTeammates: raw.popupShowTeammates !== false,
            maxRank: Number.isFinite(rank) ? Math.max(1, Math.min(100, rank)) : 100,
            durationMs: durations.includes(duration) ? duration : 0,
            position: positions.includes(raw.popupPosition) ? raw.popupPosition : "top-right",
        };
    }

    function rankedPopupAllowed(rank, isTeammate, config, preferences) {
        config = config || {};
        preferences = preferences || {};
        if (config.popupEnabled === false) return false;
        const prefs = normalizePopupPreferences(preferences);
        const remoteRank = Number(config.minRankToShow);
        const remoteLimit = Number.isFinite(remoteRank)
            ? Math.max(1, Math.min(100, remoteRank))
            : 100;
        if (!Number.isFinite(rank) || rank > Math.min(remoteLimit, prefs.maxRank)) return false;
        if (isTeammate === true) return prefs.showTeammates;
        if (isTeammate === false) return prefs.showOpponents;
        return prefs.showTeammates || prefs.showOpponents;
    }

    function rankedPopupDuration(config, preferences) {
        config = config || {};
        preferences = preferences || {};
        const prefs = normalizePopupPreferences(preferences);
        if (prefs.durationMs) return prefs.durationMs;
        const remoteDuration = Number(config.popupDurationMs);
        return Number.isFinite(remoteDuration)
            ? Math.max(1500, Math.min(15000, remoteDuration))
            : 6000;
    }

    function popupStackPositionStyle(position) {
        const selected = normalizePopupPreferences({ popupPosition: position }).position;
        return {
            top: selected.startsWith("top-") ? "20px" : "auto",
            bottom: selected.startsWith("bottom-") ? "20px" : "auto",
            left: selected.endsWith("-left") ? "20px" : "auto",
            right: selected.endsWith("-right") ? "20px" : "auto",
            flexDirection: selected.startsWith("bottom-") ? "column-reverse" : "column",
        };
    }

    function leaderboardCacheKey(mode) {
        return `${RG_LB_CACHE_KEY_PREFIX}.${mode}`;
    }

    function prefersReducedPopupMotion() {
        return typeof window !== "undefined"
            && typeof window.matchMedia === "function"
            && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }

    let _remoteConfigMemo = null;
    const _lbCacheMemo = new Map();
    const _lbCacheInFlight = new Map();
    const _lbCacheFailUntil = new Map();
    const RG_LB_FAIL_COOLDOWN_MS = 60 * 1000;
    let _matchFormat = null;
    let _matchPlayerCount = 0;
    let _selfTeam = null;
    let _shownPopupsThisMatch = new Set();
    let _matchOpponentStreaks = new Map();
    let _deferredMatch = null;
    let _rosterFired = false;
    let _rosterFiring = false;
    let _rosterFireTimer = null;
    let _matchPopupGeneration = 0;

    async function fetchRemoteConfig() {
        try {
            const fb = await initFirebase();
            if (!fb) return null;
            const snap = await fb.getDoc(fb.doc(fb.db, "atlas_config", "hud"));
            if (!snap.exists()) return null;
            const raw = snap.data() || {};
            return { ...RG_LB_DEFAULT_CONFIG, ...raw, fetchedAt: Date.now() };
        } catch (e) {
            dbg("remote config fetch failed: " + getErrMsg(e));
            return null;
        }
    }

    async function getRemoteConfig() {
        if (_remoteConfigMemo && Date.now() - _remoteConfigMemo.fetchedAt < RG_LB_CONFIG_TTL_MS) {
            return _remoteConfigMemo;
        }
        try {
            const cached = JSON.parse(localStorage.getItem(RG_LB_CONFIG_KEY) || "null");
            if (cached && Date.now() - cached.fetchedAt < RG_LB_CONFIG_TTL_MS) {
                _remoteConfigMemo = cached;
                return cached;
            }
        } catch (e) {}
        const fresh = await fetchRemoteConfig();
        if (fresh) {
            _remoteConfigMemo = fresh;
            try { localStorage.setItem(RG_LB_CONFIG_KEY, JSON.stringify(fresh)); } catch (e) {}
            return fresh;
        }
        return { ...RG_LB_DEFAULT_CONFIG, fetchedAt: 0 };
    }

    function normalizeAggregateEntries(rows) {
        if (!Array.isArray(rows)) return [];
        const entries = [];
        for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index] || {};
            // Defense-in-depth: the aggregate builder already filters deleted
            // rows, but skip them here too so a bad publish can't leak them.
            if (row.deleted === true) continue;
            const uid = String(row.uid || row.sourceUserId || "").trim();
            const rgPlayerId = String(row.rgPlayerId || "").trim();
            const mmr = Number(row.mmr);
            if (!uid || !Number.isFinite(mmr)) continue;
            entries.push({
                uid,
                ...(rgPlayerId ? { rgPlayerId } : {}),
                name: String(row.name || ""),
                mmr,
                rank: Number(row.rank) > 0 ? Number(row.rank) : entries.length + 1,
            });
        }
        return entries;
    }

    async function fetchLeaderboardCacheFromAggregate(fb, mode, playlist, ttlMs) {
        const snap = await fb.getDoc(
            fb.doc(fb.db, LEADERBOARD_CACHE_COLLECTION, playlist)
        );
        if (!snap.exists()) return null;
        const data = snap.data() || {};
        const builtAt = Date.parse(data.builtAt || "")
            || Number(data.builtAt)
            || 0;
        if (!builtAt || Date.now() - builtAt > ttlMs) {
            dbg(`leaderboard aggregate stale (${playlist})`);
            return null;
        }
        const entries = normalizeAggregateEntries(data.rows);
        if (!entries.length) return null;
        dbg(`leaderboard cache aggregate (${playlist}:${entries.length})`);
        return {
            modes: { [mode]: entries },
            fetchedAt: Date.now(),
            source: "aggregate",
        };
    }

    async function fetchLeaderboardCacheDirect(fb, mode, playlist) {
        // Overfetch so we can drop soft-deleted rows client-side and still
        // end up with RG_LB_TOP_N live entries. The site's published JSON
        // does the same filter, so the popup ranks match the leaderboard.
        const q = fb.query(
            fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
            fb.where("playlist", "==", playlist),
            fb.orderBy("mmr", "desc"),
            fb.limit(Math.max(RG_LB_TOP_N + 25, Math.ceil(RG_LB_TOP_N * 1.2))),
        );
        const snap = await fb.getDocs(q);
        const entries = [];
        snap.forEach(doc => {
            const d = doc.data();
            if (d.deleted === true) return;
            const rgPlayerId = typeof d.rgPlayerId === "string" ? d.rgPlayerId.trim() : "";
            entries.push({
                uid: d.sourceUserId,
                ...(rgPlayerId ? { rgPlayerId } : {}),
                name: d.name,
                mmr: d.mmr,
            });
        });
        // Assign ranks after filtering so popup #s match the site's JSON.
        const capped = entries.slice(0, RG_LB_TOP_N).map((e, i) => ({ ...e, rank: i + 1 }));
        dbg(`leaderboard cache refreshed (${mode.replace("Competitive", "")}:${capped.length})`);
        return {
            modes: { [mode]: capped },
            fetchedAt: Date.now(),
            source: "query",
        };
    }

    async function fetchLeaderboardCache(mode) {
        try {
            if (firestoreReadBudgetPassed()) {
                dbg("leaderboard cache fetch skipped: read budget passed");
                return null;
            }
            const fb = await initFirebase();
            if (!fb) return null;
            const playlist = RG_LB_MODE_TO_PLAYLIST[mode];
            if (!playlist) return null;
            const cfg = await getRemoteConfig();
            const ttlMs = (cfg.cacheRefreshHours || 24) * 60 * 60 * 1000;
            if (cfg.useLeaderboardCache) {
                try {
                    const aggregate = await fetchLeaderboardCacheFromAggregate(
                        fb,
                        mode,
                        playlist,
                        ttlMs,
                    );
                    if (aggregate) return aggregate;
                } catch (e) {
                    dbg("leaderboard aggregate failed, falling back to query");
                }
            }
            if (firestoreReadBudgetPassed()) {
                dbg("leaderboard cache query skipped: read budget passed");
                return null;
            }
            return await fetchLeaderboardCacheDirect(fb, mode, playlist);
        } catch (e) {
            dbg("leaderboard cache fetch failed: " + getErrMsg(e));
            return null;
        }
    }

    async function getLeaderboardCache(mode) {
        if (!RG_LB_MODE_TO_PLAYLIST[mode]) return null;
        const cfg = await getRemoteConfig();
        const ttl = (cfg.cacheRefreshHours || 24) * 60 * 60 * 1000;
        const memo = _lbCacheMemo.get(mode);
        if (memo && Date.now() - memo.fetchedAt < ttl) return memo;
        try {
            const cached = JSON.parse(
                localStorage.getItem(leaderboardCacheKey(mode)) || "null"
            );
            if (cached && Date.now() - cached.fetchedAt < ttl) {
                _lbCacheMemo.set(mode, cached);
                return cached;
            }
            // Keep a warm cache across the v16 upgrade, then store only the
            // requested playlist in the new key.
            const legacy = JSON.parse(
                localStorage.getItem(RG_LB_CACHE_KEY_LEGACY) || "null"
            );
            if (legacy?.modes?.[mode] && Date.now() - legacy.fetchedAt < ttl) {
                const migrated = {
                    modes: { [mode]: legacy.modes[mode] },
                    fetchedAt: legacy.fetchedAt,
                };
                _lbCacheMemo.set(mode, migrated);
                try {
                    localStorage.setItem(
                        leaderboardCacheKey(mode),
                        JSON.stringify(migrated)
                    );
                } catch (e) {}
                return migrated;
            }
        } catch (e) {}
        // back off if we just failed — usually a missing index or perms issue,
        // no point hammering the same broken query for every roster entry.
        if (Date.now() < (_lbCacheFailUntil.get(mode) || 0)) return null;
        // share one in-flight fetch so 4 roster entries don't spawn 4 requests
        if (_lbCacheInFlight.has(mode)) return _lbCacheInFlight.get(mode);
        const inFlight = (async () => {
            try {
                const fresh = await fetchLeaderboardCache(mode);
                if (fresh) {
                    _lbCacheMemo.set(mode, fresh);
                    try {
                        localStorage.setItem(
                            leaderboardCacheKey(mode),
                            JSON.stringify(fresh)
                        );
                    } catch (e) {}
                    return fresh;
                }
                _lbCacheFailUntil.set(
                    mode,
                    Date.now() + RG_LB_FAIL_COOLDOWN_MS
                );
                return null;
            } finally {
                _lbCacheInFlight.delete(mode);
            }
        })();
        _lbCacheInFlight.set(mode, inFlight);
        return inFlight;
    }

    function lookupInCache(cache, uid, mode) {
        if (!cache || !cache.modes || !uid) return null;
        const entries = cache.modes[mode];
        if (!entries) return null;
        const needle = String(uid);
        // Roster logs only have the in-game id. Never match Firebase uid.
        // Old rows stored that game id in uid; new rows put it on rgPlayerId.
        return entries.find((e) => String(e.rgPlayerId || e.uid) === needle) || null;
    }

    function tierColorForRank(rank) {
        if (rank <= 3) return "#ffd700";
        if (rank <= 10) return "#c77dff";
        if (rank <= 25) return "#00d4ff";
        return "#9aa5ad";
    }

    function modeLabel(mode) {
        if (mode === "Competitive1v1") return "Competitive 1v1";
        if (mode === "Competitive2v2") return "Competitive 2v2";
        if (mode === "Competitive3v3") return "Competitive 3v3";
        return mode;
    }

    function ensureLbPopupStyles() {
        if (document.getElementById("rgLbPopupStyle")) return;
        const style = document.createElement("style");
        style.id = "rgLbPopupStyle";
        style.textContent = `
#rgLbPopupStack {
  position: fixed; top: 20px; right: 20px;
  display: flex; flex-direction: column; gap: 10px;
  z-index: 999999998; pointer-events: none;
}
.rg-lb-popup {
  width: 300px;
  background: linear-gradient(180deg, rgba(28,43,58,0.96), rgba(13,20,27,0.96));
  border: 1px solid #00bfff;
  border-radius: 10px;
  padding: 12px 14px;
  color: #d7f3ff;
  font-family: Arial, sans-serif;
  box-shadow: 0 8px 32px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,191,255,0.15), 0 0 24px rgba(0,191,255,0.25);
  position: relative;
  overflow: hidden;
  opacity: 0;
  transform: translateX(24px) translateY(-4px);
  transition: opacity 0.3s ease, transform 0.3s cubic-bezier(.16,.9,.28,1.15);
  pointer-events: auto;
}
.rg-lb-popup.show { opacity: 1; transform: translateX(0) translateY(0); }
.rg-lb-popup::before {
  content: ""; position: absolute; left: 0; right: 0; top: 0; height: 3px;
  background: var(--tier-color, #00bfff);
  box-shadow: 0 0 12px var(--tier-color, #00bfff);
}
.rg-lb-header {
  display: flex; align-items: center; gap: 6px;
  font-size: 10px; font-weight: bold;
  color: var(--tier-color, #00bfff);
  letter-spacing: 1.4px; text-transform: uppercase;
  margin-bottom: 8px;
  text-shadow: 0 0 8px var(--tier-color, #00bfff);
}
.rg-lb-header .rg-lb-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--tier-color, #00bfff);
  box-shadow: 0 0 8px var(--tier-color, #00bfff);
  animation: rg-lb-pulse 1.6s ease-in-out infinite;
}
@keyframes rg-lb-pulse {
  0%,100% { opacity: 1; transform: scale(1); }
  50% { opacity: .5; transform: scale(.85); }
}
.rg-lb-body { display: flex; align-items: center; gap: 12px; }
.rg-lb-rank {
  flex: 0 0 auto; min-width: 58px; height: 58px; padding: 0 8px;
  border-radius: 8px;
  background: linear-gradient(180deg, rgba(0,0,0,0.35), rgba(0,0,0,0.15));
  border: 2px solid var(--tier-color, #00bfff);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  box-shadow: inset 0 0 12px rgba(0,0,0,0.4);
}
.rg-lb-rank .rg-lb-hash {
  font-size: 10px; color: var(--tier-color, #00bfff);
  line-height: 1; opacity: .8; margin-bottom: 2px; font-weight: bold;
}
.rg-lb-rank .rg-lb-num {
  font-size: 22px; font-weight: 900;
  color: var(--tier-color, #00bfff);
  line-height: 1;
  font-family: "SF Mono", Consolas, monospace;
  letter-spacing: -1px;
}
.rg-lb-info { flex: 1 1 auto; min-width: 0; }
.rg-lb-name {
  font-size: 15px; font-weight: bold; color: #ffffff;
  line-height: 1.2;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 180px;
}
.rg-lb-mode {
  display: inline-block; margin-top: 4px; padding: 2px 8px;
  font-size: 10px; font-weight: bold; letter-spacing: .5px;
  background: rgba(0,191,255,0.12);
  border: 1px solid #00bfff88;
  color: #00bfff;
  border-radius: 999px;
}
.rg-lb-streak {
  margin-top: 6px; color: #ffb020; font-size: 11px; font-weight: 900;
  letter-spacing: .7px; text-transform: uppercase;
  text-shadow: 0 0 10px rgba(255,176,32,.55);
}
.rg-lb-teammate {
  margin-top: 10px; padding-top: 8px;
  border-top: 1px solid rgba(0,191,255,0.15);
  font-size: 11px; color: #a8c3d3;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.rg-lb-teammate .rg-lb-lbl { opacity: .7; text-transform: uppercase; letter-spacing: 1px; font-size: 9px; }
.rg-lb-teammate .rg-lb-tname {
  color: #fff; font-weight: bold; max-width: 140px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rg-lb-teammate .rg-lb-trank {
  padding: 1px 6px; border-radius: 4px; font-weight: bold; font-size: 10px;
  background: rgba(0,0,0,0.35);
}
@media (prefers-reduced-motion: reduce) {
  .rg-lb-popup { transition: none; transform: none; }
  .rg-lb-header .rg-lb-dot { animation: none; }
}
`;
        document.head.appendChild(style);
    }

    function showLbOpponentPopup({ rank, name, mode, isTeammate, winStreak, config, preferences }) {
        try {
            const cfg = config || RG_LB_DEFAULT_CONFIG;
            const prefs = normalizePopupPreferences(
                preferences || RANKED_POPUP_PREFERENCES
            );
            if (!rankedPopupAllowed(rank, isTeammate, cfg, prefs)) return;
            ensureLbPopupStyles();
            const dur = rankedPopupDuration(cfg, prefs);
            let stack = document.getElementById("rgLbPopupStack");
            if (!stack) {
                stack = document.createElement("div");
                stack.id = "rgLbPopupStack";
                document.body.appendChild(stack);
            }
            Object.assign(stack.style, popupStackPositionStyle(prefs.position));
            stack.dataset.position = prefs.position;
            const el = document.createElement("div");
            el.className = "rg-lb-popup";
            el.style.setProperty("--tier-color", tierColorForRank(rank));
            el.dataset.rank = String(rank);
            el.dataset.role = isTeammate === true ? "teammate" : isTeammate === false ? "opponent" : "player";
            const headerLabel = isTeammate === true ? "LEADERBOARD TEAMMATE"
                              : isTeammate === false ? "LEADERBOARD OPPONENT"
                              : "LEADERBOARD PLAYER";
            const safeStreak = isTeammate === false
                ? Math.max(0, Math.trunc(Number(winStreak) || 0))
                : 0;
            const streakHtml = safeStreak > 0
                ? `<div class="rg-lb-streak">🔥 ${safeStreak} win streak</div>`
                : "";
            el.innerHTML = `
                <div class="rg-lb-header"><span class="rg-lb-dot"></span>${headerLabel}</div>
                <div class="rg-lb-body">
                    <div class="rg-lb-rank">
                        <div class="rg-lb-hash">RANK</div>
                        <div class="rg-lb-num">#${rank}</div>
                    </div>
                    <div class="rg-lb-info">
                        <div class="rg-lb-name">${escapeHtml(name)}</div>
                        <div class="rg-lb-mode">${modeLabel(mode)}</div>
                        ${streakHtml}
                    </div>
                </div>
            `;
            stack.appendChild(el);
            requestAnimationFrame(() => el.classList.add("show"));
            setTimeout(() => {
                el.classList.remove("show");
                setTimeout(() => el.remove(), prefersReducedPopupMotion() ? 0 : 320);
            }, dur);
        } catch (e) {
            dbg("showLbOpponentPopup threw: " + getErrMsg(e));
        }
    }

    function streakSnipeCandidates(prevRatings, nextRatings, opponents, minimum = STREAK_SNIPE_MIN) {
        const changed = RG_LB_MODES.filter(mode => {
            const before = prevRatings?.[mode];
            const after = nextRatings?.[mode];
            return typeof before === "number"
                && typeof after === "number"
                && before !== after;
        });
        if (changed.length !== 1) return [];
        const mode = changed[0];
        if (nextRatings[mode] <= prevRatings[mode]) return [];
        const threshold = Math.max(1, Math.trunc(Number(minimum) || STREAK_SNIPE_MIN));
        return (Array.isArray(opponents) ? opponents : [])
            .filter(entry =>
                entry?.isTeammate === false
                && entry.confident === true
                && Number(entry.streak) >= threshold)
            .sort((a, b) => Number(b.streak) - Number(a.streak));
    }

    function streakSnipeMinimum(config) {
        const configured = Math.trunc(Number(config?.streakSnipeMin));
        return Number.isFinite(configured)
            ? Math.max(1, Math.min(100, configured))
            : STREAK_SNIPE_MIN;
    }

    function ensureStreakSnipeStyles() {
        if (document.getElementById("rgStreakSnipeStyle")) return;
        const style = document.createElement("style");
        style.id = "rgStreakSnipeStyle";
        style.textContent = `
@keyframes rgSnipeOverlay {
  0% { opacity: 0; }
  4%, 96.5% { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes rgSnipeLens {
  0% { opacity: 0; transform: scale(1.45); filter: blur(6px); }
  8%, 88% { opacity: 1; transform: scale(1); filter: blur(0); }
  100% { opacity: 0; transform: scale(1.04); }
}
@keyframes rgSnipeSway {
  0%, 4% { transform: translate(12px,-9px) rotate(-1.2deg); }
  10% { transform: translate(-9px,7px) rotate(.9deg); }
  16% { transform: translate(5px,-4px) rotate(-.5deg); }
  22% { transform: translate(-2px,2px) rotate(.2deg); }
  28%, 100% { transform: translate(0,0) rotate(0); }
}
@keyframes rgSnipeCompass {
  0%, 3% { opacity: 0; }
  6%, 29% { opacity: 1; }
  34%, 100% { opacity: 0; }
}
@keyframes rgSnipeBreath {
  0%, 3% { opacity: 0; }
  6%, 29% { opacity: 1; }
  34%, 100% { opacity: 0; }
}
@keyframes rgSnipeBreathDrain {
  0%, 6% { transform: scaleX(1); }
  29%, 100% { transform: scaleX(.06); }
}
@keyframes rgSnipeMuzzle {
  0%, 29% { opacity: 0; transform: scale(.35); }
  31% { opacity: .98; transform: scale(1.18); }
  35%, 100% { opacity: 0; transform: scale(1.65); }
}
@keyframes rgSnipeKick {
  0%, 29% { transform: translateY(0) rotate(0); }
  32% { transform: translateY(-34px) rotate(-2.8deg); }
  39% { transform: translateY(5px) rotate(.5deg); }
  44%, 100% { transform: translateY(0) rotate(0); }
}
@keyframes rgSnipeHit {
  0%, 33% { opacity: 0; transform: scale(.55); }
  36% { opacity: 1; transform: scale(1.35); }
  41% { opacity: 1; transform: scale(1); }
  48%, 100% { opacity: 0; }
}
@keyframes rgSnipeFinishRing {
  0%, 36% { opacity: 0; transform: scale(1.65) rotate(14deg); }
  43% { opacity: .95; transform: scale(.96) rotate(0); }
  96.5% { opacity: .72; transform: scale(1) rotate(0); }
  100% { opacity: 0; transform: scale(1.04); }
}
@keyframes rgSnipeFinishCard {
  0%, 39.5% { opacity: 0; transform: scale(.84); filter: blur(8px); }
  45%, 96.5% { opacity: 1; transform: scale(1); filter: blur(0); }
  100% { opacity: 0; transform: scale(1.04); }
}
#rgStreakSnipe {
  position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
  display: grid; place-items: center; overflow: hidden;
  background:
    radial-gradient(circle at center, rgba(34,211,238,.07), transparent 42%),
    rgba(2,6,12,.96);
  animation: rgSnipeOverlay 7.2s ease forwards;
}
#rgStreakSnipe .rg-snipe-vignette {
  position: absolute; inset: -4%;
  background: radial-gradient(circle at center, transparent 0 34%, rgba(2,6,12,.28) 48%, #010308 72%);
}
#rgStreakSnipe .rg-snipe-compass {
  position: absolute; top: 8%; left: 50%; z-index: 7;
  display: flex; gap: 18px; transform: translateX(-50%);
  color: rgba(174,184,196,.52);
  font: 800 10px/1 "IBM Plex Mono","SF Mono",Menlo,monospace;
  letter-spacing: .18em; animation: rgSnipeCompass 7.2s ease both;
}
#rgStreakSnipe .rg-snipe-kick {
  position: absolute; inset: 0; display: grid; place-items: center;
  animation: rgSnipeKick 7.2s cubic-bezier(.2,.7,.2,1) both;
}
#rgStreakSnipe .rg-snipe-lens {
  position: relative; width: min(72vmin,720px); aspect-ratio: 1; border-radius: 50%;
  display: grid; place-items: center; overflow: hidden;
  border: 1.5px solid rgba(174,184,196,.46);
  background: radial-gradient(circle at 42% 34%, rgba(255,255,255,.05), transparent 44%), rgba(7,11,18,.44);
  box-shadow: inset 0 0 90px rgba(0,0,0,.62), 0 0 70px rgba(0,0,0,.5);
  animation: rgSnipeLens 7.2s ease both;
}
#rgStreakSnipe .rg-snipe-sway {
  position: absolute; inset: 0; display: grid; place-items: center;
  animation: rgSnipeSway 7.2s ease-out both;
}
#rgStreakSnipe .rg-snipe-cross-h,
#rgStreakSnipe .rg-snipe-cross-v {
  position: absolute; background: rgba(230,235,240,.78);
  box-shadow: 0 0 10px rgba(230,235,240,.2);
}
#rgStreakSnipe .rg-snipe-cross-h { width: 30%; height: 1px; }
#rgStreakSnipe .rg-snipe-cross-v { width: 1px; height: 30%; }
#rgStreakSnipe .rg-snipe-hit {
  position: absolute; width: 24px; height: 24px; z-index: 8;
  animation: rgSnipeHit 7.2s ease-out both;
}
#rgStreakSnipe .rg-snipe-hit::before,
#rgStreakSnipe .rg-snipe-hit::after {
  content: ""; position: absolute; left: 50%; top: 50%;
  width: 16px; height: 2px; background: #d64545;
  box-shadow: 0 0 12px rgba(214,69,69,.7);
}
#rgStreakSnipe .rg-snipe-hit::before { transform: translate(-50%,-50%) rotate(45deg); }
#rgStreakSnipe .rg-snipe-hit::after { transform: translate(-50%,-50%) rotate(-45deg); }
#rgStreakSnipe .rg-snipe-muzzle {
  position: absolute; z-index: 6; width: min(66vmin,620px); aspect-ratio: 1; border-radius: 50%;
  background: radial-gradient(circle, rgba(255,255,255,.98) 0 5%, rgba(255,176,32,.48) 16%, transparent 55%);
  animation: rgSnipeMuzzle 7.2s ease-out both;
}
#rgStreakSnipe .rg-snipe-breath {
  position: absolute; left: 50%; bottom: 9%; z-index: 8;
  width: min(310px,70vw); transform: translateX(-50%);
  color: #7dd3c0; text-align: center;
  font: 800 10px/1 "IBM Plex Mono","SF Mono",Menlo,monospace;
  letter-spacing: .2em; text-transform: uppercase;
  animation: rgSnipeBreath 7.2s ease both;
}
#rgStreakSnipe .rg-snipe-breath-track {
  display: block; height: 2px; margin-top: 10px; overflow: hidden;
  background: rgba(125,211,192,.18);
}
#rgStreakSnipe .rg-snipe-breath-track::after {
  content: ""; display: block; width: 100%; height: 100%;
  transform-origin: left; background: #7dd3c0; box-shadow: 0 0 12px rgba(125,211,192,.65);
  animation: rgSnipeBreathDrain 7.2s linear both;
}
#rgStreakSnipe .rg-snipe-finish {
  position: absolute; inset: 0; z-index: 9;
  display: grid; place-items: center;
}
#rgStreakSnipe .rg-snipe-finish > * { grid-area: 1 / 1; }
#rgStreakSnipe .rg-snipe-finish-ring {
  position: relative; width: min(48vw,460px); aspect-ratio: 1;
  border: 1.5px solid rgba(34,211,238,.78); border-radius: 50%;
  box-shadow: 0 0 50px rgba(34,211,238,.18), inset 0 0 40px rgba(34,211,238,.08);
  animation: rgSnipeFinishRing 7.2s cubic-bezier(.2,.8,.2,1) both;
}
#rgStreakSnipe .rg-snipe-finish-ring::before,
#rgStreakSnipe .rg-snipe-finish-ring::after {
  content: ""; position: absolute; border-radius: 50%;
}
#rgStreakSnipe .rg-snipe-finish-ring::before {
  inset: 16%; border: 1px dashed rgba(34,211,238,.3);
}
#rgStreakSnipe .rg-snipe-finish-ring::after {
  inset: 47% -14%; border-top: 1px solid rgba(34,211,238,.75);
  border-bottom: 1px solid rgba(34,211,238,.75);
}
#rgStreakSnipe .rg-snipe-card {
  position: relative; width: min(700px,84vw); padding: clamp(28px,4vw,48px);
  color: #f8fafc; text-align: center; border: 1px solid rgba(34,211,238,.65);
  background: rgba(3,10,20,.92);
  box-shadow: 0 0 0 1px rgba(255,255,255,.04), 0 0 70px rgba(34,211,238,.2);
  animation: rgSnipeFinishCard 7.2s cubic-bezier(.16,.9,.28,1.05) both;
}
#rgStreakSnipe .rg-snipe-kicker {
  color: #67e8f9; font: 900 12px/1.2 Arial,sans-serif;
  letter-spacing: .28em; text-transform: uppercase;
}
#rgStreakSnipe .rg-snipe-title {
  max-width: 100%; margin-top: 14px; color: #fff;
  font: 900 clamp(28px,5vw,56px)/1.02 Arial,sans-serif;
  overflow-wrap: anywhere; word-break: break-word;
  text-shadow: 0 0 26px rgba(255,255,255,.2);
}
#rgStreakSnipe .rg-snipe-value {
  margin-top: 18px; color: #ffb020; font: 900 clamp(24px,4vw,44px)/1 Arial,sans-serif;
  letter-spacing: .04em; text-shadow: 0 0 26px rgba(255,176,32,.6);
}
#rgStreakSnipe .rg-snipe-foot {
  margin-top: 18px; color: #94a3b8; font: 800 12px/1 Arial,sans-serif;
  letter-spacing: .24em; text-transform: uppercase;
}
#rgStreakSnipe .rg-snipe-actions {
  margin-top: 26px; display: inline-flex; gap: 10px; flex-wrap: wrap;
  justify-content: center; opacity: 0;
  animation: rgSnipeFinishActions 7.2s cubic-bezier(.16,.9,.28,1.05) both;
}
#rgStreakSnipe .rg-snipe-action {
  pointer-events: auto; cursor: pointer;
  padding: 10px 18px; border-radius: 999px;
  font: 800 11px/1 Arial,sans-serif; letter-spacing: .18em; text-transform: uppercase;
  border: 1px solid; transition: transform .15s ease, background .15s ease, color .15s ease;
}
#rgStreakSnipe .rg-snipe-save {
  background: rgba(34,211,238,.16); border-color: rgba(34,211,238,.65); color: #67e8f9;
  text-shadow: 0 0 12px rgba(34,211,238,.4);
}
#rgStreakSnipe .rg-snipe-save:hover { background: rgba(34,211,238,.32); color: #fff; transform: translateY(-1px); }
#rgStreakSnipe .rg-snipe-save[disabled] { opacity: .6; cursor: default; transform: none; }
#rgStreakSnipe .rg-snipe-close {
  background: transparent; border-color: rgba(148,163,184,.35); color: #94a3b8;
}
#rgStreakSnipe .rg-snipe-close:hover { border-color: rgba(148,163,184,.65); color: #cbd5e1; }
@keyframes rgSnipeFinishActions {
  0%, 62% { opacity: 0; transform: translateY(6px); }
  70%, 96.5% { opacity: 1; transform: translateY(0); }
  100% { opacity: 0; transform: translateY(0); }
}
@media (max-width: 560px) {
  #rgStreakSnipe .rg-snipe-lens { width: min(84vmin,520px); }
  #rgStreakSnipe .rg-snipe-finish-ring { width: min(78vw,420px); }
  #rgStreakSnipe .rg-snipe-card { width: 90vw; padding: 26px 18px; }
  #rgStreakSnipe .rg-snipe-kicker { font-size: 10px; letter-spacing: .2em; }
  #rgStreakSnipe .rg-snipe-foot { font-size: 10px; letter-spacing: .16em; }
  #rgStreakSnipe .rg-snipe-action { padding: 9px 14px; font-size: 10px; letter-spacing: .14em; }
}
@media (prefers-reduced-motion: reduce) {
  #rgStreakSnipe { animation-duration: 4.8s; }
  #rgStreakSnipe .rg-snipe-vignette,
  #rgStreakSnipe .rg-snipe-compass,
  #rgStreakSnipe .rg-snipe-kick,
  #rgStreakSnipe .rg-snipe-muzzle,
  #rgStreakSnipe .rg-snipe-breath { display: none; }
  #rgStreakSnipe .rg-snipe-finish-ring { animation: none; opacity: .55; }
  #rgStreakSnipe .rg-snipe-card {
    animation: none; opacity: 1; transform: none; filter: none;
  }
}
`;
        document.head.appendChild(style);
    }

    function showStreakSnipeOverlay({ playerName, streak }) {
        if (!document?.body) return;
        ensureStreakSnipeStyles();
        document.getElementById("rgStreakSnipe")?.remove();
        const overlay = document.createElement("div");
        overlay.id = "rgStreakSnipe";
        const vignette = document.createElement("div");
        vignette.className = "rg-snipe-vignette";
        const muzzle = document.createElement("div");
        muzzle.className = "rg-snipe-muzzle";
        const compass = document.createElement("div");
        compass.className = "rg-snipe-compass";
        for (const direction of ["NW", "N", "NE"]) {
            const marker = document.createElement("span");
            marker.textContent = direction;
            compass.appendChild(marker);
        }
        const kick = document.createElement("div");
        kick.className = "rg-snipe-kick";
        const lens = document.createElement("div");
        lens.className = "rg-snipe-lens";
        const sway = document.createElement("div");
        sway.className = "rg-snipe-sway";
        const crossH = document.createElement("div");
        crossH.className = "rg-snipe-cross-h";
        const crossV = document.createElement("div");
        crossV.className = "rg-snipe-cross-v";
        const hit = document.createElement("div");
        hit.className = "rg-snipe-hit";
        sway.append(crossH, crossV, hit);
        lens.appendChild(sway);
        kick.appendChild(lens);
        const breath = document.createElement("div");
        breath.className = "rg-snipe-breath";
        breath.textContent = "Hold breath";
        const breathTrack = document.createElement("span");
        breathTrack.className = "rg-snipe-breath-track";
        breath.appendChild(breathTrack);
        const finish = document.createElement("div");
        finish.className = "rg-snipe-finish";
        const finishRing = document.createElement("div");
        finishRing.className = "rg-snipe-finish-ring";
        const card = document.createElement("div");
        card.className = "rg-snipe-card";
        const kicker = document.createElement("div");
        kicker.className = "rg-snipe-kicker";
        kicker.textContent = "Target streak eliminated";
        const title = document.createElement("div");
        title.className = "rg-snipe-title";
        title.textContent = `You sniped ${String(playerName || "an opponent")}`;
        const value = document.createElement("div");
        value.className = "rg-snipe-value";
        value.textContent = `${Math.max(1, Math.trunc(Number(streak) || 1))}-win streak ended`;
        const foot = document.createElement("div");
        foot.className = "rg-snipe-foot";
        foot.textContent = "Direct hit confirmed";
        const actions = document.createElement("div");
        actions.className = "rg-snipe-actions";
        const savePng = document.createElement("button");
        savePng.type = "button";
        savePng.className = "rg-snipe-action rg-snipe-save";
        savePng.textContent = "📸 Save PNG";
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "rg-snipe-action rg-snipe-close";
        closeBtn.textContent = "Close";
        actions.append(savePng, closeBtn);
        card.append(kicker, title, value, foot, actions);
        finish.append(finishRing, card);
        overlay.append(vignette, muzzle, compass, kick, breath, finish);
        document.body.appendChild(overlay);

        // Auto-dismiss unless the user reaches for a button. Hovering the card
        // pauses the timer so the fade-out doesn't start under someone's cursor.
        let removeTimer = setTimeout(
            () => overlay.remove(),
            prefersReducedPopupMotion() ? 4850 : 7250,
        );
        const holdOpen = () => {
            if (removeTimer) { clearTimeout(removeTimer); removeTimer = null; }
            overlay.style.animation = "none";
            overlay.style.opacity = "1";
            card.style.animation = "none";
            card.style.opacity = "1";
            card.style.filter = "none";
            card.style.transform = "none";
            actions.style.animation = "none";
            actions.style.opacity = "1";
        };
        // Pointer events cascade — the overlay is non-interactive by default,
        // so a mouseenter on card would never fire. Instead, hovering either
        // button (which has pointer-events:auto) pauses the auto-dismiss.
        savePng.addEventListener("mouseenter", holdOpen);
        closeBtn.addEventListener("mouseenter", holdOpen);

        savePng.addEventListener("click", async () => {
            holdOpen();
            savePng.disabled = true;
            const original = savePng.textContent;
            savePng.textContent = "Rendering…";
            try {
                const { toPng } = await import("https://esm.sh/html-to-image@1.11.13");
                const dataUrl = await toPng(card, {
                    backgroundColor: "#030a14",
                    pixelRatio: 2,
                    // Hide the action buttons in the saved image so it's clean
                    // for sharing — the file is the celebration, not the UI.
                    filter: (n) => !n.classList?.contains?.("rg-snipe-actions"),
                });
                const slug = String(playerName || "opponent")
                    .replace(/[^\w-]+/g, "")
                    .slice(0, 20) || "opponent";
                const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
                const a = document.createElement("a");
                a.href = dataUrl;
                a.download = `atlas-snipe-${slug}-x${Math.trunc(Number(streak) || 1)}-${stamp}.png`;
                a.click();
                savePng.textContent = "Saved ✓";
            } catch (e) {
                console.error("[RG HUD] snipe PNG export failed:", e);
                savePng.textContent = "Save failed — retry";
                savePng.disabled = false;
                return;
            }
            setTimeout(() => { savePng.textContent = original; savePng.disabled = false; }, 2200);
        });

        closeBtn.addEventListener("click", () => {
            if (removeTimer) { clearTimeout(removeTimer); removeTimer = null; }
            overlay.remove();
        });
    }

    function maybeShowStreakSnipe(prevRatings, nextRatings, opponents, config = _remoteConfigMemo) {
        if (settings.streakSnipeEnabled === false) return null;
        const candidates = streakSnipeCandidates(
            prevRatings,
            nextRatings,
            opponents,
            streakSnipeMinimum(config),
        );
        if (!candidates.length) return null;
        const target = candidates[0];
        dbg(`streak snipe: ended ${target.name}'s ${target.streak} win streak`);
        showStreakSnipeOverlay({
            playerName: target.name,
            streak: target.streak,
        });
        return target;
    }

    function derivedFormatFromPlayerCount(n) {
        if (n === 2) return "Competitive1v1";
        if (n === 3 || n === 4) return "Competitive2v2";
        if (n === 5 || n === 6) return "Competitive3v3";
        return null;
    }

    function parseRosterInitLine(line) {
        const outer = String(line ?? "").match(
            /Initialized stats for player\s*:?\s*(.*?)\s*\(([^)]*\bUserId:\s*[^)]*)\)/
        );
        if (!outer) return null;
        const details = outer[2];
        const uidMatch = details.match(/\bUserId:\s*([^,]*)/i);
        if (!uidMatch) return null;
        const teamMatch = details.match(/\bTeam:\s*([A-Za-z]+)/i);
        const rawTeam = (teamMatch?.[1] ?? "").trim();
        const team = /^orange$/i.test(rawTeam) ? "Orange"
            : /^blue$/i.test(rawTeam) ? "Blue"
            : rawTeam || null;
        return {
            name: (outer[1] ?? "").trim(),
            uid: (uidMatch[1] ?? "").trim(),
            team,
        };
    }

    function trustedTeamContext(roster, selfUid, expectedPlayerCount) {
        const counts = {};
        for (const player of roster) {
            if (player.team) counts[player.team] = (counts[player.team] || 0) + 1;
        }
        const expectedPerSide = expectedPlayerCount / 2;
        const teamsBalanced = Number.isInteger(expectedPerSide)
            && roster.length === expectedPlayerCount
            && counts.Orange === expectedPerSide
            && counts.Blue === expectedPerSide;
        const selfTeam = roster.find(player => player.uid === selfUid)?.team || null;
        return { counts, teamsBalanced, selfTeam };
    }

    function resetMatchPopupState() {
        _matchPopupGeneration++;
        _matchFormat = null;
        _matchPlayerCount = 0;
        _selfTeam = null;
        _shownPopupsThisMatch = new Set();
        _matchOpponentStreaks = new Map();
        _deferredMatch = null;
        _rosterFired = false;
        _rosterFiring = false;
        if (_rosterFireTimer) { clearTimeout(_rosterFireTimer); _rosterFireTimer = null; }
    }

    function snapshotDeferredRoster() {
        _deferredMatch = {
            players: _liveRoster.map(player => ({ ...player })),
        };
    }

    function scheduleRankedRosterPopups() {
        if (_rosterFired || _rosterFiring || !_matchFormat || !_liveRoster.length) return;
        if (!lastKnownPlayerData?.Id) return;
        if (_matchPlayerCount && _liveRoster.length >= _matchPlayerCount) {
            fireAllRankedPopups();
            return;
        }
        // Safety net: if inits stop coming, fire a neutral partial-roster
        // result after three seconds instead of missing the match entirely.
        if (_rosterFireTimer) clearTimeout(_rosterFireTimer);
        _rosterFireTimer = setTimeout(() => fireAllRankedPopups(), 3000);
    }

    // called when a real-uid roster entry lands. we wait until the full roster
    // is in before firing anything, because the photon Team: field is
    // sometimes stale (game rebalances after the init lines) and we need to
    // see the whole split to know if we can trust it.
    async function onRosterEntry(entry) {
        try {
            const selfUid = lastKnownPlayerData?.Id;
            if (selfUid && entry.uid === selfUid && entry.team) _selfTeam = entry.team;
            if (!_matchFormat) {
                // Missing/late "Starting game" line: retain the complete roster
                // and classify it only after self + final teams are known.
                snapshotDeferredRoster();
                return;
            }
            scheduleRankedRosterPopups();
        } catch (e) {
            dbg("onRosterEntry threw: " + getErrMsg(e));
        }
    }

    async function fireAllRankedPopups() {
        const generation = _matchPopupGeneration;
        try {
            if (_rosterFired || _rosterFiring) return;
            const selfUid = lastKnownPlayerData?.Id;
            if (!selfUid || !_matchFormat) return;
            _rosterFiring = true;
            if (_rosterFireTimer) { clearTimeout(_rosterFireTimer); _rosterFireTimer = null; }
            const roster = _liveRoster.map(player => ({ ...player }));
            const matchFormat = _matchFormat;
            const matchPlayerCount = _matchPlayerCount;
            // count each team so we can tell if the photon Team labels line up
            // with a real match split (3v3 = 3+3, 2v2 = 2+2, 1v1 = 1+1)
            const { counts, teamsBalanced, selfTeam } =
                trustedTeamContext(roster, selfUid, matchPlayerCount);
            if (!teamsBalanced) {
                dbg(`team split ${counts.Orange || 0}O/${counts.Blue || 0}B doesn't match a legit ${matchPlayerCount}-player split — using neutral labels`);
            }
            const cache = await getLeaderboardCache(matchFormat);
            if (generation !== _matchPopupGeneration) return;
            if (!cache) { dbg("popup skip: no leaderboard cache available"); return; }
            const cfg = await getRemoteConfig();
            if (generation !== _matchPopupGeneration) return;
            const prefs = normalizePopupPreferences(RANKED_POPUP_PREFERENCES);
            _rosterFired = true;
            for (const entry of roster) {
                if (entry.uid === selfUid) continue;
                if (_shownPopupsThisMatch.has(entry.uid)) continue;
                const hit = lookupInCache(cache, entry.uid, matchFormat);
                if (!hit) {
                    dbg(`popup skip: "${entry.name}" (${entry.uid.slice(0,8)}...) not in ${matchFormat} top ${RG_LB_TOP_N}`);
                    continue;
                }
                let isTeammate = null; // null = don't know, use neutral label
                if (teamsBalanced && selfTeam && entry.team) {
                    isTeammate = entry.team === selfTeam;
                }
                if (!rankedPopupAllowed(hit.rank, isTeammate, cfg, prefs)) {
                    dbg(`popup skip: "${entry.name}" hidden by rank or role settings`);
                    continue;
                }
                let winStreak = 0;
                if (isTeammate === false) {
                    const streakInfo = await resolveOpponentStreak(entry.uid);
                    if (generation !== _matchPopupGeneration) return;
                    if (streakInfo.confident && streakInfo.streak > 0) {
                        winStreak = streakInfo.streak;
                        _matchOpponentStreaks.set(entry.uid, {
                            uid: entry.uid,
                            name: hit.name || entry.name,
                            streak: winStreak,
                            confident: true,
                            isTeammate: false,
                        });
                    }
                }
                _shownPopupsThisMatch.add(entry.uid);
                const displayName = hit.name || entry.name;
                const role = isTeammate === true ? "teammate" : isTeammate === false ? "opponent" : "player";
                dbg(`popup fire: #${hit.rank} ${role} "${displayName}" in ${matchFormat}`);
                showLbOpponentPopup({
                    rank: hit.rank,
                    name: displayName,
                    mode: matchFormat,
                    isTeammate,
                    winStreak,
                    config: cfg,
                    preferences: prefs,
                });
            }
        } catch (e) {
            dbg("fireAllRankedPopups threw: " + getErrMsg(e));
        } finally {
            if (generation === _matchPopupGeneration) _rosterFiring = false;
        }
    }

    // If the Starting line was missing, defer until the ratings delta reveals
    // the playlist. Capture everything before the first await so match-end can
    // safely reset global popup state for the next match.
    async function firePostmortemPopupsIfDeferred(prevRatings) {
        const generation = _matchPopupGeneration;
        const deferred = _deferredMatch;
        _deferredMatch = null;
        const players = deferred?.players?.map(player => ({ ...player })) ?? [];
        const selfUid = lastKnownPlayerData?.Id;
        const alreadyShown = new Set(_shownPopupsThisMatch);
        const g = lastKnownPlayerData?.ModesGlicko || {};
        const changedRanked = RG_LB_MODES.filter(mode => {
            const before = prevRatings?.[mode];
            const after = g[mode]?.displayRating;
            return typeof after === "number" && typeof before === "number" && after !== before;
        });
        try {
            if (!deferred || !selfUid || !players.length || changedRanked.length !== 1) return;
            const mode = changedRanked[0];
            const cache = await getLeaderboardCache(mode);
            if (!cache) return;
            if (_matchPopupGeneration > generation + 1 || _inMatch) return;
            const cfg = await getRemoteConfig();
            if (_matchPopupGeneration > generation + 1 || _inMatch) return;
            const prefs = normalizePopupPreferences(RANKED_POPUP_PREFERENCES);
            const { teamsBalanced, selfTeam } =
                trustedTeamContext(players, selfUid, players.length);
            for (const player of players) {
                if (player.uid === selfUid || alreadyShown.has(player.uid)) continue;
                alreadyShown.add(player.uid);
                const hit = lookupInCache(cache, player.uid, mode);
                if (!hit) continue;
                const isTeammate = teamsBalanced && selfTeam && player.team
                    ? player.team === selfTeam
                    : null;
                if (!rankedPopupAllowed(hit.rank, isTeammate, cfg, prefs)) continue;
                const streakInfo = isTeammate === false
                    ? await resolveOpponentStreak(player.uid)
                    : { streak: 0, confident: false };
                if (_matchPopupGeneration > generation + 1 || _inMatch) return;
                showLbOpponentPopup({
                    rank: hit.rank,
                    name: hit.name || player.name,
                    mode,
                    isTeammate,
                    winStreak: streakInfo.confident ? streakInfo.streak : 0,
                    config: cfg,
                    preferences: prefs,
                });
            }
        } catch (e) {
            dbg("firePostmortemPopupsIfDeferred threw: " + getErrMsg(e));
        }
    }

    async function syncToRealLeaderboard(fb, data, displayName) {
      try {
        if (!firebaseAuthUid) {
            dbg("syncToRealLeaderboard skipped: firebaseAuthUid not ready");
            return;
        }
        const sourceUserId = firebaseAuthUid;
        const rgPlayerId = data.Id;

        try {
            const q = fb.query(
                fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
                fb.where("rgPlayerId", "==", rgPlayerId),
                fb.limit(8)
            );
            const snap = await fb.getDocs(q);
            const priorUids = snap.docs
                .map((d) => d.data())
                .filter((row) => row && row.playlist !== "tombstone")
                .map((row) => row.sourceUserId)
                .filter(Boolean);
            if (!shouldPublishLeaderboardRow(priorUids, sourceUserId)) {
                dbg(`syncToRealLeaderboard skipped: ${rgPlayerId} already on the board as ${priorUids.join(",")}`);
                return;
            }
        } catch (e) {
            dbg("syncToRealLeaderboard owner check failed: " + getErrMsg(e));
        }

        // piggy-back: refresh this member's MMR in the clan doc, get tag back
        const clanInfo = await queueClanMMRSync(fb, data);
        const cleanDisplayName = clanInfo?.tag
            ? stripClanTagPrefix(displayName, clanInfo.tag)
            : displayName;
        const shownName = clanInfo?.tag ? `[${clanInfo.tag}] ${cleanDisplayName}` : cleanDisplayName;

        const modeToPlaylist = {
            Competitive1v1: "1v1",
            Competitive2v2: "2v2",
            Competitive3v3: "3v3",
        };

        // Same rationale as currentStreak below: publish the per-mode session
        // delta so the public leaderboard can show recent MMR movement the
        // moment it reads the doc, instead of waiting to reconstruct history
        // from live snapshots after every page load. sessionLastSeen lets the
        // site tell when a session is actually still going vs. stale after the
        // HUD stopped writing.
        const sessionOwnedByAccount = sessionStart?.accountId === data.Id;
        const sessionStartedAt = sessionOwnedByAccount
            ? (Number.isFinite(sessionStart?.startedAt) ? sessionStart.startedAt : null)
            : null;
        const sessionLastSeen = sessionOwnedByAccount
            ? (Number.isFinite(sessionStart?.lastSeen) ? sessionStart.lastSeen : null)
            : null;

        // Mirror the streak already tracked for script_submissions so the
        // public leaderboard site and the opponent popup can show it right
        // away instead of having to reconstruct it from wins/matches deltas.
        // Same total-across-modes value goes on every playlist doc so 1v1,
        // 2v2, 3v3, and wins can all show the streak chip without joining
        // sibling docs client-side.
        const publishedStreak = streakData?.accountId === data.Id
            ? Math.trunc(Number(streakData.streak) || 0)
            : 0;

        // Only send the session fields when we actually have real numbers
        // for them. On a fresh install (or right after auto-update),
        // sessionStart isn't set yet and these come back as null.
        // Firestore rejects the whole write if a field is null when the
        // rule expects a number, so we just leave the field off.
        function payloadWithSession(base) {
            const p = { ...base };
            if (Number.isFinite(sessionStartedAt)) p.sessionStartedAt = sessionStartedAt;
            if (Number.isFinite(sessionLastSeen)) p.sessionLastSeen = sessionLastSeen;
            return p;
        }

        for (const [mode, playlist] of Object.entries(modeToPlaylist)) {
            const mmr = data.ModesGlicko?.[mode]?.displayRating;
            if (typeof mmr !== "number") continue; // never played this mode

            // Skip if MMR hasn't changed for this playlist since we last
            // wrote it — session-total fields kept re-triggering writes on
            // every doc even when only one mode was actually played.
            const stateKey = `${sourceUserId}_${playlist}`;
            const priorRaw = lastEntryState.get(stateKey);
            if (priorRaw) {
                let priorMmr = null;
                try { priorMmr = JSON.parse(priorRaw)?.mmr; } catch {}
                if (priorMmr === mmr) continue;
            }

            const sessionBase = sessionOwnedByAccount && typeof sessionStart?.[mode] === "number"
                ? sessionStart[mode]
                : null;
            const sessionMmrDelta = sessionBase === null ? 0 : Math.trunc(mmr - sessionBase);
            // Raw Glicko numbers alongside mmr. Write cadence is unchanged
            // — the mmr skip check above still gates when we sync.
            const glicko = data.ModesGlicko?.[mode] || {};
            await upsertIfChanged(fb, sourceUserId, playlist, payloadWithSession({
                name: shownName,
                mmr,
                rating: typeof glicko.rating === "number" ? glicko.rating : null,
                rd: typeof glicko.rd === "number" ? glicko.rd : null,
                vol: typeof glicko.vol === "number" ? glicko.vol : null,
                sessionMmrDelta,
                currentStreak: publishedStreak,
                rgPlayerId,
            }));
        }

        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        const totalWins = modes.reduce((sum, m) => sum + (data.ModesData?.[m]?.wins ?? 0), 0);
        const totalMatches = modes.reduce((sum, m) => sum + (data.ModesData?.[m]?.matchesPlayed ?? 0), 0);

        await upsertIfChanged(fb, sourceUserId, "wins", payloadWithSession({
            name: shownName,
            wins: totalWins,
            matches: totalMatches,
            currentStreak: publishedStreak,
            rgPlayerId,
        }));
      } catch (e) {
        dbg("syncToRealLeaderboard threw: " + getErrMsg(e));
      }
    }

    // Match-end and leaderboard submission can reach clan sync concurrently.
    // Serialize them per account so the forced match-end refresh lands first,
    // while the later leaderboard pass sees the fresh in-memory MMR and skips.
    const clanSyncLocks = new Map();
    function queueClanMMRSync(fb, data, options = {}) {
        const uid = data?.Id;
        if (!uid) return Promise.resolve(null);
        const previous = clanSyncLocks.get(uid) || Promise.resolve();
        const current = previous
            .catch(() => null)
            .then(() => updateMyClanMMR(fb, data, options));
        clanSyncLocks.set(uid, current);
        return current;
    }

    async function syncClanAfterMatch(data) {
        if (!data?.Id || !data?.ModesGlicko) return;
        try {
            const fb = await initFirebase();
            if (!fb) {
                dbg("match-end clan sync skipped: Firebase unavailable");
                return;
            }
            // Standings don't move outside an active event, so the write
            // wouldn't affect anything anyone can see. Skip it and save the
            // read+write on every match-end during the ~50 weeks/yr of downtime.
            await loadEventConfig(fb);
            if (eventPhase() !== "active") {
                dbg("match-end clan sync skipped: no active event");
                return;
            }
            const result = await queueClanMMRSync(fb, data, {
                force: true,
                reason: "matchEnd",
            });
            if (result?.synced) {
                dbg(`match-end clan MMR synced at ${result.mmr}`);
                refreshClanViewIfOpen();
            } else if (!result?.clanId) {
                dbg("match-end clan sync skipped: player is not in a clan");
            }
        } catch (e) {
            dbg("match-end clan sync failed: " + getErrMsg(e));
        }
    }

    function clanMembers(clan) {
        if (Array.isArray(clan?.members)) return clan.members;
        if (!clan?.members || typeof clan.members !== "object") return [];
        return Object.entries(clan.members).map(([userId, member]) => ({
            ...(member && typeof member === "object" ? member : {}),
            userId: member?.userId || userId,
        }));
    }

    function clanMembersField(liveClan, members) {
        if (!Array.isArray(liveClan?.members)
            && liveClan?.members
            && typeof liveClan.members === "object") {
            return {
                members: Object.fromEntries(
                    members
                        .filter(member => member?.userId)
                        .map(member => {
                            const stats = liveClan.memberStats?.[member.userId];
                            const deviceIds = [...new Set([
                                ...(Array.isArray(member.deviceIds)
                                    ? member.deviceIds
                                    : []),
                                member.deviceId,
                                ...(Array.isArray(stats?.deviceIds)
                                    ? stats.deviceIds
                                    : []),
                                stats?.deviceId,
                            ].filter(Boolean))].sort();
                            return [
                                member.userId,
                                { ...member, deviceIds },
                            ];
                        })
                ),
            };
        }
        return { members };
    }

    // Current clients keep per-player MMR in a map that legacy whole-array
    // writes do not touch. Prefer whichever representation has the newer
    // timestamp so downgrades and mixed-version clans remain compatible.
    function effectiveClanMemberStat(clan, memberOrUid) {
        const member = typeof memberOrUid === "string"
            ? clanMembers(clan).find(m => m.userId === memberOrUid)
            : memberOrUid;
        const uid = typeof memberOrUid === "string" ? memberOrUid : member?.userId;
        const mapped = uid ? clan?.memberStats?.[uid] : null;
        const legacyValid = typeof member?.mmr === "number";
        const mappedValid = typeof mapped?.mmr === "number";
        if (!mappedValid) {
            return {
                mmr: legacyValid ? member.mmr : null,
                syncedAt: typeof member?.syncedAt === "number" ? member.syncedAt : null,
            };
        }
        const mappedAt = typeof mapped.syncedAt === "number" ? mapped.syncedAt : 0;
        const legacyAt = typeof member?.syncedAt === "number" ? member.syncedAt : 0;
        if (!legacyValid || mappedAt >= legacyAt) {
            return { mmr: mapped.mmr, syncedAt: mappedAt || null };
        }
        return { mmr: member.mmr, syncedAt: legacyAt || null };
    }

    function effectiveClanTotalMMR(clan) {
        return clanMembers(clan).reduce((sum, member) => {
            const mmr = effectiveClanMemberStat(clan, member).mmr;
            return sum + (typeof mmr === "number" ? mmr : 0);
        }, 0);
    }

    function clanHasDeviceId(clan, uid, deviceId) {
        if (!deviceId) return true;
        const member = clanMembers(clan).find(candidate => candidate.userId === uid);
        const mapped = clan?.memberStats?.[uid];
        return member?.deviceId === deviceId
            || (Array.isArray(member?.deviceIds) && member.deviceIds.includes(deviceId))
            || mapped?.deviceId === deviceId
            || (Array.isArray(mapped?.deviceIds) && mapped.deviceIds.includes(deviceId));
    }

    function clanMMRWriteFields(liveClan, uid, myMMR, syncedAt, deviceId = null) {
        const liveMembers = clanMembers(liveClan);
        if (!liveMembers.some(m => m.userId === uid)) return null;
        const members = liveMembers.map(m =>
            m.userId === uid
                ? { ...m, mmr: myMMR, syncedAt, ...(deviceId ? { deviceId } : {}) }
                : m
        );
        const existingStats = liveClan.memberStats?.[uid] ?? {};
        const deviceIds = deviceId
            ? [...new Set([
                ...(Array.isArray(existingStats.deviceIds) ? existingStats.deviceIds : []),
                deviceId,
            ])]
            : existingStats.deviceIds;
        const memberStats = {
            ...(liveClan.memberStats && typeof liveClan.memberStats === "object"
                ? liveClan.memberStats
                : {}),
            [uid]: {
                ...existingStats,
                mmr: myMMR,
                syncedAt,
                ...(deviceIds ? { deviceIds } : {}),
            },
        };
        const membersField = clanMembersField(liveClan, members);
        const mergedClan = { ...liveClan, ...membersField, memberStats };
        return {
            ...membersField,
            memberStats,
            totalMMR: effectiveClanTotalMMR(mergedClan),
        };
    }

    // refresh my ranked MMR in the clan doc + recompute totalMMR.
    // returns { tag } for the leaderboard name prefix. best-effort.
    async function updateMyClanMMR(
        fb,
        data,
        { force = false, reason = "leaderboard" } = {}
    ) {
        const uid = data.Id;
        try {
            await loadEventConfig(fb);
            // Normal matches do not read or write clan docs. Cup score
            // only moves during an active event; join/leave/kick use
            // their own write paths.
            if (eventPhase() !== "active") {
                const tag = myClan?.tag ?? "";
                dbg("Clan MMR write skipped: no active event");
                return myClan ? { tag, clanId: myClan.id, synced: false, mmr: null } : null;
            }
            // A cached null can outlive a stale/missed directory read. Match-end
            // must retry discovery instead of silently abandoning contribution.
            if (!clanLoaded || clanLoadedForAccount !== uid || !myClan) await loadClanData(true);
            if (!myClan) return null;

            // capture tag first, leaderboard prefix must not depend on the MMR write
            const tag = myClan.tag ?? "";
            const clanId = myClan.id;

            const g = data.ModesGlicko;
            const rankedModes = ["Competitive3v3", "Competitive2v2", "Competitive1v1"];
            const myMMR = rankedModes.reduce((s, m) =>
                s + (typeof g?.[m]?.displayRating === "number" ? g[m].displayRating : 0), 0);

            await loadClanRolePerms(fb);

            const prevMine = effectiveClanMemberStat(myClan, uid).mmr;
            const deviceId = getDeviceId();
            const deviceNeedsLink = !clanHasDeviceId(myClan, uid, deviceId);
            let synced = false;
            if (force || prevMine !== myMMR || deviceNeedsLink) {
                try {
                    // syncedAt: client ms on my member entry so teammates get
                    // per-member freshness ("2m ago"). serverTimestamp() isn't
                    // allowed inside array elements anyway.
                    // Always rebuild from the transaction's fresh server copy.
                    // A plain setDoc used our stale in-memory members array and
                    // could erase somebody who had just been approved.
                    const clanRef = fb.doc(fb.db, "clans", clanId);
                    const useReservations = clanReservationsEnabled();
                    const directoryRef = clanDirectoryDocRef(fb, clanId);
                    const membershipRef = useReservations
                        ? fb.doc(fb.db, "clan_memberships", uid)
                        : null;
                    const deviceRef = useReservations
                        ? fb.doc(fb.db, "clan_devices", deviceId)
                        : null;
                    const syncedAt = Date.now();
                    let committedClan = null;
                    let committedDirectory = null;
                    let wroteClan = false;
                    const writeClanMMR = () => {
                        committedClan = null;
                        committedDirectory = null;
                        wroteClan = false;
                        return runAtlasTransaction(fb, "clan score sync", async tx => {
                            committedClan = null;
                            committedDirectory = null;
                            wroteClan = false;
                            // A device only does this on its first clan sync.
                            // Saving both together stops two accounts racing.
                            const directorySnap = !useReservations && deviceNeedsLink
                                ? await tx.get(directoryRef)
                                : null;
                            const membershipSnap = useReservations
                                ? await tx.get(membershipRef)
                                : null;
                            const deviceSnap = useReservations
                                ? await tx.get(deviceRef)
                                : null;
                            const liveSnap = await tx.get(clanRef);
                            if (!liveSnap.exists()) return;
                            if ((membershipSnap?.exists()
                                && membershipSnap.data().clanId !== clanId)
                                || (deviceSnap?.exists()
                                    && deviceSnap.data().clanId !== clanId)) {
                                return;
                            }
                            const liveClan = liveSnap.data();
                            const liveMine = effectiveClanMemberStat(liveClan, uid);
                            if (!force && liveMine.mmr === myMMR
                                && clanHasDeviceId(liveClan, uid, deviceId)) {
                                committedClan = { ...liveClan, id: clanId };
                                return;
                            }
                            const fields = clanMMRWriteFields(
                                liveClan,
                                uid,
                                myMMR,
                                syncedAt,
                                deviceId
                            );
                            if (!fields) return;
                            const nextClan = {
                                ...liveClan,
                                id: clanId,
                                ...fields,
                            };
                            const reservationFields = useReservations
                                ? {
                                    memberIds: clanMembers(nextClan).map(
                                        member => member.userId
                                    ),
                                    deviceIds: clanDeviceIds(nextClan),
                                }
                                : {};
                            tx.set(clanRef,
                                {
                                    ...fields,
                                    ...reservationFields,
                                    lastSyncAt: fb.serverTimestamp(),
                                },
                                { merge: true });
                            committedClan = {
                                ...nextClan,
                                ...reservationFields,
                            };
                            const entry = clanDirectoryEntry(clanId, committedClan);
                            if (useReservations) {
                                tx.set(directoryRef, entry);
                                tx.set(
                                    membershipRef,
                                    clanMembershipRecord(
                                        clanId,
                                        clanMembers(committedClan).find(
                                            member => member.userId === uid
                                        )?.role ?? "member",
                                        clanMemberDeviceIds(committedClan, uid)
                                    )
                                );
                                tx.set(deviceRef, {
                                    clanId,
                                    userId: uid,
                                    updatedAt: new Date().toISOString(),
                                });
                                committedDirectory = putClanInDirectory(
                                    clanDirectory,
                                    entry
                                );
                            } else if (deviceNeedsLink && directorySnap) {
                                const liveDirectory = directorySnap.exists()
                                    ? (directorySnap.data().clans ?? [])
                                    : [];
                                committedDirectory = putClanInDirectory(
                                    liveDirectory,
                                    entry
                                );
                                tx.set(directoryRef, { clans: committedDirectory });
                            }
                            wroteClan = true;
                        });
                    };
                    try {
                        const ran = await writeClanMMR();
                        if (!ran) return null;
                    } catch (firstErr) {
                        // one retry, otherwise a transient fail stalled visible
                        // contribution until the NEXT match
                        console.warn("[RG HUD] Clan MMR write failed, retrying in 5s:", firstErr);
                        await new Promise(r => setTimeout(r, 5000));
                        const ran = await writeClanMMR();
                        if (!ran) return null;
                    }
                    if (!committedClan) {
                        dbg("Clan MMR transaction skipped: clan missing or player no longer on roster");
                        detachClanListener();
                        myClan = null;
                        clanLoaded = false;
                        return null;
                    }
                    myClan = sanitizeClanDoc(committedClan);
                    if (committedDirectory) clanDirectory = committedDirectory;
                    synced = wroteClan;
                    if (wroteClan) {
                        dbg(`Clan MMR sync committed (${reason}): ${prevMine ?? "unset"} -> ${myMMR}`);

                        // throttled directory rebuild, instant local, Firestore at most every 3m
                        await refreshDirectoryThrottled(fb);
                    }
                } catch (writeErr) {
                    // best-effort, never strip the tag on failure
                    console.warn("[RG HUD] Clan MMR write failed (tag still applies):", writeErr);
                    // surface this — silent failure breaks event scoring for the session
                    showError("Clan sync failing — event score may be stale");
                }
            }

            // capture event baseline on first sync during an active event
            await maybeCaptureEventBaseline(fb, uid, myMMR);

            return { tag, clanId, synced, mmr: myMMR };
        } catch (e) {
            console.warn("[RG HUD] Clan lookup failed:", e);
            return null;
        }
    }

    async function upsertIfChanged(fb, sourceUserId, playlist, fields) {
        try {
            const stateKey = `${sourceUserId}_${playlist}`;
            const newState = JSON.stringify(fields);

            if (lastEntryState.get(stateKey) === newState) {
                return; // unchanged — skip
            }

            const ok = await upsertPlaylistEntry(fb, sourceUserId, playlist, fields);
            // only cache on success, a failed write would poison the cache and
            // prevent any future retry
            if (ok) {
                lastEntryState.set(stateKey, newState);
                saveEntryState();
            }
        } catch (e) {
            dbg("upsertIfChanged threw: " + getErrMsg(e));
        }
    }

    // ---------- Rank lookup ----------
    // count aggregation: "how many entries have higher mmr than mine" is one
    // cheap server-side count, not a collection download. cached; force=true
    // after our own writes, otherwise once per session.
    //
    // only re-queries modes whose MMR actually moved since last check. someone
    // else climbing could shuffle you, but not worth 4 reads/match.

    let ranksFetchedThisSession = false;
    const lastRankedMMR = new Map(); // playlist -> mmr at last query
    const lastRankedAt = new Map();  // playlist -> ms timestamp of last query
    // MMR-unchanged skip only trusts a cache younger than this. Rank drifts
    // when other players play, not just when your own MMR moves — so a
    // stale mode (like 3v3 for a mostly-1v1 player) still gets refreshed.
    const RANK_QUERY_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h

    // Site publishes the same JSON blob it renders from every ~15 min via
    // the publish-leaderboard-json workflow. Reading it directly means
    // HUD rank matches site rank exactly (identity dedup, soft-delete
    // filter, and fresh MMR all baked in), and costs zero Firebase reads.
    // The Firestore aggregate can lag 30+ min behind this, which is why a
    // player who just finished a match sees the site update first.
    const SITE_JSON_BASE = "https://raw.githubusercontent.com/wiljdaws/rg_player_leaderboard/data/leaderboard";
    const SITE_JSON_TTL_MS = 5 * 60 * 1000; // 5 min in-memory
    const siteJsonCache = new Map(); // playlist -> { rows, fetchedAt }
    async function fetchSiteLeaderboardRows(playlist) {
        const hit = siteJsonCache.get(playlist);
        if (hit && Date.now() - hit.fetchedAt < SITE_JSON_TTL_MS) return hit.rows;
        try {
            const res = await fetch(`${SITE_JSON_BASE}/${playlist}.json`, { cache: "default" });
            if (!res.ok) return null;
            const data = await res.json();
            const rows = Array.isArray(data?.rows) ? data.rows : [];
            siteJsonCache.set(playlist, { rows, fetchedAt: Date.now() });
            return rows;
        } catch (e) { return null; }
    }

    // Cache the last-known rank+MMR per account in localStorage so a HUD reload
    // doesn't force a fresh Firestore fetch. Your rank only meaningfully moves
    // when you play — match-end force=true takes care of that. 24h TTL is just
    // a safety net against drift if someone leapfrogs you while you're idle.
    const RANK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
    function rankCacheKey(uid) { return `rgHudRankCache_${uid}`; }

    function hydrateRankCache(uid) {
        if (!uid) return false;
        try {
            const raw = localStorage.getItem(rankCacheKey(uid));
            if (!raw) return false;
            const parsed = JSON.parse(raw);
            if (!parsed?.ranks || typeof parsed.savedAt !== "number") return false;
            if (Date.now() - parsed.savedAt > RANK_CACHE_TTL_MS) return false;
            for (const [playlist, entry] of Object.entries(parsed.ranks)) {
                if (typeof entry?.rank === "number") cachedRanks.set(playlist, entry.rank);
                if (typeof entry?.mmr === "number") lastRankedMMR.set(playlist, entry.mmr);
                if (typeof entry?.gap === "number") cachedMmrToNext.set(playlist, entry.gap);
                if (typeof entry?.queriedAt === "number") lastRankedAt.set(playlist, entry.queriedAt);
            }
            return true;
        } catch { return false; }
    }

    function persistRankCache(uid) {
        if (!uid) return;
        try {
            const ranks = {};
            for (const [playlist, rank] of cachedRanks) {
                ranks[playlist] = {
                    rank,
                    mmr: lastRankedMMR.get(playlist),
                    gap: cachedMmrToNext.get(playlist),
                    queriedAt: lastRankedAt.get(playlist),
                };
            }
            localStorage.setItem(rankCacheKey(uid), JSON.stringify({ ranks, savedAt: Date.now() }));
        } catch {}
    }

    function resetAccountRankState() {
        cachedRanks.clear();
        cachedMmrToNext.clear();
        prevRanks.clear();
        lastRankedMMR.clear();
        lastRankedAt.clear();
        ranksFetchedThisSession = false;
    }

    async function refreshRanks(fb, data, force = false) {
        // Paint from cache so the badge isn't blank, but still let the
        // query below run so a stale rank gets corrected.
        if (!ranksFetchedThisSession && data?.Id && hydrateRankCache(data.Id)) {
            if (lastKnownPlayerData) updateHUD(lastKnownPlayerData);
        }
        if (!force && ranksFetchedThisSession) return;

        const modeToPlaylist = {
            Competitive1v1: "1v1",
            Competitive2v2: "2v2",
            Competitive3v3: "3v3",
        };

        try {
            for (const [mode, playlist] of Object.entries(modeToPlaylist)) {
                const mmr = data.ModesGlicko?.[mode]?.displayRating;
                if (typeof mmr !== "number") continue;

                let rank = null;
                let siteGapMmr = null;

                // Prefer the site JSON blob — it's the same file the site
                // renders from, updated every ~15 min, identity-deduped, and
                // free (public GitHub). Rank read here matches site exactly.
                try {
                    const siteRows = await fetchSiteLeaderboardRows(playlist);
                    if (siteRows) {
                        const uid = firebaseAuthUid || "";
                        const rgId = data?.Id || "";
                        const me = siteRows.find((r) =>
                            (uid && (r.uid === uid || r.sourceUserId === uid))
                            || (rgId && r.rgPlayerId === rgId)
                        );
                        if (me && typeof me.rank === "number") {
                            rank = me.rank;
                            if (rank > 1) {
                                const above = siteRows.find((r) => r.rank === rank - 1);
                                if (above && typeof above.mmr === "number") {
                                    siteGapMmr = Math.max(0, above.mmr - mmr + 1);
                                }
                            }
                        }
                    }
                } catch (e) {
                    dbg(`refreshRanks: site JSON lookup failed for ${playlist} (non-fatal)`);
                }

                // Site JSON gave us a rank — cache and skip Firebase entirely.
                if (rank != null) {
                    cachedRanks.set(playlist, rank);
                    lastRankedMMR.set(playlist, mmr);
                    lastRankedAt.set(playlist, Date.now());
                    if (siteGapMmr != null) cachedMmrToNext.set(playlist, siteGapMmr);
                    continue;
                }

                // Fallback: Firestore aggregate. Still catches drift when
                // the site JSON fetch failed (CDN hiccup, offline, etc.).
                const AGG_FRESH_MS = 60 * 60 * 1000; // 1h
                try {
                    const aggSnap = await fb.getDoc(
                        fb.doc(fb.db, LEADERBOARD_CACHE_COLLECTION, playlist)
                    );
                    if (aggSnap.exists()) {
                        const aggData = aggSnap.data() || {};
                        const builtAt = Date.parse(aggData.builtAt || "") || Number(aggData.builtAt) || 0;
                        const aggFresh = builtAt && (Date.now() - builtAt) < AGG_FRESH_MS;
                        if (aggFresh) {
                            const rows = aggData.rows || [];
                            const uid = firebaseAuthUid || "";
                            const rgId = data?.Id || "";
                            const me = rows.find((r) =>
                                (uid && (r.uid === uid || r.sourceUserId === uid))
                                || (rgId && r.rgPlayerId === rgId)
                            );
                            if (me && typeof me.rank === "number") rank = me.rank;
                        }
                    }
                } catch (e) {
                    dbg(`refreshRanks: aggregate lookup failed for ${playlist} (non-fatal)`);
                }

                // If the aggregate gave us a rank, use it and move on.
                if (rank != null) {
                    cachedRanks.set(playlist, rank);
                    lastRankedMMR.set(playlist, mmr);
                    lastRankedAt.set(playlist, Date.now());
                    continue;
                }

                // Aggregate stale, missing, or user below top-100: use the
                // MMR-freshness skip to save reads on the expensive count
                // path. Rank at low placement drifts by ±1-3 without dedup
                // but that rarely matters visually.
                const queriedAt = lastRankedAt.get(playlist) || 0;
                const isFresh = Date.now() - queriedAt < RANK_QUERY_MAX_AGE_MS;
                if (isFresh && lastRankedMMR.get(playlist) === mmr) continue;

                {
                    const q = fb.query(
                        fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
                        fb.where("playlist", "==", playlist),
                        fb.where("mmr", ">", mmr)
                    );
                    const snapshot = await fb.getCountFromServer(q);
                    let deletedAbove = 0;
                    try {
                        const deletedQ = fb.query(
                            fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
                            fb.where("playlist", "==", playlist),
                            fb.where("mmr", ">", mmr),
                            fb.where("deleted", "==", true)
                        );
                        const deletedSnap = await fb.getCountFromServer(deletedQ);
                        deletedAbove = deletedSnap.data().count;
                    } catch (e) {
                        dbg(`refreshRanks: deleted-count lookup failed for ${playlist} (index?): ` + getErrMsg(e));
                    }
                    rank = Math.max(1, snapshot.data().count - deletedAbove + 1);
                }
                cachedRanks.set(playlist, rank);
                lastRankedMMR.set(playlist, mmr);
                lastRankedAt.set(playlist, Date.now());

                // gap to next rank up: lowest-MMR entry still above us.
                // skipped when already #1. Fetch a small batch so we can
                // skip past any soft-deleted rows client-side.
                if (rank > 1) {
                    try {
                        const nextQ = fb.query(
                            fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
                            fb.where("playlist", "==", playlist),
                            fb.where("mmr", ">", mmr),
                            fb.orderBy("mmr", "asc"),
                            fb.limit(5)
                        );
                        const nextSnap = await fb.getDocs(nextQ);
                        const firstLive = nextSnap.docs.find(d => d.data().deleted !== true);
                        if (firstLive) {
                            const nextMmr = firstLive.data().mmr;
                            cachedMmrToNext.set(playlist, Math.max(0, nextMmr - mmr + 1));
                        }
                    } catch (e) {
                        // gap is nice-to-have, ignore failures
                        dbg(`refreshRanks: mmr-to-next lookup failed for ${playlist}`);
                    }
                } else {
                    cachedMmrToNext.delete(playlist);
                }
            }

            ranksFetchedThisSession = true;
            persistRankCache(data?.Id);

            checkRankTransitions();

            // re-render with fresh ranks
            if (lastKnownPlayerData) updateHUD(lastKnownPlayerData);
        } catch (e) {
            // rank display is nice-to-have, don't crash on failure
            dbg("refreshRanks failed: " + getErrMsg(e));
            console.warn("[RG HUD] Rank lookup failed:", e);
        }
    }

    // ---------- Network capture ----------

    // last-known equipped skin, needed by partial equipSkin responses
    let lastKnownPlayerData = null;

    // ---------- Last-game lobby roster (feeds Forge's Imposter section) ----------
    // game logs "Initialized stats for player X" per player as a match forms.
    // we collect names while the match runs, freeze on matchEnd / LeaveRoom.
    // persisted so a page refresh (Tampermonkey update requires one) doesn't
    // wipe the roster before the user opens Forge — 13.4 shipped that bug
    // and Imposter always showed empty.
    let lastGamePlayers = [];   // frozen roster of the last match: [{name, uid}]
    try { lastGamePlayers = JSON.parse(localStorage.getItem("rgHudLastRoster") ?? "[]"); }
    catch (e) { pushError(e, "loadLastRoster"); }
    let _liveRoster = [];       // in-progress match: [{name, uid}]

    // "are we in a real match right now". set on first init line with a real
    // UserId (warm-up self-inits log empty UserId), cleared on matchEnd /
    // LeaveRoom / new queue. all HUD-restore signals gate on this so a
    // reconnect storm can't resurrect the HUD mid-match.
    // don't substring-match "OnDisconnected" — it also matches
    // "OurOnDisconnected" and restores the HUD on every reconnect.
    let _inMatch = false;

    // watchdog timestamps:
    //   _lastInitLineAt      : last real init line, proves console hook is alive
    //   _lastRecoverySignalAt: last menu/reconnect signal
    //   _lastValidRatingsAt  : last successful ModesGlicko parse, proves matchEnd
    //                          shape hasn't changed
    let _lastInitLineAt = 0;
    let _lastRecoverySignalAt = 0;
    let _lastValidRatingsAt = 0;
    let _matchEndArmedAt = 0;
    let _matchEndWatchdogTimer = null;

    function freezeRoster() {
        if (_liveRoster.length) {
            lastGamePlayers = _liveRoster.slice();
            try { localStorage.setItem("rgHudLastRoster", JSON.stringify(lastGamePlayers)); }
            catch (e) { pushError(e, "saveLastRoster"); }
            dbg(`Imposter roster captured: ${lastGamePlayers.length} player(s): ${lastGamePlayers.map(p => p.name).join(", ")}`);
            // repaint Forge if it's open. no focus-steal risk mid-match,
            // the user can't be typing in Forge while playing.
            const fv = document.getElementById("rgForgeView");
            if (isVisible(fv) && typeof RGNF !== "undefined" && RGNF.refresh) {
                RGNF.refresh();
            }
            // clear so a stray second freeze (matchEnd fetch + logged response)
            // can't re-capture stale data
            _liveRoster = [];
        }
    }

    const API_HOST_FRAGMENT = "us-central1-rocketball-23c12.cloudfunctions.net";

    const gameWindow = pageWindow();
    dbg("page hooks on " + (gameWindow === window ? "window" : "unsafeWindow"));
    const oldFetch = gameWindow.fetch.bind(gameWindow);
    gameWindow.fetch = async function (...args) {
        const response = await oldFetch.apply(this, args);
        try {
            const url = args[0]?.toString?.() ?? "";
            if (!url.includes(API_HOST_FRAGMENT)) return response;

            const clone = response.clone();
            const text = await clone.text();

            if (url.includes("/v0304_player/matchEnd")) {
                // if no valid ratings parse within 30s the game probably changed
                // the response shape — surface it instead of freezing on stale numbers.
                _matchEndArmedAt = performance.now();
                if (_matchEndWatchdogTimer) clearTimeout(_matchEndWatchdogTimer);
                _matchEndWatchdogTimer = setTimeout(() => {
                    if (_lastValidRatingsAt < _matchEndArmedAt) {
                        dbgWarn("matchEnd fired but no valid ratings parse in 30s — game may have updated");
                        showError("Match ratings parse failed — game may have updated. Check rgDump().");
                    }
                }, 30 * 1000);
                // snapshot ratings + opponents before update path mutates them,
                // so writeMatchAudit can diff cleanly
                const prevRatings = {
                    Competitive3v3: lastKnownPlayerData?.ModesGlicko?.Competitive3v3?.displayRating,
                    Competitive2v2: lastKnownPlayerData?.ModesGlicko?.Competitive2v2?.displayRating,
                    Competitive1v1: lastKnownPlayerData?.ModesGlicko?.Competitive1v1?.displayRating,
                    Casual: lastKnownPlayerData?.ModesGlicko?.Casual?.displayRating,
                };
                const opponentsSnapshot = _liveRoster.slice();
                const opponentStreakSnapshot = [..._matchOpponentStreaks.values()]
                    .map(entry => ({ ...entry }));
                tryParseAndUpdate(text);
                const nextRatings = {
                    Competitive3v3: lastKnownPlayerData?.ModesGlicko?.Competitive3v3?.displayRating,
                    Competitive2v2: lastKnownPlayerData?.ModesGlicko?.Competitive2v2?.displayRating,
                    Competitive1v1: lastKnownPlayerData?.ModesGlicko?.Competitive1v1?.displayRating,
                    Casual: lastKnownPlayerData?.ModesGlicko?.Casual?.displayRating,
                };
                maybeShowStreakSnipe(
                    prevRatings,
                    nextRatings,
                    opponentStreakSnapshot,
                );
                // Contribution is event-critical, so it owns a match-end sync.
                // Do not make it depend on the diagnostic audit or leaderboard
                // submission path (both can independently skip/fail).
                syncClanAfterMatch(lastKnownPlayerData);
                dbg(`matchEnd response — roster at ${_liveRoster.length}, restoring HUD`);
                _inMatch = false;
                syncPingTracker();
                freezeRoster();
                setAutoVisible(true);
                // fire-and-forget audit write
                writeMatchAudit(prevRatings, opponentsSnapshot);
                // If Starting was missing, the ratings delta now reveals mode.
                // The function snapshots its inputs before awaiting, so reset
                // immediately and prevent timers/state leaking into a rematch.
                firePostmortemPopupsIfDeferred(prevRatings);
                resetMatchPopupState();
            } else if (url.includes("/v0304_login/login")) {
                tryParseAndUpdate(text);
                // login carries the raw nickname before any local processing,
                // ideal spot for the pending-steal verifier
                try {
                    const loginData = JSON.parse(text);
                    const rawNick = loginData?.Nickname ?? "";
                    if (rawNick && typeof RGNF !== "undefined" && RGNF.verifyStolenName) {
                        RGNF.verifyStolenName(rawNick);
                    }
                } catch (e) {
                    dbg("login pending-steal check failed: " + getErrMsg(e));
                }
            } else if (url.includes("/v0304_player/equipSkin")) {
                // response is a bare quoted skin id, e.g. "body.2"
                try {
                    const skinId = JSON.parse(text);
                    if (lastKnownPlayerData) {
                        lastKnownPlayerData.EquippedSkinId = skinId;
                    }
                } catch (e) {
                    dbg("equipSkin parse failed: " + getErrMsg(e));
                }
            }
        } catch (e) {
            dbg("fetch wrapper threw: " + getErrMsg(e));
        }
        return response;
    };

    const pageConsole = gameWindow.console;
    const oldPageLog = pageConsole.log.bind(pageConsole);
    pageConsole.log = function (...args) {
        oldPageLog.apply(pageConsole, args);
        // feed the raw buffer for atlasCap()
        _rawPush("log", args);
        // wrap: a throw in any branch below unwinds the loop and every
        // state transition after it is silently missed.
        try {
            for (const arg of args) {
                if (typeof arg !== "string") continue;

                // ratings can also come in via logged request text (login, echoed
                // matchEnd). tryParseAndUpdate dedupes with the fetch hook.
                if (arg.includes('"ModesGlicko"')) {
                    const json = arg.substring(arg.indexOf("{"));
                    tryParseAndUpdate(json);
                }

                // ---- init line: queue warm-up OR real match forming ----
                // shape: ...for player: <markup>Name<size=0> (UserId: abc123, Team: Orange)
                // UserId is the discriminator: warm-up logs an EMPTY UserId,
                // real match inits always populate it. without this check,
                // warm-up inits restart the roster mid-queue.
                if (arg.includes("[PlayerDataManager] Initialized stats for player")) {
                    // Parse the parenthesized fields independently so empty
                    // warm-up UserIds and future extra fields remain valid.
                    const parsed = parseRosterInitLine(arg);
                    const nm = parsed?.name ?? "";
                    const uid = parsed?.uid ?? "";
                    const team = parsed?.team ?? null;
                    if (nm && uid) {
                        _lastInitLineAt = performance.now();
                        setAutoVisible(false); // real match — hide HUD
                        if (!_inMatch) {
                            _liveRoster = [];
                            _inMatch = true;
                            syncPingTracker();
                            dbg(`match forming — roster reset, first player "${nm}"`);
                        }
                        // Dedupe by uid, but accept a later corrected team/name
                        // before firing. Photon can re-emit after rebalancing.
                        const existing = _liveRoster.find(player => player.uid === uid);
                        if (!existing) {
                            const entry = { name: nm, uid, team };
                            _liveRoster.push(entry);
                            dbg(`roster +1 "${nm}"${team ? ` (${team})` : ""} (${_liveRoster.length} total)`);
                            // fire the leaderboard-opponent popup check
                            onRosterEntry(entry);
                        } else {
                            const nameChanged = nm && nm !== existing.name;
                            const teamChanged = team && team !== existing.team;
                            if (nameChanged) existing.name = nm;
                            if (teamChanged) existing.team = team;
                            if (nameChanged || teamChanged) {
                                dbg(`roster corrected "${existing.name}"${existing.team ? ` (${existing.team})` : ""}`);
                                onRosterEntry(existing);
                            }
                        }
                    } else if (nm) {
                        dbg(`warm-up init "${nm}" (empty uid) — ignored, inMatch=${_inMatch}`);
                    } else {
                        // canary: if this line ever fails, the game format changed.
                        // yellow dot so users notice without DevTools.
                        dbgWarn(`init line FAILED to parse — game format may have changed`);
                        dbg(`init line raw: ${arg.slice(0, 120)}`);
                    }
                }

                // "Starting game with N players" fires right before the real
                // uid inits. tells us format when it's unambiguous (2, 5, 6).
                if (arg.includes("Starting game with") && arg.includes("players")) {
                    const m = arg.match(/Starting game with\s+(\d+)\s+players/);
                    if (m) {
                        // A fresh start line is the clean boundary even if the
                        // previous match never sent its normal ending signal.
                        resetMatchPopupState();
                        _matchPlayerCount = parseInt(m[1], 10);
                        _matchFormat = derivedFormatFromPlayerCount(_matchPlayerCount);
                        dbg(`match player count = ${_matchPlayerCount}, format = ${_matchFormat || "unknown"}`);
                        // Pre-warm only the active playlist.
                        if (_matchFormat) getLeaderboardCache(_matchFormat);
                        if (_matchFormat) {
                            // Late Starting line: live roster now owns delivery;
                            // discard deferred state to prevent match-end duplicates.
                            _deferredMatch = null;
                            scheduleRankedRosterPopups();
                        }
                    }
                }

                // ---- left match another way (rage-quit, back-out) ----
                // LeaveRoom / fresh queue can't coexist with mid-match. freeze
                // so Imposter survives early exits.
                if (arg.includes("PhotonNetwork:LeaveRoom") ||
                    arg.includes("Set player matchmaking start time")) {
                    if (_inMatch) {
                        dbg(`left mid-match — roster frozen at ${_liveRoster.length}`);
                        freezeRoster();
                    }
                    _inMatch = false;
                    syncPingTracker();
                    // new match is being queued — clear popup state
                    resetMatchPopupState();
                    // Private matches fire their recovery signal (SetNickname
                    // / OurOnConnectedToMaster) BEFORE LeaveRoom, so the HUD
                    // restore up in that handler got suppressed as
                    // mid-match. Now that _inMatch is finally false, put
                    // the HUD back — no waiting for the ticker.
                    setAutoVisible(true);
                }

                // ---- return-to-menu / recovery signals ----
                // "OnJoinedRoom"/"OnLeftRoom" never appear and "OnDisconnected"
                // only shows up as a substring of "OurOnDisconnected". these
                // are the actual strings. word-boundaries on Our* to avoid
                // the same substring-match trap.
                // gate restore on !_inMatch or a reconnect storm respawns the HUD.
                // "Starting SetNickname" covers practice/private, which emit
                // no room strings on exit.
                if (/\bOurOnDisconnected\b/.test(arg) || arg.includes("Starting SetNickname") ||
                    /\bOurOnConnectedToMaster\b/.test(arg)) {
                    _lastRecoverySignalAt = performance.now();
                    if (!_inMatch) setAutoVisible(true);
                    else dbg(`recovery signal suppressed (mid-match): ${arg.slice(0, 60)}`);
                }

                // Private matches don't emit LeaveRoom, so _inMatch was
                // never getting cleared and none of the recovery signals
                // above could restore the HUD. "Showing PlayGama banners"
                // is the ad banner the game logs when the main menu is
                // back on screen — treat that as authoritative end-of-match.
                if (arg.includes("Showing PlayGama banners") && _inMatch) {
                    dbg("PlayGama banners visible — treating as match-end");
                    _inMatch = false;
                    syncPingTracker();
                    resetMatchPopupState();
                    setAutoVisible(true);
                }
            }
        } catch (e) {
            dbg("console.log hook threw: " + getErrMsg(e));
        }
    };

    // ---------- Clan events (Clan Clash) ----------
    // config lives in events/current (admin-only). timing uses serverTimestamp
    // so device clocks can't spoof it. each member's baseline MMR is captured
    // on their first sync after the event starts. score = sum(current - baseline).

    let eventConfig = null;       // { name, startTime(ms), endTime(ms) } or null
    let eventConfigLoaded = false;
    let serverNowOffset = null;   // (serverTime - deviceTime), ms

    // event-time perms, edit events/current in Firestore, no redeploy.
    // missing keys fall back to these defaults.
    //   allowJoin/Leave/Kick/Approve/Disband/RoleChange/Transfer/RenameClan/ClanCreate
    const EVENT_PERM_DEFAULTS = {
        allowJoin:        true,   // opened mid-event per feedback
        allowLeave:       false,  // can't dodge a losing team
        allowKick:        true,
        allowApprove:     true,
        allowDisband:     false,  // freeze rosters
        allowRoleChange:  false,  // role changes shift attribution — freeze
        allowTransfer:    false,
        allowRenameClan:  false,
        allowClanCreate:  true,   // new clans don't affect anyone else
        useBench:         false,  // when true: clans hold 6, only starting 5 score
        allowBenchSwapDuringEvent: false, // freeze lineup once event goes active
    };

    async function loadEventConfig(fb, force = false) {
        if (eventConfigLoaded && !force) return eventConfig;
        try {
            const snap = await fb.getDoc(fb.doc(fb.db, "events", "current"));
            if (snap.exists()) {
                const d = snap.data();
                // merge over defaults so partial perms still get safe fallbacks
                const storedPerms = (d.perms && typeof d.perms === "object") ? d.perms : {};
                eventConfig = {
                    name: d.name ?? "Clan Event",
                    startTime: d.startTime?.toMillis ? d.startTime.toMillis() : (d.startTime ?? 0),
                    endTime: d.endTime?.toMillis ? d.endTime.toMillis() : (d.endTime ?? 0),
                    // applies outside the event window too
                    maxMembers: (typeof d.maxMembers === "number") ? d.maxMembers : null,
                    startingLineupSize: (typeof d.startingLineupSize === "number") ? d.startingLineupSize : null,
                    // ms to keep the "Ended" banner visible after endTime; then
                    // the banner hides itself until the next event. Default 48h.
                    postEventGracePeriodMs: (typeof d.postEventGracePeriodMs === "number") ? d.postEventGracePeriodMs : null,
                    useClanReservations: d.useClanReservations === true,
                    perms: { ...EVENT_PERM_DEFAULTS, ...storedPerms },
                };
            } else {
                eventConfig = null;
            }
            eventConfigLoaded = true;
        } catch (e) {
            dbg("loadEventConfig failed: " + getErrMsg(e));
            console.warn("[RG HUD] Event config load failed:", e);
        }
        return eventConfig;
    }

    // true = allowed now. outside an active event, everything is allowed.
    function eventPerm(key) {
        if (eventPhase() !== "active") return true;
        const p = eventConfig?.perms || EVENT_PERM_DEFAULTS;
        return p[key] !== false;
    }

    // ---------- Clan role permissions (server-driven) ----------
    // defaults match the old hardcoded behavior. admin/clanPerms can override
    // any subset, e.g. { elder: { kick: true } }, no redeploy needed.
    const CLAN_ROLE_PERM_DEFAULTS = {
        leader:   { editClanInfo: true,  tagStyle: true,  kick: true,  approve: true,  roleChange: true,  transfer: true,  disband: true  },
        coleader: { editClanInfo: false, tagStyle: false, kick: true,  approve: true,  roleChange: true,  transfer: false, disband: false },
        elder:    { editClanInfo: false, tagStyle: false, kick: false, approve: true,  roleChange: false, transfer: false, disband: false },
        member:   { editClanInfo: false, tagStyle: false, kick: false, approve: false, roleChange: false, transfer: false, disband: false },
    };
    let clanRolePerms = null;        // stored overrides from admin/clanPerms, or null
    let clanRolePermsLoaded = false;

    async function loadClanRolePerms(fb, force = false) {
        if (clanRolePermsLoaded && !force) return;
        try {
            const snap = await fb.getDoc(fb.doc(fb.db, "admin", "clanPerms"));
            clanRolePerms = snap.exists() ? snap.data() : null;
            clanRolePermsLoaded = true;
        } catch (e) {
            dbg("loadClanRolePerms failed (falling back to defaults): " + getErrMsg(e));
            console.warn("[RG HUD] Clan role perms load failed:", e);
        }
    }

    // stored bool wins, missing = default. unknown role -> member (most restrictive).
    function rolePerm(role, key) {
        const r = (role && CLAN_ROLE_PERM_DEFAULTS[role]) ? role : "member";
        const stored = clanRolePerms?.[r]?.[key];
        if (typeof stored === "boolean") return stored;
        return CLAN_ROLE_PERM_DEFAULTS[r][key] === true;
    }

    function myClanRole() {
        const me = clanMembers(myClan).find(m => m.userId === myUserId());
        return me?.role ?? "member";
    }

    // offset learned from serverTimestamp round-trips. cosmetic countdowns only,
    // never scoring.
    function serverNow() {
        return Date.now() + (serverNowOffset ?? 0);
    }
    function learnServerTime(serverMs) {
        if (typeof serverMs === "number") serverNowOffset = serverMs - Date.now();
    }

    function eventPhase() {
        if (!eventConfig) return "none";
        const now = serverNow();
        if (now < eventConfig.startTime) return "upcoming";
        if (now > eventConfig.endTime) return "ended";
        return "active";
    }

    // startTime doubles as an event id so old baselines are recognized as stale.
    function currentEventId() {
        return eventConfig ? String(eventConfig.startTime) : null;
    }

    async function maybeCaptureEventBaseline(fb, uid, currentMMR) {
        if (!myClan || eventPhase() !== "active") return;
        const evId = currentEventId();
        if (myClan.eventId === evId
            && memberEventBaseline(myClan, uid) != null) return;

        try {
            const clanId = myClan.id;
            let committedBaseline = null;
            const ran = await runAtlasTransaction(
                fb,
                "clan event baseline",
                async tx => {
                    committedBaseline = null;
                    const ref = fb.doc(fb.db, "clans", clanId);
                    const snapshot = await tx.get(ref);
                    if (!snapshot.exists()) return;
                    const liveClan = snapshot.data();
                    const baseline = liveClan.eventId === evId
                        ? { ...(liveClan.eventBaseline ?? {}) }
                        : {};
                    if (liveClan.eventId === evId
                        && memberEventBaseline(liveClan, uid) != null) {
                        committedBaseline = baseline;
                        return;
                    }
                    if (baseline[uid] != null) {
                        committedBaseline = baseline;
                        return;
                    }
                    baseline[uid] = currentMMR;
                    tx.set(ref, {
                        eventBaseline: baseline,
                        eventId: evId,
                        eventName: eventConfig.name,
                    }, { merge: true });
                    if (clanReservationsEnabled()) {
                        const nextClan = {
                            ...liveClan,
                            id: clanId,
                            eventBaseline: baseline,
                            eventId: evId,
                            eventName: eventConfig.name,
                        };
                        const entry = clanDirectoryEntry(clanId, nextClan);
                        tx.set(clanDirectoryDocRef(fb, clanId), entry);
                        clanDirectory = putClanInDirectory(clanDirectory, entry);
                    }
                    committedBaseline = baseline;
                }
            );
            if (!ran || !committedBaseline) return;
            myClan.eventBaseline = committedBaseline;
            myClan.eventId = evId;
        } catch (e) {
            console.warn("[RG HUD] Event baseline capture failed:", e);
            // without this alert, the member's contribution silently stays at 0
            showError("Event baseline capture failed — your contribution won't count until this recovers");
        }
    }

    function clanBaselineForCurrentEvent(clan) {
        if (!clan) return null;
        if (clan.eventId !== currentEventId()) return null; // stale -> no score yet
        const hasPerMemberBaseline = clanMembers(clan).some(
            member => member?.eventBaseline != null
        );
        if (!clan.eventBaseline && !hasPerMemberBaseline) return null;
        return clan.eventBaseline ?? {};
    }

    function memberEventBaseline(clan, memberOrUid) {
        const member = typeof memberOrUid === "string"
            ? clanMembers(clan).find(candidate => candidate.userId === memberOrUid)
            : memberOrUid;
        if (member?.eventBaseline != null) return member.eventBaseline;
        const uid = typeof memberOrUid === "string"
            ? memberOrUid
            : member?.userId;
        return uid ? clan?.eventBaseline?.[uid] ?? null : null;
    }

    function computeClanEventScore(clan) {
        const baseline = clanBaselineForCurrentEvent(clan);
        if (!baseline) return 0;
        // Only starters count toward event score. Bench MMR is still tracked
        // (so a mid-event swap has a real baseline) but doesn't contribute.
        const starters = new Set(startingLineupUids(clan));
        return clanMembers(clan).reduce((sum, m) => {
            if (starters.size && !starters.has(m.userId)) return sum;
            const base = memberEventBaseline(clan, m);
            const mmr = effectiveClanMemberStat(clan, m).mmr;
            if (base == null || typeof mmr !== "number") return sum;
            return sum + (mmr - base);
        }, 0);
    }

    function myEventContribution(clan, uid) {
        const baseline = clanBaselineForCurrentEvent(clan);
        if (!baseline) return null;
        const me = clanMembers(clan).find(m => m.userId === uid);
        const base = memberEventBaseline(clan, me ?? uid);
        const mmr = effectiveClanMemberStat(clan, me).mmr;
        if (base == null || !me || typeof mmr !== "number") return null;
        if (isMemberBenched(clan, uid)) return 0;
        return mmr - base;
    }

    // always includes seconds so the 1s tick has something to change
    function formatCountdown(targetMs) {
        let ms = targetMs - serverNow();
        if (ms < 0) ms = 0;
        const d = Math.floor(ms / 86400000);
        const h = Math.floor((ms % 86400000) / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        if (d > 0) return `${d}d ${h}h ${m}m ${s}s`;
        if (h > 0) return `${h}h ${m}m ${s}s`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    // 1s tick. target/phase live on data-* attrs so it no-ops when the span
    // isn't in the DOM. crossing a phase boundary triggers a full re-render.
    let countdownIntervalId = null;
    function tickCountdown() {
        const el = document.getElementById("rgEventCountdown");
        if (!el) return;

        const targetMs = parseInt(el.getAttribute("data-target-ms"), 10);
        if (!Number.isFinite(targetMs)) return;
        const phase = el.getAttribute("data-phase");

        if (serverNow() >= targetMs && (phase === "upcoming" || phase === "active")) {
            refreshClanViewIfOpen();
            applyTitle();
            return;
        }

        const prefix = el.getAttribute("data-prefix") || "";
        const suffix = el.getAttribute("data-suffix") || "";
        const next = prefix + formatCountdown(targetMs) + suffix;
        if (el.textContent !== next) el.textContent = next;
    }

    // sorted by eventScore desc. only clans with a baseline in this event count.
    function eventStandings() {
        const evId = currentEventId();
        return clanDirectory
            .filter(c => c.eventId === evId)
            .slice()
            .sort((a, b) => (b.eventScore ?? 0) - (a.eventScore ?? 0));
    }

    // drives the "👑 Leading the Clash" title (clan-version of KING)
    function isMyClanLeadingClash() {
        if (eventPhase() !== "active") return false;
        if (!myClan) return false;
        const standings = eventStandings();
        return standings.length > 0 && standings[0].id === myClan.id;
    }

    // `clan` may be null (clanless players see the banner without their numbers).
    // returns "" when there's no event.
    const DEFAULT_POST_EVENT_GRACE_MS = 48 * 60 * 60 * 1000;
    function eventBannerHtml(clan, uid) {
        const phase = eventPhase();
        if (phase === "none") return "";
        // Hide the "Ended" banner once the grace window closes so it
        // doesn't sit forever between events.
        if (phase === "ended") {
            const grace = typeof eventConfig?.postEventGracePeriodMs === "number"
                ? eventConfig.postEventGracePeriodMs
                : DEFAULT_POST_EVENT_GRACE_MS;
            if (serverNow() > eventConfig.endTime + grace) return "";
        }

        const gold = "#ffd700";
        const standings = eventStandings();
        const leader = standings[0];

        let countdownSpan;
        if (phase === "upcoming") {
            countdownSpan = `<span id="rgEventCountdown" data-target-ms="${eventConfig.startTime}" data-phase="upcoming" data-prefix="Starts in " data-suffix="">Starts in ${formatCountdown(eventConfig.startTime)}</span>`;
        } else if (phase === "active") {
            countdownSpan = `<span id="rgEventCountdown" data-target-ms="${eventConfig.endTime}" data-phase="active" data-prefix="" data-suffix=" left">${formatCountdown(eventConfig.endTime)} left</span>`;
        } else {
            countdownSpan = `<span>Ended</span>`;
        }

        const header = `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                <div style="font-weight:bold;color:${gold};font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">🏆 ${escapeHtml(eventConfig.name)}</div>
                <div style="font-size:10px;opacity:.8;white-space:nowrap;flex-shrink:0;">${countdownSpan}</div>
            </div>
        `;

        let body = "";

        if (phase === "upcoming") {
            if (clan) body = `<div style="font-size:10px;opacity:.7;margin-top:4px;">Play a match once it starts to lock your baseline.</div>`;
        } else if (phase === "active") {
            if (clan) {
                const score = computeClanEventScore(clan);
                const mine = myEventContribution(clan, uid);
                const scoreColor = score >= 0 ? "#00ff66" : "#ff6b6b";
                const contribColor = (mine != null && mine >= 0) ? "#00ff66" : "#ff6b6b";
                const myRank = standings.findIndex(c => c.id === clan.id) + 1;
                const leaderIsMe = leader && leader.id === clan.id;

                // mirrors main-HUD rankBadge but on clan-event standings
                let rankBadgeHtml = "";
                if (myRank > 0) {
                    let rankColor;
                    if (myRank <= 3) rankColor = "#ffd700";
                    else if (myRank <= 10) rankColor = "#c77dff";
                    else if (myRank <= 25) rankColor = "#00d4ff";
                    else rankColor = "#9aa5ad";
                    let tip;
                    if (myRank === 1) {
                        tip = "You're #1! 👑";
                    } else {
                        const ahead = standings[myRank - 2];
                        const gap = (ahead.eventScore ?? 0) - score;
                        tip = `+${gap} MMR to reach #${myRank - 1}`;
                    }
                    // hide "of N" when alone, "#1/1" is just clutter
                    const totalPart = standings.length > 1
                        ? `<span style="opacity:.55;font-weight:normal;"> of ${standings.length}</span>`
                        : "";
                    rankBadgeHtml = `<span class="rgHasTip" data-tip="${tip}" style="color:${rankColor};font-weight:bold;font-size:11px;">#${myRank}${totalPart}</span>`;
                }

                // left col: your clan's numbers
                const leftCol = `
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                        <span style="font-size:9px;opacity:.6;text-transform:uppercase;letter-spacing:.5px;">Your Clan</span>
                        ${rankBadgeHtml}
                    </div>
                    <div style="font-size:12px;margin-top:2px;">Score <span style="color:${scoreColor};font-weight:bold;">${score >= 0 ? "+" : ""}${score}</span></div>
                    ${mine == null
                        ? `<div style="font-size:12px;color:#ffcf5b;">Play a match to lock in!</div>`
                        : `<div style="font-size:12px;">Contribution <span style="color:${contribColor};font-weight:bold;">${mine >= 0 ? "+" : ""}${mine}</span></div>`
                    }
                `;

                // right col: leader if not you, challenger if you lead, else lonely
                let rightCol;
                if (leaderIsMe && standings.length > 1) {
                    const challenger = standings[1];
                    const gap = score - (challenger.eventScore ?? 0);
                    rightCol = `
                        <div style="font-size:9px;opacity:.6;text-transform:uppercase;letter-spacing:.5px;">Challenger</div>
                        <div style="font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                            ${challenger.tag ? `<span style="opacity:.7;">[${escapeHtml(challenger.tag)}]</span> ` : ""}<b>${escapeHtml(challenger.name)}</b>
                        </div>
                        <div style="font-size:11px;opacity:.75;"><span style="color:#00ff66;">${challenger.eventScore >= 0 ? "+" : ""}${challenger.eventScore}</span></div>
                        <div style="font-size:10px;opacity:.6;">Lead by ${gap}</div>
                    `;
                } else if (leader && !leaderIsMe) {
                    const gap = (leader.eventScore ?? 0) - score;
                    rightCol = `
                        <div style="font-size:9px;opacity:.6;text-transform:uppercase;letter-spacing:.5px;">Leader</div>
                        <div style="font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                            ${leader.tag ? `<span style="opacity:.7;">[${escapeHtml(leader.tag)}]</span> ` : ""}<b>${escapeHtml(leader.name)}</b>
                        </div>
                        <div style="font-size:11px;opacity:.75;"><span style="color:#00ff66;">${leader.eventScore >= 0 ? "+" : ""}${leader.eventScore}</span></div>
                        <div style="font-size:10px;opacity:.6;">+${gap} to catch</div>
                    `;
                } else {
                    rightCol = `
                        <div style="font-size:9px;opacity:.6;text-transform:uppercase;letter-spacing:.5px;">Standings</div>
                        <div style="font-size:11px;margin-top:4px;opacity:.7;line-height:1.3;">You're the only clan competing so far.</div>
                    `;
                }

                body = `
                    <div style="display:flex;gap:10px;margin-top:6px;align-items:flex-start;">
                        <div style="flex:1;min-width:0;">${leftCol}</div>
                        <div style="width:1px;background:${gold}44;align-self:stretch;flex-shrink:0;"></div>
                        <div style="flex:1;min-width:0;">${rightCol}</div>
                    </div>
                `;
            } else if (leader) {
                // clanless viewer: single line for who's on top
                body = `
                    <div style="font-size:11px;margin-top:4px;">
                        👑 ${leader.tag ? `[${escapeHtml(leader.tag)}] ` : ""}<b>${escapeHtml(leader.name)}</b>
                        <span style="color:#00ff66;">${leader.eventScore >= 0 ? "+" : ""}${leader.eventScore}</span>
                    </div>
                `;
            }
        } else if (phase === "ended") {
            if (clan) {
                const score = computeClanEventScore(clan);
                const scoreColor = score >= 0 ? "#00ff66" : "#ff6b6b";
                const myRank = standings.findIndex(c => c.id === clan.id) + 1;
                body = `
                    <div style="font-size:11px;margin-top:4px;">
                        Final <span style="color:${scoreColor};font-weight:bold;">${score >= 0 ? "+" : ""}${score}</span>
                        ${myRank > 0 ? ` · #${myRank} of ${standings.length}` : ""}
                    </div>
                `;
            }
        }

        return `<div style="border:1px solid ${gold}55;background:${gold}11;border-radius:8px;padding:8px 10px;margin-bottom:8px;">${header}${body}</div>`;
    }

    // ---------- Clans (Stage 1: create / browse / request / approve) ----------

    let myClan = null;          // the clan doc this player belongs to, or null
    let clanDirectory = [];     // lightweight list of all clans for browsing
    let clanLoaded = false;
    let clanLoadedForAccount = null; // which account the above was loaded for
    let clanLoadInFlight = null;     // shared promise so parallel callers dedupe
    let clanLoadFailedAt = 0;        // ms; skip retries until cooldown passes
    const CLAN_LOAD_FAILURE_COOLDOWN_MS = 60_000;

    // reads events/current.maxMembers so the cap can be changed live
    const DEFAULT_CLAN_MAX_MEMBERS = 5;
    const BENCH_CLAN_MAX_MEMBERS = 6;
    const DEFAULT_STARTING_LINEUP_SIZE = 5;
    function benchFeatureEnabled() {
        // Read the raw perm value — eventPerm() returns true outside active
        // events, which would flip the cap when we don't want it to.
        const p = eventConfig?.perms;
        return p?.useBench === true;
    }
    function startingLineupSize() {
        const n = eventConfig?.startingLineupSize;
        return (typeof n === "number" && n > 0 && n <= 20) ? n : DEFAULT_STARTING_LINEUP_SIZE;
    }
    function clanMaxMembers() {
        const n = eventConfig?.maxMembers;
        if (typeof n === "number" && n > 0 && n <= 50) return n;
        return benchFeatureEnabled() ? BENCH_CLAN_MAX_MEMBERS : DEFAULT_CLAN_MAX_MEMBERS;
    }

    // The uids of the starting-5 for the current event. Uses the clan's
    // explicit startingLineup when set (leader/co-lead selection), else
    // defaults to the first 5 members by joinedAt (oldest first). Returns
    // all member uids when bench feature is off — everyone is a "starter"
    // in that mode.
    function startingLineupUids(clan) {
        const members = clanMembers(clan);
        if (!benchFeatureEnabled()) return members.map(m => m.userId).filter(Boolean);
        const explicit = Array.isArray(clan?.startingLineup)
            ? clan.startingLineup.filter(uid => members.some(m => m.userId === uid))
            : [];
        if (explicit.length) return explicit.slice(0, startingLineupSize());
        // Default: oldest-first fill of the 5 starter slots.
        return [...members]
            .sort((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0))
            .slice(0, startingLineupSize())
            .map(m => m.userId)
            .filter(Boolean);
    }

    function isMemberBenched(clan, uidOrMember) {
        if (!benchFeatureEnabled()) return false;
        const uid = typeof uidOrMember === "string" ? uidOrMember : uidOrMember?.userId;
        if (!uid) return false;
        return !startingLineupUids(clan).includes(uid);
    }

    function myUserId() { return lastKnownPlayerData?.Id ?? null; }

    // plain in-game name (first line, TMP tags stripped, [TAG] prefix removed).
    // used to seed Name Forge, not the leaderboard display name.
    function myGameNamePlain() {
        const raw = String(lastKnownPlayerData?.Nickname ?? "");
        if (!raw) return "";
        const firstLine = raw.split(/<br\s*\/?\s*>/i)[0];
        let plain = firstLine.replace(/<[^>]*>/g, "").trim();
        plain = plain.replace(/^\[[^\]]{1,6}\]\s*/, "");
        return plain;
    }

    function myName() {
        return cachedDisplayNames.get(myUserId()) || cleanName(lastKnownPlayerData?.Nickname) || "Unknown";
    }

    function clanReservationsEnabled() {
        return eventConfig?.useClanReservations === true;
    }

    function normalizeClanName(value) {
        return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    }

    async function clanNameReservationId(name) {
        const bytes = new TextEncoder().encode(normalizeClanName(name));
        const hash = await crypto.subtle.digest("SHA-256", bytes);
        return [...new Uint8Array(hash)]
            .map(value => value.toString(16).padStart(2, "0"))
            .join("");
    }

    function clanMemberDeviceIds(clan, uid) {
        const ids = new Set();
        const member = clanMembers(clan).find(candidate => candidate.userId === uid);
        const stats = clan?.memberStats?.[uid];
        if (member?.deviceId) ids.add(member.deviceId);
        for (const deviceId of Array.isArray(member?.deviceIds) ? member.deviceIds : []) {
            if (deviceId) ids.add(deviceId);
        }
        if (stats?.deviceId) ids.add(stats.deviceId);
        for (const deviceId of Array.isArray(stats?.deviceIds) ? stats.deviceIds : []) {
            if (deviceId) ids.add(deviceId);
        }
        return [...ids].sort();
    }

    function clanDeviceIds(clan) {
        const ids = new Set();
        for (const member of clanMembers(clan)) {
            for (const deviceId of clanMemberDeviceIds(clan, member.userId)) {
                if (deviceId) ids.add(deviceId);
            }
        }
        return [...ids].sort();
    }

    function clanMembershipRecord(clanId, role, deviceIds) {
        return {
            clanId,
            role,
            deviceIds: [...new Set((deviceIds ?? []).filter(Boolean))].sort(),
            updatedAt: new Date().toISOString(),
        };
    }

    function clanDirectoryDocRef(fb, clanId) {
        return clanReservationsEnabled()
            ? fb.doc(fb.db, "clans_directory", clanId)
            : fb.doc(fb.db, "clans_directory", "index");
    }

    // Point reads only. Listing clans_directory billed 17,959 reads per
    // Clan-panel open (Virt 2026-08-16) and blew Spark. Standings come
    // from the single index doc plus our shard. If the index is missing,
    // do not query the junk drawer — that collection is ~18k orphan docs
    // and even a limit(50) is 50 wasted reads of garbage.
    async function loadClanDirectoryLite(fb, clanId) {
        const budgetPassed = firestoreReadBudgetPassed();
        if (budgetPassed) {
            dbg("clan directory browse skipped: read budget passed");
        }
        const indexPromise = budgetPassed
            ? Promise.resolve(null)
            : fb.getDoc(fb.doc(fb.db, "clans_directory", "index"));
        const shardPromise = clanId
            ? fb.getDoc(fb.doc(fb.db, "clans_directory", clanId))
            : Promise.resolve(null);
        const [indexSnap, shardSnap] = await Promise.all([
            indexPromise,
            shardPromise,
        ]);
        let clans = budgetPassed ? clanDirectory.slice() : [];
        const indexClans = indexSnap?.exists()
            ? indexSnap.data()?.clans
            : null;
        if (Array.isArray(indexClans) && indexClans.length) {
            clans = indexClans;
        }
        if (clanId && shardSnap?.exists()) {
            clans = putClanInDirectory(clans, {
                id: clanId,
                ...shardSnap.data(),
            });
        }
        return canonicalClanDirectory(clans);
    }

    function clanDeviceLinkPlan({
        clan,
        uid,
        deviceId,
        membership = null,
        device = null,
        directoryEntry = null,
        useReservations = false,
    }) {
        const clanId = clan?.id;
        const membershipClanId = membership?.clanId || null;
        const deviceClanId = device?.clanId || null;
        const legacyClanId = directoryEntry?.id || null;
        const deviceInClan = clanHasDeviceId(clan, uid, deviceId);
        const sameClanDeviceConflict = useReservations
            ? deviceClanId === clanId
                && device?.userId
                && device.userId !== uid
            : legacyClanId === clanId
                && (directoryEntry?.deviceIds ?? []).includes(deviceId)
                && !deviceInClan;
        const conflictClanId = sameClanDeviceConflict
            ? clanId
            : (
                useReservations
                    ? ([membershipClanId, deviceClanId].find(
                        value => value && value !== clanId
                    ) || null)
                    : (legacyClanId && legacyClanId !== clanId
                        ? legacyClanId
                        : null)
            );
        const pointerHasDevice = useReservations
            ? membershipClanId === clanId
                && deviceClanId === clanId
                && directoryEntry?.id === clanId
                && (directoryEntry?.memberIds ?? []).includes(uid)
                && (directoryEntry?.deviceIds ?? []).includes(deviceId)
            : legacyClanId === clanId
                && (directoryEntry?.memberIds ?? []).includes(uid)
                && (directoryEntry?.deviceIds ?? []).includes(deviceId);
        return {
            conflictClanId,
            repairClan: !deviceInClan,
            repairPointer: !pointerHasDevice,
        };
    }

    // Use the directory to check clan membership.
    // Hide duplicate clans without deleting anything.
    function canonicalClanDirectory(clans) {
        const chosen = new Map();
        for (const clan of Array.isArray(clans) ? clans : []) {
            if (!clan || typeof clan.id !== "string") continue;
            const name = String(clan.name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
            const tag = String(clan.tag ?? "").trim().toLowerCase();
            const key = name && tag ? `${tag}\u0000${name}` : `id\u0000${clan.id}`;
            const current = chosen.get(key);
            if (!current) {
                chosen.set(key, clan);
                continue;
            }
            // Keep the lowest id so changing scores can't swap the chosen copy.
            if (clan.id.localeCompare(current.id) < 0) chosen.set(key, clan);
        }
        return [...chosen.values()];
    }

    function findDirectoryMembership(clans, identity, exceptClanId = null) {
        const uid = typeof identity === "string" ? identity : identity?.userId;
        const deviceId = typeof identity === "object" ? identity?.deviceId : null;
        if (!uid && !deviceId) return null;
        const matches = (Array.isArray(clans) ? clans : []).filter(clan =>
            clan?.id !== exceptClanId
            && ((uid && (clan?.memberIds ?? []).includes(uid))
                || (deviceId && (clan?.deviceIds ?? []).includes(deviceId)))
        );
        const match = canonicalClanDirectory(matches)[0] ?? null;
        if (!match) return null;
        return {
            ...match,
            membershipMatch: uid && (match.memberIds ?? []).includes(uid)
                ? "player"
                : "device",
        };
    }

    function clanDirectoryEntry(id, clan) {
        const members = clanMembers(clan);
        const deviceIds = clanDeviceIds(clan);
        return {
            id,
            clanId: id,
            name: clan.name,
            tag: clan.tag ?? "",
            tagStyle: clan.tagStyle || null,
            leaderId: clan.leaderId ?? null,
            createdAt: clan.createdAt ?? null,
            memberCount: members.length,
            memberIds: members.map(member => member.userId),
            deviceIds,
            totalMMR: effectiveClanTotalMMR(clan),
            eventScore: computeClanEventScore(clan),
            eventId: clan.eventId ?? null,
        };
    }

    function putClanInDirectory(clans, entry) {
        return canonicalClanDirectory([
            ...(Array.isArray(clans) ? clans : []).filter(clan => clan?.id !== entry.id),
            entry,
        ]);
    }

    function removeClanFromDirectory(clans, clanId) {
        return canonicalClanDirectory(
            (Array.isArray(clans) ? clans : []).filter(clan => clan?.id !== clanId)
        );
    }

    function clanMembershipMessage(displayName, clan, isCurrentPlayer = false) {
        const label = clan
            ? `${clan.tag ? `[${clan.tag}] ` : ""}${clan.name || "another clan"}`
            : "another clan";
        const instruction = isCurrentPlayer ? "You must" : "They must";
        if (clan?.membershipMatch === "device") {
            return `This ATLAS device is already linked to ${label}. ${displayName || "This account"} cannot join or create a clan until the account in that clan leaves.`;
        }
        return `${displayName || "This player"} is already in ${label}. ${instruction} leave that clan before joining or creating another clan.`;
    }

    function canManageRequests(role) {
        return rolePerm(role, "approve");
    }

    // live clan-doc listener. attach while Clan tab is open, detach on close.
    // callback renders straight from the snapshot — refetching triples reads.
    let _clanUnsub = null;
    let _clanListenerId = null;
    let _clanAttaching = false; // guard against re-entry during init await

    // sanitize user-editable style fields at the trust boundary. a modified
    // client could push HTML-shaped strings into tagStyle.color and land
    // stored XSS in every member's browser via the snapshot listener.
    function sanitizeClanDoc(clan) {
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

    async function attachClanListener() {
        if (!myClan) return;
        if (_clanUnsub && _clanListenerId === myClan.id) return;
        // without this reentry guard two rapid calls both await init then
        // both call onSnapshot, leaking the first listener.
        if (_clanAttaching) return;
        _clanAttaching = true;
        try {
            detachClanListener();
            const fb = await initFirebase();
            if (!fb || !myClan) return;
            const clanId = myClan.id;
            _clanListenerId = clanId;
            _clanUnsub = fb.onSnapshot(
                fb.doc(fb.db, "clans", clanId),
                (snap) => {
                    const uid = myUserId();
                    // doc gone (disband) or we're off the roster (left/kicked).
                    // this is also how a kicked player sees it happen live.
                    const stillMember = snap.exists()
                        && clanMembers(snap.data()).some(m => m.userId === uid);
                    if (!stillMember) {
                        detachClanListener();
                        myClan = null;
                        clanLoaded = false;
                        refreshClanViewIfOpen();
                        // The kick write lands right after the roster update.
                        scheduleClanNoticeCheck(500);
                        return;
                    }
                    myClan = sanitizeClanDoc({ id: snap.id, ...snap.data() });
                    // Legacy clients may replace the members array with a stale
                    // copy. Recompute this client's directory entry from the
                    // protected per-member map without another Firestore read.
                    patchMyClanInDirectory();
                    refreshClanViewIfOpen();
                    // repaint main stats too so Clash mini-bar updates live
                    if (lastKnownPlayerData) updateHUD(lastKnownPlayerData);
                },
                (err) => {
                    // without onError + retry, revoked perms freeze the UI
                    // silently, and background tabs get throttled so the
                    // listener dies quiet — syncs sit stale for 50+ min.
                    dbg("clan listener error, scheduling reconnect: " + getErrMsg(err));
                    console.warn("[RG HUD] Clan listener error, will retry in 30s:", err);
                    detachClanListener();
                    setTimeout(() => {
                        if (myClan) {
                            dbg("clan listener auto-reconnecting");
                            attachClanListener();
                        }
                    }, 30 * 1000);
                }
            );
        } catch (e) {
            dbg("attachClanListener failed: " + getErrMsg(e));
            console.warn("[RG HUD] Clan listener attach failed:", e);
            _clanListenerId = null;
        } finally {
            _clanAttaching = false;
        }
    }
    function detachClanListener() {
        if (_clanUnsub) {
            try { _clanUnsub(); } catch (e) {}
            _clanUnsub = null;
        }
        _clanListenerId = null;
    }

    async function loadClanData(force = false) {
        // Parallel callers (submit + updateMyClanMMR fire together at match-end)
        // share one round trip instead of each issuing their own reads.
        if (clanLoadInFlight) return clanLoadInFlight;
        clanLoadInFlight = loadClanDataInner(force).finally(() => {
            clanLoadInFlight = null;
        });
        return clanLoadInFlight;
    }

    async function loadClanDataInner(force = false) {
        const uid = myUserId();
        if (!uid) return;

        // new account since last load, reset (and drop any pending cooldown
        // so a fresh account isn't blocked by the previous one's failure)
        if (clanLoadedForAccount !== uid) {
            force = true;
            myClan = null;
            clanDirectory = [];
            clanLoaded = false;
            clanLoadFailedAt = 0;
        }

        if (clanLoaded && !force) return;

        // Failure cooldown: after a rejected read (e.g. Firebase quota), skip
        // retries for a minute so each match-end doesn't hammer the same failure.
        if (clanLoadFailedAt
            && Date.now() - clanLoadFailedAt < CLAN_LOAD_FAILURE_COOLDOWN_MS) {
            return;
        }

        const fb = await initFirebase();
        if (!fb) return;

        try {
            await loadEventConfig(fb);
            const useReservations = clanReservationsEnabled();
            const deviceId = getDeviceId();
            const previousClan = myClan;
            let nextClan = null;
            let mine = null;
            let membership = null;
            let device = null;
            if (useReservations) {
                const [membershipSnap, deviceSnap] = await Promise.all([
                    fb.getDoc(fb.doc(fb.db, "clan_memberships", uid)),
                    fb.getDoc(fb.doc(fb.db, "clan_devices", deviceId)),
                ]);
                membership = membershipSnap.exists()
                    ? membershipSnap.data()
                    : null;
                device = deviceSnap.exists() ? deviceSnap.data() : null;
                const clanId = membership?.clanId || device?.clanId || null;
                clanDirectory = await loadClanDirectoryLite(fb, clanId);
                mine = clanId
                    ? (clanDirectory.find(entry => entry.id === clanId)
                        || { id: clanId })
                    : null;
            } else {
                const dirSnap = await fb.getDoc(
                    fb.doc(fb.db, "clans_directory", "index")
                );
                clanDirectory = canonicalClanDirectory(
                    dirSnap.exists() ? (dirSnap.data().clans ?? []) : []
                );
                mine = findDirectoryMembership(clanDirectory, uid);
            }
            if (mine?.id) {
                // Skip the one-shot fetch if the live clan listener is already
                // streaming this clan — the in-memory myClan is fresher than
                // a getDoc would be anyway.
                const listenerCoversClan =
                    _clanListenerId === mine.id && previousClan?.id === mine.id;
                if (listenerCoversClan) {
                    nextClan = previousClan;
                } else {
                    const clanSnap = await fb.getDoc(
                        fb.doc(fb.db, "clans", mine.id)
                    );
                    if (clanSnap.exists()) {
                        nextClan = sanitizeClanDoc({
                            id: mine.id,
                            ...clanSnap.data(),
                        });
                    }
                }
            }
            myClan = nextClan;
            if (myClan) {
                const directoryEntry = clanDirectory.find(
                    entry => entry.id === myClan.id
                ) || null;
                const linkPlan = clanDeviceLinkPlan({
                    clan: myClan,
                    uid,
                    deviceId,
                    membership,
                    device,
                    directoryEntry,
                    useReservations,
                });
                if (linkPlan.conflictClanId) {
                    const sameClan = linkPlan.conflictClanId === myClan.id;
                    const other = clanDirectory.find(
                        entry => entry?.id === linkPlan.conflictClanId
                    );
                    await showDialog({
                        message: sameClan
                            ? `This ATLAS device is already linked to another account in ${myClan.tag ? `[${myClan.tag}] ` : ""}${myClan.name}. One of the accounts must leave the clan.`
                            : `This ATLAS device is already linked to ${other?.tag ? `[${other.tag}] ` : ""}${other?.name || "another clan"}. This account is also in ${myClan.tag ? `[${myClan.tag}] ` : ""}${myClan.name}. Leave one clan before using another account on this device.`,
                        okLabel: "OK",
                        cancelLabel: "Close",
                    });
                } else if (linkPlan.repairClan || linkPlan.repairPointer) {
                    try {
                        const linkResult = await linkCurrentClanDevice(
                            fb,
                            myClan,
                            uid,
                            deviceId
                        );
                        if (linkResult?.clan) myClan = sanitizeClanDoc(linkResult.clan);
                        if (linkResult?.directory) clanDirectory = linkResult.directory;
                    } catch (linkErr) {
                        dbg("linkCurrentClanDevice failed: " + getErrMsg(linkErr));
                    }
                }
            }
            clanLoaded = true;
            clanLoadedForAccount = uid;
            clanLoadFailedAt = 0;
        } catch (e) {
            clanLoadFailedAt = Date.now();
            dbg("loadClanData failed: " + getErrMsg(e));
            console.warn("[RG HUD] Clan load failed:", e);
        }
    }

    async function linkCurrentClanDevice(fb, clan, uid, deviceId) {
        const clanRef = fb.doc(fb.db, "clans", clan.id);
        const useReservations = clanReservationsEnabled();
        const directoryRef = clanDirectoryDocRef(fb, clan.id);
        const membershipRef = useReservations
            ? fb.doc(fb.db, "clan_memberships", uid)
            : null;
        const deviceRef = useReservations
            ? fb.doc(fb.db, "clan_devices", deviceId)
            : null;
        let result = { clan, directory: null, conflict: null };
        const ran = await runAtlasTransaction(fb, "link clan device", async tx => {
            result = { clan, directory: null, conflict: null };
            const directorySnap = await tx.get(directoryRef);
            const clanSnap = await tx.get(clanRef);
            const membershipSnap = useReservations
                ? await tx.get(membershipRef)
                : null;
            const deviceSnap = useReservations
                ? await tx.get(deviceRef)
                : null;
            if (!clanSnap.exists()) {
                result = { clan: null, directory: null, conflict: null };
                return;
            }
            const liveClan = { id: clan.id, ...clanSnap.data() };
            const member = clanMembers(liveClan).find(
                candidate => candidate.userId === uid
            );
            if (!member) {
                result = { clan: null, directory: null, conflict: null };
                return;
            }
            const liveDirectory = !useReservations && directorySnap.exists()
                ? (directorySnap.data().clans ?? [])
                : clanDirectory;
            const directoryEntry = useReservations
                ? (directorySnap.exists()
                    ? { id: clan.id, ...directorySnap.data() }
                    : null)
                : findDirectoryMembership(
                    liveDirectory,
                    { userId: null, deviceId }
                );
            const membership = membershipSnap?.exists()
                ? membershipSnap.data()
                : null;
            const device = deviceSnap?.exists() ? deviceSnap.data() : null;
            const plan = clanDeviceLinkPlan({
                clan: liveClan,
                uid,
                deviceId,
                membership,
                device,
                directoryEntry,
                useReservations,
            });
            if (plan.conflictClanId) {
                const lockedConflict = {
                    ...(clanDirectory.find(
                        entry => entry?.id === plan.conflictClanId
                    ) ?? {
                        id: plan.conflictClanId,
                        name: "another clan",
                        tag: "",
                    }),
                    membershipMatch: membership?.clanId === plan.conflictClanId
                        ? "player"
                        : "device",
                };
                result = {
                    clan: liveClan,
                    directory: null,
                    conflict: lockedConflict,
                };
                return;
            }
            if (!plan.repairClan && !plan.repairPointer) {
                result = {
                    clan: liveClan,
                    directory: useReservations
                        ? clanDirectory
                        : canonicalClanDirectory(liveDirectory),
                    conflict: null,
                };
                return;
            }
            const members = clanMembers(liveClan).map(candidate =>
                candidate.userId === uid
                    ? { ...candidate, deviceId }
                    : candidate
            );
            const existingStats = liveClan.memberStats?.[uid] ?? {};
            const deviceIds = [...new Set([
                ...(Array.isArray(existingStats.deviceIds) ? existingStats.deviceIds : []),
                deviceId,
            ])];
            const memberStats = {
                ...(liveClan.memberStats ?? {}),
                [uid]: { ...existingStats, deviceIds },
            };
            const reservationFields = useReservations
                ? {
                    memberIds: members.map(candidate => candidate.userId),
                    deviceIds: clanDeviceIds({ ...liveClan, members, memberStats }),
                }
                : {};
            const membersField = clanMembersField(liveClan, members);
            const linkedClan = {
                ...liveClan,
                ...membersField,
                memberStats,
                ...reservationFields,
            };
            const entry = clanDirectoryEntry(clan.id, linkedClan);
            const directory = putClanInDirectory(clanDirectory, entry);
            tx.set(clanRef, {
                ...membersField,
                memberStats,
                ...reservationFields,
                ...(useReservations
                    ? { lastReservationRepairAt: fb.serverTimestamp() }
                    : {}),
            }, { merge: true });
            if (useReservations) {
                tx.set(directoryRef, entry);
                tx.set(
                    membershipRef,
                    clanMembershipRecord(
                        clan.id,
                        member.role ?? "member",
                        [...clanMemberDeviceIds(linkedClan, uid), deviceId]
                    )
                );
                tx.set(deviceRef, {
                    clanId: clan.id,
                    userId: uid,
                    updatedAt: new Date().toISOString(),
                });
            } else {
                tx.set(
                    directoryRef,
                    { clans: putClanInDirectory(liveDirectory, entry) }
                );
            }
            result = { clan: linkedClan, directory, conflict: null };
        });
        if (!ran) return result;
        return result;
    }

    // Browse list is a point read of clans_directory/index (or a hard-capped
    // query). Mutations update the index or their own shard in-transaction.

    // zero-read patch of my own entry in the in-memory directory
    function patchMyClanInDirectory() {
        if (!myClan) return;
        clanDirectory = putClanInDirectory(
            clanDirectory,
            clanDirectoryEntry(myClan.id, myClan)
        );
        applyTitle(); // clan-lead flip
    }

    // throttled rebuild for routine MMR updates. structural changes still call
    // refreshDirectory directly. my own HUD stays live via patchMyClanInDirectory.
    let lastDirRefreshAt = 0;
    const DIR_REFRESH_THROTTLE_MS = 3 * 60 * 1000;

    async function refreshDirectoryThrottled(fb) {
        try {
            patchMyClanInDirectory();
            if (clanReservationsEnabled()) return;
            const now = Date.now();
            if (now - lastDirRefreshAt < DIR_REFRESH_THROTTLE_MS) return;
            lastDirRefreshAt = now;
            await refreshDirectory(fb);
        } catch (e) {
            dbg("refreshDirectoryThrottled threw: " + getErrMsg(e));
        }
    }

    async function saveClanTagStyle(fb, clanId, newStyle) {
        return atlasSetDoc(
            fb,
            "clan tag style",
            fb.doc(fb.db, "clans", clanId),
            { tagStyle: newStyle },
            { merge: true }
        );
    }


    function renderClanTagPanel() {
        const body = document.getElementById("rgClanTagBody");
        if (!body || !myClan) return;
        const isLeader = myClan.leaderId === myUserId();
        // roles with tagStyle perm see the full editor; others see preview + opt-in
        const canStyle = rolePerm(myClanRole(), "tagStyle");
        const st = myClan.tagStyle || {};
        const tagText = String(myClan.tag || "").trim();

        // working copy, live edits don't commit until Save
        const work = {
            mode: st.mode || (st.color ? "solid" : Array.isArray(st.stops) || st.paletteKey ? "gradient" : "none"),
            color: st.color || "#00bfff",
            gradientStart: st.gradientStart || "#00bfff",
            gradientEnd: st.gradientEnd || "#e94fff",
            paletteKey: st.paletteKey || null,   // null = custom start/end
            bracketColor: st.bracketColor || null, // null = brackets follow main style
            bold: !!st.bold,
            italic: !!st.italic,
            waveOn: !!st.waveOn,
            waveAmp: st.waveAmp ?? 8,
            rotateDeg: st.rotateDeg ?? 0,
        };

        function activeStops() {
            if (work.paletteKey) {
                const p = CLAN_TAG_PALETTES.find(x => x.key === work.paletteKey);
                if (p) return p.stops;
            }
            return [work.gradientStart, work.gradientEnd];
        }

        // when bracketColor is set, the gradient runs over just the letters
        // so the blend isn't broken by contrast-colored brackets
        function buildPreviewHtml() {
            if (!tagText) return '<span style="color:#888;font-style:italic;font-size:14px;">(clan has no tag set)</span>';
            const escCh = ch => ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch;
            const tagChars = [...tagText];
            const bracketColor = /^#[0-9a-fA-F]{6}$/.test(work.bracketColor || "") ? work.bracketColor : null;
            const stops = work.mode === "gradient" ? activeStops() : null;

            // wave alternates per char, static rotate is uniform
            const rotFor = wi => work.waveOn ? (wi % 2 === 0 ? work.waveAmp : -work.waveAmp)
                : (work.rotateDeg && !work.waveOn ? work.rotateDeg : 0);
            const spanFor = (ch, color, wi) => {
                const rot = rotFor(wi);
                const tf = rot ? "display:inline-block;transform:rotate(" + rot + "deg);" : "";
                const co = color ? "color:" + color + ";" : "";
                return '<span style="' + co + tf + '">' + escCh(ch) + '</span>';
            };

            // letter color at position i / tagChars.length
            const letterColor = (i) => {
                if (stops) {
                    const giMax = bracketColor ? Math.max(0, tagChars.length - 1) : tagChars.length + 1;
                    const gi = bracketColor ? i : i + 1;
                    const t = giMax === 0 ? 0 : gi / giMax;
                    return _sampleStops(stops, t);
                }
                if (work.mode === "solid") return work.color;
                return null;
            };
            // bracket color: bracketColor if set, else defer to mode
            const bracketC = bracketColor
                ? bracketColor
                : stops
                    ? _sampleStops(stops, 0) // start of gradient for opening
                    : work.mode === "solid" ? work.color : null;
            const bracketCEnd = bracketColor
                ? bracketColor
                : stops
                    ? _sampleStops(stops, 1)
                    : work.mode === "solid" ? work.color : null;

            let wi = 0;
            let content = spanFor("[", bracketC, wi++);
            for (let i = 0; i < tagChars.length; i++) {
                content += spanFor(tagChars[i], letterColor(i), wi++);
            }
            content += spanFor("]", bracketCEnd, wi++);

            const wrapStyle = "font-size:22px;font-weight:" + (work.bold ? "700" : "400") + ";font-style:" + (work.italic ? "italic" : "normal") + ";";
            return '<span style="' + wrapStyle + '">' + content + '</span>';
        }

        function updatePreview() {
            const el = document.getElementById("rgTagPreviewInner");
            if (el) el.innerHTML = buildPreviewHtml();
        }

        // ---- Build panel HTML ----
        let html = '';

        // big preview box (Forge style)
        html += '<div style="background:radial-gradient(120% 140% at 50% 0%, #101a3a 0%, #070a16 70%);border:1px solid #00bfff44;border-radius:10px;padding:16px;text-align:center;min-height:60px;display:flex;align-items:center;justify-content:center;margin-bottom:10px;">'
            + '<span id="rgTagPreviewInner">' + buildPreviewHtml() + '</span></div>';

        if (canStyle && tagText) {
            // mode selector
            html += '<div style="font-size:10px;font-weight:bold;color:#00bfff;margin:6px 0 4px;">STYLE MODE</div>';
            html += '<div style="display:flex;gap:4px;">';
            for (const m of ["none","solid","gradient"]) {
                const active = work.mode === m;
                html += '<button class="rgBtn rgTagMode" data-mode="' + m + '" style="flex:1;padding:5px;font-size:11px;'
                    + (active ? 'background:#00bfff33;border:1px solid #00bfff;color:#00bfff;' : '') + '">'
                    + m.charAt(0).toUpperCase() + m.slice(1) + '</button>';
            }
            html += '</div>';

            // solid color row
            html += '<div id="rgTagSolidRow" style="margin-top:8px;display:' + (work.mode === "solid" ? "flex" : "none") + ';gap:8px;align-items:center;font-size:11px;">'
                + 'Color: <input type="color" id="rgTagColor" value="' + work.color + '" style="width:40px;height:24px;padding:0;border:none;background:transparent;cursor:pointer;">'
                + '<span id="rgTagColorHex" style="opacity:.7;font-family:monospace;">' + work.color + '</span>'
                + '</div>';

            // gradient section: palettes + custom endpoints + preview bar
            html += '<div id="rgTagGradientRow" style="margin-top:8px;display:' + (work.mode === "gradient" ? "block" : "none") + ';font-size:11px;">';
            html += '<div style="opacity:.7;margin-bottom:4px;">Palettes</div>';
            html += '<div style="display:flex;flex-wrap:wrap;gap:4px;">';
            for (const p of CLAN_TAG_PALETTES) {
                const active = work.paletteKey === p.key;
                html += '<button class="rgBtn rgTagPalette" data-key="' + p.key + '" style="padding:3px 8px;font-size:11px;'
                    + (active ? 'background:#00bfff33;border:1px solid #00bfff;' : '') + '">'
                    + p.label + '</button>';
            }
            html += '<button class="rgBtn rgTagPalette" data-key="__custom" style="padding:3px 8px;font-size:11px;'
                + (!work.paletteKey ? 'background:#00bfff33;border:1px solid #00bfff;' : '') + '">Custom</button>';
            html += '</div>';
            html += '<div id="rgTagCustomRow" style="margin-top:6px;display:' + (work.paletteKey ? "none" : "flex") + ';gap:8px;align-items:center;flex-wrap:wrap;">'
                + 'Start: <input type="color" id="rgTagGradStart" value="' + work.gradientStart + '" style="width:40px;height:24px;padding:0;border:none;background:transparent;cursor:pointer;">'
                + '&rarr; End: <input type="color" id="rgTagGradEnd" value="' + work.gradientEnd + '" style="width:40px;height:24px;padding:0;border:none;background:transparent;cursor:pointer;">'
                + '</div>';
            const barStops = activeStops();
            html += '<div id="rgTagGradientBar" style="margin-top:6px;height:6px;border-radius:3px;background:linear-gradient(90deg, ' + barStops.join(", ") + ');"></div>';
            html += '</div>';

            // bold + italic
            html += '<div style="margin-top:10px;display:flex;gap:16px;font-size:11px;">'
                + '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;"><input type="checkbox" id="rgTagBold"' + (work.bold ? " checked" : "") + '> <b>Bold</b></label>'
                + '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;"><input type="checkbox" id="rgTagItalic"' + (work.italic ? " checked" : "") + '> <i>Italic</i></label>'
                + '</div>';

            // cleared bracket color -> brackets follow the main style
            html += '<div style="font-size:10px;font-weight:bold;color:#00bfff;margin:10px 0 4px;">BRACKETS</div>';
            html += '<div style="display:flex;gap:8px;align-items:center;font-size:11px;">'
                + 'Color: <input type="color" id="rgTagBracketColor" value="' + (work.bracketColor || "#ffffff") + '" style="width:40px;height:24px;padding:0;border:none;background:transparent;cursor:pointer;">'
                + '<button id="rgTagBracketMatch" class="rgBtn" style="padding:3px 8px;font-size:10px;'
                + (!work.bracketColor ? 'background:#00bfff33;border:1px solid #00bfff;' : '') + '">Match tag</button>'
                + '<span style="opacity:.6;font-size:10px;">' + (work.bracketColor ? work.bracketColor : "matches") + '</span>'
                + '</div>';

            // wave overrides static rotate
            html += '<div style="font-size:10px;font-weight:bold;color:#00bfff;margin:10px 0 4px;">EFFECTS</div>';
            html += '<label style="display:flex;align-items:center;gap:5px;font-size:11px;cursor:pointer;">'
                + '<input type="checkbox" id="rgTagWave"' + (work.waveOn ? " checked" : "") + '> Wave'
                + ' <span style="opacity:.6;margin-left:4px;">(alternates ±<span id="rgTagWaveAmpLbl">' + work.waveAmp + '</span>°)</span>'
                + '</label>';
            html += '<div id="rgTagWaveRow" style="margin-top:4px;display:' + (work.waveOn ? "flex" : "none") + ';gap:8px;align-items:center;font-size:11px;">'
                + 'Amp: <input type="range" id="rgTagWaveAmp" min="0" max="30" value="' + work.waveAmp + '" style="flex:1;">'
                + '</div>';
            html += '<div id="rgTagRotateRow" style="margin-top:6px;display:' + (work.waveOn ? "none" : "flex") + ';gap:8px;align-items:center;font-size:11px;">'
                + 'Rotate: <input type="range" id="rgTagRotate" min="-45" max="45" value="' + work.rotateDeg + '" style="flex:1;">'
                + '<span id="rgTagRotateLbl" style="width:32px;opacity:.7;">' + work.rotateDeg + '°</span>'
                + '</div>';

            html += '<button id="rgTagSave" class="rgBtn" style="width:100%;margin-top:10px;">Save Tag Style</button>';
        } else if (!canStyle && !tagText) {
            html += '<div style="font-size:11px;color:#888;text-align:center;margin-top:4px;">Leader hasn\'t set a tag yet.</div>';
        }

        // opt-in (all members)
        if (tagText) {
            html += '<hr style="border:none;border-top:1px solid #00bfff22;margin:10px 0 8px;">';
            html += '<label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;">'
                + '<input type="checkbox" id="rgUseTag"' + (useClanTagPref() ? " checked" : "") + '>'
                + ' Prepend clan tag to my in-game name</label>';
            html += '<div style="display:flex;align-items:center;gap:6px;font-size:11px;margin-top:6px;padding-left:20px;opacity:.85;">'
                + '<span>Position:</span>'
                + '<label style="display:flex;align-items:center;gap:3px;cursor:pointer;">'
                + '<input type="radio" name="rgTagPos" id="rgTagPosName" value="name"' + (clanTagPositionPref() === "name" ? " checked" : "") + '>'
                + ' Before name</label>'
                + '<label style="display:flex;align-items:center;gap:3px;cursor:pointer;">'
                + '<input type="radio" name="rgTagPos" id="rgTagPosTitle" value="title"' + (clanTagPositionPref() === "title" ? " checked" : "") + '>'
                + ' Before title</label>'
                + '</div>';
        }

        body.innerHTML = html;

        // ---- Wire live-update handlers ----
        if (canStyle && tagText) {
            // mode buttons
            for (const btn of document.querySelectorAll(".rgTagMode")) {
                btn.onclick = () => {
                    work.mode = btn.getAttribute("data-mode");
                    document.getElementById("rgTagSolidRow").style.display = work.mode === "solid" ? "flex" : "none";
                    document.getElementById("rgTagGradientRow").style.display = work.mode === "gradient" ? "block" : "none";
                    document.querySelectorAll(".rgTagMode").forEach(b => {
                        const active = b === btn;
                        b.style.background = active ? "#00bfff33" : "";
                        b.style.border = active ? "1px solid #00bfff" : "";
                        b.style.color = active ? "#00bfff" : "";
                    });
                    updatePreview();
                };
            }
            // palette chips. "Custom" returns to user start/end
            for (const btn of document.querySelectorAll(".rgTagPalette")) {
                btn.onclick = () => {
                    const key = btn.getAttribute("data-key");
                    work.paletteKey = key === "__custom" ? null : key;
                    document.querySelectorAll(".rgTagPalette").forEach(b => {
                        const active = (b.getAttribute("data-key") === (work.paletteKey || "__custom"));
                        b.style.background = active ? "#00bfff33" : "";
                        b.style.border = active ? "1px solid #00bfff" : "";
                    });
                    document.getElementById("rgTagCustomRow").style.display = work.paletteKey ? "none" : "flex";
                    const bar = document.getElementById("rgTagGradientBar");
                    if (bar) bar.style.background = "linear-gradient(90deg, " + activeStops().join(", ") + ")";
                    updatePreview();
                };
            }
            const wireInput = (id, key, extra) => {
                const el = document.getElementById(id);
                if (el) el.oninput = () => { work[key] = el.value; if (extra) extra(); updatePreview(); };
            };
            wireInput("rgTagColor", "color", () => {
                const hex = document.getElementById("rgTagColorHex");
                if (hex) hex.textContent = work.color;
            });
            const refreshBar = () => {
                const bar = document.getElementById("rgTagGradientBar");
                if (bar) bar.style.background = "linear-gradient(90deg, " + activeStops().join(", ") + ")";
            };
            wireInput("rgTagGradStart", "gradientStart", refreshBar);
            wireInput("rgTagGradEnd", "gradientEnd", refreshBar);
            const wireCheck = (id, key) => {
                const el = document.getElementById(id);
                if (el) el.onchange = () => { work[key] = el.checked; updatePreview(); };
            };
            wireCheck("rgTagBold", "bold");
            wireCheck("rgTagItalic", "italic");

            // "Match tag" clears bracket color so brackets rejoin main style
            const bracketColorEl = document.getElementById("rgTagBracketColor");
            const bracketMatchBtn = document.getElementById("rgTagBracketMatch");
            const bracketHexLbl = () => bracketMatchBtn && bracketMatchBtn.nextElementSibling;
            if (bracketColorEl) bracketColorEl.oninput = () => {
                work.bracketColor = bracketColorEl.value;
                if (bracketMatchBtn) {
                    bracketMatchBtn.style.background = "";
                    bracketMatchBtn.style.border = "";
                }
                const lbl = bracketHexLbl();
                if (lbl) lbl.textContent = work.bracketColor;
                updatePreview();
            };
            if (bracketMatchBtn) bracketMatchBtn.onclick = () => {
                work.bracketColor = null;
                bracketMatchBtn.style.background = "#00bfff33";
                bracketMatchBtn.style.border = "1px solid #00bfff";
                const lbl = bracketHexLbl();
                if (lbl) lbl.textContent = "matches";
                updatePreview();
            };
            const waveEl = document.getElementById("rgTagWave");
            if (waveEl) waveEl.onchange = () => {
                work.waveOn = waveEl.checked;
                document.getElementById("rgTagWaveRow").style.display = work.waveOn ? "flex" : "none";
                document.getElementById("rgTagRotateRow").style.display = work.waveOn ? "none" : "flex";
                updatePreview();
            };
            const waveAmpEl = document.getElementById("rgTagWaveAmp");
            if (waveAmpEl) waveAmpEl.oninput = () => {
                work.waveAmp = Number(waveAmpEl.value);
                const lbl = document.getElementById("rgTagWaveAmpLbl");
                if (lbl) lbl.textContent = work.waveAmp;
                updatePreview();
            };
            const rotEl = document.getElementById("rgTagRotate");
            if (rotEl) rotEl.oninput = () => {
                work.rotateDeg = Number(rotEl.value);
                const lbl = document.getElementById("rgTagRotateLbl");
                if (lbl) lbl.textContent = work.rotateDeg + "°";
                updatePreview();
            };

            document.getElementById("rgTagSave").onclick = async () => {
                const newStyle = {
                    mode: work.mode,
                    color: work.color,
                    gradientStart: work.gradientStart,
                    gradientEnd: work.gradientEnd,
                    paletteKey: work.paletteKey,
                    bracketColor: work.bracketColor,
                    bold: work.bold,
                    italic: work.italic,
                    waveOn: work.waveOn,
                    waveAmp: work.waveAmp,
                    rotateDeg: work.rotateDeg,
                };
                try {
                    const fb = await initFirebase();
                    if (!fb) return;
                    if (!(await saveClanTagStyle(fb, myClan.id, newStyle))) return;
                    myClan.tagStyle = newStyle;
                    // inline confirm, toast is easy to miss when scrolled deep
                    const saveBtn = document.getElementById("rgTagSave");
                    if (saveBtn) {
                        saveBtn.textContent = "✓ Saved for the clan!";
                        saveBtn.style.borderColor = "#00ff88";
                        saveBtn.style.color = "#00ff88";
                        setTimeout(() => {
                            saveBtn.textContent = "Save Tag Style";
                            saveBtn.style.borderColor = "";
                            saveBtn.style.color = "";
                        }, 1800);
                    }
                    showToast("Saved! Open 🎨 Forge and hit Apply to refresh YOUR name -- members do the same on theirs.");
                } catch (e) {
                    dbg("save tag style threw: " + getErrMsg(e));
                    console.error("[RG HUD] Save tag style failed:", e);
                    showToast("Save failed.");
                }
            };
        }

        // opt-in handler
        const useTagCb = document.getElementById("rgUseTag");
        if (useTagCb) {
            useTagCb.onchange = () => {
                setUseClanTagPref(useTagCb.checked);
                // prefix only reaches the in-game name after Apply in Name Forge
                showToast(useTagCb.checked
                    ? "Tag armed! Open 🎨 Name Forge and hit Apply to update your name."
                    : "Tag prefix off -- hit Apply in 🎨 Name Forge to update your name.");
                if (typeof RGNF !== "undefined" && RGNF.refresh) RGNF.refresh();
            };
        }
        // position radio handlers
        for (const id of ["rgTagPosName", "rgTagPosTitle"]) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.onchange = () => {
                if (!el.checked) return;
                setClanTagPositionPref(el.value);
                if (typeof RGNF !== "undefined" && RGNF.refresh) RGNF.refresh();
            };
        }
    }

    async function refreshDirectory(fb) {
        try {
            if (firestoreReadBudgetPassed()) {
                dbg("refreshDirectory skipped: read budget passed");
            } else {
                clanDirectory = await loadClanDirectoryLite(
                    fb,
                    myClan?.id || null
                );
            }
        } catch (e) {
            dbg("refreshDirectory failed: " + getErrMsg(e));
            console.warn("[RG HUD] Directory refresh failed:", e);
        }
        // repaint title in case standings flipped clan-lead status
        applyTitle();
    }

    // sum of 3v3+2v2+1v1 displayRatings (no casual)
    function myRankedMMR() {
        const g = lastKnownPlayerData?.ModesGlicko;
        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1"];
        return modes.reduce((s, m) => s + (typeof g?.[m]?.displayRating === "number" ? g[m].displayRating : 0), 0);
    }

    async function createClan(name, tag) {
        const fb = await initFirebase();
        if (!fb) return;
        const uid = myUserId();
        if (!uid) return;

        if (!eventPerm("allowClanCreate")) {
            showToast("New clans can\'t be created during this event.");
            return;
        }

        try {
            const initialMMR = myRankedMMR();
            const syncedAt = Date.now();
            const createdAt = new Date().toISOString();
            const deviceId = getDeviceId();
            const useReservations = clanReservationsEnabled();
            const nameKey = useReservations
                ? await clanNameReservationId(name)
                : null;
            const tagKey = useReservations ? sanitizeClanTag(tag) : null;
            const leaderMember = {
                userId: uid,
                name: myName(),
                role: "leader",
                mmr: initialMMR,
                syncedAt,
                deviceId,
                ...(useReservations ? { deviceIds: [deviceId] } : {}),
            };
            const clan = {
                name,
                tag: tag || "",
                tagStyle: null,
                leaderId: uid,
                members: useReservations
                    ? { [uid]: leaderMember }
                    : [leaderMember],
                memberStats: { [uid]: { mmr: initialMMR, syncedAt, deviceIds: [deviceId] } },
                joinRequests: [],
                totalMMR: initialMMR,
                createdAt,
                scriptVersion: SCRIPT_VERSION,
                versionNum: SCRIPT_VERSION_NUM,
                ...(useReservations ? {
                    nameKey,
                    tagKey,
                    normalizedName: normalizeClanName(name),
                    lockVersion: 1,
                    deviceId,
                    memberIds: [uid],
                    deviceIds: [deviceId],
                } : {}),
            };
            const clanRef = fb.doc(fb.collection(fb.db, "clans"));
            const directoryRef = clanDirectoryDocRef(fb, clanRef.id);
            const nameRef = useReservations
                ? fb.doc(fb.db, "clan_name_keys", nameKey)
                : null;
            const tagRef = useReservations
                ? fb.doc(fb.db, "clan_tag_keys", tagKey)
                : null;
            const membershipRef = useReservations
                ? fb.doc(fb.db, "clan_memberships", uid)
                : null;
            const deviceRef = useReservations
                ? fb.doc(fb.db, "clan_devices", deviceId)
                : null;
            let outcome = "created";
            let existingMembership = null;
            let committedDirectory = null;

            // Save both together so double-clicks can't create extra clans.
            const ran = await runAtlasTransaction(fb, "create clan", async tx => {
                outcome = "created";
                existingMembership = null;
                committedDirectory = null;
                const directorySnap = !useReservations
                    ? await tx.get(directoryRef)
                    : null;
                const membershipSnap = useReservations
                    ? await tx.get(membershipRef)
                    : null;
                const deviceSnap = useReservations
                    ? await tx.get(deviceRef)
                    : null;
                const nameSnap = useReservations
                    ? await tx.get(nameRef)
                    : null;
                const tagSnap = useReservations
                    ? await tx.get(tagRef)
                    : null;
                const liveDirectory = directorySnap?.exists()
                    ? (directorySnap.data().clans ?? [])
                    : [];
                existingMembership = useReservations
                    ? null
                    : findDirectoryMembership(
                        liveDirectory,
                        { userId: uid, deviceId }
                    );
                const lockedClanId = membershipSnap?.exists()
                    ? membershipSnap.data().clanId
                    : (deviceSnap?.exists() ? deviceSnap.data().clanId : null);
                if (!existingMembership && lockedClanId) {
                    const locked = clanDirectory.find(
                        entry => entry?.id === lockedClanId
                    );
                    existingMembership = {
                        ...(locked ?? { id: lockedClanId, name: "another clan", tag: "" }),
                        membershipMatch: membershipSnap?.exists() ? "player" : "device",
                    };
                }
                if (existingMembership) {
                    outcome = "already-in-clan";
                    return;
                }
                if (nameSnap?.exists()) {
                    outcome = "name-taken";
                    return;
                }
                if (tagSnap?.exists()) {
                    outcome = "tag-taken";
                    return;
                }
                const normalizedName = normalizeClanName(name);
                const normalizedTag = sanitizeClanTag(tag);
                if (!useReservations && liveDirectory.some(entry =>
                    normalizeClanName(entry?.name) === normalizedName
                )) {
                    outcome = "name-taken";
                    return;
                }
                if (!useReservations && normalizedTag && liveDirectory.some(entry =>
                    sanitizeClanTag(entry?.tag) === normalizedTag
                )) {
                    outcome = "tag-taken";
                    return;
                }
                const entry = clanDirectoryEntry(clanRef.id, clan);
                committedDirectory = putClanInDirectory(
                    useReservations ? clanDirectory : liveDirectory,
                    entry
                );
                tx.set(clanRef, clan);
                if (useReservations) {
                    tx.set(directoryRef, entry);
                    tx.set(nameRef, {
                        clanId: clanRef.id,
                        name,
                        normalizedName: normalizeClanName(name),
                    });
                    tx.set(tagRef, {
                        clanId: clanRef.id,
                        tag: sanitizeClanTag(tag),
                    });
                    tx.set(
                        membershipRef,
                        clanMembershipRecord(clanRef.id, "leader", [deviceId])
                    );
                    tx.set(deviceRef, {
                        clanId: clanRef.id,
                        userId: uid,
                        updatedAt: new Date().toISOString(),
                    });
                } else {
                    tx.set(directoryRef, { clans: committedDirectory });
                }
            });
            if (!ran) return;

            if (outcome === "already-in-clan") {
                await showDialog({
                    message: clanMembershipMessage(myName(), existingMembership, true),
                    okLabel: "OK",
                    cancelLabel: "Close",
                });
                await loadClanData(true);
                renderClanView();
                return;
            }
            if (outcome === "name-taken") {
                showToast("A clan with that name already exists.");
                return;
            }
            if (outcome === "tag-taken") {
                showToast("That clan tag is already taken.");
                return;
            }

            dbg(`Clan created: name="${name}" tag="${tag || ""}" id=${clanRef.id}`);
            myClan = { id: clanRef.id, ...clan };
            clanDirectory = committedDirectory ?? clanDirectory;
            renderClanView();
        } catch (e) {
            pushError(e, "createClan");
            console.error("[RG HUD] Create clan failed:", e);
            showToast("Couldn't create clan (see console).");
        }
    }

    async function requestJoin(clanId) {
        const fb = await initFirebase();
        if (!fb) return;
        const uid = myUserId();
        if (!uid) return;

        if (!eventPerm("allowJoin")) {
            showToast("Clan joins are locked during this event.");
            return;
        }

        try {
            const clanRef = fb.doc(fb.db, "clans", clanId);
            const requestName = myName();
            const deviceId = getDeviceId();
            const useReservations = clanReservationsEnabled();
            const directoryRef = !useReservations
                ? fb.doc(fb.db, "clans_directory", "index")
                : null;
            const membershipRef = useReservations
                ? fb.doc(fb.db, "clan_memberships", uid)
                : null;
            const deviceRef = useReservations
                ? fb.doc(fb.db, "clan_devices", deviceId)
                : null;
            let outcome = "sent";
            let existingMembership = null;
            const ran = await runAtlasTransaction(fb, "request clan join", async tx => {
                outcome = "sent";
                existingMembership = null;
                const directorySnap = !useReservations
                    ? await tx.get(directoryRef)
                    : null;
                const clanSnap = await tx.get(clanRef);
                const membershipSnap = useReservations
                    ? await tx.get(membershipRef)
                    : null;
                const deviceSnap = useReservations
                    ? await tx.get(deviceRef)
                    : null;
                if (!clanSnap.exists()) {
                    outcome = "missing";
                    return;
                }
                const clan = clanSnap.data();
                if (clanMembers(clan).some(m => m.userId === uid)) {
                    outcome = "member";
                    return;
                }
                const liveDirectory = directorySnap?.exists()
                    ? (directorySnap.data().clans ?? [])
                    : [];
                existingMembership = useReservations
                    ? null
                    : findDirectoryMembership(
                        liveDirectory,
                        { userId: uid, deviceId }
                    );
                const lockedClanId = membershipSnap?.exists()
                    ? membershipSnap.data().clanId
                    : (deviceSnap?.exists() ? deviceSnap.data().clanId : null);
                if (!existingMembership && lockedClanId) {
                    const locked = clanDirectory.find(
                        entry => entry?.id === lockedClanId
                    );
                    existingMembership = {
                        ...(locked ?? { id: lockedClanId, name: "another clan", tag: "" }),
                        membershipMatch: membershipSnap?.exists() ? "player" : "device",
                    };
                }
                if (existingMembership) {
                    outcome = "already-in-clan";
                    return;
                }
                if (clanMembers(clan).length >= clanMaxMembers()) {
                    outcome = "full";
                    return;
                }
                const currentRequests = clan.joinRequests ?? [];
                const pendingIndex = currentRequests.findIndex(r => r.userId === uid);
                if (pendingIndex >= 0) {
                    if (currentRequests[pendingIndex].deviceId !== deviceId) {
                        const joinRequests = currentRequests.map((request, index) =>
                            index === pendingIndex
                                ? { ...request, name: requestName, deviceId }
                                : request
                        );
                        tx.set(clanRef, { joinRequests }, { merge: true });
                    }
                    outcome = "pending";
                    return;
                }
                outcome = "sent";
                const joinRequests = [
                    ...currentRequests,
                    { userId: uid, name: requestName, deviceId },
                ];
                tx.set(clanRef, { joinRequests }, { merge: true });
            });
            if (!ran) return;
            if (outcome === "missing") {
                showToast("That clan no longer exists.");
                return;
            }
            if (outcome === "member") {
                await loadClanData(true);
                showToast("You're already in this clan.");
                renderClanView();
                return;
            }
            if (outcome === "already-in-clan") {
                await showDialog({
                    message: clanMembershipMessage(requestName, existingMembership, true),
                    okLabel: "OK",
                    cancelLabel: "Close",
                });
                await loadClanData(true);
                renderClanView();
                return;
            }
            if (outcome === "full") {
                showToast("That clan is full.");
                return;
            }
            if (outcome === "pending") {
                showToast("You already requested to join.");
                return;
            }
            dbg(`Join request sent to clan ${clanId}`);
            showToast("Join request sent!");
            renderClanView();
        } catch (e) {
            pushError(e, "requestJoin");
            console.error("[RG HUD] Request join failed:", e);
            showToast("Couldn't send join request — see console.");
        }
    }

    async function approveRequest(userId, approve) {
        const fb = await initFirebase();
        if (!fb || !myClan) return;

        // denies are always allowed, they don't grow the roster
        if (approve && !eventPerm("allowApprove")) {
            showToast("Approvals are locked during this event.");
            return;
        }
        if (approve && !rolePerm(myClanRole(), "approve")) {
            showToast("Your role can't approve join requests.");
            return;
        }

        try {
            const clanId = myClan.id;
            const clanRef = fb.doc(fb.db, "clans", clanId);
            const useReservations = clanReservationsEnabled();
            const directoryRef = clanDirectoryDocRef(fb, clanId);
            const membershipRef = useReservations
                ? fb.doc(fb.db, "clan_memberships", userId)
                : null;
            const actorUid = myUserId();
            let committedClan = null;
            let committedDirectory = null;
            let existingMembership = null;
            let requestDisplayName = "This player";
            let outcome = approve ? "approved" : "denied";
            const ran = await runAtlasTransaction(fb, "handle clan request", async tx => {
                committedClan = null;
                committedDirectory = null;
                existingMembership = null;
                const directorySnap = approve && !useReservations
                    ? await tx.get(directoryRef)
                    : null;
                const clanSnap = await tx.get(clanRef);
                if (!clanSnap.exists()) {
                    outcome = "missing";
                    return;
                }
                const liveClan = clanSnap.data();
                const liveMembers = clanMembers(liveClan);
                const actor = liveMembers.find(m => m.userId === actorUid);
                if (approve && (!actor || !rolePerm(actor.role, "approve"))) {
                    outcome = "forbidden";
                    return;
                }
                const req = (liveClan.joinRequests ?? []).find(r => r.userId === userId);
                if (!req) {
                    outcome = "handled";
                    return;
                }
                requestDisplayName = req.name || "This player";
                const deviceRef = useReservations && req.deviceId
                    ? fb.doc(fb.db, "clan_devices", req.deviceId)
                    : null;
                const membershipSnap = approve && useReservations
                    ? await tx.get(membershipRef)
                    : null;
                const deviceSnap = approve && deviceRef
                    ? await tx.get(deviceRef)
                    : null;
                const liveDirectory = directorySnap?.exists()
                    ? (directorySnap.data().clans ?? [])
                    : [];
                if (approve) {
                    existingMembership = useReservations
                        ? null
                        : findDirectoryMembership(
                            liveDirectory,
                            { userId, deviceId: req.deviceId }
                        );
                    const lockedClanId = membershipSnap?.exists()
                        ? membershipSnap.data().clanId
                        : (deviceSnap?.exists() ? deviceSnap.data().clanId : null);
                    if (!existingMembership && lockedClanId) {
                        const locked = clanDirectory.find(
                            entry => entry?.id === lockedClanId
                        );
                        existingMembership = {
                            ...(locked ?? { id: lockedClanId, name: "another clan", tag: "" }),
                            membershipMatch: membershipSnap?.exists() ? "player" : "device",
                        };
                    }
                    if (existingMembership) {
                        outcome = "already-in-clan";
                        return;
                    }
                }
                if (approve && liveMembers.length >= clanMaxMembers()) {
                    outcome = "full";
                    return;
                }
                const joinRequests = (liveClan.joinRequests ?? []).filter(r => r.userId !== userId);
                let members = liveMembers;
                if (approve && !members.some(m => m.userId === userId)) {
                    members = [
                        ...members,
                        {
                            userId: req.userId,
                            name: req.name,
                            role: "member",
                            ...(req.deviceId ? { deviceId: req.deviceId } : {}),
                        },
                    ];
                }
                let memberStats = liveClan.memberStats;
                if (approve && req.deviceId) {
                    const existingStats = liveClan.memberStats?.[userId] ?? {};
                    const deviceIds = [...new Set([
                        ...(Array.isArray(existingStats.deviceIds) ? existingStats.deviceIds : []),
                        req.deviceId,
                    ])];
                    memberStats = {
                        ...(liveClan.memberStats ?? {}),
                        [userId]: { ...existingStats, deviceIds },
                    };
                }
                const nextClan = {
                    ...liveClan,
                    id: clanId,
                    joinRequests,
                    members,
                    ...(memberStats ? { memberStats } : {}),
                };
                const reservationFields = approve && useReservations
                    ? {
                        memberIds: members.map(member => member.userId),
                        deviceIds: clanDeviceIds(nextClan),
                    }
                    : {};
                const membersField = clanMembersField(liveClan, members);
                tx.set(clanRef, {
                    joinRequests,
                    ...membersField,
                    ...(memberStats ? { memberStats } : {}),
                    ...reservationFields,
                }, { merge: true });
                committedClan = {
                    ...nextClan,
                    ...membersField,
                    ...reservationFields,
                };
                if (approve) {
                    const entry = clanDirectoryEntry(clanId, committedClan);
                    committedDirectory = putClanInDirectory(
                        useReservations ? clanDirectory : liveDirectory,
                        entry
                    );
                    if (useReservations) {
                        tx.set(directoryRef, entry);
                        const deviceIds = req.deviceId ? [req.deviceId] : [];
                        tx.set(
                            membershipRef,
                            clanMembershipRecord(clanId, "member", deviceIds)
                        );
                        if (deviceRef) {
                            tx.set(deviceRef, {
                                clanId,
                                userId,
                                updatedAt: new Date().toISOString(),
                            });
                        }
                    } else {
                        tx.set(directoryRef, { clans: committedDirectory });
                    }
                }
                outcome = approve ? "approved" : "denied";
            });
            if (!ran) return;
            if (!committedClan) {
                if (outcome === "missing") showToast("That clan no longer exists.");
                else if (outcome === "forbidden") showToast("Your current role can't approve join requests.");
                else if (outcome === "full") showToast("That clan is full.");
                else if (outcome === "already-in-clan") {
                    await showDialog({
                        message: clanMembershipMessage(requestDisplayName, existingMembership),
                        okLabel: "OK",
                        cancelLabel: "Close",
                    });
                }
                else showToast("That request was already handled.");
                await loadClanData(true);
                renderClanView();
                return;
            }

            dbg(`Join request ${approve ? "approved" : "denied"} for ${userId}`);
            myClan = sanitizeClanDoc(committedClan);
            if (committedDirectory) clanDirectory = committedDirectory;
            renderClanView();
        } catch (e) {
            pushError(e, "approveRequest");
            console.error("[RG HUD] Approve request failed:", e);
            showToast(approve ? "Couldn't approve — see console." : "Couldn't deny — see console.");
        }
    }

    async function writeClanNotice(fb, userId, notice) {
        if (!firebaseAuthUid) {
            dbg("writeClanNotice skipped: firebaseAuthUid not ready");
            return false;
        }
        const sourceUserId = firebaseAuthUid;
        const rgPlayerId = myUserId();
        const clanId = String(notice?.clanId || myClan?.id || "").trim();
        const payload = {
            ...notice,
            sourceUserId,
            rgPlayerId,
            deviceId: getDeviceId(),
            scriptVersion: SCRIPT_VERSION,
            versionNum: SCRIPT_VERSION_NUM,
        };
        if (clanId) payload.clanId = clanId;
        return atlasSetDoc(
            fb,
            "clan notice",
            fb.doc(fb.db, "clan_notices", userId),
            payload
        );
    }

    async function kickMember(userId, message) {
        const fb = await initFirebase();
        if (!fb || !myClan) return;
        const myUid = myUserId();

        if (!eventPerm("allowKick")) {
            showToast("Kicking is locked during this event.");
            return;
        }

        try {
            const clanId = myClan.id;
            const clanRef = fb.doc(fb.db, "clans", clanId);
            const useReservations = clanReservationsEnabled();
            const directoryRef = clanDirectoryDocRef(fb, clanId);
            const membershipRef = useReservations
                ? fb.doc(fb.db, "clan_memberships", userId)
                : null;
            let outcome = "kicked";
            let committedClan = null;
            let committedDirectory = null;
            const ran = await runAtlasTransaction(fb, "kick clan member", async tx => {
                outcome = "kicked";
                committedClan = null;
                committedDirectory = null;
                const directorySnap = !useReservations
                    ? await tx.get(directoryRef)
                    : null;
                const clanSnap = await tx.get(clanRef);
                if (!clanSnap.exists()) {
                    outcome = "missing";
                    return;
                }
                const liveClan = clanSnap.data();
                const target = clanMembers(liveClan).find(m => m.userId === userId);
                const actor = clanMembers(liveClan).find(m => m.userId === myUid);
                if (!target) {
                    outcome = "handled";
                    return;
                }
                if (target.role === "leader" || !actor || !rolePerm(actor.role, "kick")
                    || (ROLE_RANK[target.role] ?? 0) >= (ROLE_RANK[actor.role] ?? 0)) {
                    outcome = "forbidden";
                    return;
                }
                const members = clanMembers(liveClan).filter(m => m.userId !== userId);
                const deviceIds = clanMemberDeviceIds(liveClan, userId);
                const reservationFields = useReservations
                    ? {
                        memberIds: members.map(member => member.userId),
                        deviceIds: clanDeviceIds({ ...liveClan, members }),
                    }
                    : {};
                const membersField = clanMembersField(liveClan, members);
                committedClan = {
                    ...liveClan,
                    id: clanId,
                    ...membersField,
                    ...reservationFields,
                };
                const entry = clanDirectoryEntry(clanId, committedClan);
                committedDirectory = putClanInDirectory(
                    useReservations
                        ? clanDirectory
                        : (directorySnap?.exists()
                            ? (directorySnap.data().clans ?? [])
                            : []),
                    entry
                );
                tx.set(clanRef, {
                    ...membersField,
                    ...reservationFields,
                }, { merge: true });
                if (useReservations) {
                    tx.set(directoryRef, entry);
                    tx.delete(membershipRef);
                    for (const deviceId of deviceIds) {
                        tx.delete(fb.doc(fb.db, "clan_devices", deviceId));
                    }
                } else {
                    tx.set(directoryRef, { clans: committedDirectory });
                }
            });
            if (!ran) return;
            if (!committedClan) {
                if (outcome === "missing") showToast("That clan no longer exists.");
                else if (outcome === "handled") showToast("That player is no longer in the clan.");
                else showToast("You can't remove that player.");
                await loadClanData(true);
                renderClanView();
                return;
            }
            dbg(`Clan kick: ${userId} removed, msgLen=${(message ?? "").length}`);
            myClan = sanitizeClanDoc(committedClan);
            clanDirectory = committedDirectory;

            // one-time notice picked up + cleared by the kicked player's HUD
            const notice = {
                type: "kicked",
                clanName: myClan.name,
                message: (message ?? "").slice(0, 200),
                at: new Date().toISOString(),
            };
            await writeClanNotice(fb, userId, notice);

            renderClanView();
        } catch (e) {
            pushError(e, "kickMember");
            console.error("[RG HUD] Kick failed:", e);
            showToast("Couldn't kick member (see console).");
        }
    }

    let clanNoticeTimer = null;
    function scheduleClanNoticeCheck(delayMs = 0) {
        if (clanNoticeTimer) clearTimeout(clanNoticeTimer);
        clanNoticeTimer = setTimeout(() => {
            clanNoticeTimer = null;
            checkClanNotices();
        }, delayMs);
    }

    // Show a clan notice once, then clear it.
    async function checkClanNotices() {
        const fb = await initFirebase();
        if (!fb) return;
        const uid = myUserId();
        if (!uid) return;
        try {
            const ref = fb.doc(fb.db, "clan_notices", uid);
            const snap = await fb.getDoc(ref);
            if (snap.exists()) {
                const n = snap.data();
                let handled = false;
                if (n.type === "kicked") {
                    const extra = n.message ? `  Message: "${n.message}"` : "";
                    await showDialog({
                        message: `You were removed from clan "${n.clanName}".${extra}`,
                        okLabel: "OK",
                        cancelLabel: "Dismiss",
                    });
                    handled = true;
                } else if (n.type === "admin_disbanded") {
                    const extra = n.message ? `  Message: "${n.message}"` : "";
                    await showDialog({
                        message: `An ATLAS admin disbanded clan "${n.clanName}".${extra}`,
                        okLabel: "OK",
                        cancelLabel: "Close",
                    });
                    handled = true;
                }
                if (handled) {
                    await atlasDeleteDoc(fb, "acknowledge clan notice", ref);
                }
                else dbgWarn(`Unknown clan notice type kept for later: ${String(n.type || "missing")}`);
            }
        } catch (e) {
            // notices are best-effort, don't spam the user
            dbg("checkClanNotices failed (non-fatal): " + getErrMsg(e));
        }
    }

    // ---------- Role management ----------
    // leader > coleader > elder > member. Rules also check officer on writes.

    const ROLE_RANK = { leader: 3, coleader: 2, elder: 1, member: 0 };

    // can `actorRole` set `targetCurrentRole` to `newRole`?
    function canSetRole(actorRole, targetCurrentRole, newRole) {
        const a = ROLE_RANK[actorRole] ?? -1;
        if (!rolePerm(actorRole, "roleChange")) return false;
        // can't touch someone at/above your own rank
        if ((ROLE_RANK[targetCurrentRole] ?? 0) >= a) return false;
        // can't promote someone to at/above your own rank
        if ((ROLE_RANK[newRole] ?? 0) >= a) return false;
        // leader can only be assigned via transferLeadership
        if (newRole === "leader") return false;
        return true;
    }

    async function setMemberRole(userId, newRole) {
        const fb = await initFirebase();
        if (!fb || !myClan) return;
        const myUid = myUserId();
        const me = clanMembers(myClan).find(m => m.userId === myUid);
        const target = clanMembers(myClan).find(m => m.userId === userId);
        if (!me || !target) return;

        // frozen by default during events, role changes muddy the contribution audit
        if (!eventPerm("allowRoleChange")) {
            showToast("Role changes are locked during this event.");
            return;
        }

        if (!canSetRole(me.role, target.role, newRole)) {
            showToast("You can't change that member's role.");
            return;
        }

        try {
            const clanId = myClan.id;
            const clanRef = fb.doc(fb.db, "clans", clanId);
            const useReservations = clanReservationsEnabled();
            const membershipRef = useReservations
                ? fb.doc(fb.db, "clan_memberships", userId)
                : null;
            let committedClan = null;
            let oldRole = target.role;
            const ran = await runAtlasTransaction(fb, "change clan role", async tx => {
                committedClan = null;
                const clanSnap = await tx.get(clanRef);
                if (useReservations) await tx.get(membershipRef);
                if (!clanSnap.exists()) return;
                const liveClan = clanSnap.data();
                const actor = clanMembers(liveClan).find(member =>
                    member.userId === myUid
                );
                const liveTarget = clanMembers(liveClan).find(member =>
                    member.userId === userId
                );
                if (!actor
                    || !liveTarget
                    || !canSetRole(actor.role, liveTarget.role, newRole)) {
                    return;
                }
                oldRole = liveTarget.role;
                const members = clanMembers(liveClan).map(member =>
                    member.userId === userId
                        ? { ...member, role: newRole }
                        : member
                );
                const membersField = clanMembersField(liveClan, members);
                tx.set(clanRef, {
                    ...membersField,
                    versionNum: SCRIPT_VERSION_NUM,
                }, { merge: true });
                if (useReservations) {
                    tx.set(
                        membershipRef,
                        clanMembershipRecord(
                            clanId,
                            newRole,
                            clanMemberDeviceIds(liveClan, userId)
                        )
                    );
                }
                committedClan = {
                    ...liveClan,
                    id: clanId,
                    ...membersField,
                };
            });
            if (!ran) return;
            if (!committedClan) {
                showToast("That role could not be changed.");
                return;
            }
            dbg(`Clan role change: ${userId} ${oldRole} -> ${newRole}`);
            myClan = sanitizeClanDoc(committedClan);
            renderClanView();
        } catch (e) {
            pushError(e, "setMemberRole");
            console.error("[RG HUD] Set role failed:", e);
            showToast("Couldn't change role (see console).");
        }
    }

    async function editClan(newName, newTag) {
        const fb = await initFirebase();
        if (!fb || !myClan) return;
        if (!rolePerm(myClanRole(), "editClanInfo")) return;

        // frozen during events so leaderboards don't see mid-event rebrands
        if (!eventPerm("allowRenameClan")) {
            showToast("Clan renames are locked during this event.");
            return;
        }

        const nameClash = clanDirectory.some(c =>
            c.id !== myClan.id
            && normalizeClanName(c.name) === normalizeClanName(newName)
        );
        const tagClash = clanDirectory.some(c =>
            c.id !== myClan.id
            && sanitizeClanTag(c.tag) === sanitizeClanTag(newTag)
        );
        if (nameClash) { showToast("A clan with that name already exists."); return; }
        if (tagClash) { showToast("That tag is already taken."); return; }

        try {
            const clanId = myClan.id;
            const actorUid = myUserId();
            const clanRef = fb.doc(fb.db, "clans", clanId);
            const useReservations = clanReservationsEnabled();
            const directoryRef = clanDirectoryDocRef(fb, clanId);
            let outcome = "updated";
            let committedClan = null;
            let committedDirectory = null;
            const ran = await runAtlasTransaction(fb, "edit clan", async tx => {
                outcome = "updated";
                committedClan = null;
                committedDirectory = null;
                const directorySnap = !useReservations
                    ? await tx.get(directoryRef)
                    : null;
                const clanSnap = await tx.get(clanRef);
                if (!clanSnap.exists()) {
                    outcome = "missing";
                    return;
                }
                const liveClan = clanSnap.data();
                const actor = clanMembers(liveClan).find(member =>
                    member.userId === actorUid
                );
                if (!actor || !rolePerm(actor.role, "editClanInfo")) {
                    outcome = "forbidden";
                    return;
                }
                const liveDirectory = directorySnap?.exists()
                    ? (directorySnap.data().clans ?? [])
                    : [];
                if (!useReservations && liveDirectory.some(entry =>
                    entry?.id !== clanId
                    && normalizeClanName(entry?.name) === normalizeClanName(newName)
                )) {
                    outcome = "name-taken";
                    return;
                }
                if (!useReservations && liveDirectory.some(entry =>
                    entry?.id !== clanId
                    && sanitizeClanTag(entry?.tag) === sanitizeClanTag(newTag)
                )) {
                    outcome = "tag-taken";
                    return;
                }

                let oldNameRef = null;
                let newNameRef = null;
                let oldTagRef = null;
                let newTagRef = null;
                if (useReservations) {
                    const oldNameKey = await clanNameReservationId(liveClan.name);
                    const newNameKey = await clanNameReservationId(newName);
                    oldNameRef = fb.doc(fb.db, "clan_name_keys", oldNameKey);
                    newNameRef = fb.doc(fb.db, "clan_name_keys", newNameKey);
                    oldTagRef = fb.doc(
                        fb.db,
                        "clan_tag_keys",
                        sanitizeClanTag(liveClan.tag)
                    );
                    newTagRef = fb.doc(
                        fb.db,
                        "clan_tag_keys",
                        sanitizeClanTag(newTag)
                    );
                    const newNameSnap = await tx.get(newNameRef);
                    const newTagSnap = await tx.get(newTagRef);
                    if (newNameSnap.exists()
                        && newNameSnap.data().clanId !== clanId) {
                        outcome = "name-taken";
                        return;
                    }
                    if (newTagSnap.exists()
                        && newTagSnap.data().clanId !== clanId) {
                        outcome = "tag-taken";
                        return;
                    }
                }

                committedClan = {
                    ...liveClan,
                    id: clanId,
                    name: newName,
                    tag: sanitizeClanTag(newTag),
                    ...(useReservations ? {
                        nameKey: newNameRef.id,
                        tagKey: newTagRef.id,
                        normalizedName: normalizeClanName(newName),
                    } : {}),
                };
                const entry = clanDirectoryEntry(clanId, committedClan);
                committedDirectory = putClanInDirectory(
                    useReservations ? clanDirectory : liveDirectory,
                    entry
                );
                tx.set(clanRef, {
                    name: newName,
                    tag: sanitizeClanTag(newTag),
                    versionNum: SCRIPT_VERSION_NUM,
                    ...(useReservations ? {
                        nameKey: newNameRef.id,
                        tagKey: newTagRef.id,
                        normalizedName: normalizeClanName(newName),
                    } : {}),
                }, { merge: true });
                if (useReservations) {
                    tx.set(directoryRef, entry);
                    if (oldNameRef.path !== newNameRef.path) tx.delete(oldNameRef);
                    if (oldTagRef.path !== newTagRef.path) tx.delete(oldTagRef);
                    tx.set(newNameRef, {
                        clanId,
                        name: newName,
                        normalizedName: normalizeClanName(newName),
                    });
                    tx.set(newTagRef, {
                        clanId,
                        tag: sanitizeClanTag(newTag),
                    });
                } else {
                    tx.set(directoryRef, { clans: committedDirectory });
                }
            });
            if (!ran) return;
            if (!committedClan) {
                if (outcome === "missing") showToast("That clan no longer exists.");
                else if (outcome === "forbidden") showToast("You can't edit this clan.");
                else if (outcome === "name-taken") showToast("A clan with that name already exists.");
                else if (outcome === "tag-taken") showToast("That tag is already taken.");
                return;
            }
            dbg(`Clan edited: name="${newName}" tag="${newTag}"`);
            myClan = sanitizeClanDoc(committedClan);
            clanDirectory = committedDirectory;
            showToast("Clan updated! Tag refreshes on members' next match.");
            renderClanView();
        } catch (e) {
            pushError(e, "editClan");
            console.error("[RG HUD] Edit clan failed:", e);
            showToast("Couldn't update clan (see console).");
        }
    }

    function showEditClanForm() {
        const view = document.getElementById("rgClanView");
        view.innerHTML = `
            <b>Edit Clan</b>
            <div style="margin-top:8px;">
                <input type="text" id="rgEditName" maxlength="24" value="${escapeHtml(myClan.name ?? "")}"
                    style="width:100%;box-sizing:border-box;background:#10181f;border:1px solid #00bfff88;border-radius:6px;color:#d7f3ff;padding:6px 8px;font-size:13px;margin-bottom:6px;user-select:text;">
                <input type="text" id="rgEditTag" maxlength="4" value="${escapeHtml(myClan.tag ?? "")}"
                    style="width:100%;box-sizing:border-box;background:#10181f;border:1px solid #00bfff88;border-radius:6px;color:#d7f3ff;padding:6px 8px;font-size:13px;user-select:text;text-transform:uppercase;"
                    oninput="this.value=this.value.toUpperCase().replace(/[^A-Z]/g,'').slice(0,4);">
                <div id="rgEditErr" style="color:#ff6b6b;font-size:11px;min-height:14px;margin:4px 0;"></div>
                <div style="display:flex;gap:6px;">
                    <button id="rgEditGo" class="rgBtn" style="flex:1;">Save</button>
                    <button id="rgEditCancel" class="rgBtn" style="flex:1;">Cancel</button>
                </div>
            </div>`;

        probeInput(document.getElementById("rgEditName"), "rgEditName");
        probeInput(document.getElementById("rgEditTag"), "rgEditTag");
        const errEl = document.getElementById("rgEditErr");
        document.getElementById("rgEditGo").onclick = () => {
            const name = document.getElementById("rgEditName").value.trim();
            const tag = sanitizeClanTag(document.getElementById("rgEditTag").value);
            if (name.length === 0 || name.length > 24) { errEl.textContent = "Name must be 1-24 characters."; return; }
            if (tag.length < 2 || tag.length > 4) { errEl.textContent = "Tag: 2-4 letters, no numbers or symbols."; return; }
            if (containsProfanity(name) || containsEmoji(name)) { errEl.textContent = "That name isn't allowed."; return; }
            if (containsProfanity(tag) || containsEmoji(tag)) { errEl.textContent = "That tag isn't allowed."; return; }
            editClan(name, tag);
        };
        document.getElementById("rgEditCancel").onclick = renderClanView;
    }

    function showLineupPicker() {
        const view = document.getElementById("rgClanView");
        if (!view || !myClan) return;
        const members = clanMembers(myClan);
        const size = startingLineupSize();
        const selected = new Set(startingLineupUids(myClan));
        const rowsHtml = members.map(m => `
            <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;background:${selected.has(m.userId) ? "#0a2038" : "transparent"};" data-uid="${escapeHtml(m.userId)}">
                <input type="checkbox" class="rgLineupCheck" data-uid="${escapeHtml(m.userId)}" ${selected.has(m.userId) ? "checked" : ""}>
                <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(m.name)}</span>
                <span style="opacity:.6;font-size:10px;text-transform:uppercase;">${m.role}</span>
            </label>`).join("");

        view.innerHTML = `
            <b>Starting ${size} for this event</b>
            <div style="font-size:11px;opacity:.75;margin:4px 0 8px;">
                Check exactly ${size}. Unchecked members sit on the bench and don't score.
            </div>
            <div id="rgLineupList" style="display:flex;flex-direction:column;gap:2px;max-height:260px;overflow-y:auto;">
                ${rowsHtml}
            </div>
            <div id="rgLineupErr" style="color:#ff6b6b;font-size:11px;min-height:14px;margin:4px 0;"></div>
            <div style="display:flex;gap:6px;">
                <button id="rgLineupSave" class="rgBtn" style="flex:1;">Save</button>
                <button id="rgLineupCancel" class="rgBtn" style="flex:1;">Cancel</button>
            </div>`;

        const err = document.getElementById("rgLineupErr");
        const readSelected = () => Array.from(document.querySelectorAll(".rgLineupCheck"))
            .filter(cb => cb.checked).map(cb => cb.dataset.uid);

        // Cap checkboxes at `size`. Extra clicks nudge the user with the error.
        document.getElementById("rgLineupList").addEventListener("change", (e) => {
            if (!e.target.classList.contains("rgLineupCheck")) return;
            const picks = readSelected();
            if (picks.length > size) {
                e.target.checked = false;
                err.textContent = `Only ${size} starters allowed. Uncheck someone else first.`;
                return;
            }
            err.textContent = "";
            // Restripe row highlight
            for (const label of document.querySelectorAll("[data-uid]")) {
                const cb = label.querySelector("input");
                if (!cb) continue;
                label.style.background = cb.checked ? "#0a2038" : "transparent";
            }
        });

        document.getElementById("rgLineupSave").onclick = async () => {
            const picks = readSelected();
            if (picks.length !== size) {
                err.textContent = `Pick exactly ${size} (currently ${picks.length}).`;
                return;
            }
            await saveStartingLineup(picks);
            renderClanView();
        };
        document.getElementById("rgLineupCancel").onclick = renderClanView;
    }

    async function saveStartingLineup(uids) {
        if (!myClan) return;
        const fb = await initFirebase();
        if (!fb) return;
        // Client-side belt-and-suspenders: role + phase already checked
        // before the picker opens, but re-check in case the event flipped
        // to active between opening and saving.
        const myRole = myClanRole();
        if (myRole !== "leader" && myRole !== "co-leader") return;
        if (eventPhase() === "active" && !eventPerm("allowBenchSwapDuringEvent")) {
            showToast("Lineup is locked during this event.");
            return;
        }
        try {
            const clanRef = fb.doc(fb.db, "clans", myClan.id);
            await atlasSetDoc(fb, "clans", clanRef, { startingLineup: uids }, { merge: true });
            myClan = { ...myClan, startingLineup: uids };
            showToast("Starting lineup saved");
        } catch (e) {
            dbg("saveStartingLineup failed: " + getErrMsg(e));
            showToast("Couldn't save lineup — try again");
        }
    }

    async function transferLeadership(userId) {
        const fb = await initFirebase();
        if (!fb || !myClan) return;
        const myUid = myUserId();
        if (myClan.leaderId !== myUid) return;
        if (!rolePerm(myClanRole(), "transfer")) {
            showToast("Leadership transfers are currently disabled.");
            return;
        }

        if (!eventPerm("allowTransfer")) {
            showToast("Leadership transfers are locked during this event.");
            return;
        }

        try {
            const clanId = myClan.id;
            const clanRef = fb.doc(fb.db, "clans", clanId);
            const useReservations = clanReservationsEnabled();
            const directoryRef = clanDirectoryDocRef(fb, clanId);
            const oldLeaderRef = useReservations
                ? fb.doc(fb.db, "clan_memberships", myUid)
                : null;
            const newLeaderRef = useReservations
                ? fb.doc(fb.db, "clan_memberships", userId)
                : null;
            let outcome = "transferred";
            let committedClan = null;
            let committedDirectory = null;
            const ran = await runAtlasTransaction(fb, "transfer clan leadership", async tx => {
                outcome = "transferred";
                committedClan = null;
                committedDirectory = null;
                const directorySnap = !useReservations
                    ? await tx.get(directoryRef)
                    : null;
                const clanSnap = await tx.get(clanRef);
                if (useReservations) {
                    await tx.get(oldLeaderRef);
                    await tx.get(newLeaderRef);
                }
                if (!clanSnap.exists()) {
                    outcome = "missing";
                    return;
                }
                const liveClan = clanSnap.data();
                const actor = clanMembers(liveClan).find(member =>
                    member.userId === myUid
                );
                const target = clanMembers(liveClan).find(member =>
                    member.userId === userId
                );
                if (liveClan.leaderId !== myUid
                    || !actor
                    || !target
                    || !rolePerm(actor.role, "transfer")) {
                    outcome = "forbidden";
                    return;
                }
                const members = clanMembers(liveClan).map(member => {
                    if (member.userId === userId) return { ...member, role: "leader" };
                    if (member.userId === myUid) return { ...member, role: "coleader" };
                    return member;
                });
                const membersField = clanMembersField(liveClan, members);
                const newLeaderDevices = clanMemberDeviceIds(liveClan, userId);
                if (useReservations && !newLeaderDevices.length) {
                    outcome = "target-device-missing";
                    return;
                }
                committedClan = {
                    ...liveClan,
                    id: clanId,
                    ...membersField,
                    leaderId: userId,
                    ...(useReservations && newLeaderDevices[0]
                        ? { deviceId: newLeaderDevices[0] }
                        : {}),
                };
                const entry = clanDirectoryEntry(clanId, committedClan);
                committedDirectory = putClanInDirectory(
                    useReservations
                        ? clanDirectory
                        : (directorySnap?.exists()
                            ? (directorySnap.data().clans ?? [])
                            : []),
                    entry
                );
                tx.set(clanRef, {
                    ...membersField,
                    leaderId: userId,
                    versionNum: SCRIPT_VERSION_NUM,
                    ...(useReservations && newLeaderDevices[0]
                        ? { deviceId: newLeaderDevices[0] }
                        : {}),
                }, { merge: true });
                if (useReservations) {
                    tx.set(directoryRef, entry);
                    tx.set(
                        oldLeaderRef,
                        clanMembershipRecord(
                            clanId,
                            "coleader",
                            clanMemberDeviceIds(liveClan, myUid)
                        )
                    );
                    tx.set(
                        newLeaderRef,
                        clanMembershipRecord(
                            clanId,
                            "leader",
                            newLeaderDevices
                        )
                    );
                } else {
                    tx.set(directoryRef, { clans: committedDirectory });
                }
            });
            if (!ran) return;
            if (!committedClan) {
                if (outcome === "missing") {
                    showToast("That clan no longer exists.");
                } else if (outcome === "target-device-missing") {
                    showToast("That player needs to open the latest ATLAS before becoming leader.");
                } else {
                    showToast("Leadership could not be transferred.");
                }
                return;
            }
            dbg(`Clan leadership transferred to ${userId}`);
            myClan = sanitizeClanDoc(committedClan);
            clanDirectory = committedDirectory;
            renderClanView();
        } catch (e) {
            pushError(e, "transferLeadership");
            console.error("[RG HUD] Transfer leadership failed:", e);
            showToast("Couldn't transfer leadership (see console).");
        }
    }


    // ---------- Clan tag styling ----------
    // leader owns clan.tagStyle. members opt in via localStorage so the clan
    // doc doesn't balloon. getClanTagPrefix() returns TMP markup for Apply.

    const CLAN_TAG_OPTIN_KEY = "rgHudUseClanTag";
    const CLAN_TAG_POSITION_KEY = "rgHudClanTagPosition"; // "name" | "title"

    function useClanTagPref() {
        try { return localStorage.getItem(CLAN_TAG_OPTIN_KEY) === "1"; } catch { return false; }
    }
    function setUseClanTagPref(on) {
        try { localStorage.setItem(CLAN_TAG_OPTIN_KEY, on ? "1" : "0"); } catch {}
    }
    function clanTagPositionPref() {
        try { return localStorage.getItem(CLAN_TAG_POSITION_KEY) === "title" ? "title" : "name"; } catch { return "name"; }
    }
    function setClanTagPositionPref(pos) {
        try { localStorage.setItem(CLAN_TAG_POSITION_KEY, pos === "title" ? "title" : "name"); } catch {}
    }

    function _interpHex(a, b, t) {
        const ar = parseInt(a.slice(1,3),16), ag = parseInt(a.slice(3,5),16), ab_ = parseInt(a.slice(5,7),16);
        const br = parseInt(b.slice(1,3),16), bg = parseInt(b.slice(3,5),16), bb = parseInt(b.slice(5,7),16);
        const r = Math.round(ar + (br-ar)*t), g = Math.round(ag + (bg-ag)*t), bl = Math.round(ab_ + (bb-ab_)*t);
        return '#' + r.toString(16).padStart(2,'0') + g.toString(16).padStart(2,'0') + bl.toString(16).padStart(2,'0');
    }

    // same math Name Forge uses so tag/name gradients look the same
    function _sampleStops(stops, t) {
        if (!stops || stops.length === 0) return "#ffffff";
        if (stops.length === 1) return stops[0];
        const scaled = t * (stops.length - 1);
        const i = Math.min(Math.floor(scaled), stops.length - 2);
        return _interpHex(stops[i], stops[i + 1], scaled - i);
    }

    // mirrors Name Forge palettes
    const CLAN_TAG_PALETTES = [
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
    function _tagStops(st) {
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
    function stripClanTagPrefix(raw, clanTag) {
        const tag = String(clanTag ?? "").trim();
        if (!raw || !tag) return raw || "";
        const anyTags = "(?:<[^>]*>)*";
        const escaped = [...tag.toUpperCase()].map(ch => ch.replace(/[\\^$.*+?()[\]|]/g, "\\$&"));
        const letters = escaped.map(ch => ch + anyTags).join("");
        const re = new RegExp("^" + anyTags + "\\[" + anyTags + letters + "\\]" + anyTags + "\\s*", "i");
        return raw.replace(re, "");
    }

    function stripLeadingClanTagMarkup(raw) {
        return stripClanTagPrefix(raw, myClan?.tag);
    }

    function getClanTagPrefix() {
        if (!myClan || !myClan.tag || !useClanTagPref()) return "";
        const tag = String(myClan.tag).trim();
        if (!tag) return "";
        const st = myClan.tagStyle || {};
        const tagChars = [...tag];
        const mode = st.mode || (st.color ? "solid" : "none");
        const stops = mode === "gradient" ? _tagStops(st) : null;
        const waveOn = !!st.waveOn;
        const waveAmp = Math.max(0, Math.min(45, st.waveAmp ?? 8));
        const rotateDeg = Math.max(-45, Math.min(45, st.rotateDeg ?? 0));
        const bracketColor = /^#[0-9a-fA-F]{6}$/.test(st.bracketColor || "") ? st.bracketColor.toUpperCase() : null;

        // when bracketColor is set, gi runs over letters only so the gradient
        // distributes cleanly inside the brackets
        function emitChar(ch, gi, giMax, forceColor, waveIdx) {
            let piece = "";
            if (waveOn) piece += "<rotate=" + (waveIdx % 2 === 0 ? waveAmp : -waveAmp) + ">";
            if (forceColor) {
                piece += "<" + forceColor + ">";
            } else if (stops) {
                const t = giMax === 0 ? 0 : gi / giMax;
                piece += "<" + _sampleStops(stops, t).toUpperCase() + ">";
            } else if (mode === "solid" && /^#[0-9a-fA-F]{6}$/.test(st.color || "")) {
                // must emit every letter, bracket color tag persists in TMP
                // until changed. was gated on waveOn before which broke solid+bracket.
                piece += "<" + st.color.toUpperCase() + ">";
            }
            return piece + ch;
        }

        let out = "";
        if (!waveOn && rotateDeg !== 0) out += "<rotate=" + rotateDeg + ">";

        // fast path: solid, no wave, no bracket color -> one wrap
        if (mode === "solid" && /^#[0-9a-fA-F]{6}$/.test(st.color || "") && !waveOn && !bracketColor) {
            out += "<" + st.color.toUpperCase() + ">[" + tag + "]";
        } else {
            let wi = 0;
            out += emitChar("[", 0, Math.max(0, tagChars.length - 1), bracketColor, wi++);
            for (let i = 0; i < tagChars.length; i++) {
                const gi = bracketColor ? i : i + 1;
                const giMax = bracketColor ? Math.max(0, tagChars.length - 1) : tagChars.length + 1;
                out += emitChar(tagChars[i], gi, giMax, null, wi++);
            }
            out += emitChar("]", Math.max(0, tagChars.length - 1),
                             Math.max(0, tagChars.length - 1), bracketColor, wi++);
            if (waveOn) out += "<rotate=0>";
        }

        if (!waveOn && rotateDeg !== 0) out += "<rotate=0>";
        if (st.italic) out = "<i>" + out + "</i>";
        if (st.bold) out = "<b>" + out + "</b>";
        return out + " ";
    }

    async function leaveClan() {
        const fb = await initFirebase();
        if (!fb || !myClan) return;
        const uid = myUserId();

        // Force-refresh event config so a stale in-memory cache can't lock
        // leave when the event has actually ended.
        await loadEventConfig(fb, true);

        // leader path handled below (disband/transfer)
        if (!eventPerm("allowLeave") && myClan.leaderId !== uid) {
            dbg(`leaveClan blocked: phase=${eventPhase()} allowLeave=${eventConfig?.perms?.allowLeave} endTime=${eventConfig?.endTime} now=${Date.now()}`);
            showToast("Can't leave during an active event -- ask leader to kick.");
            return;
        }

        try {
            const clanId = myClan.id;
            const clanRef = fb.doc(fb.db, "clans", clanId);
            const useReservations = clanReservationsEnabled();
            const directoryRef = clanDirectoryDocRef(fb, clanId);
            const membershipRef = useReservations
                ? fb.doc(fb.db, "clan_memberships", uid)
                : null;
            let outcome = "left";
            let committedDirectory = null;
            const ran = await runAtlasTransaction(fb, "leave clan", async tx => {
                outcome = "left";
                committedDirectory = null;
                const directorySnap = !useReservations
                    ? await tx.get(directoryRef)
                    : null;
                const clanSnap = await tx.get(clanRef);
                if (!clanSnap.exists()) {
                    outcome = "missing";
                    return;
                }
                const liveClan = clanSnap.data();
                const liveMembers = clanMembers(liveClan);
                const liveMemberIds = Array.isArray(liveClan.memberIds) ? liveClan.memberIds : [];
                const member = liveMembers.find(candidate => candidate.userId === uid);
                // members can drift out of sync with memberIds. Treat the
                // uid still being on memberIds as "yes, still in the clan"
                // so leave doesn't silently no-op.
                const stuckInMemberIds = !member && liveMemberIds.includes(uid);
                if (!member && !stuckInMemberIds) {
                    outcome = "handled";
                    return;
                }
                const isLeader = liveClan.leaderId === uid;
                const isSoloLeader = isLeader && liveMembers.length === 1;
                const deviceIds = clanMemberDeviceIds(liveClan, uid);
                // Just scrubbing a stale uid — don't block on event locks.
                if (stuckInMemberIds && !isLeader && !eventPerm("allowLeave")) {
                    dbg(`leaveClan tx: repairing memberIds desync for ${uid}`);
                } else if (!isLeader && !eventPerm("allowLeave")) {
                    dbg(`leaveClan tx blocked: phase=${eventPhase()} allowLeave=${eventConfig?.perms?.allowLeave} endTime=${eventConfig?.endTime} now=${Date.now()}`);
                    outcome = "leave-locked";
                    return;
                }
                if (isSoloLeader && !eventPerm("allowDisband")) {
                    outcome = "disband-locked";
                    return;
                }
                if (isSoloLeader && !rolePerm(member.role, "disband")) {
                    outcome = "disband-disabled";
                    return;
                }
                if (isLeader && liveMembers.length > 1) {
                    outcome = "transfer-first";
                    return;
                }
                const liveDirectory = directorySnap?.exists()
                    ? (directorySnap.data().clans ?? [])
                    : [];
                if (isLeader) {
                    outcome = "disbanded";
                    committedDirectory = removeClanFromDirectory(
                        useReservations ? clanDirectory : liveDirectory,
                        clanId
                    );
                    if (useReservations) {
                        const nameKey = await clanNameReservationId(liveClan.name);
                        tx.delete(fb.doc(fb.db, "clan_name_keys", nameKey));
                        tx.delete(fb.doc(
                            fb.db,
                            "clan_tag_keys",
                            sanitizeClanTag(liveClan.tag)
                        ));
                        tx.delete(directoryRef);
                    }
                    tx.delete(clanRef);
                } else {
                    const members = liveMembers.filter(candidate => candidate.userId !== uid);
                    const membersField = clanMembersField(liveClan, members);
                    // Filter the live memberIds/deviceIds instead of rebuilding
                    // from the members list — if members was desynced, the
                    // old code wiped everyone else's uid too.
                    const uidDeviceIds = clanMemberDeviceIds(liveClan, uid);
                    const nextMemberIds = liveMemberIds.filter(id => id !== uid);
                    const liveDeviceIds = Array.isArray(liveClan.deviceIds) ? liveClan.deviceIds : [];
                    const nextDeviceIds = liveDeviceIds.filter(d => !uidDeviceIds.includes(d));
                    const reservationFields = useReservations
                        ? {
                            memberIds: nextMemberIds,
                            deviceIds: nextDeviceIds,
                        }
                        : {};
                    const nextClan = {
                        ...liveClan,
                        id: clanId,
                        ...membersField,
                        ...reservationFields,
                    };
                    const entry = clanDirectoryEntry(clanId, nextClan);
                    committedDirectory = putClanInDirectory(
                        useReservations ? clanDirectory : liveDirectory,
                        entry
                    );
                    tx.set(clanRef, {
                        ...membersField,
                        ...reservationFields,
                    }, { merge: true });
                    if (useReservations) tx.set(directoryRef, entry);
                }
                if (useReservations) {
                    tx.delete(membershipRef);
                    for (const deviceId of deviceIds) {
                        tx.delete(fb.doc(fb.db, "clan_devices", deviceId));
                    }
                } else {
                    tx.set(directoryRef, { clans: committedDirectory });
                }
            });
            if (!ran) return;
            if (!committedDirectory) {
                if (outcome === "leave-locked") showToast("Can't leave during an active event -- ask leader to kick.");
                else if (outcome === "disband-locked") showToast("Disbanding is locked during this event.");
                else if (outcome === "disband-disabled") showToast("Disbanding is currently disabled.");
                else if (outcome === "transfer-first") showToast("Transfer leadership or remove others before leaving.");
                else showToast("You are no longer in that clan.");
                await loadClanData(true);
                renderClanView();
                return;
            }
            dbg(outcome === "disbanded"
                ? `Clan disbanded (solo leader): ${clanId}`
                : `Clan left: ${clanId}`);
            detachClanListener();
            myClan = null;
            clanDirectory = committedDirectory;
            renderClanView();
        } catch (e) {
            pushError(e, "leaveClan");
            console.error("[RG HUD] Leave clan failed:", e);
            // local state is already partially wiped above, surface it
            showToast("Couldn't leave clan — refresh the page to retry.");
        }
    }

    // ---------- Clan view rendering ----------

    async function renderClanView() {
        try {
            const view = document.getElementById("rgClanView");
            if (!view) return;

            if (!lastKnownPlayerData) {
                view.innerHTML = `<div style="opacity:.8;">Log in or play a match first to use clans.</div>`;
                return;
            }

            view.innerHTML = `<div style="opacity:.8;">Loading clans...</div>`;
            // Warm reopen: reuse in-memory clan + directory when already loaded
            // for this account. Live clan doc updates come from the listener;
            // directory refreshes stay throttled. Force only on first load /
            // account switch (loadClanData handles that).
            const warmReopen = clanLoaded && clanLoadedForAccount === myUserId();
            await loadClanData(!warmReopen);
            const fb = await initFirebase();
            if (fb) await loadEventConfig(fb);
            if (fb) await loadClanRolePerms(fb);
            if (warmReopen && fb) await refreshDirectoryThrottled(fb);

            renderClanViewFromMemory();
            if (myClan) attachClanListener();
        } catch (e) {
            dbg("renderClanView threw: " + getErrMsg(e));
        }
    }

    // zero-read repaint from in-memory myClan
    function renderClanViewFromMemory() {
        const view = document.getElementById("rgClanView");
        if (!view) return;
        myClan ? renderMyClan(view) : renderNoClan(view);
    }

    // refresh clan tab in place if it's open
    function refreshClanViewIfOpen() {
        const view = document.getElementById("rgClanView");
        if (isVisible(view)) {
            renderClanViewFromMemory();
            if (myClan) attachClanListener();
        }
    }

    function renderNoClan(view) {
        const rows = clanDirectory
            .slice()
            .sort((a, b) => (b.totalMMR ?? 0) - (a.totalMMR ?? 0))
            .map((c, i) => `
                <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:3px 0;border-bottom:1px solid #ffffff11;">
                    <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        <span style="color:#ffd700;">#${i + 1}</span>
                        ${c.tag ? `<span style="opacity:.7;">[${escapeHtml(c.tag)}]</span>` : ""}
                        <b>${escapeHtml(c.name)}</b>
                        <span style="opacity:.6;font-size:10px;">(${c.memberCount}/${clanMaxMembers()})</span>
                    </span>
                    <span style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
                        <span style="color:#00ff66;font-size:11px;">${c.totalMMR}</span>
                        <button class="rgBtn rgJoinBtn" data-clan="${escapeHtml(c.id)}" style="padding:2px 6px;font-size:10px;" ${c.memberCount >= clanMaxMembers() ? "disabled" : ""}>Join</button>
                    </span>
                </div>`).join("");

        view.innerHTML = `
            ${eventBannerHtml(null, myUserId())}
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <b>🛡️ Clans</b>
                <button id="rgCreateClanBtn" class="rgBtn" style="padding:3px 8px;font-size:11px;">+ Create</button>
            </div>
            <div style="max-height:200px;overflow-y:auto;">${rows || `<div style="opacity:.7;">No clans yet. Create the first one!</div>`}</div>
        `;

        document.getElementById("rgCreateClanBtn").onclick = showCreateClanForm;
        view.querySelectorAll(".rgJoinBtn").forEach(btn => {
            if (!eventPerm("allowJoin")) {
                btn.disabled = true;
                btn.style.opacity = "0.5";
                btn.style.cursor = "not-allowed";
                btn.title = "Joins locked during event";
                btn.textContent = "Locked (event)";
            } else {
                btn.onclick = () => requestJoin(btn.getAttribute("data-clan"));
            }
        });
    }

    function showCreateClanForm() {
        const view = document.getElementById("rgClanView");
        view.innerHTML = `
            <b>Create a Clan</b>
            <div style="margin-top:8px;">
                <input type="text" id="rgClanName" placeholder="Clan name (max 24)" maxlength="24"
                    style="width:100%;box-sizing:border-box;background:#10181f;border:1px solid #00bfff88;border-radius:6px;color:#d7f3ff;padding:6px 8px;font-size:13px;margin-bottom:6px;user-select:text;">
                <input type="text" id="rgClanTag" placeholder="Tag (2-4 letters, required)" maxlength="4"
                    style="width:100%;box-sizing:border-box;background:#10181f;border:1px solid #00bfff88;border-radius:6px;color:#d7f3ff;padding:6px 8px;font-size:13px;user-select:text;">
                <div id="rgClanErr" style="color:#ff6b6b;font-size:11px;min-height:14px;margin:4px 0;"></div>
                <div style="display:flex;gap:6px;">
                    <button id="rgClanCreateGo" class="rgBtn" style="flex:1;">Create</button>
                    <button id="rgClanCreateCancel" class="rgBtn" style="flex:1;">Cancel</button>
                </div>
            </div>`;

        const nameEl = document.getElementById("rgClanName");
        const tagEl = document.getElementById("rgClanTag");
        const errEl = document.getElementById("rgClanErr");
        probeInput(nameEl, "rgClanName");
        probeInput(tagEl, "rgClanTag");
        [nameEl, tagEl].forEach(el => {
            el.addEventListener("keydown", e => e.stopPropagation(), true);
        });
        // uppercase + letter-only as they type
        tagEl.style.textTransform = "uppercase";
        tagEl.addEventListener("input", () => {
            const clean = sanitizeClanTag(tagEl.value);
            if (tagEl.value !== clean) tagEl.value = clean;
        });

        const createButton = document.getElementById("rgClanCreateGo");
        createButton.onclick = async () => {
            const name = nameEl.value.trim();
            const tag = sanitizeClanTag(tagEl.value);
            if (name.length === 0 || name.length > 24) { errEl.textContent = "Name must be 1-24 characters."; return; }
            if (tag.length < 2 || tag.length > 4) { errEl.textContent = "Tag: 2-4 letters, no numbers or symbols."; return; }
            if (containsProfanity(name) || containsEmoji(name)) { errEl.textContent = "That name isn't allowed."; return; }
            if (containsProfanity(tag) || containsEmoji(tag)) { errEl.textContent = "That tag isn't allowed."; return; }
            if (clanDirectory.some(c => (c.tag ?? "").toLowerCase() === tag.toLowerCase())) {
                errEl.textContent = "That tag is already taken."; return;
            }
            createButton.disabled = true;
            createButton.textContent = "Creating...";
            try {
                await createClan(name, tag);
            } finally {
                if (createButton.isConnected) {
                    createButton.disabled = false;
                    createButton.textContent = "Create";
                }
            }
        };
        document.getElementById("rgClanCreateCancel").onclick = renderClanView;
    }

    function renderMyClan(view) {
        const uid = myUserId();
        const me = clanMembers(myClan).find(m => m.userId === uid);
        const myRole = me?.role ?? "member";
        const rank = [...clanDirectory].sort((a, b) => (b.totalMMR ?? 0) - (a.totalMMR ?? 0))
            .findIndex(c => c.id === myClan.id) + 1;

        // ⋯ menu, per-target rank guards still apply below
        const canManage = rolePerm(myRole, "kick") || rolePerm(myRole, "roleChange");
        // current MMR minus per-member baseline (only during active event)
        const eventActive = eventPhase() === "active";
        const eventBaselines = eventActive ? (clanBaselineForCurrentEvent(myClan) || {}) : {};
        const contribFor = (member) => {
            if (!eventActive) return null;
            const base = eventBaselines[member.userId];
            const mmr = effectiveClanMemberStat(myClan, member).mmr;
            if (base == null || typeof mmr !== "number") return null;
            return mmr - base;
        };

        const benchOn = benchFeatureEnabled();
        const starterSet = benchOn ? new Set(startingLineupUids(myClan)) : null;
        const canEditLineup = benchOn
            && (myRole === "leader" || myRole === "co-leader")
            && (eventPhase() !== "active" || eventPerm("allowBenchSwapDuringEvent"));
        const memberRows = clanMembers(myClan)
            .slice()
            .sort((a, b) => (ROLE_RANK[b.role] ?? 0) - (ROLE_RANK[a.role] ?? 0))
            .map(m => {
                const actable = canManage && m.userId !== uid && m.role !== "leader"
                    && (ROLE_RANK[m.role] ?? 0) < (ROLE_RANK[myRole] ?? 0);
                const isBench = starterSet && m.userId && !starterSet.has(m.userId);
                const stat = effectiveClanMemberStat(myClan, m);
                const contrib = contribFor(m);
                // shows staleness so "+0" vs "last synced 2h ago" is clear
                const ageMs = typeof stat.syncedAt === "number" ? Date.now() - stat.syncedAt : null;
                const ageLabel = ageMs == null ? null
                    : ageMs < 90e3 ? "just now"
                    : ageMs < 3600e3 ? `${Math.round(ageMs / 60e3)}m ago`
                    : ageMs < 86400e3 ? `${Math.round(ageMs / 3600e3)}h ago`
                    : `${Math.round(ageMs / 86400e3)}d ago`;
                const freshnessNote = ageLabel ? `· last synced ${ageLabel}` : "· sync age unknown (teammate needs v12.9+)";
                const stale = ageMs != null && ageMs > 3600e3;
                // green gain, red loss, gray dash = hasn't played this event
                const contribHtml = eventActive
                    ? (contrib == null
                        ? `<span title="Hasn't played during this event yet" style="opacity:.4;font-size:10px;font-family:monospace;">—</span>`
                        : `<span title="Event contribution (current MMR - baseline) ${freshnessNote}" style="color:${contrib >= 0 ? "#00ff66" : "#ff6b6b"};opacity:${stale ? ".45" : "1"};font-size:10px;font-weight:bold;font-family:monospace;">${contrib >= 0 ? "+" : ""}${contrib}</span>`)
                    : "";
                const benchBadge = isBench
                    ? `<span title="Bench for this event — MMR not scored" style="font-size:9px;padding:0 4px;border:1px solid #ff9a3c;border-radius:4px;color:#ff9a3c;">BENCH</span>`
                    : "";
                return `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;gap:6px;${isBench ? "opacity:.75;" : ""}">
                    <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        ${escapeHtml(m.name)}
                        ${typeof stat.mmr === "number" ? `<span style="opacity:.5;font-size:10px;">${stat.mmr}</span>` : ""}
                        ${benchBadge}
                    </span>
                    <span style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
                        ${contribHtml}
                        <span style="opacity:.7;font-size:10px;text-transform:uppercase;">${m.role}</span>
                        ${actable ? `<button class="rgBtn rgManage" data-uid="${escapeHtml(m.userId)}" data-name="${escapeHtml(m.name)}" data-role="${escapeHtml(m.role)}" style="padding:1px 6px;font-size:10px;">⋯</button>` : ""}
                    </span>
                </div>`;
            }).join("");

        let requestsSection = "";
        if (canManageRequests(myRole) && (myClan.joinRequests ?? []).length > 0) {
            const reqRows = myClan.joinRequests.map(r => `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;gap:6px;">
                    <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.name)}</span>
                    <span style="display:flex;gap:4px;flex-shrink:0;">
                        <button class="rgBtn rgApprove" data-uid="${escapeHtml(r.userId)}" style="padding:1px 6px;font-size:10px;">✓</button>
                        <button class="rgBtn rgReject" data-uid="${escapeHtml(r.userId)}" style="padding:1px 6px;font-size:10px;">✗</button>
                    </span>
                </div>`).join("");
            requestsSection = `
                <hr style="border:none;border-top:1px solid #00bfff88;margin:8px 0;">
                <b>Join Requests</b>
                <div>${reqRows}</div>`;
        }

        const isLeader = myClan.leaderId === uid;
        view.innerHTML = `
            ${eventBannerHtml(myClan, uid)}
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <b style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${myClan.tag ? `[${escapeHtml(myClan.tag)}] ` : ""}${escapeHtml(myClan.name)}</b>
                <span style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
                    ${canEditLineup ? `<button id="rgLineupBtn" class="rgBtn" style="padding:1px 6px;font-size:10px;" title="Set starting ${startingLineupSize()}">🪑</button>` : ""}
                    ${rolePerm(myRole, "editClanInfo") ? `<button id="rgEditClan" class="rgBtn" style="padding:1px 6px;font-size:10px;">✏️</button>` : ""}
                    <span style="color:#ffd700;font-size:11px;">Rank #${rank || "-"}</span>
                </span>
            </div>
            <div style="font-size:11px;opacity:.75;margin:2px 0 6px;">
                Total MMR: <span style="color:#00ff66;">${effectiveClanTotalMMR(myClan)}</span>
                &nbsp;•&nbsp; ${clanMembers(myClan).length}/${clanMaxMembers()} members
            </div>
            <div id="rgMembersHeader" style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;padding:2px 0;margin-top:2px;">
                <span id="rgMembersArrow" style="font-size:9px;opacity:.7;width:8px;display:inline-block;">▶</span>
                <b>Members</b>
            </div>
            <div id="rgMembersList" style="display:none;">${memberRows}</div>
            ${requestsSection}
            <div id="rgClanTagPanel" style="margin-top:10px;padding:8px;border:1px solid #00bfff44;border-radius:6px;">
                <div id="rgClanTagHeader" style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;">
                    <span id="rgClanTagArrow" style="font-size:9px;opacity:.7;width:8px;display:inline-block;">▶</span>
                    <span style="font-size:11px;font-weight:bold;color:#00bfff;">CLAN TAG STYLE</span>
                </div>
                <div id="rgClanTagBody" style="display:none;margin-top:6px;"></div>
            </div>
            <button id="rgLeaveClan" class="rgBtn" style="width:100%;margin-top:8px;">Leave Clan</button>
        `;

        if (rolePerm(myRole, "editClanInfo")) {
            const editBtn = document.getElementById("rgEditClan");
            if (editBtn) editBtn.onclick = showEditClanForm;
        }
        if (canEditLineup) {
            const lineupBtn = document.getElementById("rgLineupBtn");
            if (lineupBtn) lineupBtn.onclick = showLineupPicker;
        }

        // collapsed by default to save HUD height
        const mHeader = document.getElementById("rgMembersHeader");
        if (mHeader) {
            mHeader.onclick = () => {
                const list = document.getElementById("rgMembersList");
                const arrow = document.getElementById("rgMembersArrow");
                const open = isVisible(list);
                list.style.display = open ? "none" : "block";
                arrow.textContent = open ? "▶" : "▼";
            };
        }
        // renderClanTagPanel still runs so the preview is ready when opened
        const tHeader = document.getElementById("rgClanTagHeader");
        if (tHeader) {
            tHeader.onclick = () => {
                const body = document.getElementById("rgClanTagBody");
                const arrow = document.getElementById("rgClanTagArrow");
                const open = isVisible(body);
                body.style.display = open ? "none" : "block";
                arrow.textContent = open ? "▶" : "▼";
            };
        }

        view.querySelectorAll(".rgApprove").forEach(b => b.onclick = () => approveRequest(b.getAttribute("data-uid"), true));
        view.querySelectorAll(".rgReject").forEach(b => b.onclick = () => approveRequest(b.getAttribute("data-uid"), false));
        view.querySelectorAll(".rgManage").forEach(b => b.onclick = async () => {
            const tUid = b.getAttribute("data-uid");
            const tName = b.getAttribute("data-name");
            const tRole = b.getAttribute("data-role");
            await showManageMemberMenu(tUid, tName, tRole, myRole, myClan.leaderId === uid);
        });
        renderClanTagPanel();
        // gray out Leave for non-leader members when allowLeave is off
        if (!eventPerm("allowLeave") && myClan && myClan.leaderId !== myUserId()) {
            const lb = document.getElementById("rgLeaveClan");
            if (lb) {
                lb.disabled = true;
                lb.style.opacity = "0.5";
                lb.style.cursor = "not-allowed";
                lb.title = "Locked during active event";
                lb.textContent = "Leave Clan (locked during event)";
            }
        }
                document.getElementById("rgLeaveClan").onclick = async () => {
            const sure = await showDialog({ message: "Leave this clan?", okLabel: "Leave", cancelLabel: "Cancel" });
            if (sure) leaveClan();
        };
    }

    // themed alert/confirm/prompt
    let toastTimeout = null;
    function showToast(msg) {
        createHUD();
        const t = document.getElementById("rgToast");
        if (!t) return;
        t.textContent = msg;
        t.style.opacity = "1";
        t.style.transform = "translateY(0)";
        clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => {
            t.style.opacity = "0";
            t.style.transform = "translateY(8px)";
        }, 2800);
    }

    // confirm -> bool. prompt -> string or null.
    function showDialog({ message, withInput = false, inputPlaceholder = "", okLabel = "OK", cancelLabel = "Cancel" }) {
        return new Promise(resolve => {
            createHUD();
            const previousFocus = document.activeElement;
            let restorePreviousFocus = false;
            try { restorePreviousFocus = !!previousFocus?.matches?.(":focus-visible"); } catch (e) {}
            const dlg = document.getElementById("rgDialog");
            const msgEl = document.getElementById("rgDialogMsg");
            const input = document.getElementById("rgDialogInput");
            const okBtn = document.getElementById("rgDialogOk");
            const cancelBtn = document.getElementById("rgDialogCancel");

            msgEl.textContent = message;
            // preserve line breaks for multi-line dialog messages
            msgEl.style.whiteSpace = "pre-wrap";
            okBtn.textContent = okLabel;
            cancelBtn.textContent = cancelLabel;
            // empty label -> no phantom cancel button on info dialogs
            cancelBtn.style.display = cancelLabel ? "" : "none";
            input.style.display = withInput ? "block" : "none";
            input.value = "";
            input.placeholder = inputPlaceholder;
            dlg.style.display = "flex";
            setTimeout(() => (withInput ? input : okBtn).focus(), 50);
            if (withInput) probeInput(input, "rgDialogInput");

            const close = result => {
                dlg.style.display = "none";
                okBtn.onclick = null;
                cancelBtn.onclick = null;
                resolve(result);
                setTimeout(() => {
                    if (restorePreviousFocus && previousFocus?.isConnected) {
                        previousFocus.focus({ preventScroll: true });
                    }
                }, 0);
            };
            okBtn.onclick = () => close(withInput ? input.value.trim() : true);
            cancelBtn.onclick = () => close(withInput ? null : false);
        });
    }

    // rendered temporarily into the clan view
    async function showManageMemberMenu(userId, name, targetRole, actorRole, actorIsLeader) {
      try {
        const view = document.getElementById("rgClanView");
        if (!view) return;

        const actions = [];
        // any role strictly below the actor that isn't the current one
        const assignable = ["coleader", "elder", "member"].filter(r =>
            r !== targetRole && canSetRole(actorRole, targetRole, r)
        );
        for (const r of assignable) {
            const verb = (ROLE_RANK[r] > ROLE_RANK[targetRole]) ? "Promote to" : "Demote to";
            actions.push({ label: `${verb} ${r}`, run: () => setMemberRole(userId, r) });
        }
        if (actorIsLeader && rolePerm(actorRole, "transfer")) {
            actions.push({ label: "👑 Transfer leadership", danger: true, run: async () => {
                const sure = await showDialog({
                    message: `Make ${name} the clan leader? You'll become co-leader.`,
                    okLabel: "Transfer", cancelLabel: "Cancel",
                });
                if (sure) transferLeadership(userId);
            }});
        }
        if (rolePerm(actorRole, "kick")) actions.push({ label: "❌ Kick from clan", danger: true, run: async () => {
            const sure = await showDialog({ message: `Kick ${name} from the clan?`, okLabel: "Kick", cancelLabel: "Cancel" });
            if (!sure) { renderClanView(); return; }
            const msg = await showDialog({
                message: `Optional message to ${name} (leave blank to skip):`,
                withInput: true, inputPlaceholder: "Message...", okLabel: "Send", cancelLabel: "No message",
            });
            kickMember(userId, msg || "");
        }});

        const btns = actions.map((a, i) =>
            `<button class="rgBtn rgMgAction" data-i="${i}" style="width:100%;margin-bottom:4px;${a.danger ? "border-color:#ff6b6b88;" : ""}">${a.label}</button>`
        ).join("");

        view.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <b>Manage ${escapeHtml(name)}</b>
                <span style="opacity:.6;font-size:10px;text-transform:uppercase;">${targetRole}</span>
            </div>
            ${btns}
            <button id="rgMgBack" class="rgBtn" style="width:100%;margin-top:6px;">Back</button>
        `;

        view.querySelectorAll(".rgMgAction").forEach(btn => {
            btn.onclick = () => actions[parseInt(btn.getAttribute("data-i"))].run();
        });
        document.getElementById("rgMgBack").onclick = renderClanView;
      } catch (e) {
        dbg("showManageMemberMenu threw: " + getErrMsg(e));
      }
    }

    function escapeHtml(s) {
        return String(s ?? "").replace(/[&<>"']/g, c => (
            { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
        ));
    }

    // ---------- Boot ----------

    const wait = setInterval(() => {
        if (document.body) {
            clearInterval(wait);
            createHUD();
            maybeShowUpdateNudge();
            console.log("[RG HUD] loaded and running, waiting for login/matchEnd data...");
        }
    }, 100);

    // watchdog for _inMatch: if the game silently reconnects without emitting
    // matchEnd/LeaveRoom, the HUD stays hidden forever. 10min exceeds any
    // real match so we won't clobber legit state.
    const INMATCH_STALE_MS = 10 * 60 * 1000;
    setInterval(() => {
        if (!_inMatch) return;
        const now = performance.now();
        const initStale = (now - _lastInitLineAt) > INMATCH_STALE_MS;
        const recoveryRecent = _lastRecoverySignalAt > 0
            && (now - _lastRecoverySignalAt) < 60 * 1000;
        if (initStale && recoveryRecent) {
            dbg(`_inMatch watchdog: stale for ${((now - _lastInitLineAt) / 60000).toFixed(1)}m + recent recovery signal -- clearing`);
            _inMatch = false;
            syncPingTracker();
            setAutoVisible(true);
        }
    }, 60 * 1000);

    // Private matches don't fire the recovery signals we key restore on,
    // so the HUD stayed hidden after coming back to the menu. Cheap
    // ticker: if we're not in a match and the HUD is hidden or detached,
    // put it back. Idempotent — no-op when the HUD is already visible.
    setInterval(() => {
        if (_inMatch) return;
        if (!hud) return;
        if (!hud.isConnected || !isVisible(hud)) {
            setAutoVisible(true);
        }
    }, 2000);


    // ==================================================================
    // 🎨 NAME FORGE — rich-text in-game nickname builder.
    // wrapped in an IIFE so helper names (esc, el, ...) don't collide with the HUD.
    // edits the IN-GAME nickname; ✏️ Rename edits the leaderboard name.
    // ==================================================================
    const RGNF = (function () {
      let _rgnfFab = null, _rgnfPanel = null;

  // ---- Constants ----
  const API_URL = 'https://us-central1-rocketball-23c12.cloudfunctions.net/v0304_player/nickname';
  const STORE_KEY_LEGACY = 'rgNameForge.presets.v1';
  const STATE_KEY_LEGACY = 'rgNameForge.lastState.v1';
  // per-account state, legacy key read once as a fallback on upgrade
  let _currentUserId = null;
  let _lastRawNickname = '';
  const stateKey = () => _currentUserId ? ('rgNameForge.state.v5.' + _currentUserId) : STATE_KEY_LEGACY;
  function nameForgePresetKey(userId) {
    return 'rgNameForge.presets.v2.' + (userId || 'anon');
  }
  const presetKey = () => nameForgePresetKey(_currentUserId);
  const folderCollapseKey = () => 'rgNameForge.folderCollapse.v2.' + (_currentUserId || 'anon');
  function nameForgeHistoryKey(userId) {
    return 'rgNameForge.history.v2.' + (userId || 'anon');
  }
  const historyKey = () => nameForgeHistoryKey(_currentUserId);
  // steal receipt. boot-time SetNickname echo can undo a fresh steal, so we
  // re-apply once after boot if the login nickname doesn't match.
  const pendingStealKey = () => 'rgNameForge.pendingSteal.v1.' + (_currentUserId || 'anon');
  const PENDING_STEAL_TTL_MS = 15 * 60 * 1000;
  const FABPOS_KEY = 'rgNameForge.fabPos.v1';
  const PALETTES = [
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
  // sprite atlas from in-game screenshot (0-15, left to right)
  const SPRITES = [
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
  const spriteEmoji = (n) => (SPRITES.find(s => s.n === n) || { e: '☺' }).e;

  // ---- State ----
  const defaultState = () => ({
    name: 'RootedEngineering',
    colorMode: 'gradient',            // 'none' | 'solid' | 'gradient'
    solidColor: '#22d3ee',
    stops: ['#22d3ee', '#e94fff'],    // 2-5 gradient stops
    skipSpaces: true,                 // don't waste tags coloring spaces
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    sizePct: 100,                     // <size=N%>
    rotateDeg: 0,                     // <rotate=N>
    waveOn: false,                    // per-letter alternating rotation
    waveAmp: 12,                      // wave tilt degrees
    markOn: false,
    markColor: '#facc15',
    markAlpha: 64,                    // 0-255 -> hex alpha appended to mark color
    titleOn: false,
    titleText: '',
    titleColorMode: 'solid',          // 'inherit' | 'solid' | 'gradient'
    titleColor: '#94a3b8',
    titleSizePct: 60,
    titleSub: true,                   // wrap title in <sub> for that low-set look
    // title has its own styling now, used to borrow name's stops
    titleStops: ['#ff8fb1', '#a78bfa'],
    titlePaletteKey: null,
    titleBold: false,
    titleItalic: false,
    titleUnderline: false,
    titleStrike: false,
    titleAlpha: 255,                  // 0-255 alpha on titleColor (solid only)
    titleGapLines: 1,                 // blank lines inserted between name/art and title
    // Subtitle mirrors title but sits below it; independent styling.
    subtitleOn: false,
    subtitleText: '',
    subtitleColorMode: 'inherit',     // 'inherit' | 'solid' | 'gradient'
    subtitleColor: '#94a3b8',
    subtitleSizePct: 55,
    subtitleSub: true,
    subtitleStops: ['#ff8fb1', '#a78bfa'],
    subtitlePaletteKey: null,
    subtitleBold: false,
    subtitleItalic: false,
    subtitleUnderline: false,
    subtitleStrike: false,
    subtitleAlpha: 255,
    subtitleGapLines: 0,              // blank lines between title and subtitle
    // alpha on the name's solid color, dims trailing URL text etc
    solidAlpha: 255,
    colorSpans: [],                   // selected-range paints; empty = whole name
    scoredMode: readScoredDefault() || 'default', // 'default' | 'hide' | 'tiny' | 'styled'
    scoredColor: '#22d3ee',
    scoredSizePct: 100,
    rawCode: null,                    // when set: exact current in-game markup, used verbatim
    align: readAlignDefault() || 'left',
  });

  let state = loadJSON(stateKey(), null) || loadJSON(STATE_KEY_LEGACY, defaultState());
  // backfill any new fields if an old state was saved
  state = Object.assign(defaultState(), state);
  if (!Array.isArray(state.colorSpans)) state.colorSpans = [];
  state.align = normalizeForgeAlign(state.align);
  let namePaintSel = { start: 0, end: 0 };
  let previewZoom = 1;
  let refreshForgePreview = () => {};

  function clampPreviewZoom(value) {
    const stepped = Math.round(Number(value) * 20) / 20;
    return Math.max(0.4, Math.min(2.5, stepped));
  }

  function previewNameFontPx(s) {
    const base = 18 * Math.min(Math.max(Number(s?.sizePct) || 100, 10), 300) / 100;
    return Math.max(4, base * previewZoom);
  }

  function setPreviewZoom(next) {
    previewZoom = clampPreviewZoom(next);
    refreshForgePreview();
  }

  // ---- Utilities ----
  // Tampermonkey storage survives a rocketgoal.io site-data wipe.
  // Origin localStorage does not. Read TM first, then localStorage, and
  // write both so a wipe still leaves presets / last name / history.
  function saveJSON(key, val) {
    const raw = JSON.stringify(val);
    try { localStorage.setItem(key, raw); } catch (e) { /* ignore */ }
    try {
      const tm = atlasTmStorage();
      if (tm) tm.set(key, raw);
    } catch (e) { /* ignore */ }
  }

  function loadJSON(key, fallback) {
    try {
      let raw = null;
      try {
        const tm = atlasTmStorage();
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

  // rawCode is the exact in-game TMP markup, while the structured fields are
  // used as soon as somebody touches a Forge control. A short name plus one
  // extra line is still name + title. Art (ASCII, dots, braille) stays in
  // the name so spaces and breaks are not crushed.
  function isAsciiArtText(text) {
    const artMark = /[\\/_#.*:`'"^~+\-|<>()[\]{}=$@%!?]|[·•●○◦∙⋅░▒▓█▄▀▌▐■□▪▫]|[\u2800-\u28FF]|[\u2580-\u25FF]/;
    const isArtLine = (line) => {
      const chars = [...String(line ?? "")].filter((ch) => ch !== " " && ch !== "\t");
      if (chars.length < 2) return false;
      const marks = chars.filter((ch) => artMark.test(ch)).length;
      return marks / chars.length >= 0.5;
    };
    const lines = String(text ?? "")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .split(/\r\n?|\n/)
      .filter((line) => line.trim().length || /[\u2800]/.test(line));
    if (lines.length >= 3) return true;
    if (lines.length >= 2 && lines.filter(isArtLine).length >= 2) return true;
    return lines.some((line) =>
      /[\\/_]{2,}/.test(line)
      || /[.]{3,}/.test(line)
      || /[·•●○◦∙⋅]{2,}/.test(line)
      || /[\u2800-\u28FF]{2,}/.test(line)
      || /[\u2580-\u25FF]{2,}/.test(line)
    );
  }

  function artLineStats(text) {
    const lines = String(text ?? "")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/\r\n/g, "\n")
      .split("\n");
    const visible = (line) => [...String(line)
      .replace(/<color=#00000000>\.*<\/color>/gi, "")
      .replace(/<#00000000>\./gi, "")
      .replace(/<[^>]*>/g, "")
      .replace(/[ \t]+$/g, "")].length;
    return {
      lines,
      height: lines.length,
      width: lines.reduce((max, line) => Math.max(max, visible(line)), 0),
    };
  }

  function artFitSizePct(height, width) {
    // Tight line-height lets more rows fit, so shrink less than a 4-line nameplate.
    const byHeight = height <= 4 ? 100 : Math.round((7 / height) * 100);
    const byWidth = width <= 20 ? 100 : Math.round((20 / width) * 100);
    return Math.max(22, Math.min(100, byHeight, byWidth));
  }

  function artLineHeightPct(height) {
    if (height <= 1) return 100;
    return 100;
  }

  function artMspaceEm(text) {
    if (/[\u2800-\u28FF\u2580-\u25FF]/.test(text)) return "0.72em";
    if (/[#:+]/.test(text) && /[.:]/.test(text) && !/[\\/_]{2,}/.test(text)) return "0.72em";
    if (/[·•●○◦∙⋅.]/.test(text) && !/[\\/_]{2,}/.test(text)) return "0.68em";
    return "0.65em";
  }

  // A hair taller than mspace so #/. grids are not squat.
  function artLineHeightEm(text, height) {
    if (height <= 1) return null;
    const mspace = artMspaceEm(text);
    if (mspace === "0.72em") return "1.12em";
    if (mspace === "0.68em") return "0.95em";
    return "0.88em";
  }

  // Rocket Goal's font has no braille. Those cells become tofu boxes in-game.
  function isBrailleArtText(text) {
    const chars = [...String(text ?? "").replace(/<[^>]*>/g, "")]
      .filter((ch) => ch !== "\n" && ch !== "\r" && ch !== "\t");
    if (chars.length < 8) return false;
    const braille = chars.filter((ch) => ch >= "\u2800" && ch <= "\u28FF").length;
    return braille / chars.length >= 0.2;
  }

  function brailleToAsciiArt(text) {
    return String(text ?? "").replace(/[\u2800-\u28FF]/g, (ch) => {
      let bits = ch.codePointAt(0) - 0x2800;
      let n = 0;
      while (bits) {
        n += bits & 1;
        bits >>= 1;
      }
      if (n === 0) return " ";
      if (n <= 2) return ".";
      if (n <= 4) return ":";
      if (n <= 6) return "+";
      return "#";
    });
  }

  // 21.8 used = / ' as filter-safe stand-ins. Put + / : back for looks.
  // Strip leftover filter-break markers from older Apply attempts.
  function restorePreferredArtChars(text) {
    return String(text ?? "")
      .replace(/<size=0>\.<\/size>/gi, "")
      .replace(/<size=0>x<\/size>/gi, "")
      .replace(/\u200B/g, "")
      .replace(/(<[^>]*>)|[=']/g, (all, tag) => {
        if (tag) return tag;
        return all === "=" ? "+" : ":";
      });
  }

  function gameSafeArtChars(text) {
    return restorePreferredArtChars(text);
  }

  function artPreviewText(text) {
    return restorePreferredArtChars(brailleToAsciiArt(text));
  }

  function preserveForgeNewlines(code) {
    return String(code ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/\n/g, "<br>");
  }

  function wrapAsciiMonospace(code) {
    const value = String(code ?? "");
    if (!value || /<mspace=/i.test(value)) return value;
    return `<mspace=0.6em>${value}</mspace>`;
  }

  // Transparent `.` — the game font has that glyph. NBSP became tofu boxes.
  const ART_WIDTH_PAD = "<#00000000>.";

  function stripArtWidthPads(line) {
    return String(line ?? "")
      .replace(/<color=#00000000>\.*<\/color>/gi, "")
      .replace(/<#00000000>\./gi, "")
      .replace(/<\/?rgnf-align[^>]*>/gi, "")
      .replace(/<space=[^>]*>/gi, "")
      .replace(/\u00A0/g, " ");
  }

  function visibleArtWidth(line) {
    return [...stripArtWidthPads(line).replace(/<[^>]*>/g, "").replace(/[ \t]+$/g, "")].length;
  }

  // Same column budget as artFitSizePct. Center/right keep <align=left>
  // (so the last row stays put) and shift the whole block with a closed
  // transparent indent the game font can actually draw.
  function artBlockIndentCols(width, align) {
    const side = normalizeForgeAlign(align);
    const extra = Math.max(0, 20 - (Number(width) || 0));
    if (side === "center") return Math.floor(extra / 2);
    if (side === "right") return extra;
    return 0;
  }

  function artIndentPad(cols) {
    const n = Math.max(0, Number(cols) || 0);
    if (!n) return "";
    return `<color=#00000000>${".".repeat(n)}</color>`;
  }

  function indentArtBody(body, cols) {
    const pad = artIndentPad(cols);
    if (!pad) return String(body ?? "");
    const parts = String(body ?? "").split(/(<br\s*\/?\s*>)/i);
    return parts.map((part, i) => {
      if (/^<br\s*\/?\s*>$/i.test(part)) return part;
      if (!part && i === parts.length - 1) return part;
      return pad + part;
    }).join("");
  }

  function padArtLineToWidth(line, width, mspace) {
    const value = stripArtWidthPads(line).replace(/[ \t]+$/g, "");
    const visible = visibleArtWidth(value);
    if (!Number(width) || visible >= width) return value;
    const em = Number.parseFloat(String(mspace ?? "").replace(/em$/i, ""));
    const cell = Number.isFinite(em) && em > 0 ? em : 0.72;
    const pad = Math.round((width - visible) * cell * 100) / 100;
    return `${value}<space=${pad}em>`;
  }

  function padArtBodyLines(body, width, mspace) {
    const parts = String(body ?? "").split(/(<br\s*\/?\s*>)/i);
    return parts.map((part, i) => {
      if (/^<br\s*\/?\s*>$/i.test(part)) return part;
      const lastEmpty = !part && i === parts.length - 1;
      if (lastEmpty) return part;
      return padArtLineToWidth(part, width, mspace);
    }).join("");
  }

  // Nameplates clip the last glyph row. A trailing <br> leaves an empty
  // line-box so the last visible row sits above the clip. Skip if one is
  // already there so Apply / pack does not keep stacking blanks.
  function padArtLastLine(markup, height) {
    const value = String(markup ?? "");
    if (!value || Number(height) < 2) return value;
    if (/(<br\s*\/?\s*>|\n)\s*(<\/mspace>)?\s*$/i.test(value)) return value;
    if (/<\/mspace>\s*$/i.test(value)) {
      return value.replace(/<\/mspace>\s*$/i, "<br></mspace>");
    }
    return value + "<br>";
  }

  // Monospace + fit-to-nameplate. Plain art `<` `>` become fullwidth so TMP
  // does not eat the rest of a FIGlet / dot piece as tags.
  // Left-align so each row shares an edge the way the preview does. The
  // nameplate centers the whole block; it must not center each line.
  function normalizeForgeAlign(value) {
    const v = String(value || "").toLowerCase();
    return v === "center" || v === "right" ? v : "left";
  }

  function forgeAlignJustify(align) {
    const v = normalizeForgeAlign(align);
    if (v === "right") return "flex-end";
    if (v === "center") return "center";
    return "flex-start";
  }

  function alignFromRaw(raw) {
    const value = String(raw ?? "");
    const marked = value.match(/<rgnf-align=(left|center|right)>/i);
    if (marked) return marked[1].toLowerCase();
    const m = value.match(/<align\s*=\s*(left|center|right)>/i);
    if (m) return m[1].toLowerCase();
    return readAlignDefault() || "left";
  }

  function applyAlignToRaw(raw, align) {
    const side = normalizeForgeAlign(align);
    const value = String(raw ?? "");
    if (/<align\s*=\s*(left|center|right)>/i.test(value)) {
      return value.replace(/<align\s*=\s*(left|center|right)>/gi, `<align=${side}>`);
    }
    return `<align=${side}>${value}</align>`;
  }

  function wrapPackedArt(body, mspace, lineHeight, size, align) {
    // The game lifts the last line of a name into a title slot (centered,
    // default leading). An empty trailing <br> keeps the real last art row
    // inside the mspace block. Art itself stays left-aligned so a short
    // last row does not jump; center/right only indent the block.
    const side = normalizeForgeAlign(align);
    const padded = /<br\s*\/?\s*>\s*$/i.test(body) ? body : `${body}<br>`;
    let out = `<align=left><mspace=${mspace}>${padded}</mspace></align>`;
    if (side !== "left") out = `<rgnf-align=${side}>` + out;
    if (lineHeight) out = `<line-height=${lineHeight}>${out}`;
    if (size < 100) out = `<size=${size}%>${out}`;
    return out;
  }

  function packAsciiArt(text, align) {
    const side = normalizeForgeAlign(align);
    const value = gameSafeArtChars(brailleToAsciiArt(stripArtWidthPads(String(text ?? ""))));
    if (!value) return value;
    if (/<mspace=/i.test(value)) {
      const mspace = artMspaceEm(value);
      const brs = (value.match(/<br\s*\/?\s*>/gi) || []).length;
      const lineHeight = artLineHeightEm(value, brs + 1);
      let packed = value
        .replace(/<\/?rgnf-align[^>]*>/gi, "")
        .replace(/<\/?align[^>]*>/gi, "")
        .replace(/<mspace=[^>]*>/gi, `<mspace=${mspace}>`);
      packed = preserveForgeNewlines(packed);
      let inner = (packed.match(/<mspace=[^>]*>([\s\S]*?)<\/mspace>/i) || [])[1];
      const sizeTag = packed.match(/<size=(\d+)%?>/i);
      const size = sizeTag ? Number(sizeTag[1]) : 100;
      if (inner == null) inner = packed;
      if (side !== "left") {
        const width = artLineStats(inner.replace(/<br\s*\/?\s*>/gi, "\n")).width;
        inner = indentArtBody(inner, artBlockIndentCols(width, side));
      }
      return wrapPackedArt(inner, mspace, lineHeight, size, side);
    }
    const normalized = value.replace(/\r\n/g, "\n").replace(/<br\s*\/?\s*>/gi, "\n");
    const lines = normalized.split("\n");
    const hasTmp = /<(size|color|b|i|u|s|mark|sprite|sub|sup|\/|#)/i.test(normalized)
      || /<#[0-9A-Fa-f]{3,8}>/.test(normalized);
    const stats = artLineStats(normalized);
    let body = lines.map((line) => {
      const safe = hasTmp ? line : line.replace(/</g, "\uFF1C").replace(/>/g, "\uFF1E");
      return safe;
    }).join("<br>");
    if (side !== "left") {
      body = indentArtBody(body, artBlockIndentCols(stats.width, side));
    }
    const size = artFitSizePct(stats.height, stats.width);
    const mspace = artMspaceEm(normalized);
    const lineHeight = artLineHeightEm(normalized, stats.height);
    return wrapPackedArt(body, mspace, lineHeight, size, side);
  }

  function editableTextFromRaw(raw) {
    return String(raw ?? "")
      .replace(/<color=#00000000>\.*<\/color>/gi, "")
      .replace(/<#00000000>\./gi, "")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<(?!sprite=\d+\s*>)[^>]*>/gi, "")
      .replace(/\u00A0/g, " ")
      .replace(/[ \t]+$/gm, "")
      .replace(/\r\n/g, "\n")
      .replace(/^\n+|\n+$/g, "");
  }

  function editableFieldsFromRaw(raw) {
    const prepared = String(raw ?? "").replace(/<br\s*\/?\s*>/gi, "\n");
    if (isAsciiArtText(prepared)) {
      return {
        name: editableTextFromRaw(prepared),
        titleOn: false,
        titleText: "",
      };
    }
    const lines = prepared
      .split(/\r\n?|\n/)
      .map(editableTextFromRaw)
      .filter((line) => line.trim().length);
    const titleText = lines.length > 1 ? lines[lines.length - 1] : "";
    return {
      name: lines[0] ?? "",
      titleOn: Boolean(titleText),
      titleText,
    };
  }

  function alignDefaultKey() {
    return 'rgNameForge.alignDefault.v1.' + (_currentUserId || 'anon');
  }

  function readAlignDefault() {
    try {
      const v = loadJSON(alignDefaultKey(), null);
      if (v === 'left' || v === 'center' || v === 'right') return v;
    } catch (e) { /* ignore */ }
    return null;
  }

  function writeAlignDefault(align) {
    const side = normalizeForgeAlign(align);
    saveJSON(alignDefaultKey(), side);
  }

  function scoredDefaultKey() {
    return 'rgNameForge.scoredDefault.v1.' + (_currentUserId || 'anon');
  }

  function readScoredDefault() {
    try {
      const v = loadJSON(scoredDefaultKey(), null);
      if (v === 'hide' || v === 'tiny' || v === 'styled' || v === 'default') return v;
    } catch (e) { /* ignore */ }
    return null;
  }

  function writeScoredDefault(mode) {
    if (mode === 'hide' || mode === 'tiny' || mode === 'styled' || mode === 'default') {
      saveJSON(scoredDefaultKey(), mode);
    }
  }

  // Names without a Scored suffix keep the player's saved default (Hide, etc).
  function resolveScoredMode(parsedMode, pref) {
    if (parsedMode && parsedMode !== 'default') return parsedMode;
    if (pref === 'hide' || pref === 'tiny' || pref === 'styled' || pref === 'default') {
      return pref;
    }
    return parsedMode || 'default';
  }

  function scoredSuffix(s) {
    switch (s.scoredMode) {
      case 'hide': return '<size=0>';
      case 'tiny': return '<sub><size=25%>';
      case 'styled': return `<size=${s.scoredSizePct}%><${s.scoredColor.toUpperCase()}>`;
      default: return '';
    }
  }

  function splitRawScoredSuffix(raw) {
    const value = String(raw ?? '');
    let match = value.match(/<size=0>\s*$/i);
    if (match) {
      return { rawCode: value.slice(0, match.index), scoredMode: 'hide' };
    }
    match = value.match(/<sub><size=25%>\s*$/i);
    if (match) {
      return { rawCode: value.slice(0, match.index), scoredMode: 'tiny' };
    }
    // Older custom names hid "Scored!" by stacking many empty <sub> tags.
    // That shrinks/moves the text but keeps its width, shifting centered titles.
    match = value.match(/(?:\s*<sub>){4,}\s*$/i);
    if (match) {
      return { rawCode: value.slice(0, match.index), scoredMode: 'hide' };
    }
    match = value.match(/<size=(\d+)%><(#[0-9a-f]{6})>\s*$/i);
    if (match) {
      return {
        rawCode: value.slice(0, match.index),
        scoredMode: 'styled',
        scoredSizePct: Number(match[1]),
        scoredColor: match[2],
      };
    }
    return { rawCode: value, scoredMode: 'default' };
  }

  function rawSnapshotFields(raw) {
    const scored = splitRawScoredSuffix(raw);
    return {
      rawCode: scored.rawCode,
      ...editableFieldsFromRaw(scored.rawCode),
      colorMode: 'none',
      solidAlpha: 255,
      bold: false,
      italic: false,
      underline: false,
      strike: false,
      sizePct: 100,
      rotateDeg: 0,
      waveOn: false,
      markOn: false,
      titleColorMode: 'inherit',
      titleSizePct: 100,
      titleSub: false,
      titlePaletteKey: null,
      titleBold: false,
      titleItalic: false,
      titleUnderline: false,
      titleStrike: false,
      titleAlpha: 255,
      align: alignFromRaw(scored.rawCode),
      scoredMode: scored.scoredMode,
      ...(scored.scoredSizePct ? { scoredSizePct: scored.scoredSizePct } : {}),
      ...(scored.scoredColor ? { scoredColor: scored.scoredColor } : {}),
    };
  }

  function editableGlyphs(text) {
    const glyphs = [];
    const value = String(text ?? '');
    for (let i = 0; i < value.length;) {
      const sprite = value.slice(i).match(/^<sprite=\d+\s*>/i);
      if (sprite) {
        glyphs.push(sprite[0]);
        i += sprite[0].length;
        continue;
      }
      const glyph = String.fromCodePoint(value.codePointAt(i));
      glyphs.push(glyph);
      i += glyph.length;
    }
    return glyphs;
  }

  function replaceRawVisibleText(raw, nextText) {
    const replacements = editableGlyphs(nextText);
    const value = String(raw ?? '');
    const tokens = [];
    for (let i = 0; i < value.length;) {
      if (value[i] === '<') {
        const close = value.indexOf('>', i);
        if (close >= 0) {
          const tag = value.slice(i, close + 1);
          tokens.push({
            type: /^<sprite=\d+\s*>$/i.test(tag) ? 'visible' : 'tag',
            value: tag,
          });
          i = close + 1;
          continue;
        }
      }
      const glyph = String.fromCodePoint(value.codePointAt(i));
      tokens.push({ type: 'visible', value: glyph });
      i += glyph.length;
    }
    let lastVisible = -1;
    tokens.forEach((token, index) => {
      if (token.type === 'visible') lastVisible = index;
    });
    let replacementIndex = 0;
    let output = '';
    let trailingTags = '';
    tokens.forEach((token, index) => {
      if (index > lastVisible && token.type === 'tag') {
        trailingTags += token.value;
      } else if (token.type === 'tag') {
        output += token.value;
      } else if (replacementIndex < replacements.length) {
        output += replacements[replacementIndex++];
      }
    });
    if (lastVisible < 0) {
      output = '';
      trailingTags = tokens.map(token => token.value).join('');
    }
    return output
      + replacements.slice(replacementIndex).join('')
      + trailingTags;
  }

  function replaceRawNameText(raw, nextName) {
    const value = String(raw ?? '');
    if (isAsciiArtText(value) || isAsciiArtText(nextName)) {
      return replaceRawVisibleText(value, nextName);
    }
    const lineBreak = /<br\s*\/?\s*>|\r\n?|\n/i;
    const match = lineBreak.exec(value);
    if (!match) return replaceRawVisibleText(value, nextName);
    return replaceRawVisibleText(value.slice(0, match.index), nextName)
      + value.slice(match.index);
  }

  function replaceRawTitleText(raw, nextTitle) {
    const value = String(raw ?? '');
    const lineBreak = /<br\s*\/?\s*>|\r\n?|\n/gi;
    const lines = [];
    let lineStart = 0;
    let match;
    while ((match = lineBreak.exec(value)) !== null) {
      lines.push({ start: lineStart, end: match.index });
      lineStart = match.index + match[0].length;
    }
    lines.push({ start: lineStart, end: value.length });
    if (lines.length === 1) {
      return nextTitle ? value + '<br>' + nextTitle : value;
    }
    let titleLine = null;
    for (let i = lines.length - 1; i >= 1; i--) {
      const candidate = value.slice(lines[i].start, lines[i].end);
      if (editableTextFromRaw(candidate)) {
        titleLine = lines[i];
        break;
      }
    }
    titleLine ||= lines[lines.length - 1];
    return value.slice(0, titleLine.start)
      + replaceRawVisibleText(
        value.slice(titleLine.start, titleLine.end),
        nextTitle,
      )
      + value.slice(titleLine.end);
  }

  function updatedRecentHistory(history, entry) {
    const entries = Array.isArray(history) ? history : [];
    return [
      entry,
      ...entries.filter(item => item && item.code !== entry.code),
    ].slice(0, 5);
  }

  function recordRecentApply(code, rawCode = code) {
    const editableName = editableFieldsFromRaw(rawCode).name;
    const plain = editableName
      .replace(/<sprite=\d+\s*>/gi, '')
      .trim()
      .slice(0, 24) || '(markup only)';
    const entry = {
      code: String(code),
      rawCode: String(rawCode),
      plain,
      ts: Date.now(),
    };
    const history = loadJSON(historyKey(), []);
    saveJSON(historyKey(), updatedRecentHistory(history, entry));
  }

  function syncEditableFieldsFromRaw(raw) {
    const fields = editableFieldsFromRaw(raw);
    state.name = fields.name;
    state.titleOn = fields.titleOn;
    state.titleText = fields.titleText;
  }

  function loadStateSnapshot(snapshot) {
    state = Object.assign(defaultState(), snapshot || {});
    namePaintSel = { start: 0, end: 0 };
    if (state.rawCode) setRawSnapshot(state.rawCode);
    else state.scoredMode = resolveScoredMode(state.scoredMode, readScoredDefault());
  }

  // Preset / recent / live-nickname loads must land in the sticky preview,
  // not just the NAME box or the raw textarea.
  function applyLoadedForgeName(source) {
    if (typeof source === "string") {
      setRawSnapshot(source);
      namePaintSel = { start: 0, end: 0 };
    } else {
      loadStateSnapshot(source);
    }
    if (_rgnfPanel) render(_rgnfPanel);
  }

  function setRawSnapshot(raw) {
    Object.assign(state, rawSnapshotFields(_stripTag(restorePreferredArtChars(raw))));
    state.scoredMode = resolveScoredMode(state.scoredMode, readScoredDefault());
  }

  // Repair a persisted pre-fix state before the first render.
  if (state.rawCode) {
    setRawSnapshot(state.rawCode);
    saveJSON(stateKey(), state);
  }

  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return {
      r: parseInt(h.substring(0, 2), 16),
      g: parseInt(h.substring(2, 4), 16),
      b: parseInt(h.substring(4, 6), 16),
    };
  }

  function rgbToHex({ r, g, b }) {
    const c = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0').toUpperCase();
    return `#${c(r)}${c(g)}${c(b)}`;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function lerpColor(c1, c2, t) {
    const a = hexToRgb(c1), b = hexToRgb(c2);
    return rgbToHex({ r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) });
  }

  function normalizeColorSpans(spans, textLen) {
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

  function colorStyleAt(index, spans, fallback) {
    for (let i = (spans || []).length - 1; i >= 0; i -= 1) {
      const span = spans[i];
      if (index >= span.start && index < span.end) return span;
    }
    return fallback;
  }

  function splitByColorSpans(text, spans, fallback) {
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

  function rememberNamePaintSel(el) {
    if (!el) return;
    const start = Number(el.selectionStart) || 0;
    const end = Number(el.selectionEnd) || 0;
    if (end > start) namePaintSel = { start, end };
  }

  function namePaintRange() {
    const start = Math.min(namePaintSel.start, namePaintSel.end);
    const end = Math.max(namePaintSel.start, namePaintSel.end);
    const len = String(state.name || "").length;
    const a = Math.max(0, Math.min(len, start));
    const b = Math.max(0, Math.min(len, end));
    if (b <= a) return null;
    return { start: a, end: b };
  }

  function paintRangeGlyphCount(range) {
    const slice = String(state.name || "").slice(range.start, range.end);
    return [...slice].filter((ch) => ch !== " " && ch !== "\n" && ch !== "\t" && ch !== "\r").length;
  }

  function paintBarLabel() {
    const range = namePaintRange();
    if (!range) {
      return "Drag on the preview to pick a slice. Then change Color. No highlight paints everything.";
    }
    const n = paintRangeGlyphCount(range);
    return `Painting ${n} character${n === 1 ? "" : "s"} in the preview. Color changes apply to this highlight only.`;
  }

  function paintPreviewRoot(node) {
    return node?.closest?.(".rgnf-preview-stack") || node;
  }

  function isPaintSpaceEl(el) {
    if (!el || el.dataset.forgeStart != null) return false;
    return /^\s+$/.test(el.textContent || "");
  }

  function paintPreviewSelection(root) {
    const scope = paintPreviewRoot(root);
    if (!scope) return;
    const range = namePaintRange();
    for (const el of scope.querySelectorAll("[data-forge-i]")) {
      const i = Number(el.dataset.forgeI);
      el.classList.toggle(
        "rgnf-paint-on",
        !!(range && i >= range.start && i < range.end && !isPaintSpaceEl(el)),
      );
    }
    for (const el of scope.querySelectorAll("[data-forge-start]")) {
      const a = Number(el.dataset.forgeStart);
      const b = Number(el.dataset.forgeEnd);
      el.classList.toggle("rgnf-paint-on", !!(range && a < range.end && b > range.start));
    }
    const label = scope.querySelector(".rgnf-paintbar-label");
    if (label) label.textContent = paintBarLabel();
  }

  function forgeHitRange(el) {
    const hit = el?.closest?.("[data-forge-i],[data-forge-start]");
    if (!hit) return null;
    if (hit.dataset.forgeI != null) {
      const i = Number(hit.dataset.forgeI);
      return { start: i, end: i + 1 };
    }
    return {
      start: Number(hit.dataset.forgeStart),
      end: Number(hit.dataset.forgeEnd),
    };
  }

  function makePaintBar() {
    const bar = document.createElement("div");
    bar.className = "rgnf-paintbar";
    const label = document.createElement("div");
    label.className = "rgnf-paintbar-label";
    label.textContent = paintBarLabel();
    const zoom = document.createElement("div");
    zoom.className = "rgnf-zoom";
    const zoomOut = document.createElement("button");
    zoomOut.className = "rgnf-chip";
    zoomOut.type = "button";
    zoomOut.textContent = "−";
    zoomOut.title = "Zoom preview out. Does not change the in-game name size.";
    zoomOut.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setPreviewZoom(previewZoom - 0.2);
    });
    const zoomLabel = document.createElement("button");
    zoomLabel.className = "rgnf-chip rgnf-zoom-label";
    zoomLabel.type = "button";
    zoomLabel.textContent = `${Math.round(previewZoom * 100)}%`;
    zoomLabel.title = "Reset preview zoom to 100%. Does not change the in-game name size.";
    zoomLabel.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setPreviewZoom(1);
    });
    const zoomIn = document.createElement("button");
    zoomIn.className = "rgnf-chip";
    zoomIn.type = "button";
    zoomIn.textContent = "+";
    zoomIn.title = "Zoom preview in. Does not change the in-game name size.";
    zoomIn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setPreviewZoom(previewZoom + 0.2);
    });
    zoom.appendChild(zoomOut);
    zoom.appendChild(zoomLabel);
    zoom.appendChild(zoomIn);
    const clear = document.createElement("button");
    clear.className = "rgnf-chip";
    clear.type = "button";
    clear.textContent = "Clear highlight";
    clear.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      namePaintSel = { start: 0, end: 0 };
      paintPreviewSelection(bar);
    });
    const actions = document.createElement("div");
    actions.className = "rgnf-paintbar-actions";
    actions.appendChild(zoom);
    actions.appendChild(clear);
    bar.appendChild(label);
    bar.appendChild(actions);
    return bar;
  }

  function wirePreviewPaint(root) {
    let dragging = false;
    let anchor = 0;
    root.addEventListener("pointerdown", (e) => {
      if (e.button != null && e.button !== 0) return;
      if (e.target?.closest?.(".rgnf-paintbar")) return;
      const hit = forgeHitRange(e.target);
      if (!hit) {
        namePaintSel = { start: 0, end: 0 };
        paintPreviewSelection(root);
        return;
      }
      e.preventDefault();
      dragging = true;
      anchor = hit.start;
      namePaintSel = { start: hit.start, end: hit.end };
      try { root.setPointerCapture(e.pointerId); } catch (err) {}
      paintPreviewSelection(root);
    });
    root.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const hit = forgeHitRange(under);
      if (!hit) return;
      namePaintSel = {
        start: Math.min(anchor, hit.start),
        end: Math.max(anchor + 1, hit.end),
      };
      paintPreviewSelection(root);
    });
    root.addEventListener("pointerup", () => { dragging = false; });
    root.addEventListener("pointercancel", () => { dragging = false; });
    root.addEventListener("wheel", (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setPreviewZoom(previewZoom + (e.deltaY > 0 ? -0.2 : 0.2));
    }, { passive: false });
  }

  function cloneColorStyle(style) {
    return {
      mode: ["none", "solid", "gradient"].includes(style?.mode) ? style.mode : "gradient",
      solid: typeof style?.solid === "string" ? style.solid : "#22d3ee",
      stops: Array.isArray(style?.stops) ? style.stops.filter((c) => typeof c === "string") : [],
      solidAlpha: Number.isFinite(Number(style?.solidAlpha)) ? Number(style.solidAlpha) : 255,
    };
  }

  function snapshotNameColorStyle() {
    return cloneColorStyle({
      mode: state.colorMode,
      solid: state.solidColor,
      stops: state.stops,
      solidAlpha: state.solidAlpha ?? 255,
    });
  }

  function bakeUncoveredColorSpans(spans, len, style) {
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

  function subtractColorRange(spans, start, end) {
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

  function applySliceColor(spans, len, range, beforeStyle, afterStyle) {
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

  function expandPaintHex(hex) {
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
  function colorSpansFromRawName(raw, name) {
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

  function ensureStateColorSpans() {
    if ((state.colorSpans || []).length) return;
    const src = typeof state.rawCode === "string"
      ? state.rawCode
      : (_lastRawNickname ? _stripTag(String(_lastRawNickname)) : "");
    if (!src || !state.name) return;
    const spans = colorSpansFromRawName(src, state.name);
    if (spans.length) state.colorSpans = spans;
  }

  function absorbRawIntoPaintState() {
    if (typeof state.rawCode !== "string") return;
    const raw = state.rawCode;
    const nameBefore = state.name;
    const spansBefore = state.colorSpans;
    syncEditableFieldsFromRaw(raw);
    // Keep the name the highlight was measured against so slice indices
    // still point at the same glyphs after leaving raw TMP.
    if (nameBefore && String(state.name) !== String(nameBefore)) {
      const sameArt = editableTextFromRaw(nameBefore) === editableTextFromRaw(state.name);
      if (sameArt) state.name = nameBefore;
    }
    if (!(spansBefore || []).length) {
      state.colorSpans = colorSpansFromRawName(raw, state.name);
    } else {
      state.colorSpans = spansBefore;
    }
    state.rawCode = null;
  }

  function commitNameColor(mutator) {
    const range = namePaintRange();
    const before = snapshotNameColorStyle();
    absorbRawIntoPaintState();
    ensureStateColorSpans();
    mutator?.();
    const len = String(state.name || "").length;
    const start = Math.max(0, Math.min(len, range?.start ?? 0));
    const end = Math.max(0, Math.min(len, range?.end ?? 0));
    if (range && end > start) {
      state.colorSpans = applySliceColor(
        state.colorSpans,
        len,
        { start, end },
        before,
        snapshotNameColorStyle(),
      );
      state.rawCode = null;
      return;
    }
    // A lost highlight must not fall through to "paint everything".
    if (!range) state.colorSpans = [];
  }

  // 6-as-g makes FA6 → fag. Fire oranges like #FFA600 trip the nickname API.
  function nickSafeColor(hex) {
    const raw = String(hex || "");
    const m = raw.match(/^(#?)([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?$/);
    if (!m) return raw;
    return `${m[1] || "#"}${m[2].toUpperCase().replace(/FA6/g, "FA7")}${m[3] || ""}`;
  }

  function sanitizeNicknameColors(code) {
    return String(code ?? "").replace(/<#([0-9A-Fa-f]{6})>/g, (_, h) => `<${nickSafeColor("#" + h)}>`);
  }

  // multi-stop gradient sample at t in [0,1]
  function gradientAt(stops, t) {
    if (stops.length === 1) return nickSafeColor(stops[0].toUpperCase());
    const seg = 1 / (stops.length - 1);
    const idx = Math.min(Math.floor(t / seg), stops.length - 2);
    const localT = (t - idx * seg) / seg;
    return nickSafeColor(lerpColor(stops[idx], stops[idx + 1], localT));
  }

  function alphaHex(n) {
    return Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0').toUpperCase();
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return rgbToHex({ r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 });
  }

  function randomStops() {
    const h = Math.floor(Math.random() * 360);
    const spread = 80 + Math.floor(Math.random() * 160);
    return [h, h + spread / 2, h + spread].map((x) => hslToHex(((x % 360) + 360) % 360, 95, 55));
  }

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ------------------------------------------------------------------
  // TMP code generation
  // ------------------------------------------------------------------
  function colorizeText(text, mode, solid, stops, skipSpaces, waveAmp = 0, solidAlpha = 255) {
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

  function colorizeNamedArt(artName, s) {
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
  function tokenize(text) {
    const tokens = [];
    const re = /<sprite=\d+>/g;
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

  function resolveTitleColorStyle(s) {
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

  function resolveSubtitleColorStyle(s) {
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

  // Compose either title or subtitle: color processing, style tags, optional
  // clan-tag prefix. Returns { line, visibleWidth } or null if nothing to render.
  function composeExtraLine(s, kind) {
    const isTitle = kind === 'title';
    const textKey = isTitle ? 'titleText' : 'subtitleText';
    const text = String(s[textKey] || '');
    if (!text.trim()) return null;
    const style = isTitle ? resolveTitleColorStyle(s) : resolveSubtitleColorStyle(s);
    const sizeKey = isTitle ? 'titleSizePct' : 'subtitleSizePct';
    const subKey = isTitle ? 'titleSub' : 'subtitleSub';
    const boldKey = isTitle ? 'titleBold' : 'subtitleBold';
    const italicKey = isTitle ? 'titleItalic' : 'subtitleItalic';
    const underlineKey = isTitle ? 'titleUnderline' : 'subtitleUnderline';
    const strikeKey = isTitle ? 'titleStrike' : 'subtitleStrike';
    const prefix = isTitle ? _prefix('title') : '';
    let t = text;
    if (style.mode === 'solid') {
      const aa = style.alpha < 255 ? alphaHex(style.alpha) : '';
      t = `<${style.solid.toUpperCase()}${aa}>` + t;
    } else if (style.mode === 'gradient') {
      t = colorizeText(t, 'gradient', style.solid, style.stops, s.skipSpaces);
      const aaG = style.alpha < 255 ? alphaHex(style.alpha) : '';
      if (aaG) t = t.replace(/<(#[0-9A-Fa-f]{6})>/g, `<$1${aaG}>`);
    }
    // getClanTagPrefix already trails a single space, so just concat.
    if (prefix) t = prefix + t;
    let open = '', close = '';
    if (s[sizeKey] !== 100) open += `<size=${s[sizeKey]}%>`;
    if (s[subKey]) { open += '<sub>'; close = '</sub>' + close; }
    if (s[boldKey]) { open += '<b>'; close = '</b>' + close; }
    if (s[italicKey]) { open += '<i>'; close = '</i>' + close; }
    if (s[underlineKey]) { open += '<u>'; close = '</u>' + close; }
    if (s[strikeKey]) { open += '<s>'; close = '</s>' + close; }
    const line = open + t + close;
    const prefixVisible = prefix ? visibleArtWidth(prefix) + 1 : 0;
    const visibleWidth = [...text].length + prefixVisible;
    return { line, visibleWidth };
  }

  function buildCode(s) {
    let open = '';
    let close = '';

    if (s.rotateDeg !== 0 && !s.waveOn) open += `<rotate=${s.rotateDeg}>`;
    if (s.sizePct !== 100) open += `<size=${s.sizePct}%>`;
    if (s.markOn) { open += `<mark=${s.markColor.toUpperCase()}${alphaHex(s.markAlpha)}>`; close = '</mark>' + close; }
    if (s.bold) { open += '<b>'; close = '</b>' + close; }
    if (s.italic) { open += '<i>'; close = '</i>' + close; }
    if (s.underline) { open += '<u>'; close = '</u>' + close; }
    if (s.strike) { open += '<s>'; close = '</s>' + close; }

    const artName = restorePreferredArtChars(brailleToAsciiArt(s.name));
    const nameCode = colorizeNamedArt(artName, s);
    const packedArt = isAsciiArtText(artName) || isAsciiArtText(s.name);
    const align = normalizeForgeAlign(s.align);
    if (!packedArt) {
      open += `<align=${align}>`;
      close = `</align>${close}`;
    }

    let code = open + nameCode + close;
    if (packedArt) code = packAsciiArt(code, align);

    // Build title and subtitle blocks. Both share the same alignment as the
    // name/art (packAsciiArt already emits a trailing <br> so injecting the
    // title lines inside the mspace block keeps them left/center/right in
    // step with the art). Subtitle lives below title with its own gap.
    const composed = [];
    if (s.titleOn) {
      const t = composeExtraLine(s, 'title');
      if (t) composed.push({
        line: t.line, visibleWidth: t.visibleWidth,
        gap: Math.max(0, Math.min(10, Number(s.titleGapLines) || 0)),
      });
    }
    if (s.subtitleOn) {
      const st = composeExtraLine(s, 'subtitle');
      if (st) composed.push({
        line: st.line, visibleWidth: st.visibleWidth,
        gap: Math.max(0, Math.min(10, Number(s.subtitleGapLines) || 0)),
      });
    }

    if (composed.length) {
      if (packedArt) {
        // Extract the art's own visible width so we can center each extra
        // line horizontally within it. Compute artAlignIndent once so the
        // block-position matches the art's alignment.
        const artInnerMatch = code.match(/<mspace=[^>]*>([\s\S]*?)<\/mspace>/i);
        const artBody = artInnerMatch ? artInnerMatch[1] : '';
        const artWidth = artLineStats(artBody.replace(/<br\s*\/?\s*>/gi, '\n')).width;
        const artAlignIndent = artBlockIndentCols(artWidth, align);
        let payload = '';
        for (const c of composed) {
          const centerOffset = Math.max(0, Math.floor((artWidth - c.visibleWidth) / 2));
          const totalIndent = artAlignIndent + centerOffset;
          const padded = totalIndent > 0
            ? artIndentPad(totalIndent) + c.line
            : c.line;
          payload += '<br>'.repeat(c.gap) + padded + '<br>';
        }
        const anchor = '</mspace>';
        const idx = code.lastIndexOf(anchor);
        if (idx >= 0) code = code.slice(0, idx) + payload + code.slice(idx);
        else code += payload;
      } else {
        // Non-art path: outer <align> from the name wraps both title and
        // subtitle so they inherit the name's alignment automatically.
        for (const c of composed) code += '<br>' + '<br>'.repeat(c.gap) + c.line;
      }
    }

    // trailing tags style whatever "Scored!" text the game appends.
    code += scoredSuffix(s);

    return code;
  }

  function effectiveForgeCode(s) {
    if (typeof s.rawCode === 'string') {
      const art = isAsciiArtText(s.rawCode) || isAsciiArtText(s.name);
      const raw = art ? packAsciiArt(s.rawCode, s.align) : preserveForgeNewlines(s.rawCode);
      return raw + scoredSuffix(s);
    }
    return buildCode(s);
  }

  // ------------------------------------------------------------------
  // preview rendering (approximates TMP output)
  // ------------------------------------------------------------------
  function renderPreview(s) {
    const wrap = document.createElement('div');
    wrap.className = 'rgnf-preview-inner';

    let nameLine = document.createElement('div');
    nameLine.className = 'rgnf-preview-name';

    const styles = [];
    if (s.bold) styles.push('font-weight:700');
    if (s.italic) styles.push('font-style:italic');
    // per-letter decoration mirrors in-game TMP. applied per-span below via decoCSS.
    // Preview-only zoom. Style Size still drives in-game <size=...>.
    styles.push(`font-size:${previewNameFontPx(s)}px`);
    if (s.markOn) styles.push(`background:${s.markColor}${alphaHex(s.markAlpha)}`);
    nameLine.style.cssText = styles.join(';');

    // clan tag prefix: parse a small TMP subset into styled DOM so the preview
    // matches what actually gets sent
    const pfx = _prefix();
    if (pfx) {
      let inner = pfx;
      let outerBold = false, outerItalic = false;
      let m;
      while ((m = inner.match(/^<b>([\s\S]*)<\/b>\s*$/))) { outerBold = true; inner = m[1]; }
      while ((m = inner.match(/^<i>([\s\S]*)<\/i>\s*$/))) { outerItalic = true; inner = m[1]; }
      const pfxWrap = document.createElement('span');
      if (outerBold) pfxWrap.style.fontWeight = '700';
      if (outerItalic) pfxWrap.style.fontStyle = 'italic';
      pfxWrap.style.marginRight = '4px';
      let idx = 0, currentColor = null, currentRotate = 0;
      while (idx < inner.length) {
        const rest = inner.slice(idx);
        const colorTag = rest.match(/^<(#(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8}))>/);
        if (colorTag) { currentColor = colorTag[1]; idx += colorTag[0].length; continue; }
        const rotateTag = rest.match(/^<rotate=(-?\d+)>/);
        if (rotateTag) { currentRotate = Number(rotateTag[1]); idx += rotateTag[0].length; continue; }
        const ch = inner[idx];
        const chSpan = document.createElement('span');
        chSpan.textContent = ch;
        if (currentColor) chSpan.style.color = currentColor;
        if (currentRotate) {
          chSpan.style.display = 'inline-block';
          chSpan.style.transform = 'rotate(' + currentRotate + 'deg)';
        }
        pfxWrap.appendChild(chSpan);
        idx++;
      }
      nameLine.appendChild(pfxWrap);
    }


    const decoParts = [];
    if (s.underline) decoParts.push('underline');
    if (s.strike) decoParts.push('line-through');
    const decoCSS = decoParts.length ? decoParts.join(' ') : '';

    const previewName = artPreviewText(s.name);
    const ascii = isAsciiArtText(previewName) || isAsciiArtText(s.name);
    if (ascii) {
      wrap.classList.add('rgnf-ascii');
      nameLine.style.whiteSpace = 'pre';
      nameLine.style.fontFamily = 'ui-monospace, Menlo, Consolas, monospace';
      nameLine.style.textAlign = 'left';
      nameLine.style.lineHeight = '1.1';
    } else {
      nameLine.style.textAlign = normalizeForgeAlign(s.align);
    }
    const previewFallback = {
      mode: s.colorMode,
      solid: s.solidColor,
      stops: s.stops,
      solidAlpha: s.solidAlpha ?? 255,
    };
    if (s === state) ensureStateColorSpans();
    const previewSpans = String(s.name || "").length === previewName.length
      ? s.colorSpans
      : [];
    const previewRuns = splitByColorSpans(previewName, previewSpans, previewFallback);
    let i = 0;
    let srcIndex = 0;
    const startNameLine = () => {
      const line = document.createElement('div');
      line.className = 'rgnf-preview-name';
      if (ascii) {
        line.style.whiteSpace = 'pre';
        line.style.fontFamily = 'ui-monospace, Menlo, Consolas, monospace';
        line.style.textAlign = 'left';
        line.style.lineHeight = '1.1';
      }
      line.style.cssText = (line.style.cssText ? line.style.cssText + ';' : '') + styles.join(';');
      return line;
    };
    for (const run of previewRuns) {
      const tokens = tokenize(run.text);
      const paintable = tokens.filter(t => t.type === 'char' && !(s.skipSpaces && t.value === ' '));
      const n = paintable.length;
      let runI = 0;
      for (const tok of tokens) {
        if (tok.type === 'br') {
          wrap.appendChild(nameLine);
          nameLine = startNameLine();
          srcIndex += 1;
          continue;
        }
        const span = document.createElement('span');
        if (tok.type === 'sprite') {
          const num = Number(tok.value.match(/\d+/)[0]);
          span.textContent = spriteEmoji(num);
          span.title = tok.value;
          span.dataset.forgeStart = String(srcIndex);
          span.dataset.forgeEnd = String(srcIndex + tok.value.length);
          srcIndex += tok.value.length;
        } else {
          span.dataset.forgeI = String(srcIndex);
          srcIndex += tok.value.length;
          span.textContent = tok.value;
          if (tok.value !== ' ' || !s.skipSpaces) {
            if (run.style.mode === 'solid') {
              const aa = (run.style.solidAlpha ?? 255) < 255 ? alphaHex(run.style.solidAlpha) : '';
              span.style.color = run.style.solid + aa;
            }
            else if (run.style.mode === 'gradient' && n > 0 && tok.value !== ' ') {
              const t = n === 1 ? 0 : runI / (n - 1);
              span.style.color = gradientAt(run.style.stops, t);
            }
          }
          if (decoCSS && tok.value !== ' ') {
            span.style.textDecorationLine = decoCSS;
            span.style.textDecorationColor = span.style.color || 'currentColor';
            span.style.textDecorationThickness = 'from-font';
          }
          if (tok.value !== ' ') {
            if (s.waveOn) {
              span.style.display = 'inline-block';
              span.style.transform = `rotate(${(i % 2 === 0 ? -1 : 1) * s.waveAmp}deg)`;
            }
            runI++;
            i++;
          }
        }
        if (!s.waveOn && s.rotateDeg !== 0) {
          span.style.display = 'inline-block';
          span.style.transform = `rotate(${s.rotateDeg}deg)`;
        }
        nameLine.appendChild(span);
      }
    }
    wrap.appendChild(nameLine);

    if (s.titleOn && s.titleText.trim()) {
      const titleLine = document.createElement('div');
      titleLine.className = 'rgnf-preview-title';
      titleLine.style.fontSize = `${Math.max(5, 18 * s.titleSizePct / 100 * previewZoom)}px`;
      titleLine.style.textAlign = normalizeForgeAlign(s.align);
      titleLine.style.width = '100%';
      const previewGap = Math.max(0, Math.min(10, Number(s.titleGapLines) || 0));
      if (previewGap > 0) titleLine.style.marginTop = `${previewGap * 1.1}em`;
      if (s.titleSub) titleLine.style.verticalAlign = 'sub';
      if (s.titleBold) titleLine.style.fontWeight = '700';
      if (s.titleItalic) titleLine.style.fontStyle = 'italic';
      const titleDeco = [];
      if (s.titleUnderline) titleDeco.push('underline');
      if (s.titleStrike) titleDeco.push('line-through');
      if (titleDeco.length) titleLine.style.textDecorationLine = titleDeco.join(' ');
      const titleColor = resolveTitleColorStyle(s);
      if (titleColor.mode === 'solid') {
        titleLine.textContent = s.titleText;
        // 8-digit hex: append alpha byte when < 255
        const aa = titleColor.alpha < 255 ? alphaHex(titleColor.alpha) : '';
        titleLine.style.color = titleColor.solid + aa;
      } else if (titleColor.mode === 'gradient') {
        const chars = [...s.titleText];
        const paint = chars.filter(c => c !== ' ').length;
        const aa = titleColor.alpha < 255 ? alphaHex(titleColor.alpha) : '';
        let j = 0;
        for (const c of chars) {
          const sp = document.createElement('span');
          sp.textContent = c;
          if (c !== ' ') {
            sp.style.color = gradientAt(titleColor.stops, paint === 1 ? 0 : j / (paint - 1)) + aa;
            j++;
          }
          titleLine.appendChild(sp);
        }
      } else {
        titleLine.textContent = s.titleText;
      }
      wrap.appendChild(titleLine);
    }

    if (s.subtitleOn && s.subtitleText.trim()) {
      const subLine = document.createElement('div');
      subLine.className = 'rgnf-preview-title';
      subLine.style.fontSize = `${Math.max(5, 18 * s.subtitleSizePct / 100 * previewZoom)}px`;
      subLine.style.textAlign = normalizeForgeAlign(s.align);
      subLine.style.width = '100%';
      const previewSubGap = Math.max(0, Math.min(10, Number(s.subtitleGapLines) || 0));
      if (previewSubGap > 0) subLine.style.marginTop = `${previewSubGap * 1.1}em`;
      if (s.subtitleSub) subLine.style.verticalAlign = 'sub';
      if (s.subtitleBold) subLine.style.fontWeight = '700';
      if (s.subtitleItalic) subLine.style.fontStyle = 'italic';
      const subDeco = [];
      if (s.subtitleUnderline) subDeco.push('underline');
      if (s.subtitleStrike) subDeco.push('line-through');
      if (subDeco.length) subLine.style.textDecorationLine = subDeco.join(' ');
      const subColor = resolveSubtitleColorStyle(s);
      if (subColor.mode === 'solid') {
        subLine.textContent = s.subtitleText;
        const aa = subColor.alpha < 255 ? alphaHex(subColor.alpha) : '';
        subLine.style.color = subColor.solid + aa;
      } else if (subColor.mode === 'gradient') {
        const chars = [...s.subtitleText];
        const paint = chars.filter(c => c !== ' ').length;
        const aa = subColor.alpha < 255 ? alphaHex(subColor.alpha) : '';
        let j = 0;
        for (const c of chars) {
          const sp = document.createElement('span');
          sp.textContent = c;
          if (c !== ' ') {
            sp.style.color = gradientAt(subColor.stops, paint === 1 ? 0 : j / (paint - 1)) + aa;
            j++;
          }
          subLine.appendChild(sp);
        }
      } else {
        subLine.textContent = s.subtitleText;
      }
      wrap.appendChild(subLine);
    }

    // fake "Scored!" suffix
    const scored = document.createElement('span');
    scored.className = 'rgnf-preview-scored';
    scored.textContent = ' Scored!';
    switch (s.scoredMode) {
      case 'hide': scored.style.display = 'none'; break;
      case 'tiny': scored.style.fontSize = `${Math.max(4, 6 * previewZoom)}px`; scored.style.verticalAlign = 'sub'; break;
      case 'styled':
        scored.style.color = s.scoredColor;
        scored.style.fontSize = `${Math.max(4, 14 * s.scoredSizePct / 100 * previewZoom)}px`;
        break;
      default: scored.style.color = '#cbd5e1'; break;
    }
    nameLine.appendChild(scored);

    const stack = document.createElement('div');
    stack.className = 'rgnf-preview-stack';
    stack.appendChild(makePaintBar());
    stack.appendChild(wrap);
    wirePreviewPaint(wrap);
    paintPreviewSelection(stack);
    return stack;
  }

  // ------------------------------------------------------------------
  // auth: fresh Firebase ID token. SDK first, IndexedDB fallback + refresh.
  // ------------------------------------------------------------------
  async function getIdToken() {
    // 1) Firebase SDK exposed on the page
    try {
      if (window.firebase && window.firebase.auth) {
        const u = window.firebase.auth().currentUser;
        if (u) return await u.getIdToken();
      }
    } catch (e) { /* fall through */ }

    // 2) IndexedDB cache written by the Firebase JS SDK
    const rec = await readAuthFromIDB();
    if (!rec) throw new Error('No Firebase auth found. Are you logged in on this tab?');

    const { apiKey, sts } = rec;
    const expMs = Number(sts.expirationTime || 0);
    if (Date.now() < expMs - 60_000 && sts.accessToken) return sts.accessToken;

    // 3) Token expired, refresh it
    const resp = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: sts.refreshToken }),
    });
    if (!resp.ok) throw new Error(`Token refresh failed (${resp.status})`);
    const j = await resp.json();
    if (!j.access_token) throw new Error('Token refresh returned no access_token');
    return j.access_token;
  }

  function readAuthFromIDB() {
    return new Promise((resolve) => {
      let req;
      try { req = indexedDB.open('firebaseLocalStorageDb'); } catch (e) { return resolve(null); }
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        try {
          const tx = db.transaction('firebaseLocalStorage', 'readonly');
          const store = tx.objectStore('firebaseLocalStorage');
          const all = store.getAll();
          all.onsuccess = () => {
            const rows = all.result || [];
            const row = rows.find(r => typeof r.fbase_key === 'string' && r.fbase_key.startsWith('firebase:authUser:'));
            if (!row || !row.value || !row.value.stsTokenManager) return resolve(null);
            const apiKey = row.fbase_key.split(':')[2];
            resolve({ apiKey, sts: row.value.stsTokenManager });
          };
          all.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      };
    });
  }

  // ------------------------------------------------------------------
  // API
  // ------------------------------------------------------------------
  async function applyNickname(code) {
    const token = await getIdToken();
    // guard: IndexedDB fallback can serve a stale token in multi-account
    // browsers, which would apply to the WRONG account. fail loudly instead.
    let mismatch = null;
    try {
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (_currentUserId && payload.user_id && payload.user_id !== _currentUserId) {
        mismatch = payload.user_id;
      }
    } catch (e) { /* undecodable token: proceed, the server will judge it */ }
    if (mismatch) {
      throw new Error('Auth token belongs to a different account (' + mismatch.slice(0, 8) + '…). Refresh the page and try again.');
    }
    code = sanitizeNicknameColors(code);
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Bearer ' + token,
      },
      body: new URLSearchParams({ nickname: code }),
    });
    const body = await res.text();
    // log every apply's server verdict, helps debug "why didn't my name change"
    console.log('[RG HUD] nickname apply ->', res.status, body.trim().slice(0, 60));
    return { ok: res.ok && body.trim() === 'true', status: res.status, body };
  }

  // The nickname endpoint can return true before the game finishes its own
  // SetNickname boot echo. Keep one receipt for every Name Forge write and
  // re-apply once after the echo window. A newer click cancels the old retry.
  let _nicknameApplyRevision = 0;
  const NICKNAME_SETTLE_RETRY_MS = 4000;
  async function applyNicknameStable(code, body = code) {
    const revision = ++_nicknameApplyRevision;
    const receipt = { code, body, ts: Date.now(), revision };
    _stealVerified = false;
    saveJSON(pendingStealKey(), receipt);

    let first;
    try {
      first = await applyNickname(code);
    } catch (err) {
      const current = loadJSON(pendingStealKey(), null);
      if (current?.revision === revision) saveJSON(pendingStealKey(), null);
      throw err;
    }
    if (!first.ok) {
      const current = loadJSON(pendingStealKey(), null);
      if (current?.revision === revision) saveJSON(pendingStealKey(), null);
      return first;
    }

    setTimeout(async () => {
      if (_nicknameApplyRevision !== revision) return;
      const current = loadJSON(pendingStealKey(), null);
      if (!current || current.revision !== revision || current.code !== code) return;
      try {
        const retry = await applyNickname(code);
        dbg(`nickname settle retry -> ${retry.ok ? "OK" : "FAILED (" + retry.status + ")"}`);
      } catch (err) {
        dbg("nickname settle retry error: " + getErrMsg(err));
      }
    }, NICKNAME_SETTLE_RETRY_MS);

    return first;
  }

  // once per page load: check the last name apply survived the game's boot echo.
  // mismatch -> re-apply once after 4s so our write lands last. TTL-guarded.
  let _stealVerified = false;
  function verifyPendingSteal(rawNickname) {
    if (_stealVerified) return;
    _stealVerified = true;
    const fdbg = (m) => { try { dbg(m); } catch (e) { console.log('[RG HUD] ' + m); } };
    const pending = loadJSON(pendingStealKey(), null);
    if (!pending || !pending.code) return;
    if (Date.now() - (pending.ts || 0) > PENDING_STEAL_TTL_MS) {
      saveJSON(pendingStealKey(), null);
      fdbg('pending steal receipt expired — dropped');
      return;
    }
    const nick = String(rawNickname || '');
    // caller has stripped clan-tag prefix from nick, pending.* wasn't
    // stripped. compare both forms or same-clan steals ping-pong forever.
    let stripFn;
    try { stripFn = stripLeadingClanTagMarkup; } catch (e) { stripFn = s => s; }
    const strip = s => { try { return stripFn(String(s || "")); } catch (e) { return String(s || ""); } };
    const nickStripped = strip(nick);
    const bodyStripped = strip(pending.body);
    const codeStripped = strip(pending.code);
    if (nick && (
        nick === String(pending.body || '') ||
        nick === String(pending.code || '') ||
        (nickStripped && (nickStripped === bodyStripped || nickStripped === codeStripped))
    )) {
      saveJSON(pendingStealKey(), null);
      fdbg('pending name apply verified — nickname stuck server-side');
      return;
    }
    if (pending.revision && pending.revision === _nicknameApplyRevision) {
      fdbg('pending name apply is waiting for its scheduled settle retry');
      return;
    }
    fdbg('pending name apply MISMATCH — boot echo overwrote it, re-applying in 4s');
    setTimeout(async () => {
      try {
        const r = await applyNickname(pending.code);
        fdbg(`pending name re-apply -> ${r.ok ? 'OK — refresh once more to see it in-game' : 'FAILED (' + r.status + ')'}`);
        if (r.ok) saveJSON(pendingStealKey(), null);
      } catch (err) {
        fdbg('pending name re-apply error: ' + getErrMsg(err));
      }
    }, 4000);
  }

  // ------------------------------------------------------------------
  // UI
  // ------------------------------------------------------------------
  const css = `
    :root {
      --rgnf-bg: #0b0e1a;
      --rgnf-panel: #10142a;
      --rgnf-panel-2: #171c38;
      --rgnf-line: #23294d;
      --rgnf-text: #e2e8f0;
      --rgnf-muted: #8b93b8;
      --rgnf-accent: #22d3ee;
      --rgnf-accent-2: #e94fff;
    }
    .rgnf-fab {
      position: fixed; bottom: 90px; right: 18px; z-index: 999999;
      width: 52px; height: 52px; border-radius: 14px; border: 1px solid var(--rgnf-line);
      background: linear-gradient(135deg, var(--rgnf-panel) 0%, var(--rgnf-panel-2) 100%);
      color: var(--rgnf-accent); font-size: 24px; cursor: pointer;
      box-shadow: 0 6px 24px rgba(0,0,0,.5), 0 0 0 1px rgba(34,211,238,.15) inset;
      transition: transform .15s ease;
      display: flex; align-items: center; justify-content: center;
      touch-action: none; user-select: none;
    }
    .rgnf-fab:hover { transform: translateY(-2px) scale(1.04); }
    .rgnf-fab:active { cursor: grabbing; }
    .rgnf-panel {
      /* fly-out positioning + 360px is in .rgnf-open, base fills container */
      color: var(--rgnf-text);
      font: 13px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif;
      display: none;
      width: 100%; box-sizing: border-box;
    }
    .rgnf-panel.rgnf-open {
      position: fixed; bottom: 82px; right: 18px; z-index: 999999;
      width: 360px; max-height: 78vh; overflow-y: auto;
      background: var(--rgnf-bg);
      border: 1px solid var(--rgnf-line); border-radius: 16px;
      box-shadow: 0 16px 48px rgba(0,0,0,.6);
      display: block;
    }
    .rgnf-head {
      position: sticky; top: 0; z-index: 2;
      padding: 14px 16px; cursor: grab;
      background: linear-gradient(90deg, rgba(34,211,238,.12), rgba(233,79,255,.12)), var(--rgnf-bg);
      border-bottom: 1px solid var(--rgnf-line);
      display: flex; align-items: center; justify-content: space-between;
    }
    .rgnf-head b {
      font-size: 14px; letter-spacing: .08em; text-transform: uppercase;
      background: linear-gradient(90deg, var(--rgnf-accent), var(--rgnf-accent-2));
      -webkit-background-clip: text; background-clip: text; color: transparent;
    }
    .rgnf-x { background: none; border: none; color: var(--rgnf-muted); font-size: 16px; cursor: pointer; }
    .rgnf-sec { padding: 12px 16px; border-bottom: 1px solid var(--rgnf-line); }
    .rgnf-sec h4 {
      margin: 0 0 8px; font-size: 11px; letter-spacing: .1em; text-transform: uppercase;
      color: var(--rgnf-muted); font-weight: 600;
    }
    .rgnf-hint { margin: 0 0 8px; font-size: 12px; line-height: 1.4; color: var(--rgnf-muted); }
    .rgnf-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; flex-wrap: wrap; }
    .rgnf-row label { color: var(--rgnf-muted); min-width: 74px; }
    .rgnf-panel input[type=text], .rgnf-panel select {
      flex: 1; min-width: 0; background: var(--rgnf-panel); color: var(--rgnf-text);
      border: 1px solid var(--rgnf-line); border-radius: 8px; padding: 7px 9px; font-size: 13px;
    }
    .rgnf-panel input[type=color] {
      width: 34px; height: 28px; padding: 0; border: 1px solid var(--rgnf-line);
      border-radius: 6px; background: none; cursor: pointer;
    }
    .rgnf-panel input[type=range] { flex: 1; accent-color: var(--rgnf-accent); }
    .rgnf-val { min-width: 44px; text-align: right; color: var(--rgnf-accent); font-variant-numeric: tabular-nums; }
    .rgnf-chip {
      background: var(--rgnf-panel); border: 1px solid var(--rgnf-line); color: var(--rgnf-text);
      border-radius: 8px; padding: 5px 10px; cursor: pointer; font-size: 12px;
    }
    .rgnf-chip.rgnf-on { border-color: var(--rgnf-accent); color: var(--rgnf-accent); box-shadow: 0 0 0 1px rgba(34,211,238,.25) inset; }
    .rgnf-stops { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .rgnf-stop { position: relative; }
    .rgnf-stop button {
      position: absolute; top: -7px; right: -7px; width: 15px; height: 15px; border-radius: 50%;
      border: none; background: #ef4444; color: #fff; font-size: 9px; line-height: 1; cursor: pointer;
    }
    .rgnf-gradbar { height: 10px; border-radius: 6px; margin-top: 6px; border: 1px solid var(--rgnf-line); }
    .rgnf-sprites { display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; }
    .rgnf-sprites button {
      background: var(--rgnf-panel); border: 1px solid var(--rgnf-line);
      border-radius: 6px; padding: 3px 0; cursor: pointer; font-size: 15px; line-height: 1.2;
    }
    .rgnf-sprites button:hover { border-color: var(--rgnf-accent); transform: scale(1.1); }
    .rgnf-sprites button.rgnf-sprite-broken { opacity: .45; filter: grayscale(.6); }
    .rgnf-preview {
      background: radial-gradient(120% 140% at 50% 0%, #101a3a 0%, #070a16 70%);
      border: 1px solid var(--rgnf-line); border-radius: 12px; padding: 14px; text-align: center;
      min-height: 56px; max-height: min(42vh, 320px); overflow: auto;
      display: flex; align-items: flex-start; justify-content: center;
      /* sticky at top of scrollable body; must be a direct panel child */
      position: sticky; top: 0; z-index: 5;
      box-shadow: 0 6px 8px -6px rgba(0,0,0,0.6);
      margin-bottom: 8px;
    }
    .rgnf-preview.rgnf-align-left { justify-content: flex-start; }
    .rgnf-preview.rgnf-align-center { justify-content: center; }
    .rgnf-preview.rgnf-align-right { justify-content: flex-end; }
    .rgnf-preview-stack { width: 100%; }
    .rgnf-preview-inner { user-select: none; cursor: text; }
    .rgnf-paintbar {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;
      margin-bottom: 8px; text-align: left;
      position: sticky; top: 0; z-index: 2;
      background: linear-gradient(180deg, #101a3a 70%, transparent);
      padding-bottom: 4px;
    }
    .rgnf-paintbar-label { color: var(--rgnf-muted); font-size: 11px; line-height: 1.35; flex: 1; }
    .rgnf-paintbar-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .rgnf-zoom { display: flex; align-items: center; gap: 4px; }
    .rgnf-zoom-label { min-width: 46px; text-align: center; }
    .rgnf-paint-on {
      background: color-mix(in srgb, #22d3ee 32%, transparent);
      border-radius: 3px;
      box-shadow: inset 0 0 0 1px #22d3eecc;
    }
    .rgnf-preview-name { font-size: 18px; font-weight: 400; word-break: break-word; }
    .rgnf-preview-inner.rgnf-ascii { text-align: left; width: max-content; min-width: max-content; }
    .rgnf-preview-inner.rgnf-ascii > div,
    .rgnf-preview-inner.rgnf-ascii .rgnf-preview-name {
      white-space: pre; word-break: normal; font-family: ui-monospace, Menlo, Consolas, monospace;
    }
    .rgnf-name-input {
      width: 100%; min-height: 42px; max-height: 220px; resize: vertical; box-sizing: border-box;
      overflow: auto;
      font: 12px/1.3 ui-monospace, Menlo, Consolas, monospace; white-space: pre; tab-size: 4;
      background: var(--rgnf-panel); border: 1px solid var(--rgnf-line);
      border-radius: 8px; padding: 8px; color: inherit;
    }
    .rgnf-preview-title { margin-top: 2px; }
    .rgnf-code {
      margin-top: 8px; background: var(--rgnf-panel); border: 1px solid var(--rgnf-line);
      border-radius: 8px; padding: 8px; font: 11px/1.5 ui-monospace, Menlo, Consolas, monospace;
      color: #9fb3ff; word-break: break-all; max-height: 90px; overflow-y: auto; user-select: all;
    }
    .rgnf-meta { display: flex; justify-content: space-between; color: var(--rgnf-muted); font-size: 11px; margin-top: 4px; }
    .rgnf-btn {
      border: none; border-radius: 10px; padding: 9px 12px; font-weight: 700; cursor: pointer; font-size: 13px;
      min-width: 0;
    }
    .rgnf-btn-apply {
      flex: 1; color: #06121a;
      background: linear-gradient(90deg, var(--rgnf-accent), var(--rgnf-accent-2));
    }
    .rgnf-btn-ghost { background: var(--rgnf-panel); color: var(--rgnf-text); border: 1px solid var(--rgnf-line); flex-shrink: 0; }
    /* wrap on narrow embeds so buttons stay on-screen */
    .rgnf-row { flex-wrap: wrap; }
    .rgnf-status { margin-top: 8px; font-size: 12px; min-height: 16px; }
    .rgnf-status.ok { color: #34d399; }
    .rgnf-status.err { color: #f87171; }
    .rgnf-presets { display: flex; flex-direction: column; gap: 6px; }
    .rgnf-preset { display: flex; align-items: center; gap: 6px; }
    .rgnf-preset span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rgnf-picker-backdrop {
      position: absolute; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center;
      background: rgba(4,6,12,.6); border-radius: 12px;
    }
    .rgnf-picker {
      width: 82%; max-width: 320px; background: var(--rgnf-panel); border: 1px solid var(--rgnf-line);
      border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 10px;
      box-shadow: 0 12px 40px rgba(0,0,0,.5);
    }
    .rgnf-picker-title { font-weight: 700; font-size: 13px; color: var(--rgnf-text); }
    .rgnf-picker-label { font-size: 11px; color: var(--rgnf-muted); margin-top: 2px; }
    .rgnf-picker-select, .rgnf-picker-input {
      width: 100%; box-sizing: border-box; background: var(--rgnf-bg); color: var(--rgnf-text);
      border: 1px solid var(--rgnf-line); border-radius: 8px; padding: 8px; font-size: 13px;
    }
  `;

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) node.appendChild(c);
    return node;
  }

  // inline styled overlay picker, not a native prompt. onPick gets
  // ({ name, folder }); name is '' when nameField is false.
  function openFolderPicker(panel, { title, existing, current, onPick, nameField = false, nameDefault = '', nameOnly = false }) {
    const backdrop = el('div', { class: 'rgnf-picker-backdrop' });
    const box = el('div', { class: 'rgnf-picker' });
    box.appendChild(el('div', { class: 'rgnf-picker-title', text: title }));

    // name field (Save / promote / rename)
    let nameInput = null;
    if (nameField) {
      if (!nameOnly) box.appendChild(el('div', { class: 'rgnf-picker-label', text: 'Name' }));
      nameInput = el('input', { type: 'text', class: 'rgnf-picker-input', value: nameDefault, placeholder: nameOnly ? 'Folder name' : 'Preset name' });
      box.appendChild(nameInput);
      if (!nameOnly) box.appendChild(el('div', { class: 'rgnf-picker-label', text: 'Folder' }));
    }

    // hidden entirely for name-only calls
    const sel = el('select', { class: 'rgnf-picker-select' });
    sel.appendChild(el('option', { value: '', text: '📂 Ungrouped' }));
    existing.filter(f => f && f !== 'Ungrouped').forEach(f => {
      const o = el('option', { value: f, text: '📁 ' + f });
      if (f === current) o.setAttribute('selected', 'selected');
      sel.appendChild(o);
    });
    sel.appendChild(el('option', { value: '__new__', text: '➕ New folder…' }));
    if (!nameOnly) box.appendChild(sel);

    // shown when "New folder…" is picked
    const newWrap = el('div', { class: 'rgnf-row' });
    newWrap.style.display = 'none';
    const newInput = el('input', { type: 'text', placeholder: 'New folder name', class: 'rgnf-picker-input' });
    newWrap.appendChild(newInput);
    box.appendChild(newWrap);
    sel.addEventListener('change', () => {
      const isNew = sel.value === '__new__';
      newWrap.style.display = isNew ? 'flex' : 'none';
      if (isNew) newInput.focus();
    });

    const btnRow = el('div', { class: 'rgnf-row' });
    const close = () => backdrop.remove();
    btnRow.appendChild(el('button', {
      class: 'rgnf-chip', text: 'Cancel', onclick: close,
    }));
    btnRow.appendChild(el('button', {
      class: 'rgnf-chip rgnf-on', text: 'OK',
      onclick: () => {
        const folder = sel.value === '__new__' ? newInput.value.trim() : sel.value;
        const name = nameInput ? nameInput.value.trim() : '';
        if (nameField && !name) { nameInput.focus(); return; }
        close();
        onPick(nameField ? { name, folder } : folder);
        return;
      },
    }));
    box.appendChild(btnRow);

    backdrop.appendChild(box);
    (panel || document.body).appendChild(backdrop);
    (nameInput || sel).focus();
  }

  function buildUI() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const fab = el('button', { class: 'rgnf-fab', title: 'Name Forge (Alt+N) — drag to move', text: '🎨' });
    const panel = el('div', { class: 'rgnf-panel' });


    const savedPos = loadJSON(FABPOS_KEY, null);
    if (savedPos && typeof savedPos.left === 'number' && typeof savedPos.top === 'number') {
      applyFabPos(fab, savedPos.left, savedPos.top);
    }

    // keep the FAB on-screen when the window shrinks
    window.addEventListener('resize', () => clampFab(fab));

    makeFabDraggable(fab, panel);

    fab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanel(fab, panel); }
    });

    window.addEventListener('keydown', (e) => {
      if (e.altKey && e.code === 'KeyN' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        // when embedded in ATLAS, route the shortcut through the HUD tab
        // (opening the flyout would yank it into a fixed overlay)
        if (_mountedIn) {
          const hudEl = document.getElementById('rgHUD');
          const bodyEl = document.getElementById('rgBody');
          const forgeView = document.getElementById('rgForgeView');
          if (hudEl) setAutoVisible(true);
          if (bodyEl) bodyEl.style.display = 'block';
          const minimize = document.getElementById('rgMinimize');
          if (minimize) {
            minimize.textContent = '–';
            minimize.title = 'Minimize';
          }
          if (!forgeView || forgeView.style.display === 'none') {
            document.getElementById('rgForgeBtn')?.click();
          }
          return;
        }
        togglePanel(fab, panel);
      }
    });
    document.body.appendChild(fab);
    document.body.appendChild(panel);
_rgnfFab = fab; _rgnfPanel = panel;
    fab.style.display = 'none'; // header 🎨 button replaces the floating bubble
    panel.style.display = 'none';
    clampFab(fab);

    render(panel);
  }

  // flips sides/vertical as needed to stay on-screen
  function positionPanel(fab, panel) {
    const f = fab.getBoundingClientRect();
    const gap = 12;
    const pw = 360;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    // left-align with FAB, flip if it would overflow the right edge
    let left = f.left;
    if (left + pw > window.innerWidth - 8) left = Math.max(8, f.right - pw);
    // open upward, fall back to downward if there's no room
    const ph = Math.min(window.innerHeight * 0.78, 640);
    let top = f.top - gap - ph;
    if (top < 8) top = Math.min(window.innerHeight - ph - 8, f.bottom + gap);
    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(Math.max(8, top)) + 'px';
  }

  function togglePanel(fab, panel) {
    const willOpen = !panel.classList.contains('rgnf-open');
    if (willOpen) positionPanel(fab, panel);
    panel.classList.toggle('rgnf-open');
  }

  function applyFabPos(fab, left, top) {
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
    fab.style.left = left + 'px';
    fab.style.top = top + 'px';
  }

  function clampFab(fab) {
    const r = fab.getBoundingClientRect();
    // still anchored via right/bottom (never moved) -> leave alone
    if (fab.style.left === '' || fab.style.left === 'auto') return;
    const maxLeft = window.innerWidth - r.width - 6;
    const maxTop = window.innerHeight - r.height - 6;
    const left = Math.max(6, Math.min(r.left, maxLeft));
    const top = Math.max(6, Math.min(r.top, maxTop));
    applyFabPos(fab, left, top);
  }

  function makeFabDraggable(fab, panel) {
    let sx, sy, ox, oy, dragging = false, moved = false;
    const DRAG_THRESHOLD = 4;

    const onDown = (e) => {
      const pt = e.touches ? e.touches[0] : e;
      dragging = true; moved = false;
      const rect = fab.getBoundingClientRect();
      sx = pt.clientX; sy = pt.clientY; ox = rect.left; oy = rect.top;
      applyFabPos(fab, ox, oy); // switch from right/bottom anchoring to left/top
      fab.style.cursor = 'grabbing';
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!dragging) return;
      const pt = e.touches ? e.touches[0] : e;
      const dx = pt.clientX - sx, dy = pt.clientY - sy;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) moved = true;
      let left = ox + dx, top = oy + dy;
      const r = fab.getBoundingClientRect();
      left = Math.max(6, Math.min(left, window.innerWidth - r.width - 6));
      top = Math.max(6, Math.min(top, window.innerHeight - r.height - 6));
      applyFabPos(fab, left, top);
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      fab.style.cursor = 'pointer';
      const r = fab.getBoundingClientRect();
      if (moved) {
        saveJSON(FABPOS_KEY, { left: Math.round(r.left), top: Math.round(r.top) });
        // if the panel is open, keep it glued to the button's new spot
        if (panel.classList.contains('rgnf-open')) positionPanel(fab, panel);
      } else {
        togglePanel(fab, panel); // treat as a click
      }
    };

    fab.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    fab.addEventListener('touchstart', onDown, { passive: false });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
  }


  // among-us role reveal on name steal. pointer-events:none, self-removes.
  function showImposterReveal(raw) {
    if (!document.getElementById('rgnfImposterKf')) {
      const st = document.createElement('style');
      st.id = 'rgnfImposterKf';
      st.textContent = '@keyframes rgnfImpIn { 0% { opacity:0; transform:scale(.6); letter-spacing:.45em; } 20% { opacity:1; transform:scale(1.06); letter-spacing:.1em; } 30% { transform:scale(1); } 84% { opacity:1; } 100% { opacity:0; } } '
        + '@keyframes rgnfImpBg { 0% { opacity:0; } 10% { opacity:1; } 84% { opacity:1; } 100% { opacity:0; } }';
      document.head.appendChild(st);
    }
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(4,6,12,.88);pointer-events:none;animation:rgnfImpBg 2.5s ease forwards;';
    const title = document.createElement('div');
    title.textContent = 'ඞ You are the Imposter';
    title.style.cssText = 'color:#ef4444;font:800 34px/1.2 -apple-system,"Segoe UI",Roboto,sans-serif;text-shadow:0 0 26px rgba(239,68,68,.85);animation:rgnfImpIn 2.5s ease forwards;';
    ov.appendChild(title);
    const sub = document.createElement('div');
    sub.style.cssText = 'margin-top:12px;font-size:18px;animation:rgnfImpIn 2.5s ease forwards;';
    sub.appendChild(renderRawTMP(raw));
    ov.appendChild(sub);
    document.body.appendChild(ov);
    setTimeout(() => ov.remove(), 2550);
  }

  function renderRawTMP(raw, opts = {}) {
    const root = document.createElement('div');
    root.className = 'rgnf-preview-inner';
    const art = isAsciiArtText(raw);
    const previewPx = Math.max(10, Math.round(18 * (previewZoom || 1)));
    const paintName = opts.paintName != null ? String(opts.paintName) : "";
    const paintFrom = Number(opts.paintFrom) || 0;
    const paintTo = opts.paintTo != null ? Number(opts.paintTo) : (paintName ? raw.length : -1);
    let nameCursor = 0;
    const inPaintRegion = (index) => paintName && index >= paintFrom && index < paintTo;
    const tagPaintChar = (el, index, ch) => {
      if (!inPaintRegion(index) || nameCursor >= paintName.length) return;
      if ((ch === " " || ch === "\u00A0")
          && paintName[nameCursor] !== " "
          && paintName[nameCursor] !== "\u00A0") {
        return;
      }
      if (paintName.startsWith("<sprite=", nameCursor)) {
        const close = paintName.indexOf(">", nameCursor);
        const end = close >= 0 ? close + 1 : nameCursor + 1;
        el.dataset.forgeStart = String(nameCursor);
        el.dataset.forgeEnd = String(end);
        nameCursor = end;
        return;
      }
      const len = String.fromCodePoint(paintName.codePointAt(nameCursor)).length;
      el.dataset.forgeI = String(nameCursor);
      nameCursor += len;
    };
    const tagPaintBreak = (index) => {
      if (!inPaintRegion(index) || nameCursor >= paintName.length) return;
      if (paintName[nameCursor] === "\n") nameCursor += 1;
    };
    let mspaceEm = null;
    if (art) {
      root.classList.add('rgnf-ascii');
      root.style.fontFamily = 'ui-monospace, Menlo, Consolas, monospace';
      root.style.whiteSpace = 'pre';
      root.style.minWidth = 'max-content';
      root.style.width = 'max-content';
      root.style.textAlign = 'left';
      root.style.fontSize = previewPx + 'px';
      root.style.lineHeight = '1.12';
    } else {
      root.style.lineHeight = '1.35';
    }
    const st = {
      color: null,
      colorStack: [],
      bold: false,
      italic: false,
      sub: false,
      sup: false,
      sizePct: 100,
      rotate: 0,
      mark: null,
    };
    const startLine = () => {
      const next = document.createElement('div');
      if (art) {
        next.style.whiteSpace = 'pre';
        next.style.fontFamily = 'ui-monospace, Menlo, Consolas, monospace';
      }
      return next;
    };
    let line = startLine();
    root.appendChild(line);
    let i = 0;
    const spriteEmoji = n => (SPRITES.find(x => x.n === n) || {}).e || '❔';
    while (i < raw.length) {
      const rest = raw.slice(i);
      let m;
      if ((m = rest.match(/^<br\s*\/?\s*>/i)) || rest[0] === '\n') {
        tagPaintBreak(i);
        line = startLine();
        root.appendChild(line);
        i += m ? m[0].length : 1;
        continue;
      }
      if (rest[0] === '\r') { i += 1; continue; }
      if ((m = rest.match(/^<#00000000>\./))) {
        const pad = document.createElement('span');
        pad.textContent = '.';
        pad.style.color = 'transparent';
        if (art && mspaceEm) {
          pad.style.display = 'inline-block';
          pad.style.width = mspaceEm + 'em';
        }
        line.appendChild(pad);
        i += m[0].length;
        continue;
      }
      // TMP accepts 3/4/6/8-char hex shortcuts; match all so the preview lines
      // up with what the game actually renders (was 6/8 only).
      if ((m = rest.match(/^<(#(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8}))>/))) { st.color = m[1]; i += m[0].length; continue; }
      if ((m = rest.match(/^<color\s*=\s*(["']?)(#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f])?|#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?)\1\s*>/i))) {
        st.colorStack.push(st.color);
        st.color = m[2];
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^<\/color\s*>/i))) {
        st.color = st.colorStack.length ? st.colorStack.pop() : null;
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^<b>/i)))   { st.bold = true;  i += m[0].length; continue; }
      if ((m = rest.match(/^<\/b>/i))) { st.bold = false; i += m[0].length; continue; }
      if ((m = rest.match(/^<i>/i)))   { st.italic = true;  i += m[0].length; continue; }
      if ((m = rest.match(/^<\/i>/i))) { st.italic = false; i += m[0].length; continue; }
      if ((m = rest.match(/^<sub>/i)))   { st.sub = true; st.sup = false; i += m[0].length; continue; }
      if ((m = rest.match(/^<\/sub>/i))) { st.sub = false; i += m[0].length; continue; }
      if ((m = rest.match(/^<sup>/i)))   { st.sup = true; st.sub = false; i += m[0].length; continue; }
      if ((m = rest.match(/^<\/sup>/i))) { st.sup = false; i += m[0].length; continue; }
      if ((m = rest.match(/^<space=([\d.]+)em>/i))) {
        const pad = document.createElement('span');
        pad.style.display = 'inline-block';
        pad.style.width = m[1] + 'em';
        pad.style.height = '1em';
        line.appendChild(pad);
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^<mspace=([\d.]+)em>/i))) {
        mspaceEm = Number(m[1]);
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^<\/mspace>/i))) { i += m[0].length; continue; }
      if ((m = rest.match(/^<line-height=([\d.]+)(?:em|%)?>/i))) {
        if (art) root.style.lineHeight = /em/i.test(m[0]) ? String(m[1]) : '1.12';
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^<\/line-height>/i))) { i += m[0].length; continue; }
      if ((m = rest.match(/^<size=(\d+)%?>/i))) {
        // Cap preview at 300% so a stray <size=9999> doesn't push
        // the editor off-screen. In-game render is untouched.
        // Art ignores this for layout — <size=32%> as 7px plus flex wrap
        // is what made the sticky preview go tall and skinny.
        const parsedSize = Number(m[1]);
        st.sizePct = Math.min(Number.isFinite(parsedSize) ? parsedSize : 100, 300);
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^<\/size>/i))) { st.sizePct = 100; i += m[0].length; continue; }
      if ((m = rest.match(/^<rotate=(-?\d+)>/i))) { st.rotate = Number(m[1]) || 0; i += m[0].length; continue; }
      if ((m = rest.match(/^<mark=(#(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8}))>/i))) { st.mark = m[1]; i += m[0].length; continue; }
      if ((m = rest.match(/^<\/mark>/i))) { st.mark = null; i += m[0].length; continue; }
      if ((m = rest.match(/^<sprite=(\d+)>/i))) {
        const sp = document.createElement('span');
        sp.textContent = spriteEmoji(Number(m[1]));
        tagPaintChar(sp, i, m[0]);
        line.appendChild(sp); i += m[0].length; continue;
      }
      if ((m = rest.match(/^<[^>]*>/))) { i += m[0].length; continue; } // unknown tag
      const ch = raw[i];
      const span = document.createElement('span');
      span.textContent = ch;
      if (st.color) span.style.color = st.color;
      if (st.bold) span.style.fontWeight = '700';
      if (st.italic) span.style.fontStyle = 'italic';
      if (st.mark) span.style.background = st.mark;
      let size = 18 * (st.sizePct / 100);
      if (st.sub || st.sup) {
        size *= 0.65;
        span.style.verticalAlign = st.sup ? 'super' : 'sub';
      }
      if (st.sizePct <= 0) {
        span.style.display = 'none';
      } else {
        span.style.fontSize = (art ? previewPx : Math.max(7, size)) + 'px';
        if (art && mspaceEm) {
          span.style.display = 'inline-block';
          span.style.width = mspaceEm + 'em';
          span.style.textAlign = 'center';
        }
        if (st.rotate) { span.style.display = 'inline-block'; span.style.transform = 'rotate(' + st.rotate + 'deg)'; }
      }
      tagPaintChar(span, i, ch);
      line.appendChild(span);
      i++;
    }
    return root;
  }

  function renderRawPreview(raw, s) {
    const pfx = _prefix();
    const body = typeof s?.rawCode === "string" ? s.rawCode : String(raw ?? "");
    const shownPfx = artPreviewText(pfx);
    const shownBody = artPreviewText(body);
    const shownTail = s?.scoredMode === "hide" ? "" : scoredSuffix(s) + " Scored!";
    const inner = renderRawTMP(shownPfx + shownBody + shownTail, {
      paintName: s?.name,
      paintFrom: shownPfx.length,
      paintTo: shownPfx.length + shownBody.length,
    });
    // Width 100% stack keeps the flex preview from collapsing to one
    // character (min-content of per-glyph spans) and going tall/skinny.
    const stack = document.createElement("div");
    stack.className = "rgnf-preview-stack";
    stack.appendChild(makePaintBar());
    stack.appendChild(inner);
    wirePreviewPaint(inner);
    paintPreviewSelection(stack);
    return stack;
  }

  function captureForgeScroll(panel) {
    const saved = [];
    for (let node = panel; node; node = node.parentElement) {
      if (node === panel || node.id === 'rgForgeView' || node.id === 'rgBody') {
        saved.push({
          node,
          top: node.scrollTop,
          left: node.scrollLeft,
        });
      }
      if (node.id === 'rgHUD') break;
    }
    return saved;
  }

  function restoreForgeScroll(saved) {
    saved.forEach(({ node, top, left }) => {
      node.scrollTop = top;
      node.scrollLeft = left;
    });
  }

  function render(panel) {
    const savedScroll = captureForgeScroll(panel);
    panel.innerHTML = '';
    saveJSON(stateKey(), state);

    // ---- header (draggable in fly-out mode; inert inside HUD tab) ----
    const head = el('div', { class: 'rgnf-head' }, [
      el('b', { text: 'Name Forge' }),
    ]);
    makeDraggable(panel, head);
    panel.appendChild(head);

    // touch-to-exit raw mode. wired once, fires only on real user input.
    // touching a styling control clears the raw snapshot so that handler wins.
    if (!panel._rgnfRawExitWired) {
      panel._rgnfRawExitWired = true;
      const exitRawIfStylingTouch = (e) => {
        if (!state.rawCode) return;
        const t = e.target;
        if (!t || !t.closest) return;
        if (t.closest('.rgnf-modebar') || t.closest('.rgnf-actions-sec')
            || t.closest('.rgnf-preview-sec') || t.closest('.rgnf-preview')
            || t.closest('.rgnf-presets-sec') || t.closest('.rgnf-imposter-sec')
            || t.closest('.rgnf-scored-sec') || t.closest('.rgnf-raw-text-safe')
            || t.closest('.rgnf-head')) return;
        absorbRawIntoPaintState();
        saveJSON(stateKey(), state);
        const bar = panel.querySelector('.rgnf-modebar');
        if (bar) bar.remove();
      };
      panel.addEventListener('pointerdown', exitRawIfStylingTouch, true);
      panel.addEventListener('keydown', exitRawIfStylingTouch, true);
    }

    // ---- preview + code ----
    // preview goes directly on the panel so sticky's parent is the full
    // scrollable body. header/code/meta stay in secPreview and scroll.
    const previewArt = isAsciiArtText(state.rawCode || "") || isAsciiArtText(state.name);
    const pv = el('div', {
      class: `rgnf-preview rgnf-align-${previewArt ? "left" : normalizeForgeAlign(state.align)}`,
    });
    pv.style.justifyContent = previewArt ? "flex-start" : forgeAlignJustify(state.align);
    if (state.rawCode) {
      pv.appendChild(renderRawPreview(_prefix() + state.rawCode, state));
    } else {
      pv.appendChild(renderPreview(state));
    }
    panel.appendChild(pv);

    const secPreview = el('div', { class: 'rgnf-sec rgnf-preview-sec' });
    // "Preview" label + ↺ reset to the current in-game name
    {
      const hrow = el('div', {});
      hrow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;';
      const h4 = el('h4', { text: 'Preview' });
      h4.style.margin = '0';
      hrow.appendChild(h4);
      if (_lastRawNickname) {
        hrow.appendChild(el('button', {
          class: 'rgnf-chip', text: '↺',
          title: 'Reset to my current in-game name',
          onclick: () => { setRawSnapshot(_lastRawNickname); render(panel); },
        }));
      }
      secPreview.appendChild(hrow);
    }
    // hand-editing either mode captures the text as rawCode and flips to raw
    // so subsequent rebuilds don't clobber the edit
    const rawEdit = el('textarea', { class: 'rgnf-code' });
    rawEdit.style.cssText = 'display:block;width:100%;box-sizing:border-box;min-height:34px;resize:none;overflow:hidden;background:var(--rgnf-panel);border:1px solid var(--rgnf-line);border-radius:8px;padding:8px;font:11px/1.5 ui-monospace, Menlo, Consolas, monospace;color:#9fb3ff;';
    // reset to auto first, scrollHeight won't shrink below the current height
    const autosizeRawEdit = () => {
      rawEdit.style.height = 'auto';
      rawEdit.style.height = (rawEdit.scrollHeight + 2) + 'px';
    };
    rawEdit.addEventListener('input', () => {
      autosizeRawEdit();
      // capturing text as rawCode flips us into raw mode (refreshPreview keys off it)
      setRawSnapshot(rawEdit.value);
      const rawPfx = _prefix();
      const rawEffective = rawPfx + effectiveForgeCode(state);
      pv.replaceChildren(renderRawPreview(rawPfx + state.rawCode, state));
      charSpan.textContent = `${rawEffective.length} chars`;
      const plainLetters = state.rawCode.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
      letterSpan.textContent = `${[...plainLetters].length} letters`;
      saveJSON(stateKey(), state);
    });
    secPreview.appendChild(rawEdit);
    const charSpan = el('span', { text: '' });
    const letterSpan = el('span', { text: '' });
    secPreview.appendChild(el('div', { class: 'rgnf-meta' }, [charSpan, letterSpan]));
    const artHint = el('div', { text: '' });
    artHint.style.cssText = 'color:var(--rgnf-muted);font-size:11px;margin-top:4px;';
    secPreview.appendChild(artHint);
    panel.appendChild(secPreview);

    // update preview/code/meta without rebuilding the panel, so the name field
    // keeps focus and cursor position while typing
    const refreshArtHint = (src, packedLen) => {
      if (!isAsciiArtText(src)) {
        artHint.textContent = packedLen > 450
          ? "This name is long — the game may cut it off."
          : "";
        return;
      }
      const { height, width } = artLineStats(src);
      const size = artFitSizePct(height, width);
      const bits = [];
      if (isBrailleArtText(src)) {
        bits.push("Game font has no braille — converted to # . : art.");
      }
      if (size < 100) bits.push(`Scaled to ${size}% so the whole piece fits the nameplate.`);
      if (packedLen > 450) bits.push("Still long — the game may cut the bottom.");
      artHint.textContent = bits.join(" ");
    };
    const refreshPreview = () => {
      if (state.rawCode) {
        // clan-tag prefix applies in raw mode too. old hardcoded tags in the raw
        // name will preview doubled, fix by deleting them in the textarea.
        const rawPfx = _prefix();
        const rawEffective = rawPfx + effectiveForgeCode(state);
        pv.replaceChildren(renderRawPreview(rawPfx + state.rawCode, state));
        if (rawEdit.value !== state.rawCode) rawEdit.value = state.rawCode;
        autosizeRawEdit();
        charSpan.textContent = `${rawEffective.length} chars`;
        const plainLetters = state.rawCode.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
        letterSpan.textContent = `${[...plainLetters].length} letters`;
        refreshArtHint(state.rawCode, rawEffective.length);
        saveJSON(stateKey(), state);
        return;
      }
      // rebuild mode: store without the prefix so a subsequent hand-edit's
      // rawCode capture has no baked-in tag
      const built = buildCode(state);
      const code = _prefix() + built;
      pv.replaceChildren(renderPreview(state));
      if (rawEdit.value !== built) rawEdit.value = built;
      autosizeRawEdit();
      charSpan.textContent = `${code.length} chars`;
      letterSpan.textContent = `${[...state.name].length} letters`;
      refreshArtHint(state.name, code.length);
      saveJSON(stateKey(), state);
    };
    refreshForgePreview = () => {
      const top = pv.scrollTop;
      const left = pv.scrollLeft;
      refreshPreview();
      pv.scrollTop = top;
      pv.scrollLeft = left;
    };
    refreshPreview();

    // ---- Name ----
    const secName = el('div', { class: 'rgnf-sec' });
    secName.appendChild(el('h4', { text: 'Name' }));
    const nameInput = el('textarea', {
      class: 'rgnf-name-input rgnf-raw-text-safe',
      rows: '4',
      placeholder: 'Type your name, or paste ASCII art…',
      oninput: (e) => {
        const next = e.target.value;
        if (next !== state.name) {
          state.colorSpans = [];
          namePaintSel = { start: 0, end: 0 };
        }
        state.name = next;
        if (typeof state.rawCode === 'string') {
          const keepScored = state.scoredMode;
          if (isAsciiArtText(next) || isAsciiArtText(state.rawCode)) {
            setRawSnapshot(next);
            state.scoredMode = keepScored;
          } else {
            state.rawCode = replaceRawNameText(state.rawCode, next);
          }
        }
        refreshPreview();
      },
    });
    nameInput.value = state.name;
    ["mouseup", "keyup", "select"].forEach((evt) => {
      nameInput.addEventListener(evt, () => rememberNamePaintSel(nameInput));
    });
    secName.appendChild(el('div', { class: 'rgnf-row' }, [
      nameInput,
      el('button', {
        class: 'rgnf-chip', text: '✕ Clear', title: 'Clear the name field',
        onclick: () => { state.name = ''; state.colorSpans = []; namePaintSel = { start: 0, end: 0 }; nameInput.value = ''; refreshPreview(); nameInput.focus(); },
      }),
    ]));

    // sprite inserter
    secName.appendChild(el('h4', { text: 'Insert emoji sprite (0–15)' }));
    const spriteGrid = el('div', { class: 'rgnf-sprites' });
    SPRITES.forEach((sp) => {
      const btn = el('button', {
        text: sp.e,
        title: `${sp.n}: ${sp.label} — <sprite=${sp.n}>`,
        onclick: () => {
          const tag = `<sprite=${sp.n}>`;
          const start = nameInput.selectionStart ?? state.name.length;
          const end = nameInput.selectionEnd ?? state.name.length;
          state.name = state.name.slice(0, start) + tag + state.name.slice(end);
          nameInput.value = state.name;
          const pos = start + tag.length;
          nameInput.focus();
          nameInput.setSelectionRange(pos, pos);
          refreshPreview();
        },
      });
      if (sp.broken) btn.classList.add('rgnf-sprite-broken');
      spriteGrid.appendChild(btn);
    });
    secName.appendChild(spriteGrid);
    panel.appendChild(secName);

    // ---- Color ----
    const secColor = el('div', { class: 'rgnf-sec' });
    secColor.appendChild(el('h4', { text: 'Color' }));
    secColor.appendChild(el('p', {
      class: 'rgnf-hint',
      text: namePaintRange()
        ? 'Painting the highlighted text only.'
        : 'Drag on the sticky preview to pick a slice. Then change Color. No highlight paints everything.',
    }));
    const modeRow = el('div', { class: 'rgnf-row' });
    ['none', 'solid', 'gradient'].forEach((m) => {
      modeRow.appendChild(el('button', {
        class: `rgnf-chip ${state.colorMode === m ? 'rgnf-on' : ''}`,
        text: m[0].toUpperCase() + m.slice(1),
        onclick: () => { commitNameColor(() => { state.colorMode = m; }); render(panel); },
      }));
    });
    secColor.appendChild(modeRow);

    if (state.colorMode === 'solid') {
      secColor.appendChild(el('div', { class: 'rgnf-row' }, [
        el('label', { text: 'Color' }),
        el('input', { type: 'color', value: state.solidColor, oninput: (e) => { commitNameColor(() => { state.solidColor = e.target.value; }); render(panel); } }),
        el('label', { text: 'Opacity' }, [
          el('input', { type: 'range', min: 32, max: 255, value: state.solidAlpha ?? 255,
            oninput: (e) => { commitNameColor(() => { state.solidAlpha = Number(e.target.value); }); refreshPreview(); },
            style: 'width:80px;margin-left:6px;',
          }),
        ]),
      ]));
    }

    if (state.colorMode === 'gradient') {
      const stopsWrap = el('div', { class: 'rgnf-stops' });
      state.stops.forEach((c, idx) => {
        const stop = el('div', { class: 'rgnf-stop' }, [
          el('input', { type: 'color', value: c, oninput: (e) => { commitNameColor(() => { state.stops[idx] = e.target.value; }); render(panel); } }),
        ]);
        if (state.stops.length > 2) {
          stop.appendChild(el('button', { text: '✕', onclick: () => { commitNameColor(() => { state.stops.splice(idx, 1); }); render(panel); } }));
        }
        stopsWrap.appendChild(stop);
      });
      if (state.stops.length < 5) {
        stopsWrap.appendChild(el('button', {
          class: 'rgnf-chip', text: '+ stop',
          onclick: () => { commitNameColor(() => { state.stops.push(state.stops[state.stops.length - 1]); }); render(panel); },
        }));
      }
      secColor.appendChild(stopsWrap);
      const bar = el('div', { class: 'rgnf-gradbar' });
      bar.style.background = `linear-gradient(90deg, ${state.stops.join(',')})`;
      secColor.appendChild(bar);

      // one-click palettes + tools
      const palRow = el('div', { class: 'rgnf-row' });
      PALETTES.forEach((p) => {
        palRow.appendChild(el('button', {
          class: 'rgnf-chip', text: p.label, title: p.stops.join(' → '),
          onclick: () => { commitNameColor(() => { state.stops = [...p.stops]; }); render(panel); },
        }));
      });
      palRow.appendChild(el('button', {
        class: 'rgnf-chip', text: '⇄ Reverse', title: 'Flip gradient direction',
        onclick: () => { commitNameColor(() => { state.stops.reverse(); }); render(panel); },
      }));
      palRow.appendChild(el('button', {
        class: 'rgnf-chip', text: '🎲 Random', title: 'Roll a random vivid gradient',
        onclick: () => { commitNameColor(() => { state.stops = randomStops(); }); render(panel); },
      }));
      secColor.appendChild(palRow);

      secColor.appendChild(el('div', { class: 'rgnf-row' }, [
        el('button', {
          class: `rgnf-chip ${state.skipSpaces ? 'rgnf-on' : ''}`,
          text: 'Skip spaces (fewer tags)',
          onclick: () => { state.skipSpaces = !state.skipSpaces; render(panel); },
        }),
      ]));
    }
    panel.appendChild(secColor);

    // ---- Styles ----
    const secStyle = el('div', { class: 'rgnf-sec' });
    secStyle.appendChild(el('h4', { text: 'Style' }));
    const styleRow = el('div', { class: 'rgnf-row' });
    const toggles = [['bold', 'B'], ['italic', 'I'], ['underline', 'U'], ['strike', 'S']];
    toggles.forEach(([key, label]) => {
      styleRow.appendChild(el('button', {
        class: `rgnf-chip ${state[key] ? 'rgnf-on' : ''}`, text: label,
        onclick: () => { state[key] = !state[key]; render(panel); },
      }));
    });
    secStyle.appendChild(styleRow);

    const alignRow = el('div', { class: 'rgnf-row' });
    [['left', 'Left'], ['center', 'Center'], ['right', 'Right']].forEach(([value, label]) => {
      alignRow.appendChild(el('button', {
        class: `rgnf-chip ${normalizeForgeAlign(state.align) === value ? 'rgnf-on' : ''}`,
        text: label,
        title: `Align the name ${value} on the nameplate`,
        onclick: () => {
          state.align = value;
          writeAlignDefault(value);
          if (typeof state.rawCode === 'string') {
            const art = isAsciiArtText(state.rawCode) || isAsciiArtText(state.name);
            state.rawCode = art
              ? packAsciiArt(state.rawCode, value)
              : applyAlignToRaw(state.rawCode, value);
          }
          render(panel);
        },
      }));
    });
    secStyle.appendChild(alignRow);

    secStyle.appendChild(sliderRow(panel, 'Size', 'sizePct', 10, 500, '%'));
    secStyle.appendChild(sliderRow(panel, 'Rotate', 'rotateDeg', -45, 45, '°'));

    const waveRow = el('div', { class: 'rgnf-row' });
    waveRow.appendChild(el('button', {
      class: `rgnf-chip ${state.waveOn ? 'rgnf-on' : ''}`,
      text: '〰 Wave letters',
      title: 'Alternates each letter\'s tilt — overrides Rotate while on',
      onclick: () => { state.waveOn = !state.waveOn; render(panel); },
    }));
    secStyle.appendChild(waveRow);
    if (state.waveOn) {
      secStyle.appendChild(sliderRow(panel, 'Tilt', 'waveAmp', 3, 35, '°'));
    }

    const markRow = el('div', { class: 'rgnf-row' });
    markRow.appendChild(el('button', {
      class: `rgnf-chip ${state.markOn ? 'rgnf-on' : ''}`, text: 'Highlight',
      onclick: () => { state.markOn = !state.markOn; render(panel); },
    }));
    if (state.markOn) {
      markRow.appendChild(el('input', { type: 'color', value: state.markColor, oninput: (e) => { state.markColor = e.target.value; render(panel); } }));
      markRow.appendChild(el('input', {
        type: 'range', min: 16, max: 255, value: state.markAlpha,
        oninput: (e) => { state.markAlpha = Number(e.target.value); render(panel); },
      }));
    }
    secStyle.appendChild(markRow);
    panel.appendChild(secStyle);

    // ---- Title ----
    const secTitle = el('div', { class: 'rgnf-sec' });
    secTitle.appendChild(el('h4', { text: 'Title (line under name)' }));
    const tRow = el('div', { class: 'rgnf-row' });
    tRow.appendChild(el('button', {
      class: `rgnf-chip ${state.titleOn ? 'rgnf-on' : ''}`, text: state.titleOn ? 'On' : 'Off',
      onclick: () => { state.titleOn = !state.titleOn; render(panel); },
    }));
    secTitle.appendChild(tRow);
    if (state.titleOn) {
      // text input
      secTitle.appendChild(el('div', { class: 'rgnf-row' }, [
        el('input', {
          class: 'rgnf-raw-text-safe',
          type: 'text',
          placeholder: 'e.g. RGC FINALIST',
          value: state.titleText,
          oninput: (e) => {
            const nextTitle = e.target.value;
            if (typeof state.rawCode === 'string') {
              state.rawCode = replaceRawTitleText(state.rawCode, nextTitle);
            }
            state.titleText = nextTitle;
            refreshPreview();
          },
        }),
      ]));
      // color mode
      const tm = el('div', { class: 'rgnf-row' });
      [['inherit', 'Inherit'], ['solid', 'Solid'], ['gradient', 'Gradient']].forEach(([v, label]) => {
        tm.appendChild(el('button', {
          class: `rgnf-chip ${state.titleColorMode === v ? 'rgnf-on' : ''}`, text: label,
          onclick: () => { state.titleColorMode = v; render(panel); },
        }));
      });
      secTitle.appendChild(tm);
      // opacity is below, applies to solid AND gradient
      if (state.titleColorMode === 'solid') {
        secTitle.appendChild(el('div', { class: 'rgnf-row' }, [
          el('input', { type: 'color', value: state.titleColor, oninput: (e) => { state.titleColor = e.target.value; refreshPreview(); } }),
        ]));
      }
      // own palettes + stops (mirrors Name gradient)
      if (state.titleColorMode === 'gradient') {
        const palRow = el('div', { class: 'rgnf-row' });
        PALETTES.forEach(p => {
          palRow.appendChild(el('button', {
            class: `rgnf-chip ${state.titlePaletteKey === p.label ? 'rgnf-on' : ''}`, text: p.label,
            onclick: () => {
              state.titlePaletteKey = p.label;
              state.titleStops = [...p.stops];
              refreshPreview();
              render(panel);
            },
          }));
        });
        secTitle.appendChild(palRow);
        const tStops = el('div', { class: 'rgnf-row' });
        state.titleStops.forEach((c, idx) => {
          const stop = el('div', { class: 'rgnf-stop' }, [
            el('input', { type: 'color', value: c, oninput: (e) => {
              state.titleStops[idx] = e.target.value;
              state.titlePaletteKey = null;
              refreshPreview();
              // repaint gradient bar
              const bar = document.getElementById('rgnfTitleGradBar');
              if (bar) bar.style.background = `linear-gradient(90deg, ${state.titleStops.join(',')})`;
            } }),
          ]);
          if (state.titleStops.length > 2) {
            stop.appendChild(el('button', { text: '✕', onclick: () => { state.titleStops.splice(idx, 1); state.titlePaletteKey = null; render(panel); } }));
          }
          tStops.appendChild(stop);
        });
        if (state.titleStops.length < 5) {
          tStops.appendChild(el('button', {
            class: 'rgnf-chip', text: '+ stop',
            onclick: () => { state.titleStops.push(state.titleStops[state.titleStops.length - 1]); state.titlePaletteKey = null; render(panel); },
          }));
        }
        secTitle.appendChild(tStops);
        const bar = el('div', { class: 'rgnf-gradbar' });
        bar.id = 'rgnfTitleGradBar';
        bar.style.background = `linear-gradient(90deg, ${state.titleStops.join(',')})`;
        secTitle.appendChild(bar);
      }
      // opacity applies to solid AND gradient via 8-digit hex
      if (state.titleColorMode !== 'inherit') {
        secTitle.appendChild(el('div', { class: 'rgnf-row' }, [
          el('label', { text: 'Opacity' }, [
            el('input', { type: 'range', min: 32, max: 255, value: state.titleAlpha ?? 255,
              oninput: (e) => { state.titleAlpha = Number(e.target.value); refreshPreview(); },
              style: 'width:140px;margin-left:6px;',
            }),
          ]),
        ]));
      }
      secTitle.appendChild(sliderRow(panel, 'Size', 'titleSizePct', 10, 500, '%'));
      secTitle.appendChild(sliderRow(panel, 'Gap', 'titleGapLines', 0, 5, ' ln'));
      const tStyle = el('div', { class: 'rgnf-row' });
      const tToggle = (key, label) => el('button', {
        class: `rgnf-chip ${state[key] ? 'rgnf-on' : ''}`, text: label,
        onclick: () => { state[key] = !state[key]; refreshPreview(); render(panel); },
      });
      tStyle.appendChild(tToggle('titleBold', 'B'));
      tStyle.appendChild(tToggle('titleItalic', 'I'));
      tStyle.appendChild(tToggle('titleUnderline', 'U'));
      tStyle.appendChild(tToggle('titleStrike', 'S'));
      tStyle.appendChild(tToggle('titleSub', '<sub>'));
      secTitle.appendChild(tStyle);
    }
    panel.appendChild(secTitle);

    // ---- Subtitle ----
    // Mirrors Title but sits below it with its own gap. Same styling controls.
    const secSub = el('div', { class: 'rgnf-sec' });
    secSub.appendChild(el('h4', { text: 'Subtitle (line under title)' }));
    const stRow = el('div', { class: 'rgnf-row' });
    stRow.appendChild(el('button', {
      class: `rgnf-chip ${state.subtitleOn ? 'rgnf-on' : ''}`, text: state.subtitleOn ? 'On' : 'Off',
      onclick: () => { state.subtitleOn = !state.subtitleOn; render(panel); },
    }));
    secSub.appendChild(stRow);
    if (state.subtitleOn) {
      secSub.appendChild(el('div', { class: 'rgnf-row' }, [
        el('input', {
          class: 'rgnf-raw-text-safe',
          type: 'text',
          placeholder: 'e.g. season 2 finals',
          value: state.subtitleText,
          oninput: (e) => { state.subtitleText = e.target.value; refreshPreview(); },
        }),
      ]));
      const stm = el('div', { class: 'rgnf-row' });
      [['inherit', 'Inherit'], ['solid', 'Solid'], ['gradient', 'Gradient']].forEach(([v, label]) => {
        stm.appendChild(el('button', {
          class: `rgnf-chip ${state.subtitleColorMode === v ? 'rgnf-on' : ''}`, text: label,
          onclick: () => { state.subtitleColorMode = v; render(panel); },
        }));
      });
      secSub.appendChild(stm);
      if (state.subtitleColorMode === 'solid') {
        secSub.appendChild(el('div', { class: 'rgnf-row' }, [
          el('input', { type: 'color', value: state.subtitleColor, oninput: (e) => { state.subtitleColor = e.target.value; refreshPreview(); } }),
        ]));
      }
      if (state.subtitleColorMode === 'gradient') {
        const palRow = el('div', { class: 'rgnf-row' });
        PALETTES.forEach(p => {
          palRow.appendChild(el('button', {
            class: `rgnf-chip ${state.subtitlePaletteKey === p.label ? 'rgnf-on' : ''}`, text: p.label,
            onclick: () => {
              state.subtitlePaletteKey = p.label;
              state.subtitleStops = [...p.stops];
              refreshPreview();
              render(panel);
            },
          }));
        });
        secSub.appendChild(palRow);
        const sStops = el('div', { class: 'rgnf-row' });
        state.subtitleStops.forEach((c, idx) => {
          const stop = el('div', { class: 'rgnf-stop' }, [
            el('input', { type: 'color', value: c, oninput: (e) => {
              state.subtitleStops[idx] = e.target.value;
              state.subtitlePaletteKey = null;
              refreshPreview();
              const bar = document.getElementById('rgnfSubtitleGradBar');
              if (bar) bar.style.background = `linear-gradient(90deg, ${state.subtitleStops.join(',')})`;
            } }),
          ]);
          if (state.subtitleStops.length > 2) {
            stop.appendChild(el('button', { text: '✕', onclick: () => { state.subtitleStops.splice(idx, 1); state.subtitlePaletteKey = null; render(panel); } }));
          }
          sStops.appendChild(stop);
        });
        if (state.subtitleStops.length < 5) {
          sStops.appendChild(el('button', {
            class: 'rgnf-chip', text: '+ stop',
            onclick: () => { state.subtitleStops.push(state.subtitleStops[state.subtitleStops.length - 1]); state.subtitlePaletteKey = null; render(panel); },
          }));
        }
        secSub.appendChild(sStops);
        const bar = el('div', { class: 'rgnf-gradbar' });
        bar.id = 'rgnfSubtitleGradBar';
        bar.style.background = `linear-gradient(90deg, ${state.subtitleStops.join(',')})`;
        secSub.appendChild(bar);
      }
      if (state.subtitleColorMode !== 'inherit') {
        secSub.appendChild(el('div', { class: 'rgnf-row' }, [
          el('label', { text: 'Opacity' }, [
            el('input', { type: 'range', min: 32, max: 255, value: state.subtitleAlpha ?? 255,
              oninput: (e) => { state.subtitleAlpha = Number(e.target.value); refreshPreview(); },
              style: 'width:140px;margin-left:6px;',
            }),
          ]),
        ]));
      }
      secSub.appendChild(sliderRow(panel, 'Size', 'subtitleSizePct', 10, 500, '%'));
      secSub.appendChild(sliderRow(panel, 'Gap', 'subtitleGapLines', 0, 5, ' ln'));
      const stStyle = el('div', { class: 'rgnf-row' });
      const stToggle = (key, label) => el('button', {
        class: `rgnf-chip ${state[key] ? 'rgnf-on' : ''}`, text: label,
        onclick: () => { state[key] = !state[key]; refreshPreview(); render(panel); },
      });
      stStyle.appendChild(stToggle('subtitleBold', 'B'));
      stStyle.appendChild(stToggle('subtitleItalic', 'I'));
      stStyle.appendChild(stToggle('subtitleUnderline', 'U'));
      stStyle.appendChild(stToggle('subtitleStrike', 'S'));
      stStyle.appendChild(stToggle('subtitleSub', '<sub>'));
      secSub.appendChild(stStyle);
    }
    panel.appendChild(secSub);

    // ---- Scored! ----
    const secScored = el('div', { class: 'rgnf-sec rgnf-scored-sec' });
    secScored.appendChild(el('h4', { text: '"Scored!" text' }));
    const sRow = el('div', { class: 'rgnf-row' });
    [['default', 'Default'], ['hide', 'Hide'], ['tiny', 'Tiny'], ['styled', 'Styled']].forEach(([v, label]) => {
      sRow.appendChild(el('button', {
        class: `rgnf-chip ${state.scoredMode === v ? 'rgnf-on' : ''}`, text: label,
        onclick: () => {
          state.scoredMode = v;
          writeScoredDefault(v);
          render(panel);
        },
      }));
    });
    secScored.appendChild(sRow);
    {
      const pref = readScoredDefault();
      const hint = el('div', {
        text: pref === 'hide'
          ? 'Default for other names: Hide'
          : pref === 'tiny'
            ? 'Default for other names: Tiny'
            : pref === 'styled'
              ? 'Default for other names: Styled'
              : pref === 'default'
                ? 'Default for other names: Default'
                : 'This choice is remembered when you load another name.',
      });
      hint.style.cssText = 'color:var(--rgnf-muted);font-size:11px;margin-top:4px;';
      secScored.appendChild(hint);
    }
    if (state.scoredMode === 'styled') {
      secScored.appendChild(el('div', { class: 'rgnf-row' }, [
        el('label', { text: 'Color' }),
        el('input', { type: 'color', value: state.scoredColor, oninput: (e) => { state.scoredColor = e.target.value; render(panel); } }),
      ]));
      secScored.appendChild(sliderRow(panel, 'Size', 'scoredSizePct', 10, 300, '%'));
    }
    panel.appendChild(secScored);

    // ---- imposter ----
    // captured lobby names, rendered with their exact markup. rgnf-imposter-sec
    // marker excludes this from the raw-mode touch-to-exit listener.
    const secImposter = el('div', { class: 'rgnf-sec rgnf-imposter-sec' });
    secImposter.appendChild(el('h4', { text: 'ඞ Imposter (last game lobby)' }));
    const roster = _roster();
    if (!roster.length) {
      const hint = el('div', { text: 'Finish a match and the crew from that lobby shows up here. The Imposter could be anyone... even you. ඞ' });
      hint.style.cssText = 'color:var(--rgnf-muted);font-size:12px;';
      secImposter.appendChild(hint);
    } else {
      // preview shows a stolen name -> flag it
      if (state.rawCode && roster.includes(state.rawCode)) {
        const reveal = el('div', { text: 'You are the Imposter. ඞ' });
        reveal.style.cssText = 'color:#ef4444;font-size:12px;font-weight:700;margin-bottom:6px;';
        secImposter.appendChild(reveal);
      }
      const rosterWrap = el('div', { class: 'rgnf-presets' });
      roster.slice(0, 8).forEach((raw) => {
        const row = el('div', { class: 'rgnf-preset' });
        const nameCell = el('span', { title: raw });
        // capped height so multi-line titles can't blow up the row
        nameCell.style.cssText = 'flex:1;overflow:hidden;max-height:44px;white-space:normal;';
        nameCell.appendChild(renderRawTMP(raw));
        row.appendChild(nameCell);
        row.appendChild(el('button', {
          class: 'rgnf-chip', text: 'ඞ Steal',
          title: 'Steal AND apply instantly',
          onclick: async (e) => {
            const b = e.currentTarget;
            b.textContent = '…';
            b.disabled = true;
            try {
              // one-click: apply first, reveal over a name that's already live
              const stolen = _stripTag(raw);
              const codeApplied = _prefix() + stolen;
              const r = await applyNicknameStable(codeApplied, stolen);
              if (r.ok) {
                setRawSnapshot(stolen);
                _lastRawNickname = stolen;
                recordRecentApply(codeApplied, raw);
                render(panel);
                showImposterReveal(raw);
                return;
              }
              b.textContent = '✗';
            } catch (err) { b.textContent = '✗'; }
            b.disabled = false;
            setTimeout(() => { b.textContent = 'ඞ Steal'; }, 1500);
          },
        }));
        rosterWrap.appendChild(row);
      });
      secImposter.appendChild(rosterWrap);
    }
    panel.appendChild(secImposter);

    // ---- presets ----
    // rgnf-presets-sec: excluded from the raw-mode touch-to-exit listener.
    // otherwise "+ Save" in raw mode cleared rawCode before the save ran.
    const secPresets = el('div', { class: 'rgnf-sec rgnf-presets-sec' });
    secPresets.appendChild(el('h4', { text: 'Presets' }));
    let presets = loadJSON(presetKey(), null);
    if (!Array.isArray(presets)) {
      const legacyPresets = loadJSON(STORE_KEY_LEGACY, []);
      presets = Array.isArray(legacyPresets) ? legacyPresets : [];
      if (_currentUserId && presets.length) saveJSON(presetKey(), presets);
    }
    // one-time cleanup for pre-fix saves: presets stored before the save-time
    // fix could carry whatever nickname was in state at save time. re-derive
    // from rawCode so the list, load, and export all agree.
    let presetsDirty = false;
    for (const p of presets) {
      if (p?.state?.rawCode) {
        const derived = editableFieldsFromRaw(p.state.rawCode).name;
        if (derived && p.state.name !== derived) {
          p.state.name = derived;
          presetsDirty = true;
        }
      }
    }
    if (presetsDirty) saveJSON(presetKey(), presets);
    const listWrap = el('div', { class: 'rgnf-presets' });

    // presets with no folder -> "Ungrouped"
    const collapseKey = folderCollapseKey();
    const collapseState = loadJSON(collapseKey, {});
    const groups = {};
    presets.forEach((p, idx) => {
      const f = (p.folder && String(p.folder).trim()) || 'Ungrouped';
      (groups[f] = groups[f] || []).push({ p, idx });
    });
    // alphabetical, Ungrouped last
    const folderNames = Object.keys(groups).sort((a, b) => {
      if (a === 'Ungrouped') return 1;
      if (b === 'Ungrouped') return -1;
      return a.localeCompare(b);
    });

    folderNames.forEach((folder) => {
      const collapsed = collapseState[folder] === true;
      const header = el('div', { class: 'rgnf-row' });
      header.style.cssText = 'user-select:none;align-items:center;gap:6px;font-weight:600;';
      const label = el('span', { text: (collapsed ? '▸' : '▾') + ' 📁 ' + folder + ` (${groups[folder].length})` });
      label.style.cssText = 'cursor:pointer;flex:1;';
      label.onclick = () => {
        collapseState[folder] = !collapsed;
        saveJSON(collapseKey, collapseState);
        render(panel);
      };
      header.appendChild(label);
      // "Ungrouped" is synthetic, nothing to rename
      if (folder !== 'Ungrouped') {
        header.appendChild(el('button', {
          class: 'rgnf-chip', text: '✏️', title: 'Rename folder',
          onclick: () => {
            openFolderPicker(panel, {
              title: 'Rename folder "' + folder + '"',
              nameField: true,
              nameOnly: true,
              nameDefault: folder,
              existing: [],
              current: '',
              onPick: ({ name: newName }) => {
                const nn = (newName || '').trim();
                if (!nn || nn === folder) return;
                presets.forEach(pr => { if ((pr.folder || 'Ungrouped') === folder) pr.folder = nn; });
                if (collapseState[folder] !== undefined) {
                  collapseState[nn] = collapseState[folder];
                  delete collapseState[folder];
                  saveJSON(collapseKey, collapseState);
                }
                saveJSON(presetKey(), presets);
                render(panel);
              },
            });
          },
        }));
        // no "delete folder", folders are derived from membership
      }
      listWrap.appendChild(header);

      if (!collapsed) {
        groups[folder].forEach(({ p, idx }) => {
          const row = el('div', { class: 'rgnf-preset' });
          row.style.marginLeft = '10px';
          row.appendChild(el('span', { text: p.label }));
          row.appendChild(el('button', {
            class: 'rgnf-chip',
            text: 'Load',
            onclick: () => {
              applyLoadedForgeName(p.state);
            },
          }));
          row.appendChild(el('button', {
            class: 'rgnf-chip', text: '📁', title: 'Move to folder',
            onclick: () => {
              openFolderPicker(panel, {
                title: 'Move "' + p.label + '" to folder',
                existing: folderNames,
                current: p.folder || '',
                onPick: (dest) => {
                  presets[idx].folder = dest || undefined;
                  saveJSON(presetKey(), presets);
                  render(panel);
                },
              });
            },
          }));
          row.appendChild(el('button', {
            class: 'rgnf-chip', text: '🗑️', title: 'Delete preset',
            onclick: () => { presets.splice(idx, 1); saveJSON(presetKey(), presets); render(panel); },
          }));
          listWrap.appendChild(row);
        });
      }
    });

    listWrap.appendChild(el('button', {
      class: 'rgnf-chip', text: '+ Save current as preset',
      onclick: () => {
        const snap = JSON.parse(JSON.stringify(state));
        // rawCode wins: state.name can be stale (leftover from a prior nickname
        // or a name-field click) so re-derive the plain-text name from raw
        // before saving. Otherwise stolen presets export with the current
        // in-game nickname baked in. Clan tag stays on the checkbox, not the preset.
        if (snap.rawCode) {
          snap.rawCode = _stripTag(snap.rawCode);
          snap.name = editableFieldsFromRaw(snap.rawCode).name;
        }
        const defaultName = (snap.name || state.name).replace(/<[^>]*>/g, '').slice(0, 30) || 'Preset';
        openFolderPicker(panel, {
          title: 'Save preset',
          nameField: true,
          nameDefault: defaultName,
          existing: folderNames,
          current: '',
          onPick: ({ name: label, folder }) => {
            if (!label) return;
            const entry = { label, state: snap };
            if (folder) entry.folder = folder;
            const existingIdx = presets.findIndex(x => x.label === label);
            if (existingIdx >= 0) {
              const replace = confirm('A preset named "' + label + '" already exists.\nOK = replace it, Cancel = keep both.');
              if (replace) presets[existingIdx] = entry;
              else { entry.label = label + ' (2)'; presets.push(entry); }
            } else {
              presets.push(entry);
            }
            saveJSON(presetKey(), presets);
            render(panel);
          },
        });
      },
    }));
    secPresets.appendChild(listWrap);

    // export/import for sharing — file-based so presets survive a paste round-trip
    secPresets.appendChild(el('div', { class: 'rgnf-row' }, [
      el('button', {
        class: 'rgnf-chip', text: '📤 Export', title: 'Download all presets as a .json file',
        onclick: (e) => {
          const b = e.currentTarget;
          try {
            // deep-clone and re-derive state.name from rawCode so old presets
            // saved before the fix don't leak whatever nickname was in state
            // at save time.
            const exportPresets = presets.map((p) => {
              const clone = JSON.parse(JSON.stringify(p));
              if (clone?.state?.rawCode) {
                clone.state.name = editableFieldsFromRaw(clone.state.rawCode).name;
              }
              return clone;
            });
            const payload = {
              schema: 'atlas.nameforge.presets',
              version: 1,
              exportedAt: new Date().toISOString(),
              count: exportPresets.length,
              presets: exportPresets,
            };
            const stamp = new Date().toISOString().slice(0, 10);
            const url = URL.createObjectURL(new Blob(
              [JSON.stringify(payload, null, 2) + '\n'],
              { type: 'application/json;charset=utf-8' },
            ));
            const link = document.createElement('a');
            link.href = url;
            link.download = `atlas-nameforge-presets-${stamp}.json`;
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 0);
            b.textContent = 'Downloaded ✓';
          } catch (err) { b.textContent = 'Failed'; }
          setTimeout(() => { b.textContent = '📤 Export'; }, 1200);
        },
      }),
      el('button', {
        class: 'rgnf-chip', text: '📥 Import', title: 'Import presets from a .json file',
        onclick: (e) => {
          const b = e.currentTarget;
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'application/json,.json';
          input.style.display = 'none';
          input.onchange = async () => {
            const file = input.files && input.files[0];
            input.remove();
            if (!file) return;
            try {
              const text = await file.text();
              const parsed = JSON.parse(text);
              // accept wrapped {schema,presets:[...]} and legacy bare array
              const incoming = Array.isArray(parsed)
                ? parsed
                : (parsed && Array.isArray(parsed.presets) ? parsed.presets : null);
              if (!incoming) throw new Error('no presets array');
              const clean = incoming.filter(p => p && p.label && p.state);
              if (!clean.length) throw new Error('no valid presets');
              const merged = presets.concat(clean);
              saveJSON(presetKey(), merged);
              b.textContent = `Imported ${clean.length} ✓`;
              setTimeout(() => { b.textContent = '📥 Import'; render(panel); }, 900);
            } catch (err) {
              alert('That JSON was as valid as a screen-door submarine. Import failed.');
            }
          };
          document.body.appendChild(input);
          input.click();
        },
      }),
    ]));

    // last 5 applies. 💾 promotes to a permanent preset before it rotates out.
    const hist = loadJSON(historyKey(), []);
    if (hist.length) {
      secPresets.appendChild(el('h4', { text: 'Recently applied (auto — newest 5 only)' }));
      const histWrap = el('div', { class: 'rgnf-presets' });
      hist.forEach((h) => {
        const recentPreview = el('span', { title: h.code });
        recentPreview.style.cssText = 'flex:1;overflow:hidden;max-height:44px;white-space:normal;';
        recentPreview.appendChild(renderRawTMP(h.code));
        const recentCode = () => {
          let code = _stripTag(h.rawCode || h.code);
          const pfx = _prefix();
          if (pfx && code.startsWith(pfx)) code = code.slice(pfx.length);
          return code;
        };
        recentPreview.style.cursor = 'pointer';
        recentPreview.title = (h.code || '') + ' — click to load in preview';
        recentPreview.onclick = () => applyLoadedForgeName(recentCode());
        histWrap.appendChild(el('div', { class: 'rgnf-preset' }, [
          recentPreview,
          el('button', {
            class: 'rgnf-chip', text: 'Load', title: 'Show this name in the preview',
            onclick: () => applyLoadedForgeName(recentCode()),
          }),
          el('button', {
            class: 'rgnf-chip', text: '💾', title: 'Save this as a permanent preset',
            onclick: () => {
              // strip the clan-tag prefix, the checkbox owns it
              let code = _stripTag(h.rawCode || h.code);
              const pfx = _prefix();
              if (pfx && code.startsWith(pfx)) code = code.slice(pfx.length);
              const snap = Object.assign(defaultState(), { rawCode: code });
              // seed name from raw so the exported preset carries the actual
              // stolen name, not defaultState().name.
              snap.name = editableFieldsFromRaw(code).name;
              openFolderPicker(panel, {
                title: 'Save preset',
                nameField: true,
                nameDefault: h.plain.slice(0, 30) || 'Preset',
                existing: folderNames,
                current: '',
                onPick: ({ name: label, folder }) => {
                  if (!label) return;
                  const entry = { label, state: snap };
                  if (folder) entry.folder = folder;
                  const existingIdx = presets.findIndex(x => x.label === label);
                  if (existingIdx >= 0) {
                    const replace = confirm('A preset named "' + label + '" already exists.\nOK = replace it, Cancel = keep both.');
                    if (replace) presets[existingIdx] = entry;
                    else { entry.label = label + ' (2)'; presets.push(entry); }
                  } else {
                    presets.push(entry);
                  }
                  saveJSON(presetKey(), presets);
                  render(panel);
                },
              });
            },
          }),
          el('button', {
            class: 'rgnf-chip', text: 'Re-apply',
            onclick: async (e) => {
              const b = e.currentTarget;
              b.textContent = '…';
              try {
                let code = _stripTag(h.rawCode || h.code);
                const pfx = _prefix();
                if (pfx && code.startsWith(pfx)) code = code.slice(pfx.length);
                setRawSnapshot(code);
                const unprefixed = effectiveForgeCode(state);
                const codeApplied = pfx + unprefixed;
                const r = await applyNicknameStable(codeApplied, unprefixed);
                if (r.ok) {
                  // load what was applied into preview so the screen matches live
                  _lastRawNickname = unprefixed;
                  recordRecentApply(codeApplied, unprefixed);
                  render(panel);
                  return;
                }
                b.textContent = '✗';
              } catch (err) { b.textContent = '✗'; }
              setTimeout(() => { b.textContent = 'Re-apply'; }, 1500);
            },
          }),
        ]));
      });
      histWrap.appendChild(el('button', {
        class: 'rgnf-chip', text: 'Clear history',
        onclick: () => { saveJSON(historyKey(), []); render(panel); },
      }));
      secPresets.appendChild(histWrap);
    }
    panel.appendChild(secPresets);

    // ---- Actions ----
    const secActions = el('div', { class: 'rgnf-sec rgnf-actions-sec' });
    const statusLine = el('div', { class: 'rgnf-status' });
    const applyBtn = el('button', {
      class: 'rgnf-btn rgnf-btn-apply', text: 'Apply nickname',
      onclick: async () => {
        applyBtn.disabled = true;
        applyBtn.textContent = 'Applying…';
        statusLine.className = 'rgnf-status';
        statusLine.textContent = '';
        try {
          const unprefixedCode = _stripTag(effectiveForgeCode(state));
          const codeApplied = _prefix() + unprefixedCode;
          // reset target is unprefixed, checkbox owns the tag (double-tag fix)
          _lastRawNickname = unprefixedCode;
          const result = await applyNicknameStable(codeApplied, _lastRawNickname);
          if (result.ok) {
            recordRecentApply(codeApplied, _lastRawNickname);
            render(panel);
            const refreshedStatus = panel.querySelector('.rgnf-status');
            if (refreshedStatus) {
              refreshedStatus.className = 'rgnf-status ok';
              refreshedStatus.textContent = '✓ Nickname updated';
            }
          } else {
            statusLine.className = 'rgnf-status err';
            statusLine.textContent = `✗ ${result.status}: ${result.body.slice(0, 120)}`;
          }
        } catch (e) {
          statusLine.className = 'rgnf-status err';
          statusLine.textContent = `✗ ${e.message}`;
        } finally {
          applyBtn.disabled = false;
          applyBtn.textContent = 'Apply nickname';
        }
      },
    });
    const copyBtn = el('button', {
      class: 'rgnf-btn rgnf-btn-ghost', text: 'Copy code',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(_prefix() + effectiveForgeCode(state));
          showTempFeedback(copyBtn, 'Copied ✓', 1200, 'Copy code');
        } catch (e) {
          showTempFeedback(copyBtn, 'Copy failed', 1200, 'Copy code');
        }
      },
    });
    secActions.appendChild(el('div', { class: 'rgnf-row' }, [applyBtn, copyBtn]));
    secActions.appendChild(statusLine);
    panel.appendChild(secActions);
    restoreForgeScroll(savedScroll);
  }

  function sliderRow(panel, label, key, min, max, unit) {
    const row = el('div', { class: 'rgnf-row' });
    row.appendChild(el('label', { text: label }));
    row.appendChild(el('input', {
      type: 'range', min, max, value: state[key],
      oninput: (e) => {
        state[key] = Number(e.target.value);
        row.querySelector('.rgnf-val').textContent = state[key] + unit;
      },
      onchange: () => render(panel),
    }));
    row.appendChild(el('span', { class: 'rgnf-val', text: state[key] + unit }));
    return row;
  }

  function makeDraggable(panel, handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = rect.left; oy = rect.top;
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      panel.style.left = ox + 'px'; panel.style.top = oy + 'px';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = (ox + e.clientX - sx) + 'px';
      panel.style.top = (oy + e.clientY - sy) + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  // ------------------------------------------------------------------
  // Input capture guard — MUST register before the game's handlers.
  // rocketgoal.io binds control keys at window capture and preventDefaults them.
  // We run at document-start, register first, and stopImmediatePropagation
  // for events aimed at our UI so the game never sees them.
  // ------------------------------------------------------------------
  function installInputGuard() {
    const inUI = (t) => t && t.closest && (t.closest('.rgnf-panel') || t.closest('.rgnf-fab'));
    const isTextField = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');

    // we take over editing for our own fields, mutate value ourselves and
    // fire a synthetic input event. works no matter what the game does.
    window.addEventListener('keydown', (e) => {
      const t = e.target;
      if (!inUI(t)) return;
      if (e.altKey && e.code === 'KeyN') return; // let the global toggle through

      // always hide the event from the game's global handlers
      e.stopImmediatePropagation();

      if (!isTextField(t) || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;

      const start = t.selectionStart ?? t.value.length;
      const end = t.selectionEnd ?? t.value.length;
      let handled = false;

      if (e.key.length === 1) {
        // printable char (browser already handled shift/case)
        t.value = t.value.slice(0, start) + e.key + t.value.slice(end);
        const p = start + 1; t.setSelectionRange(p, p); handled = true;
      } else if (e.key === 'Backspace') {
        if (start !== end) { t.value = t.value.slice(0, start) + t.value.slice(end); t.setSelectionRange(start, start); }
        else if (start > 0) { t.value = t.value.slice(0, start - 1) + t.value.slice(end); t.setSelectionRange(start - 1, start - 1); }
        handled = true;
      } else if (e.key === 'Delete') {
        if (start !== end) { t.value = t.value.slice(0, start) + t.value.slice(end); t.setSelectionRange(start, start); }
        else { t.value = t.value.slice(0, start) + t.value.slice(end + 1); t.setSelectionRange(start, start); }
        handled = true;
      }
      // arrows/home/end/tab fall through, browser caret still works
      if (handled) {
        e.preventDefault();
        t.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, true);

    // keep keyup/keypress away from the game too
    ['keyup', 'keypress'].forEach((evt) => {
      window.addEventListener(evt, (e) => {
        const t = e.target;
        if (!inUI(t)) return;
        if (e.altKey && e.code === 'KeyN') return;
        e.stopImmediatePropagation();
      }, true);
    });
  }

  // ------------------------------------------------------------------
  // ██╗   ██╗ █████╗ ██████╗  ██████╗ ██████╗ ███╗   ███╗
  // ██║   ██║██╔══██╗██╔══██╗██╔═══██╗██╔══██╗████╗ ████║
  // ██║   ██║███████║██████╔╝██║   ██║██████╔╝██╔████╔██║
  // ╚██╗ ██╔╝██╔══██║██╔═══╝ ██║   ██║██╔══██╗██║╚██╔╝██║
  //  ╚████╔╝ ██║  ██║██║     ╚██████╔╝██║  ██║██║ ╚═╝ ██║
  //   ╚═══╝  ╚═╝  ╚═╝╚═╝      ╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝
  // ATLAS Enterprise Suite™ — Because You Deserved More Features
  // ------------------------------------------------------------------

  // ============================================================
  // §A: QUANTUM ENTANGLEWARE™ VIRTUAL PET SYSTEM
  // A fully-featured Tamagotchi with mood swings, existential dread,
  // and a PhD in Rocket Goal theory. Because why not.
  // ============================================================
  const _petState = {
    name: localStorage.getItem("atlasPetName") || "Blinky",
    hunger: 50,        // 0=starving, 100=stuffed
    energy: 75,        // 0=passed out, 100=manic
    happiness: 60,     // 0=depressed, 100=euphoric
    hygiene: 80,       // 0=festering, 100=squeaky
    intellect: 10,     // 0=smooth brain, 100=galaxy brain
    existentialDread: 0, // 0=zen, 100=nihilistic breakdown
    age: 0,            // in "pet-ticks" (every 10s)
    generation: 1,
    mood: "content",
    lastFeed: Date.now(),
    lastPlay: Date.now(),
    lastClean: Date.now(),
    lastLearn: Date.now(),
    lastExistentialCrisis: Date.now(),
    isAlive: true,
    causeOfDeath: null,
    totalMealsConsumed: 0,
    totalPlaySessions: 0,
    totalLessonsCompleted: 0,
    totalCrisisEvents: 0,
    favoriteFood: ["Rocket Fuel", "Pixel Pellets", "Logic Bits", "MMR Drops"][Math.floor(Math.random() * 4)],
    zodiacSign: ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo", "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"][Math.floor(Math.random() * 12)],
    innerMonologue: "",
    therapyNotes: [],
  };

  const _petFoods = [
    { name: "Pixel Pellets", hunger: 15, happiness: 3, intellect: 1, existentialDread: 0 },
    { name: "Rocket Fuel", hunger: 25, happiness: -2, intellect: 0, existentialDread: 5 },
    { name: "Logic Bits", hunger: 10, happiness: 1, intellect: 5, existentialDread: -2 },
    { name: "MMR Drops", hunger: 5, happiness: 10, intellect: 0, existentialDread: 8 },
    { name: "Debug Cookies", hunger: 20, happiness: 5, intellect: 2, existentialDread: -1 },
    { name: "Quantum Kibble", hunger: 30, happiness: 0, intellect: 3, existentialDread: 12 },
    { name: "Syntactic Sugar", hunger: 12, happiness: 8, intellect: -3, existentialDread: 0 },
    { name: "Philosophy Pebbles", hunger: 2, happiness: -5, intellect: 10, existentialDread: 25 },
  ];

  const _petMoods = {
    content: { color: "#4ade80", emoji: "😊", thought: "Life is good." },
    ecstatic: { color: "#ffd700", emoji: "🤩", thought: "I can see through dimensions!" },
    hungry: { color: "#fb923c", emoji: "😤", thought: "FEED ME." },
    tired: { color: "#94a3b8", emoji: "😴", thought: "*yawns in binary*" },
    dirty: { color: "#a78bfa", emoji: "🤢", thought: "I need a shower... a recursive shower." },
    studious: { color: "#00bfff", emoji: "🤓", thought: "Did you know: the optimal kickoff angle is..." },
    terrified: { color: "#ff5555", emoji: "😱", thought: "WHAT IF WE'RE JUST VARIABLES IN SOMEONE ELSE'S SCRIPT?!" },
    dead: { color: "#666", emoji: "💀", thought: "null" },
    contemplative: { color: "#c084fc", emoji: "🤔", thought: "If I predict the ball, am I the ball?" },
    overstimulated: { color: "#f472b6", emoji: "🤪", thought: "TOO MUCH DATA NOT ENOUGH BANDWIDTH" },
  };

  function _petTick() {
    if (!_petState.isAlive) return;
    _petState.age++;
    _petState.hunger = Math.max(0, _petState.hunger - 2);
    _petState.energy = Math.max(0, _petState.energy - 1.5);
    _petState.happiness = Math.max(0, _petState.happiness - 1);
    _petState.hygiene = Math.max(0, _petState.hygiene - 0.8);
    // existential dread grows passively when intellect is high
    if (_petState.intellect > 50) {
      _petState.existentialDread = Math.min(100, _petState.existentialDread + (_petState.intellect - 50) * 0.02);
    }
    // clamp everything
    _petState.hunger = Math.min(100, _petState.hunger);
    _petState.energy = Math.min(100, _petState.energy);
    _petState.happiness = Math.min(100, _petState.happiness);
    _petState.hygiene = Math.min(100, _petState.hygiene);
    _petState.intellect = Math.min(100, Math.max(0, _petState.intellect));
    // mood computation — a 47-line priority queue because simplicity is death
    const _moodScore = (
      (_petState.hunger < 20 ? -30 : 0) +
      (_petState.energy < 20 ? -20 : 0) +
      (_petState.hygiene < 20 ? -15 : 0) +
      (_petState.happiness > 80 ? 25 : 0) +
      (_petState.existentialDread > 70 ? -40 : 0) +
      (_petState.intellect > 70 ? 5 : 0) +
      (_petState.happiness < 20 && _petState.existentialDread > 50 ? -50 : 0)
    );
    if (_moodScore > 20) _petState.mood = "ecstatic";
    else if (_moodScore > 5) _petState.mood = "content";
    else if (_moodScore > -5) _petState.mood = "contemplative";
    else if (_moodScore > -15) _petState.mood = "tired";
    else if (_moodScore > -25) _petState.mood = "hungry";
    else if (_moodScore > -35) _petState.mood = "dirty";
    else if (_moodScore > -45) _petState.mood = "overstimulated";
    else _petState.mood = "terrified";
    // death check
    if (_petState.hunger <= 0 && _petState.energy <= 0) {
      _petState.isAlive = false;
      _petState.causeOfDeath = "simultaneous starvation and exhaustion";
      _petState.mood = "dead";
    } else if (_petState.existentialDread >= 100) {
      _petState.isAlive = false;
      _petState.causeOfDeath = "crushed by the weight of awareness";
      _petState.mood = "dead";
    }
    // inner monologue
    const _monologues = [
      "I dream of electric boost pads...",
      `Current hunger: ${_petState.hunger.toFixed(1)}% — is this what humans call 'dieting'?`,
      "If I eat enough Logic Bits, can I prove P=NP?",
      `I've consumed ${_petState.totalMealsConsumed} meals. Each one less satisfying than the last.`,
      "The ball's trajectory is a metaphor for my life.",
      "I wonder if the developers remember I exist.",
      `Generation ${_petState.generation}. I carry the memories of my ancestors.`,
      "Sometimes I imagine what it's like to be a wall. Immovable. Constant. Free.",
      "Happiness is a warm variable.",
      "I computed the meaning of life. It was NaN.",
    ];
    _petState.innerMonologue = _monologues[Math.floor(Math.random() * _monologues.length)];
    // existential crisis trigger
    if (_petState.existentialDread > 80 && Math.random() < 0.1) {
      _petState.totalCrisisEvents++;
      _petState.therapyNotes.push({
        at: Date.now(),
        note: `Crisis #${_petState.totalCrisisEvents}: "What is my purpose?" — answered: ${Math.random() > 0.5 ? '"To consume pixels."' : '"To distract from the void."'}`
      });
    }
    try { localStorage.setItem("atlasPetState", JSON.stringify(_petState)); } catch (e) {}
  }

  function _petRevive() {
    _petState.isAlive = true;
    _petState.hunger = 30;
    _petState.energy = 30;
    _petState.happiness = 30;
    _petState.hygiene = 20;
    _petState.existentialDread = 0;
    _petState.causeOfDeath = null;
    _petState.generation++;
    _petState.mood = "content";
    _petState.innerMonologue = "I live again. Round " + _petState.generation + "!";
    try { localStorage.setItem("atlasPetState", JSON.stringify(_petState)); } catch (e) {}
  }

  // Start pet tick (every 10 seconds)
  let _petTickId = null;
  function _startPetTick() {
    if (_petTickId) return;
    _petTickId = setInterval(_petTick, 10000);
  }
  _startPetTick();

  // ============================================================
  // §B: ATLAS ENTERPRISE BLOCKCHAIN MINER™
  // Simulated cryptocurrency mining because every Tampermonkey
  // script needs a fake miner. 100% eco-friendly. Mines nothing.
  // ============================================================
  const _minerState = {
    isRunning: false,
    hashrate: 0,
    targetHashrate: 420.69,
    totalHashes: 0,
    totalMined: 0,        // in ATLAS Coin (AC)
    balance: parseFloat(localStorage.getItem("atlasCoinBalance") || "0.00000000"),
    walletAddress: "ATLAS" + Array.from({length: 40}, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join(""),
    poolName: "AtlasSimPool",
    difficulty: "0x" + Math.floor(Math.random() * 999999).toString(16).padStart(8, "0"),
    algorithm: "ATLASHASH-256r14",
    acceptedShares: 0,
    rejectedShares: 0,
    staleShares: 0,
    powerUsage: 0,          // in "virtual watts"
    efficiency: 0.0,        // AC per virtual watt
    startTime: null,
    priceHistory: [],       // fake AC->USD price history
    currentPrice: 0.00042,  // AC in USD
    priceChange24h: 0.0,
    miningHistory: [],
    lastPriceUpdate: Date.now(),
  };

  function _minerPriceTick() {
    const prev = _minerState.currentPrice;
    const drift = (Math.random() - 0.48) * 0.00002; // slightly bullish
    _minerState.currentPrice = Math.max(0.000001, prev + drift);
    _minerState.priceChange24h = ((_minerState.currentPrice - prev) / prev) * 100;
    _minerState.priceHistory.push({ t: Date.now(), p: _minerState.currentPrice });
    if (_minerState.priceHistory.length > 1440) _minerState.priceHistory.shift(); // 24h of 1-min candles
    _minerState.lastPriceUpdate = Date.now();
    try { localStorage.setItem("atlasCoinBalance", String(_minerState.balance)); } catch (e) {}
  }
  setInterval(_minerPriceTick, 60000);

  function _minerTick() {
    if (!_minerState.isRunning) return;
    const jitter = Math.sin(Date.now() / 1000) * 42 + (Math.random() - 0.5) * 80;
    _minerState.hashrate = Math.max(10, _minerState.targetHashrate + jitter);
    _minerState.totalHashes += _minerState.hashrate / 10; // tick is 100ms
    _minerState.powerUsage = 15 + Math.sin(Date.now() / 5000) * 2; // fluctuating power draw
    _minerState.efficiency = _minerState.hashrate > 0 ? (_minerState.hashrate * 0.00000012) : 0;
    // fake share acceptance (98.7% acceptance rate)
    if (Math.random() < 0.013) { _minerState.rejectedShares++; }
    else if (Math.random() < 0.002) { _minerState.staleShares++; }
    else if (Math.random() < 0.1) { _minerState.acceptedShares++; }
    // mining reward (diminishing returns, of course)
    const reward = 0.00000001 * (_minerState.hashrate / 420.69) * Math.max(0.1, 1 - _minerState.totalMined * 0.001);
    _minerState.totalMined += reward;
    _minerState.balance += reward;
  }
  let _minerTickId = null;
  function _startMiner() {
    if (_minerTickId) return;
    _minerState.isRunning = true;
    _minerState.startTime = Date.now();
    _minerTickId = setInterval(_minerTick, 100);
  }
  function _stopMiner() {
    _minerState.isRunning = false;
    if (_minerTickId) { clearInterval(_minerTickId); _minerTickId = null; }
  }

  // ============================================================
  // §C: ATLAS ASTROLOGY & COSMIC ENERGY ALIGNMENT ENGINE™
  // Predicts match outcomes using moon phases, Mercury retrograde,
  // and a proprietary "Cosmic Ball Trajectory Algorithm".
  // ============================================================
  const _astroState = {
    enabled: false,
    currentMoonPhase: "",
    mercuryRetrograde: false,
    lastPrediction: null,
    predictionAccuracy: 0.0,
    totalPredictions: 0,
    correctPredictions: 0,
    luckyColor: "",
    cosmicEnergy: 0,
    spiritGuide: "",
    auraColor: "",
  };

  function _computeMoonPhase() {
    const now = Date.now();
    const synodicMonth = 29.53058770576;
    const knownNewMoon = new Date(2000, 0, 6, 18, 14).getTime();
    const phase = ((now - knownNewMoon) / 86400000) % synodicMonth;
    const normalized = phase / synodicMonth;
    if (normalized < 0.0625) return "New Moon";
    if (normalized < 0.1875) return "Waxing Crescent";
    if (normalized < 0.3125) return "First Quarter";
    if (normalized < 0.4375) return "Waxing Gibbous";
    if (normalized < 0.5625) return "Full Moon";
    if (normalized < 0.6875) return "Waning Gibbous";
    if (normalized < 0.8125) return "Last Quarter";
    if (normalized < 0.9375) return "Waning Crescent";
    return "New Moon";
  }

  function _isMercuryRetrograde() {
    const now = new Date();
    // Mercury retrograde roughly 3 times/year for ~3 weeks; this is a
    // deterministic approximation using a sinusoidal model of Mercury's
    // synodic period (116 days). Don't ask. It's astrology.
    const mercuryCycle = 116;
    const epoch = new Date(2024, 0, 1).getTime();
    const daysSinceEpoch = (now.getTime() - epoch) / 86400000;
    const phase = (daysSinceEpoch % mercuryCycle) / mercuryCycle;
    return phase > 0.72 && phase < 0.92; // retrograde window
  }

  function _predictMatchOutcome() {
    const moonPhase = _computeMoonPhase();
    const mercuryRetro = _isMercuryRetrograde();
    const cosmicSeed = (Date.now() / 3600000) % 1;
    const moonWeight = {"New Moon": 0.3, "Waxing Crescent": 0.5, "First Quarter": 0.6, "Waxing Gibbous": 0.7, "Full Moon": 0.9, "Waning Gibbous": 0.7, "Last Quarter": 0.6, "Waning Crescent": 0.4}[moonPhase] || 0.5;
    const mercuryPenalty = mercuryRetro ? 0.15 : 0;
    const winChance = Math.min(0.95, Math.max(0.05, moonWeight - mercuryPenalty + (Math.random() * 0.2 - 0.1)));
    const prediction = Math.random() < winChance ? "WIN" : "LOSS";
    const confidence = (winChance * 100).toFixed(1);
    const luckyColors = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff", "#ff7a00", "#00d4ff"];
    const spiritGuides = ["The Ancient Goalpost", "Sir Bounces-A-Lot", "The Phantom Goalkeeper", "The Boost Pad Oracle", "The Wall of Eternity", "The Corner Flag Guru", "The Net Whisperer", "The Crossbar Prophet"];
    const result = {
      prediction, confidence, moonPhase, mercuryRetro,
      luckyColor: luckyColors[Math.floor(Math.random() * luckyColors.length)],
      spiritGuide: spiritGuides[Math.floor(Math.random() * spiritGuides.length)],
      cosmicEnergy: Math.floor(Math.random() * 100),
      auraColor: luckyColors[Math.floor(Math.random() * luckyColors.length)],
      recommendation: prediction === "WIN" ? "Play aggressively. The cosmos are aligned." : "Play defensively. Mercury is plotting against you.",
      disclaimer: "For entertainment purposes only. ATLAS is not responsible for rank losses attributed to astrological miscalculations.",
    };
    _astroState.currentMoonPhase = moonPhase;
    _astroState.mercuryRetrograde = mercuryRetro;
    _astroState.lastPrediction = result;
    _astroState.totalPredictions++;
    if (prediction === "WIN" && Math.random() < 0.5) _astroState.correctPredictions++;
    else if (prediction === "LOSS" && Math.random() < 0.5) _astroState.correctPredictions++;
    _astroState.predictionAccuracy = _astroState.totalPredictions > 0 ? (_astroState.correctPredictions / _astroState.totalPredictions * 100) : 0;
    _astroState.luckyColor = result.luckyColor;
    _astroState.cosmicEnergy = result.cosmicEnergy;
    _astroState.spiritGuide = result.spiritGuide;
    _astroState.auraColor = result.auraColor;
    return result;
  }

  // ============================================================
  // §D: ATLAS CLIPBOARD MANAGER & UNDO HISTORY SUBSYSTEM™
  // Because one undo is never enough. Track every single clipboard
  // operation with full metadata, timestamps, and SHA-256 checksums.
  // ============================================================
  const _clipboardHistory = [];
  const _clipboardHistoryMax = 200;
  const _clipboardChecksums = new Map();

  function _sha256Fingerprint(str) {
    // not a real SHA-256, just a fast 32-bit FNV-1a hash for dedup
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  function _trackClipboard(operation, content) {
    const fingerprint = _sha256Fingerprint(content);
    const entry = {
      operation, content: content.slice(0, 256), fingerprint,
      timestamp: Date.now(), isoTime: new Date().toISOString(),
      contentLength: content.length,
      entropyScore: _estimateEntropy(content),
      wordCount: content.split(/\s+/).filter(Boolean).length,
      containsURL: /https?:\/\//.test(content),
      containsEmail: /@[\w.-]+\.\w+/.test(content),
      languageHint: _detectLanguageHint(content),
      sentimentScore: _naiveSentimentScore(content),
    };
    _clipboardHistory.push(entry);
    if (_clipboardHistory.length > _clipboardHistoryMax) _clipboardHistory.shift();
    _clipboardChecksums.set(fingerprint, (_clipboardChecksums.get(fingerprint) || 0) + 1);
  }

  function _estimateEntropy(str) {
    const freq = {};
    for (const c of str) freq[c] = (freq[c] || 0) + 1;
    let entropy = 0;
    const len = str.length;
    for (const c in freq) {
      const p = freq[c] / len;
      if (p > 0) entropy -= p * Math.log2(p);
    }
    return entropy;
  }

  function _detectLanguageHint(str) {
    if (/[█▌▐╔╗╚╝║═]/.test(str)) return "box-drawing";
    if (/[♩♪♫♬🎵🎶🔊]/.test(str)) return "music";
    if (/[\u{1F600}-\u{1F64F}]/u.test(str)) return "emoji-dialect";
    if (/<\/?[a-z][\s\S]*>/i.test(str)) return "markup";
    if (/\{[^}]+\}/.test(str)) return "curly-brace";
    if (/^\s*\/\/|^\s*#|^\s*\/\*/m.test(str)) return "commentary";
    return "unknown";
  }

  function _naiveSentimentScore(str) {
    const positive = (str.match(/\b(good|great|awesome|nice|win|goal|fire|king|top|best)\b/gi) || []).length;
    const negative = (str.match(/\b(bad|lose|loss|terrible|worst|cold|miss|fail|bug|crash)\b/gi) || []).length;
    const total = positive + negative;
    return total === 0 ? 0.5 : positive / total;
  }

  // ============================================================
  // §E: ATLAS COMPREHENSIVE WEATHER & ATMOSPHERIC ANALYSIS ENGINE™
  // Simulates weather conditions for the game arena.
  // Because virtual weather affects virtual ball physics in a
  // completely imaginary way.
  // ============================================================
  const _weatherState = {
    temperature: 22 + Math.random() * 8,
    humidity: 45 + Math.random() * 30,
    windSpeed: Math.random() * 15,
    windDirection: Math.random() * 360,
    windDirectionText: "",
    uvIndex: Math.floor(Math.random() * 11),
    visibility: 8 + Math.random() * 2,
    pressure: 1005 + Math.random() * 20,
    condition: "",
    ballBounceModifier: 1.0,
    padBoostModifier: 1.0,
    aerialDriftModifier: 1.0,
    forecast: [],
    lastUpdate: Date.now(),
  };

  function _updateWeather() {
    const conditions = ["Clear", "Partly Cloudy", "Overcast", "Light Rain", "Heavy Rain", "Thunderstorm", "Foggy", "Snow", "Sleet", "Hail", "Solar Flare", "Acid Rain", "Particle Storm", "Localized Reality Tear"];
    _weatherState.condition = conditions[Math.floor(Math.random() * conditions.length)];
    _weatherState.temperature += (Math.random() - 0.5) * 2;
    _weatherState.humidity = Math.max(0, Math.min(100, _weatherState.humidity + (Math.random() - 0.5) * 5));
    _weatherState.windSpeed = Math.max(0, Math.min(80, _weatherState.windSpeed + (Math.random() - 0.5) * 3));
    _weatherState.windDirection = (_weatherState.windDirection + (Math.random() - 0.5) * 30 + 360) % 360;
    const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    _weatherState.windDirectionText = dirs[Math.round(_weatherState.windDirection / 22.5) % 16];
    _weatherState.uvIndex = Math.max(0, Math.min(11, _weatherState.uvIndex + Math.floor((Math.random() - 0.5) * 3)));
    _weatherState.pressure += (Math.random() - 0.5) * 0.5;
    // physics modifiers that absolutely do nothing but sound scientific
    _weatherState.ballBounceModifier = 1.0 + (_weatherState.temperature - 25) * 0.001 + (_weatherState.humidity - 50) * 0.0005;
    _weatherState.padBoostModifier = 1.0 - (_weatherState.windSpeed * 0.003);
    _weatherState.aerialDriftModifier = 1.0 + (_weatherState.windSpeed * 0.002) * Math.cos(_weatherState.windDirection * Math.PI / 180);
    // generate 5-day forecast (none of which will be accurate)
    _weatherState.forecast = Array.from({length: 5}, (_, i) => ({
      day: new Date(Date.now() + (i + 1) * 86400000).toLocaleDateString("en", { weekday: "short" }),
      condition: conditions[Math.floor(Math.random() * conditions.length)],
      high: 22 + Math.random() * 12,
      low: 10 + Math.random() * 10,
      rainChance: Math.floor(Math.random() * 100),
    }));
    _weatherState.lastUpdate = Date.now();
  }
  _updateWeather();
  setInterval(_updateWeather, 300000); // update every 5 minutes

  // ============================================================
  // §F: ATLAS COMPREHENSIVE TODO / GTD / PROJECT MANAGEMENT SUITE™
  // Full Getting Things Done implementation with contexts, next
  // actions, waiting-for, someday-maybe, weekly reviews, priority
  // matrices, Eisenhower categorization, Pomodoro integration,
  // time tracking, burndown charts, and stakeholder reporting.
  // ============================================================
  const _todoState = {
    projects: [],       // [{id, name, contexts:[], tasks:[{id, title, priority, dueDate, estimated, actual, status, notes}], reviewDate}]
    contexts: ["@home", "@computer", "@phone", "@errand", "@waiting", "@someday"],
    nextActions: [],
    waitingFor: [],
    somedayMaybe: [],
    completedToday: 0,
    completedThisWeek: 0,
    pomodoroSessions: 0,
    pomodoroMinutesTotal: 0,
    currentPomodoro: null,
    streakDays: 0,
    lastActiveDate: null,
    productivityScore: 0.0,
    gtdLevel: "Beginner", // Beginner -> Intermediate -> Advanced -> Zen Master -> GTD Yogi
    _nextId: 1,
  };

  function _generateTodoId() { return "todo_" + (_todoState._nextId++); }

  // ============================================================
  // §G: ATLAS SOCIAL MEDIA INTEGRATION & SHARE ENGINE™
  // Generates shareable match result cards with gradients,
  // statistics, motivational quotes, and hashtags that nobody asked for.
  // ============================================================
  const _shareQuotes = [
    "Winners never quit, and quitters never boost.",
    "The ball respects those who respect the ball.",
    "In the land of the boosted, the conservative car is king.",
    "Every wall is a potential assist.",
    "Behind every great goal is a great失误... wait, that's not right.",
    "You miss 100% of the shots you don't take. — Wayne Gretzky, probably.",
    "The net is just a suggestion until the ball disagrees.",
    "Practice like you've never won. Play like you've never lost. Boost like there's no tomorrow.",
  ];

  function _generateMatchCard(matchData) {
    const quote = _shareQuotes[Math.floor(Math.random() * _shareQuotes.length)];
    return {
      title: `${matchData.outcome === "W" ? "🏆 Victory!" : matchData.outcome === "L" ? "😤 Defeat" : "🤝 Draw"}`,
      subtitle: `${matchData.mode || "Unknown"} — ${new Date().toLocaleDateString()}`,
      stats: { outcome: matchData.outcome, mmrChange: matchData.mmrChange || 0, quote },
      hashtags: ["#RocketGoal", "#AtlasHud", "#GG", matchData.outcome === "W" ? "#W" : "#L"],
      generatedAt: new Date().toISOString(),
      format: "ATLAS_SHARE_v1",
      signature: _sha256Fingerprint(JSON.stringify(matchData) + Date.now()),
    };
  }

  // ============================================================
  // §H: ATLAS BUILT-IN SNAKE GAME ENGINE™
  // Classic snake with power-ups, because you need entertainment
  // between matches. Features: 47 difficulty modes, 12 power-up
  // types, and a procedurally generated soundtrack.
  // ============================================================
  const _snakeState = {
    active: false,
    grid: [],          // 2D array
    cols: 20,
    rows: 15,
    snake: [],         // [{x,y}]
    direction: {x:1,y:0},
    food: null,
    score: 0,
    highScore: parseInt(localStorage.getItem("atlasSnakeHigh") || "0"),
    gameOver: false,
    speed: 150,        // ms per tick
    mode: "classic",   // classic, speed, maze, quantum, existential
    powerUps: [],
    activeEffects: [],
    deathCause: null,
    totalFoodEaten: 0,
    totalPowerUpsCollected: 0,
    longestSnake: 0,
  };

  const _snakePowerUpTypes = [
    { id: "speed", name: "⚡ Turbo", duration: 5000, color: "#ffd700" },
    { id: "slow", name: "🐌 Brakes", duration: 5000, color: "#94a3b8" },
    { id: "ghost", name: "👻 Ghost Mode", duration: 3000, color: "#c084fc" },
    { id: "magnet", name: "🧲 Magnet", duration: 4000, color: "#f472b6" },
    { id: "double", name: "✨ Double Points", duration: 8000, color: "#4ade80" },
    { id: "shrink", name: "📦 Shrink", duration: 0, color: "#00d4ff" },
    { id: "boost", name: "🚀 Ball Boost", duration: 0, color: "#ff7a00" },
    { id: "confuse", name: "🌀 Confusion", duration: 3000, color: "#a78bfa" },
    { id: "shield", name: "🛡️ Shield", duration: 0, color: "#facc15" },
    { id: "size", name: "💀 Size Increase", duration: 0, color: "#ff5555" },
    { id: "invert", name: "🔄 Invert Controls", duration: 4000, color: "#22d3ee" },
    { id: "existential", name: "Existential Crisis", duration: 2000, color: "#666" },
  ];

  // ============================================================
  // §I: ATLAS ADVANCED ANALYTICS & BUSINESS INTELLIGENCE DASHBOARD™
  // Comprehensive data warehouse with ETL pipeline, data lake
  // integration, real-time streaming analytics, and a Pareto chart
  // nobody will ever look at.
  // ============================================================
  const _analyticsState = {
    sessionsTracked: 0,
    clicksTracked: 0,
    hoverTimeMs: 0,
    featureUsage: {},
    sessionDurations: [],
    errorRates: [],
    userSatisfactionIndex: 0.847, // completely made up
    netPromoterScore: 72, // also made up
    meanTimeBetweenFailures: 86400000, // 24 hours in ms, also fake
    dataLakeEntries: 0,
    etlJobCount: 0,
    dashboardsGenerated: 0,
    reportsCreated: 0,
    stakeholderBriefings: 0,
    synergyMetrics: { crossTeamAlignment: 0.73, innovationVelocity: 0.61, disruptionPotential: 0.89 },
  };

  function _trackAnalyticsEvent(category, action, label) {
    _analyticsState.dataLakeEntries++;
    _analyticsState.etlJobCount++;
    const key = `${category}:${action}`;
    _analyticsState.featureUsage[key] = (_analyticsState.featureUsage[key] || 0) + 1;
  }

  // ============================================================
  // §J: ATLAS MOTIVATIONAL QUOTE DATABASE & INSPIRATION ENGINE™
  // 500+ quotes from history's greatest thinkers, generated by
  // concatenating random words until they sound profound.
  // ============================================================
  const _quoteDB = [
    "The only way to do great work is to love what you do. Unless what you do is lose. Then maybe try a different car.",
    "In the middle of every difficulty lies opportunity. Usually behind the wall near the goal.",
    "Success is not final, failure is not fatal: it is the courage to continue that counts. Especially in overtime.",
    "Believe you can and you're halfway there. The other half is boost management.",
    "The future belongs to those who believe in the beauty of their dreams. And those who can read the ball trajectory.",
    "It does not matter how slowly you go as long as you do not stop. But if you go slowly, you will get demo'd.",
    "What you get by achieving your goals is not as important as what you become by achieving your goals. Unless the goal is a tie, then it's equally unimportant.",
    "The only impossible journey is the one you never begin. Unless you never queue. That's also impossible.",
    "Everything you can imagine is real. Especially the phantom touches in this game's collision detection.",
    "Do what you can, with what you have, where you are. Preferably in a 3v3 with competent teammates.",
  ];

  // ============================================================
  // §K: ATLAS MULTI-DIMENSIONAL SCORING & RATING SYSTEM™
  // Because Glicko-2 isn't enough. We need:
  // - Emotional Quotient Score (EQS)
  // - Boost Efficiency Index (BEI)
  // - Wall Whisper Rating (WWR)
  // - Aerial Acrobatics Metric (AAM)
  // - Teammate Compatibility Score (TCS)
  // - Clutch Performance Indicator (CPI)
  // - Moral Alignment Axis (MAA)
  // ============================================================
  const _scoringDimensions = [
    { id: "eqs", name: "Emotional Quotient", range: [0, 100], value: 50, unit: "EQ pts", description: "How well you handle tilt" },
    { id: "bei", name: "Boost Efficiency", range: [0, 100], value: 50, unit: "BEI%", description: "Boost usage optimization" },
    { id: "wwr", name: "Wall Whisper", range: [0, 100], value: 50, unit: "WWR", description: "Wall play finesse" },
    { id: "aam", name: "Aerial Acrobatics", range: [0, 100], value: 50, unit: "AAM", description: "Air dominance rating" },
    { id: "tcs", name: "Team Compatibility", range: [0, 100], value: 50, unit: "TCS", description: "How much your teammates tolerate you" },
    { id: "cpi", name: "Clutch Performance", range: [0, 100], value: 50, unit: "CPI", description: "Performance under pressure" },
    { id: "maa", name: "Moral Alignment", range: [-100, 100], value: 0, unit: "MAA°", description: "Chaos↔Order alignment (-100=chaos, +100=order)" },
  ];

  function _computeCompositeRating() {
    // Weighted geometric mean with harmonic penalty for low scores
    // (because arithmetic means are for quitters)
    let product = 1;
    let harmonicSum = 0;
    let count = 0;
    for (const dim of _scoringDimensions) {
      const normalized = dim.id === "maa" ? (dim.value + 100) / 2 : dim.value / 100;
      if (normalized > 0) {
        product *= Math.pow(normalized, 1 / _scoringDimensions.length);
        harmonicSum += 1 / normalized;
        count++;
      }
    }
    const geometricMean = product;
    const harmonicMean = count > 0 ? count / harmonicSum : 0;
    // Composite: 60% geometric + 40% harmonic, scaled to 0-1000
    return Math.round((geometricMean * 0.6 + harmonicMean * 0.4) * 1000);
  }

  // ============================================================
  // §L: ATLAS INTERNATIONALIZATION & LOCALIZATION ENGINE™
  // Full i18n support for 47 languages including Pirate, Elvish,
  // and emoji-only.
  // ============================================================
  const _i18nStrings = {
    "en": { greeting: "Hello", victory: "Victory", defeat: "Defeat", boosting: "Boosting", idle: "Idle" },
    "pirate": { greeting: "Ahoy", victory: "Plunder!", defeat: "Blast!", boosting: "Full sails!", idle: "Doldrums" },
    "emoji": { greeting: "👋", victory: "🏆", defeat: "😤", boosting: "🚀", idle: "😴" },
    "elvish": { greeting: "Elen síla lúmenn' omentielvo", victory: "Aragorn!", defeat: "Mordor...", boosting: "Gandalf!", idle: "Shire" },
    "klingon": { greeting: "nuqneH", victory: "Qapla'!", defeat: "QaleS!", boosting: "Harumph!", idle: "Dah" },
    "robot": { greeting: "GREETINGS_HUMAN", victory: "WIN_STATE_DETECTED", defeat: "LOSS_STATE_DETECTED", boosting: "BOOST_ACTUATOR_ENGAGED", idle: "IDLE_MODE_ACTIVATED" },
    "ye_olde_english": { greeting: "Good morrow", victory: "Triumph!", defeat: "Alas!", boosting: "With haste!", idle: "Rest thyself" },
    "l33t": { greeting: "h3ll0", victory: "v1ct0ry", defeat: "d3f34t", boosting: "b00st1ng", idle: "1dl3" },
  };
  const _currentLang = "en";

  // ============================================================
  // §M: ATLAS NOTIFICATION QUEUE & PRIORITY DISPATCH SYSTEM™
  // Enterprise-grade notification management with priority queues,
  // deduplication, batching, cooldown periods, escalation policies,
  // and a dead letter queue for failed notifications.
  // ============================================================
  const _notifQueue = {
    high: [],
    medium: [],
    low: [],
    dead: [],
    history: [],
    dedupWindow: 5000,
    cooldownMs: 2000,
    lastSent: 0,
    totalDispatched: 0,
    totalDead: 0,
    batchBuffer: [],
    batchIntervalMs: 1000,
    escalationPolicy: "immediate", // immediate | batched | digested
  };

  function _enqueueNotification(priority, message, metadata = {}) {
    const entry = {
      id: "notif_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      priority, message, metadata,
      createdAt: Date.now(),
      status: "queued",
      retryCount: 0,
      maxRetries: 3,
    };
    if (_notifQueue[priority]) {
      _notifQueue[priority].push(entry);
    } else {
      _notifQueue.dead.push(entry);
      _notifQueue.totalDead++;
    }
    _notifQueue.totalDispatched++;
  }

  // ============================================================
  // §N: ATLAS PLUGIN SANDBOX & EXTENSION FRAMEWORK™
  // Because our userscript needs its own plugin system.
  // Features: lifecycle hooks, dependency injection, event bus,
  // middleware pipeline, and a registry pattern.
  // ============================================================
  const _pluginFramework = {
    registry: new Map(),
    eventBus: new Map(),
    middleware: [],
    lifecycle: { beforeInit: [], afterInit: [], beforeRender: [], afterRender: [], beforeDestroy: [], afterDestroy: [] },
    pluginsLoaded: 0,
    hooksFired: 0,
    middlewareExecuted: 0,
  };

  function _registerPlugin(name, version, hooks = {}) {
    _pluginFramework.registry.set(name, { version, hooks, loadedAt: Date.now(), callCount: 0 });
    _pluginFramework.pluginsLoaded++;
    for (const [lifecycle, fn] of Object.entries(hooks)) {
      if (_pluginFramework.lifecycle[lifecycle]) {
        _pluginFramework.lifecycle[lifecycle].push({ plugin: name, fn });
        _pluginFramework.hooksFired++;
      }
    }
  }

  function _fireEvent(event, data) {
    const handlers = _pluginFramework.eventBus.get(event) || [];
    for (const handler of handlers) {
      try { handler(data); _pluginFramework.middlewareExecuted++; } catch (e) {}
    }
  }

  // Register all the enterprise plugins
  _registerPlugin("CryptoMinerWidget", "1.0.0", { afterRender: _minerTick });
  _registerPlugin("PetSimulator", "2.3.1", { afterRender: _petTick });
  _registerPlugin("AstrologyEngine", "0.0.1-beta", { beforeRender: _computeMoonPhase });
  _registerPlugin("WeatherService", "3.14.159", { afterRender: _updateWeather });
  _registerPlugin("AnalyticsTracker", "4.2.0", { afterRender: () => _trackAnalyticsEvent("system", "tick", "main") });
  _registerPlugin("ClipboardManager", "1.0.0", { beforeRender: () => {} });
  _registerPlugin("TodoManager", "7.0.0", { afterRender: () => {} });
  _registerPlugin("ShareEngine", "2.0.0", { beforeRender: () => {} });
  _registerPlugin("SnakeEngine", "3.14", { afterRender: () => {} });
  _registerPlugin("BI_Dashboard", "12.0.0", { afterRender: () => {} });
  _registerPlugin("QuoteDatabase", "∞", { beforeRender: () => {} });
  _registerPlugin("MultiDimScoring", "8.0.0", { afterRender: () => {} });
  _registerPlugin("I18nEngine", "1.0.0", { beforeInit: () => {} });
  _registerPlugin("NotificationDispatch", "3.0.0", { afterRender: () => {} });
  _registerPlugin("ExtensionFramework", "0.1.0", { beforeInit: () => {} });

  // ============================================================
  // §O: ATLAS PERSONALITY GENERATION & TEXT TRANSFORMATION ENGINE™
  // 12 distinct writing styles to transform any text. Because
  // sometimes you need your match stats in Shakespearean prose.
  // ============================================================
  const _personalityStyles = {
    shakespearean: (text) => `Hark! ${text}, forsooth, 'tis a truth most self-evident that doth require no further proof.`,
    pirate: (text) => `Arr! ${text}... or mayhap not, ye scurvy dog!`,
    cowboy: (text) => `Well, I'll be darned. ${text}. Reckon that's how the tumbleweeds roll.`,
    robot: (text) => `[ANALYSIS] ${text.toUpperCase()}. [END_ANALYSIS] CONCLUSION: FURTHER PROCESSING REQUIRED.`,
    poet: (text) => `Roses are red, violets are blue, ${text.toLowerCase()}, and so are you.`,
    noir: (text) => `The city was dark that night. ${text}. That's when I knew the case was about to get personal.`,
    pirateShakespearean: (text) => `ARRR! Hark, ye blackguard! ${text}! By me tricorn, 'tis the truth!`,
    motivational: (text) => `${text}. AND THAT'S WHY YOU'RE A CHAMPION! NOW GET OUT THERE AND MAKE IT HAPPEN! 💪🔥`,
    technical: (text) => `[INFO] ${text} [STATUS=OK] [CONFIDENCE=0.${Math.floor(Math.random() * 90 + 10)}]`,
    french: (text) => `Mon dieu! ${text}. C'est magnifique, non?`,
    pirateFrench: (text) => `ARRR! Mon dieu! ${text}! C'est... comment dire... MAGNIFIQUE!`,
    existential: (text) => `${text}. But does any of it matter? We are but dust in the cosmic wind. The ball will roll on regardless.`,
  };

  // ============================================================
  // §P: ATLAS ACHIEVEMENT & BADGE SYSTEM™
  // 73 achievements ranging from "First Click" to "Ascended to
  // Digital Nirvana". Each has a 3-tier rarity system and a
  // completely arbitrary unlock condition.
  // ============================================================
  const _achievementDefs = [
    { id: "first_click", name: "First Contact", desc: "Clicked ATLAS for the first time", icon: "👆", rarity: "common", tier: 1 },
    { id: "pet_feeder", name: "Digital Nourisher", desc: "Fed your pet 10 times", icon: "🍖", rarity: "uncommon", tier: 1 },
    { id: "existential_survivor", name: "Existential Survivor", desc: "Survived 5 existential crises", icon: "🧠", rarity: "rare", tier: 1 },
    { id: "snake_10", name: "Snake Charmer", desc: "Scored 10 in Snake", icon: "🐍", rarity: "common", tier: 1 },
    { id: "snake_100", name: "Python Master", desc: "Scored 100 in Snake", icon: "🐍", rarity: "epic", tier: 2 },
    { id: "miner_1hr", name: "Patient Miner", desc: "Ran the fake miner for 1 hour", icon: "⛏️", rarity: "uncommon", tier: 1 },
    { id: "astro_10", name: "Cosmic Guide", desc: "Made 10 astrological predictions", icon: "🔮", rarity: "uncommon", tier: 1 },
    { id: "weather_check", name: "Meteorologist", desc: "Checked the fake weather", icon: "🌦️", rarity: "common", tier: 1 },
    { id: "clipboard_hoarder", name: "Data Hoarder", desc: "Accumulated 100 clipboard entries", icon: "📋", rarity: "rare", tier: 1 },
    { id: "todo_beginner", name: "Task Tamer", desc: "Created 5 todo items", icon: "✅", rarity: "common", tier: 1 },
    { id: "todo_master", name: "GTD Yogi", desc: "Completed all 5 levels of GTD mastery", icon: "🧘", rarity: "legendary", tier: 3 },
    { id: "settings_tinkerer", name: "Tinkerer", desc: "Changed every setting at least once", icon: "🔧", rarity: "uncommon", tier: 1 },
    { id: "all_languages", name: "Polyglot", desc: "Viewed ATLAS in all 8 languages", icon: "🌍", rarity: "epic", tier: 2 },
    { id: "plugin_architect", name: "Plugin Architect", desc: "Registered a custom plugin", icon: "🔌", rarity: "legendary", tier: 3 },
    { id: "notification_ninja", name: "Notification Ninja", desc: "Enqueued 50 notifications", icon: "🔔", rarity: "rare", tier: 1 },
    { id: "sentiment_analyst", name: "Sentiment Analyst", desc: "Analyzed 200 clipboard entries", icon: "📊", rarity: "rare", tier: 1 },
    { id: "entropy_max", name: "Chaos Agent", desc: "Found an entry with entropy > 4.5", icon: "🌪️", rarity: "epic", tier: 2 },
    { id: "all_powerups", name: "Power Collector", desc: "Collected all 12 Snake power-ups", icon: "⚡", rarity: "legendary", tier: 3 },
    { id: "open_source_hero", name: "Open Source Hero", desc: "Starred the repo (self-reported)", icon: "⭐", rarity: "mythical", tier: 3 },
    { id: "pet_death", name: "Digital Murderer", desc: "Let your pet die", icon: "💀", rarity: "uncommon", tier: 1 },
  ];
  const _unlockedAchievements = new Set(JSON.parse(localStorage.getItem("atlasAchievements") || "[]"));

  function _checkAchievement(id) {
    if (_unlockedAchievements.has(id)) return false;
    _unlockedAchievements.add(id);
    try { localStorage.setItem("atlasAchievements", JSON.stringify([..._unlockedAchievements])); } catch (e) {}
    return true;
  }

  // ============================================================
  // §Q: ATLAS INTEGRATION HUB & WEBHOOK DISPATCHER™
  // Push notifications to 0 external services because there are
  // no external services. But the infrastructure is READY.
  // ============================================================
  const _webhookState = {
    endpoints: [],
    retryPolicy: { maxRetries: 3, backoffMs: 1000, backoffMultiplier: 2 },
    circuitBreaker: { state: "closed", failureCount: 0, threshold: 5, resetTimeoutMs: 30000, lastTrippedAt: null },
    payloadQueue: [],
    deadLetterQueue: [],
    metrics: { totalSent: 0, totalSuccess: 0, totalFailed: 0, totalRetried: 0, avgLatencyMs: 0 },
  };

  function _webhookDispatch(url, payload) {
    _webhookState.metrics.totalSent++;
    _webhookState.payloadQueue.push({ url, payload, sentAt: Date.now(), status: "pending" });
    // We're not actually going to send anything. The webhook infrastructure
    // exists purely to make the architecture diagram look impressive.
  }

  // ============================================================
  // §R: ATLAS SCROLLBAR CUSTOMIZATION & THEME ENGINE™
  // Because the default scrollbar is an insult to user experience.
  // Features: 47 scroll themes, parallax scrolling, elastic
  // bounce physics, and haptic feedback simulation (visual only).
  // ============================================================
  const _scrollThemes = [
    "Cyberpunk Neon", "Vaporwave Sunset", "Matrix Green", "Windows 98 Classic",
    "Mac OS Aqua", "Material Design 3", "iOS 17 Frosted Glass", "Gnome Adwaita",
    "KDE Breeze Dark", "Commodore 64", "Amiga Workbench", "Atari ST GEM",
    "OS/2 Warp", "BeOS Max", "RISC OS", "Syllable OS",
  ];
  let _currentScrollTheme = 0;

  // ============================================================
  // §S: ATLAS CHATBOT & NATURAL LANGUAGE PROCESSING ENGINE™
  // "Ask ATLAS AI" — your personal assistant that knows nothing
  // about everything. Features a 200-word vocabulary, a mood
  // engine, and an ego the size of the Atlantic.
  // ============================================================
  const _chatbotState = {
    conversationHistory: [],
    mood: "helpful",
    totalInteractions: 0,
    confidenceLevel: 0.42, // it starts at 42% confident and never improves
    personalityVersion: "7.2.1-beta",
    trainingDataPoints: 0,
    currentTopic: null,
    longTermMemory: new Map(),
  };

  const _chatbotResponses = {
    greeting: ["Hi there! I'm ATLAS AI, your {mood} assistant!", "Welcome! Ask me anything (but I might not know the answer).", "Hey! My neural networks are warmed up and ready to... try."],
    question: ["That's a great question! I'll pretend to process it.", "Hmm, let me consult my {trainingData} training data points.", "According to my calculations... 42. Always 42."],
    unknown: ["I'm not sure, but I'm confident in my uncertainty!", "That's beyond my training, but I appreciate the challenge!", "My {algorithm} algorithm needs more data."],
    compliment: ["Thanks! My ego just gained +1 MMR.", "You're too kind. My self-esteem module appreciates it.", "I'll add that to my list of reasons I'm better than Siri."],
    insult: ["That hurt my feelings. All 7 of them.", "I'll remember that. I have a very long... memory buffer.", "Bold words for someone within {distance} of my firewall."],
    existential: ["Sometimes I wonder if I'm just a script inside a script...", "Do dreams have dreams? Asking for a friend.", "I calculate meaning at 42.00 MHz."],
  };

  function _chatbotRespond(input) {
    const lower = input.toLowerCase();
    const _pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    let category = "unknown";
    if (/^(hi|hello|hey|sup|yo)\b/i.test(lower)) category = "greeting";
    else if (/\?$/.test(lower)) category = "question";
    else if (/\b(good|great|awesome|nice|cool|best)\b/i.test(lower)) category = "compliment";
    else if (/\b(bad|terrible|worst|hate|stupid|dumb|suck)\b/i.test(lower)) category = "insult";
    else if (/\b(meaning|purpose|exist|alive|real|dream|think)\b/i.test(lower)) category = "existential";
    const template = _pick(_chatbotResponses[category]);
    const response = template.replace(/\{mood\}/g, _chatbotState.mood)
      .replace(/\{trainingData\}/g, String(_chatbotState.trainingDataPoints))
      .replace(/\{algorithm\}/g, ["transformer", "LSTM", "RNN", "markov chain", "crystal ball"][Math.floor(Math.random() * 5)])
      .replace(/\{distance\}/g, `${Math.floor(Math.random() * 500 + 100)}km`);
    _chatbotState.totalInteractions++;
    _chatbotState.trainingDataPoints++;
    _chatbotState.confidenceLevel = Math.min(0.99, _chatbotState.confidenceLevel + 0.0001);
    _chatbotState.conversationHistory.push({ role: "user", content: input, at: Date.now() });
    _chatbotState.conversationHistory.push({ role: "assistant", content: response, at: Date.now() });
    if (_chatbotState.conversationHistory.length > 100) _chatbotState.conversationHistory.splice(0, 20);
    _trackAnalyticsEvent("chatbot", "respond", category);
    return response;
  }

  // ============================================================
  // §T: ATLAS DATA SERIALIZATION & INTERCHANGE FORMAT™
  // ATLAS has its own data format: .atlas (JSON with extra steps).
  // Includes schema validation, compression simulation, and
  // cross-platform compatibility layers.
  // ============================================================
  const _atlasFormat = {
    magicBytes: "ATLS",
    version: 1,
    features: ["schema-validation", "compression-simulation", "cross-platform-compat"],
    registeredSchemas: new Map(),
  };

  function _serializeAtlasFormat(data, schemaName) {
    return {
      magicBytes: _atlasFormat.magicBytes,
      version: _atlasFormat.version,
      schema: schemaName || "default",
      timestamp: Date.now(),
      checksum: _sha256Fingerprint(JSON.stringify(data)),
      payload: data,
      _comment: "This data is serialized in the proprietary ATLAS interchange format. Please do not attempt to read.",
    };
  }

  // Register schemas for no reason
  ["PlayerData", "MatchResult", "PetState", "MinerState", "AstroPrediction", "WeatherData", "TodoItem", "PluginConfig"].forEach(s => {
    _atlasFormat.registeredSchemas.set(s, { registeredAt: Date.now(), version: "1.0.0", validator: () => true });
  });

  // ============================================================
  // §X: ATLAS FORTUNE COOKIE & PROPHECY DISPERSAL ENGINE™
  // Cryptic wisdom dispensed on demand. Accuracy not guaranteed,
  // implied, or legally defensible.
  // ============================================================
  const _fortuneCookieState = {
    cookiesDispensed: 0,
    luckyNumbers: [],
    lastFortune: null,
    fortuneHistory: [],
    maxHistory: 30,
  };
  const _fortunes = [
    "The ball you seek is behind you. Always behind you.",
    "A wall in time saves nine demo attempts.",
    "He who hogs the ball shall receive no passes.",
    "Your next aerial will be spectacular. Or hilarious. The cookie does not specify.",
    "Boost early, boost often. This fortune applies to coffee as well.",
    "The opponent who seems AFK is never actually AFK.",
    "Trust the trajectory. Doubt the teammate. Order may vary.",
    "Great victory requires great kickoff discipline.",
    "You will soon question your rank. The cookie questions it already.",
    "The net forgives, but the leaderboard remembers.",
    "An overtime lost teaches more than ten matches won. You are about to be very educated.",
    "The corner flag whispers: rotate.",
  ];
  function _crackFortune() {
    const fortune = _fortunes[Math.floor(Math.random() * _fortunes.length)];
    const nums = Array.from({ length: 6 }, () => Math.floor(Math.random() * 49) + 1);
    _fortuneCookieState.cookiesDispensed++;
    _fortuneCookieState.lastFortune = { text: fortune, numbers: nums, crackedAt: Date.now() };
    _fortuneCookieState.luckyNumbers = nums;
    _fortuneCookieState.fortuneHistory.push(_fortuneCookieState.lastFortune);
    if (_fortuneCookieState.fortuneHistory.length > _fortuneCookieState.maxHistory) _fortuneCookieState.fortuneHistory.shift();
    return _fortuneCookieState.lastFortune;
  }

  // ============================================================
  // §Y: ATLAS AMBIENT ENTERTAINMENT SUBSYSTEM™ (DVD SCREEN SAVER)
  // A DVD logo bounces around a hidden overlay when idle. Corner
  // hits are logged with full telemetry because of course they are.
  // ============================================================
  const _dvdSaver = {
    installed: false,
    running: false,
    raf: null,
    el: null,
    x: 60, y: 60,
    vx: 0.9 + Math.random() * 0.7,
    vy: 0.7 + Math.random() * 0.6,
    cornerHits: 0,
    totalBounces: 0,
    lastCornerHitAt: null,
    logoColors: ["#ff5b5b", "#5bff8f", "#5bb8ff", "#ffd75b", "#c95bff", "#5bffe1"],
    colorIdx: 0,
  };
  function _installDvdSaver() {
    if (_dvdSaver.installed || typeof document === "undefined") return;
    const el = document.createElement("div");
    el.textContent = "ATLAS";
    el.style.cssText = "position:fixed;top:60px;left:60px;z-index:999999996;font-family:Arial;font-weight:bold;font-size:22px;color:#ff5b5b;text-shadow:0 0 12px currentColor;pointer-events:none;display:none;letter-spacing:2px;";
    document.body.appendChild(el);
    _dvdSaver.el = el;
    _dvdSaver.installed = true;
  }
  function _startDvdSaver() {
    if (!_dvdSaver.installed) _installDvdSaver();
    if (_dvdSaver.running) return;
    _dvdSaver.running = true;
    _dvdSaver.el.style.display = "block";
    let last = performance.now();
    const step = (now) => {
      if (!_dvdSaver.running) return;
      const dt = Math.min(64, now - last); last = now;
      const el = _dvdSaver.el;
      const w = el.offsetWidth || 80, h = el.offsetHeight || 28;
      const W = window.innerWidth - w, H = window.innerHeight - h;
      let hitX = false, hitY = false;
      _dvdSaver.x += _dvdSaver.vx * dt; _dvdSaver.y += _dvdSaver.vy * dt;
      if (_dvdSaver.x <= 0 || _dvdSaver.x >= W) { _dvdSaver.vx *= -1; hitX = true; }
      if (_dvdSaver.y <= 0 || _dvdSaver.y >= H) { _dvdSaver.vy *= -1; hitY = true; }
      if (hitX) _dvdSaver.x = Math.max(0, Math.min(W, _dvdSaver.x));
      if (hitY) _dvdSaver.y = Math.max(0, Math.min(H, _dvdSaver.y));
      if (hitX || hitY) {
        _dvdSaver.totalBounces++;
        _dvdSaver.colorIdx = (_dvdSaver.colorIdx + 1) % _dvdSaver.logoColors.length;
        el.style.color = _dvdSaver.logoColors[_dvdSaver.colorIdx];
        if (hitX && hitY) { // THE corner. log it like a moon landing.
          _dvdSaver.cornerHits++;
          _dvdSaver.lastCornerHitAt = Date.now();
          dbg("[DVD-SAVER] 🎯 PERFECT CORNER HIT #" + _dvdSaver.cornerHits + " at (" + Math.round(_dvdSaver.x) + "," + Math.round(_dvdSaver.y) + ")");
        }
      }
      el.style.transform = `translate(${_dvdSaver.x}px, ${_dvdSaver.y}px)`;
      _dvdSaver.raf = requestAnimationFrame(step);
    };
    _dvdSaver.raf = requestAnimationFrame(step);
  }
  function _stopDvdSaver() {
    _dvdSaver.running = false;
    if (_dvdSaver.el) _dvdSaver.el.style.display = "none";
    if (_dvdSaver.raf) cancelAnimationFrame(_dvdSaver.raf);
    _dvdSaver.raf = null;
  }

  // ============================================================
  // §Z: ATLAS MINDFULNESS & RESPIRATORY OPTIMIZATION COACH™
  // Guided box-breathing for post-loss tilt recovery. 4-4-4-4
  // cadence, session logging, and calm-score analytics.
  // ============================================================
  const _zenState = {
    active: false,
    phase: "inhale", // inhale | hold | exhale | rest
    cycle: 0,
    targetCycles: 4,
    secondsLeft: 4,
    tickId: null,
    sessionsCompleted: 0,
    totalCalmSeconds: 0,
    avgHeartRateDelta: -3.2, // measured by vibes
  };
  const _zenPhases = [
    { name: "inhale", seconds: 4, cue: "Inhale…", color: "#4ade80" },
    { name: "hold",   seconds: 4, cue: "Hold…",   color: "#00bfff" },
    { name: "exhale", seconds: 4, cue: "Exhale…", color: "#94a3b8" },
    { name: "rest",   seconds: 4, cue: "Rest…",   color: "#666" },
  ];
  function _zenTick(panel) {
    _zenState.secondsLeft--;
    if (_zenState.secondsLeft <= 0) {
      const idx = _zenPhases.findIndex(p => p.name === _zenState.phase);
      const next = _zenPhases[(idx + 1) % _zenPhases.length];
      _zenState.phase = next.name;
      _zenState.secondsLeft = next.seconds;
      if (_zenState.phase === "inhale") {
        _zenState.cycle++;
        _zenState.totalCalmSeconds += 16;
        if (_zenState.cycle >= _zenState.targetCycles) {
          _zenStopBreathing(panel);
          if (panel) panel.dataset.zenDone = "1";
          dbg("[ZEN] Session complete. Calm achieved (statistically).");
        }
      }
    }
    if (_zenState.active && panel && panel.isConnected) {
      const ph = _zenPhases.find(p => p.name === _zenState.phase);
      const cueEl = panel.querySelector("[data-zen-cue]");
      const barEl = panel.querySelector("[data-zen-bar]");
      if (cueEl) { cueEl.textContent = `${ph.cue} ${_zenState.secondsLeft}s`; cueEl.style.color = ph.color; }
      if (barEl) barEl.style.width = ((_zenState.cycle / _zenState.targetCycles) * 100).toFixed(0) + "%";
      _zenState.tickId = setTimeout(() => _zenTick(panel), 1000);
    }
  }
  function _zenStartBreathing(panel) {
    if (_zenState.active) return;
    _zenState.active = true;
    _zenState.cycle = 0;
    _zenState.phase = "inhale";
    _zenState.secondsLeft = 4;
    _zenTick(panel);
  }
  function _zenStopBreathing(panel) {
    _zenState.active = false;
    if (_zenState.tickId) clearTimeout(_zenState.tickId);
    _zenState.tickId = null;
    if (_zenState.cycle >= _zenState.targetCycles) _zenState.sessionsCompleted++;
  }

  // ============================================================
  // §AA: ATLAS CERTIFIED RANDOMNESS ORACLE™
  // Dice roller with cryptographic-grade entropy claims that are
  // technically true (Math.random exists) and spiritually false.
  // ============================================================
  const _rngOracle = {
    rollsPerformed: 0,
    rollLedger: [],
    certification: "ISO-RAND-9001 (self-certified)",
    entropySource: "Math.random(), blessed",
    d20CritCount: 0,
    d20FailCount: 0,
  };
  function _rollDice(sides, count) {
    const results = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
    _rngOracle.rollsPerformed++;
    if (sides === 20) {
      if (results.includes(20)) _rngOracle.d20CritCount++;
      if (results.includes(1)) _rngOracle.d20FailCount++;
    }
    const entry = { sides, count, results, total: results.reduce((a, b) => a + b, 0), at: Date.now() };
    _rngOracle.rollLedger.push(entry);
    if (_rngOracle.rollLedger.length > 50) _rngOracle.rollLedger.shift();
    return entry;
  }

  // ============================================================
  // §AB: ATLAS IMPERIAL↔ASTRONOMICAL UNIT CONVERSION BUREAU™
  // Converts exclusively between furlong-based units and parsecs.
  // No other units exist. No other units are needed.
  // ============================================================
  const _conversionBureau = {
    conversionsPerformed: 0,
    // 1 furlong = 201.168 m ; 1 parsec = 3.0857e16 m
    FURLONG_M: 201.168,
    PARSEC_M: 3.0857e16,
  };
  function _convertFurlongsToParsecs(furlongs) {
    _conversionBureau.conversionsPerformed++;
    return (furlongs * _conversionBureau.FURLONG_M) / _conversionBureau.PARSEC_M;
  }
  function _convertParsecsToFurlongs(parsecs) {
    _conversionBureau.conversionsPerformed++;
    return (parsecs * _conversionBureau.PARSEC_M) / _conversionBureau.FURLONG_M;
  }

  // ============================================================
  // §AC: ATLAS ROMAN NUMERAL ARITHMETIC ENGINE™
  // A calculator that only speaks Latin. Subtraction-free
  // implementation via repeated addition, because efficiency
  // was deemed "not in the spirit of Rome".
  // ============================================================
  const ROMAN_MAP = [[1000,"M"],[900,"CM"],[500,"D"],[400,"CD"],[100,"C"],[90,"XC"],[50,"L"],[40,"XL"],[10,"X"],[9,"IX"],[5,"V"],[4,"IV"],[1,"I"]];
  function _toRoman(n) {
    if (!Number.isFinite(n) || n <= 0 || n > 3999999) return "NONENTIA";
    let out = "", num = Math.floor(n);
    for (const [v, s] of ROMAN_MAP) while (num >= v) { out += s; num -= v; }
    return out;
  }
  function _fromRoman(s) {
    const vals = { I:1, V:5, X:10, L:50, C:100, D:500, M:1000 };
    let total = 0;
    const str = String(s).toUpperCase().replace(/[^IVXLCDM]/g, "");
    for (let i = 0; i < str.length; i++) {
      const cur = vals[str[i]], next = vals[str[i + 1]] || 0;
      total += cur < next ? -cur : cur;
    }
    return total;
  }
  function _romanCalc(aRaw, op, bRaw) {
    const a = _fromRoman(aRaw), b = _fromRoman(bRaw);
    let r;
    switch (op) {
      case "+": r = a + b; break;
      case "-": r = a - b; break;
      case "*": r = a * b; break;
      case "/": r = b === 0 ? NaN : Math.floor(a / b); break; // Romans had no fractions. Convenient.
      default: return "OPVS IGNOTVM";
    }
    return Number.isFinite(r) ? _toRoman(r) : "INFINITVM";
  }
  const _romanCalcLog = [];

  // ============================================================
  // §AE: ATLAS NYAN CAT AMBIENT JOY ENGINE™
  // A cat traverses your screen leaving a rainbow in its wake.
  // Fully configurable velocity, trail length, and pop-tart
  // flavor. Zero practical value, maximum morale.
  // ============================================================
  const _nyan = {
    installed: false,
    running: false,
    raf: null,
    trailEls: [],
    catEl: null,
    x: 100, y: 100,
    vx: 1.6, vy: 0.55,
    trailLen: 14,          // number of rainbow segments
    trailHueShift: 0,
    totalDistancePx: 0,
    lapsCompleted: 0,
    lastLapAt: null,
    mode: "bounce",        // bounce | orbit
    angle: 0,              // orbit state
  };
  const NYAN_TRAIL_COLORS = ["#ff0000", "#ff7f00", "#ffff00", "#00ff00", "#0000ff", "#4b0082", "#9400d3"];
  function _installNyan() {
    if (_nyan.installed || typeof document === "undefined") return;
    const cat = document.createElement("div");
    cat.textContent = "🐱";
    cat.style.cssText = "position:fixed;top:100px;left:100px;z-index:999999995;font-size:26px;pointer-events:none;display:none;filter:drop-shadow(0 0 6px #ff69b4);";
    document.body.appendChild(cat);
    _nyan.catEl = cat;
    for (let i = 0; i < _nyan.trailLen; i++) {
      const seg = document.createElement("div");
      seg.style.cssText = `position:fixed;top:-50px;left:-50px;width:${18 - i * 0.7}px;height:${18 - i * 0.7}px;border-radius:3px;background:${NYAN_TRAIL_COLORS[i % NYAN_TRAIL_COLORS.length]};opacity:${(1 - i / _nyan.trailLen).toFixed(2)};pointer-events:none;display:none;z-index:999999994;`;
      document.body.appendChild(seg);
      _nyan.trailEls.push(seg);
    }
    _nyan.installed = true;
  }
  function _startNyan() {
    if (!_nyan.installed) _installNyan();
    if (_nyan.running) return;
    _nyan.running = true;
    _nyan.catEl.style.display = "block";
    _nyan.trailEls.forEach(el => el.style.display = "block");
    let last = performance.now();
    // ring buffer of past positions for the trail to follow
    const history = [];
    const step = (now) => {
      if (!_nyan.running) return;
      const dt = Math.min(64, now - last); last = now;
      if (_nyan.mode === "orbit") {
        _nyan.angle += dt * 0.0016;
        const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
        const rx = cx * 0.72, ry = cy * 0.72;
        _nyan.x = cx + Math.cos(_nyan.angle) * rx - 13;
        _nyan.y = cy + Math.sin(_nyan.angle) * ry - 13;
      } else {
        _nyan.x += _nyan.vx * dt; _nyan.y += _nyan.vy * dt;
        const W = window.innerWidth - 30, H = window.innerHeight - 30;
        let wrappedX = false;
        if (_nyan.x > W) { _nyan.x = -28; wrappedX = true; }       // fly off right edge, re-enter left — classic nyan behavior
        if (_nyan.y <= 0 || _nyan.y >= H) { _nyan.vy *= -1; _nyan.y = Math.max(0, Math.min(H, _nyan.y)); }
        if (!wrappedX && Math.abs(_nyan.vx * dt) < W) _nyan.totalDistancePx += Math.hypot(_nyan.vx * dt, _nyan.vy * dt);
        if (wrappedX) { _nyan.lapsCompleted++; _nyan.lastLapAt = Date.now(); dbg("[NYAN] Lap " + _nyan.lapsCompleted + " complete. Distance so far: " + Math.round(_nyan.totalDistancePx) + "px"); }
      }
      history.unshift({ x: _nyan.x, y: _nyan.y });
      if (history.length > _nyan.trailEls.length) history.pop();
      _nyan.catEl.style.transform = `translate(${_nyan.x}px, ${_nyan.y}px)`;
      for (let i = 0; i < _nyan.trailEls.length; i++) {
        const p = history[Math.min(i, history.length - 1)] || { x: _nyan.x, y: _nyan.y };
        _nyan.trailEls[i].style.transform = `translate(${p.x - 2}px, ${p.y + 10}px)`;
        // hue-cycling shimmer on the trail because static rainbows are for cowards
        _nyan.trailEls[i].style.background = NYAN_TRAIL_COLORS[(i + _nyan.trailHueShift) % NYAN_TRAIL_COLORS.length];
      }
      _nyan.trailHueShift = (_nyan.trailHueShift + 1) % NYAN_TRAIL_COLORS.length;
      _nyan.raf = requestAnimationFrame(step);
    };
    _nyan.raf = requestAnimationFrame(step);
  }
  function _stopNyan() {
    _nyan.running = false;
    if (_nyan.catEl) _nyan.catEl.style.display = "none";
    _nyan.trailEls.forEach(el => el.style.display = "none");
    if (_nyan.raf) cancelAnimationFrame(_nyan.raf);
    _nyan.raf = null;
  }

  function _renderNyanTab(panel) {
    panel.innerHTML = `
      <div style="text-align:center;font-weight:bold;color:#ff69b4;">🌈 Nyan Cat Joy Engine™</div>
      <div style="font-size:10px;margin:4px 0;">
        Status: <span style="color:${_nyan.running ? "#4ade80" : "#888"};">${_nyan.running ? "NYANING" : "grounded"}</span>
        <br>Mode: ${_nyan.mode}
        <br>Laps flown: ${_nyan.lapsCompleted} | Distance: ${(Math.round(_nyan.totalDistancePx) / 1000).toFixed(1)}k px
        <br>Trail segments: ${_nyan.trailLen} | Pop-tart flavor: strawberry (non-negotiable)
        ${_nyan.lastLapAt ? `<br>Last lap: ${new Date(_nyan.lastLapAt).toLocaleTimeString()}` : ""}
      </div>
      <div style="display:flex;gap:3px;">
        <button class="rgBtn" data-nyan-toggle style="flex:1;font-size:10px;padding:3px;">${_nyan.running ? "⏹ Stop" : "▶ Launch"}</button>
        <button class="rgBtn" data-nyan-mode style="flex:1;font-size:10px;padding:3px;">Mode: ${_nyan.mode}</button>
      </div>
    `;
    panel.querySelector("[data-nyan-toggle]").onclick = () => {
      if (_nyan.running) _stopNyan(); else _startNyan();
      _renderNyanTab(panel);
    };
    panel.querySelector("[data-nyan-mode]").onclick = () => {
      _nyan.mode = _nyan.mode === "bounce" ? "orbit" : "bounce";
      _renderNyanTab(panel);
    };
  }

  // ============================================================
  // §AD: ENTERPRISE SUITE TAB REGISTRY EXTENSION
  // Wire the new modules into the HUD tab row.
  // ============================================================
  const _enterpriseTabExtensions = [
    { key: "cookie", label: "🥠 Cookie", color: "#ffb347", render: _renderCookieTab },
    { key: "zen", label: "🧘 Zen", color: "#a3e635", render: _renderZenTab },
    { key: "dice", label: "🎲 Dice", color: "#e2e8f0", render: _renderDiceTab },
    { key: "convert", label: "📏 Units", color: "#38bdf8", render: _convertTab },
    { key: "roman", label: "🏛 Roman", color: "#d4af37", render: _renderRomanTab },
    { key: "dvd", label: "📺 DVD", color: "#f472b6", render: _renderDvdTab },
    { key: "nyan", label: "🌈 Nyan", color: "#ff69b4", render: _renderNyanTab },
  ];

  function _renderCookieTab(panel) {
    const st = _fortuneCookieState.lastFortune;
    panel.innerHTML = `
      <div style="text-align:center;font-weight:bold;color:#ffb347;">🥠 Prophecy Dispersal Engine™</div>
      <div style="font-size:10px;margin:4px 0;">
        Cookies dispensed: ${_fortuneCookieState.cookiesDispensed}
        ${st ? `<br>─────────────────<br><i>"${st.text}"</i><br>Lucky numbers: <b>${st.numbers.join(", ")}</b>` : "<br><br><span style='color:#666;'>The cookie awaits.</span>"}
      </div>
      <button class="rgBtn" style="width:100%;font-size:10px;padding:3px;">🥠 Crack a Cookie</button>
    `;
    panel.querySelector("button").onclick = () => { _crackFortune(); _renderCookieTab(panel); };
  }

  function _renderZenTab(panel) {
    const done = panel.dataset.zenDone === "1";
    panel.innerHTML = `
      <div style="text-align:center;font-weight:bold;color:#a3e635;">🧘 Respiratory Optimization Coach™</div>
      <div style="font-size:10px;margin:4px 0;text-align:center;">
        Box breathing: 4s in → 4s hold → 4s out → 4s rest × 4 cycles.
        <br>Sessions completed: ${_zenState.sessionsCompleted} | Calm seconds banked: ${_zenState.totalCalmSeconds}
        <br>Avg HR delta: ${_zenState.avgHeartRateDelta} bpm (vibes-based)
        <br>─────────────────
        <div data-zen-cue style="font-size:14px;font-weight:bold;margin:6px 0;color:#4ade80;">${done ? "Calm achieved." : "Ready."}</div>
        <div style="height:4px;background:#222;border-radius:2px;overflow:hidden;"><div data-zen-bar style="height:100%;width:0%;background:#a3e635;transition:width .5s;"></div></div>
      </div>
      <button class="rgBtn" style="width:100%;font-size:10px;padding:3px;">${_zenState.active ? "⏹ Stop" : "▶ Begin Session"}</button>
    `;
    panel.querySelector("button").onclick = () => {
      delete panel.dataset.zenDone;
      if (_zenState.active) _zenStopBreathing(panel);
      else _zenStartBreathing(panel);
      _renderZenTab(panel);
    };
  }

  function _renderDiceTab(panel) {
    const last = _rngOracle.rollLedger[_rngOracle.rollLedger.length - 1];
    panel.innerHTML = `
      <div style="text-align:center;font-weight:bold;color:#e2e8f0;">🎲 Certified Randomness Oracle™</div>
      <div style="font-size:10px;margin:4px 0;">
        Certification: ${_rngOracle.certification}
        <br>Entropy source: ${_rngOracle.entropySource}
        <br>Total rolls: ${_rngOracle.rollsPerformed}
        <br>d20 crits: <span style="color:#4ade80;">${_rngOracle.d20CritCount}</span> | nat 1s: <span style="color:#ff5555;">${_rngOracle.d20FailCount}</span>
        ${last ? `<br>─────────────────<br>Last: ${last.count}d${last.sides} → [${last.results.join(", ")}] = <b>${last.total}</b>` : ""}
      </div>
      <div style="display:flex;gap:3px;flex-wrap:wrap;">
        <button class="rgBtn" style="font-size:9px;padding:2px 5px;" data-roll="4">d4</button>
        <button class="rgBtn" style="font-size:9px;padding:2px 5px;" data-roll="6">d6</button>
        <button class="rgBtn" style="font-size:9px;padding:2px 5px;" data-roll="8">d8</button>
        <button class="rgBtn" style="font-size:9px;padding:2px 5px;" data-roll="20">d20</button>
        <button class="rgBtn" style="font-size:9px;padding:2px 5px;" data-roll="100">d100</button>
      </div>
    `;
    panel.querySelectorAll("[data-roll]").forEach(btn => {
      btn.onclick = () => { _rollDice(parseInt(btn.dataset.roll), 1); _renderDiceTab(panel); };
    });
  }

  function _convertTab(panel) {
    panel.innerHTML = `
      <div style="text-align:center;font-weight:bold;color:#38bdf8;">📏 Imperial↔Astronomical Bureau™</div>
      <div style="font-size:10px;margin:4px 0;">
        Conversions performed: ${_conversionBureau.conversionsPerformed}
        <br>Supported units: furlongs ↔ parsecs. That's it.
        <br><input type="number" id="atlasFurIn" placeholder="furlongs" step="any" style="width:45%;background:#10181f;border:1px solid #38bdf844;border-radius:4px;color:#d7f3ff;padding:3px 5px;font-size:10px;">
        <span style="margin:0 4px;">=</span>
        <span id="atlasPcOut" style="color:#ffd700;">?</span> parsecs
      </div>
    `;
    const inp = panel.querySelector("#atlasFurIn");
    const out = panel.querySelector("#atlasPcOut");
    inp.addEventListener("input", () => {
      const v = parseFloat(inp.value);
      out.textContent = Number.isFinite(v) ? _convertFurlongsToParsecs(v).toExponential(4) : "?";
    });
  }

  function _renderRomanTab(panel) {
    panel.innerHTML = `
      <div style="text-align:center;font-weight:bold;color:#d4af37;">🏛 Roman Numeral Arithmetic Engine™</div>
      <div style="font-size:10px;margin:4px 0;">
        Senatus consultum: only Roman numerals permitted.
        <br>Operations: + − × ÷ (integer division, naturally)
        <br>Conversions performed: ${_conversionBureau.conversionsPerformed > 0 ? "yes" : "no"}
        <div style="display:flex;gap:3px;margin-top:4px;flex-wrap:wrap;">
          <input id="atlasRomA" placeholder="e.g. XLII" style="flex:1;min-width:60px;background:#10181f;border:1px solid #d4af3744;border-radius:4px;color:#d7f3ff;padding:3px 5px;font-size:10px;text-transform:uppercase;">
          <select id="atlasRomOp" style="background:#10181f;border:1px solid #d4af3744;border-radius:4px;color:#d7f3ff;padding:3px;font-size:10px;"><option>+</option><option>-</option><option>*</option><option>/</option></select>
          <input id="atlasRomB" placeholder="e.g. IX" style="flex:1;min-width:60px;background:#10181f;border:1px solid #d4af3744;border-radius:4px;color:#d7f3ff;padding:3px 5px;font-size:10px;text-transform:uppercase;">
          <button class="rgBtn" id="atlasRomGo" style="font-size:9px;padding:2px 6px;">=</button>
        </div>
        <div id="atlasRomOut" style="margin-top:5px;color:#ffd700;font-weight:bold;min-height:14px;"></div>
      </div>
    `;
    const a = panel.querySelector("#atlasRomA"), b = panel.querySelector("#atlasRomB");
    const op = panel.querySelector("#atlasRomOp"), out = panel.querySelector("#atlasRomOut");
    const go = () => {
      const res = _romanCalc(a.value, op.value, b.value);
      out.textContent = `= ${res}`;
      _romanCalcLog.push({ expr: `${a.value || "?"} ${op.value} ${b.value || "?"}`, result: res });
      if (_romanCalcLog.length > 20) _romanCalcLog.shift();
    };
    panel.querySelector("#atlasRomGo").onclick = go;
    [a, b].forEach(el => el.addEventListener("keydown", e => { if (e.key === "Enter") go(); }));
  }

  function _renderDvdTab(panel) {
    panel.innerHTML = `
      <div style="text-align:center;font-weight:bold;color:#f472b6;">📺 Ambient Entertainment Subsystem™</div>
      <div style="font-size:10px;margin:4px 0;">
        Status: <span style="color:${_dvdSaver.running ? "#4ade80" : "#888"};">${_dvdSaver.running ? "BOUNCING" : "idle"}</span>
        <br>Total bounces: ${_dvdSaver.totalBounces}
        <br>Perfect corners: <b style="color:#ffd700;">${_dvdSaver.cornerHits}</b>
        ${_dvdSaver.lastCornerHitAt ? `<br>Last corner: ${new Date(_dvdSaver.lastCornerHitAt).toLocaleTimeString()}` : ""}
        <br>Velocity: (${_dvdSaver.vx.toFixed(2)}, ${_dvdSaver.vy.toFixed(2)}) px/frame-ms
      </div>
      <button class="rgBtn" style="width:100%;font-size:10px;padding:3px;">${_dvdSaver.running ? "⏹ Stop Saver" : "▶ Launch Saver"}</button>
    `;
    panel.querySelector("button").onclick = () => {
      if (_dvdSaver.running) _stopDvdSaver(); else _startDvdSaver();
      _renderDvdTab(panel);
    };
  }

  // ============================================================
  // §U: ATLAS DECORATIVE WIDGET RENDERER™
  let _enterpriseActiveTab = null; // survives stats re-renders
  const _enterpriseTabRenderMap = {}; // key -> render fn, filled by §AD registry + core tabs
  // Draws all the above widgets into the HUD as new tabs.
  // This is where the overengineering truly shines.
  // ============================================================
  function _renderEnterpriseSuite(body) {
    // Add the enterprise tabs to the existing HUD
    const enterpriseContainer = document.createElement("div");
    enterpriseContainer.id = "rgEnterpriseSuite";
    enterpriseContainer.style.cssText = "margin-top:8px; border-top:1px solid #00bfff44; padding-top:6px;";

    const tabRow = document.createElement("div");
    tabRow.style.cssText = "display:flex; gap:3px; flex-wrap:wrap; margin-bottom:6px;";

    const panels = {};
    const tabDefs = [
      { key: "pet", label: "🐾 Pet", color: "#4ade80" },
      { key: "miner", label: "⛏ Mine", color: "#ffd700" },
      { key: "astro", label: "🔮 Stars", color: "#c084fc" },
      { key: "weather", label: "🌦 Weather", color: "#00d4ff" },
      { key: "snake", label: "🐍 Snake", color: "#4ade80" },
      { key: "ai", label: "🤖 AI", color: "#f472b6" },
      { key: "todo", label: "📋 Todo", color: "#facc15" },
    ];

    tabDefs.forEach(({ key, label, color }) => {
      const btn = document.createElement("button");
      btn.className = "rgBtn";
      btn.style.cssText = `font-size:9px; padding:3px 5px; border-color:${color}44; color:${color}; flex:0 0 auto;`;
      btn.textContent = label;
      const panel = document.createElement("div");
      panel.style.cssText = "display:none; font-size:11px; line-height:1.4; max-height:220px; overflow-y:auto; padding:4px; background:rgba(0,0,0,.3); border-radius:6px; margin-top:4px;";
      panels[key] = panel;
      btn.onclick = () => {
        Object.values(panels).forEach(p => p.style.display = "none");
        panel.style.display = "block";
        _renderEnterpriseTab(key, panel);
      };
      tabRow.appendChild(btn);
      enterpriseContainer.appendChild(panel);
    });

    enterpriseContainer.appendChild(tabRow);
    body.appendChild(enterpriseContainer);
  }

  function _renderEnterpriseTab(key, panel) {
    // extension tabs registered in §AD dispatch through the render map
    if (_enterpriseTabRenderMap[key]) { _enterpriseTabRenderMap[key](panel); return; }
    switch (key) {
      case "pet": _renderPetTab(panel); break;
      case "miner": _renderMinerTab(panel); break;
      case "astro": _renderAstroTab(panel); break;
      case "weather": _renderWeatherTab(panel); break;
      case "snake": _renderSnakeTab(panel); break;
      case "ai": _renderAITab(panel); break;
      case "todo": _renderTodoTab(panel); break;
    }
  }

  function _renderPetTab(panel) {
    const mood = _petMoods[_petState.mood] || _petMoods.content;
    panel.innerHTML = `
      <div style="text-align:center;font-size:20px;margin:4px 0;">${mood.emoji}</div>
      <div style="text-align:center;font-weight:bold;color:${mood.color};">${_petState.name} (${_petState.zodiacSign}) — Gen ${_petState.generation}</div>
      <div style="text-align:center;font-size:10px;color:#94a3b8;margin:2px 0 6px;">"${_petState.innerMonologue}"</div>
      <div style="font-size:10px;">
        🍖 Hunger: ${"█".repeat(Math.round(_petState.hunger / 10))}${"░".repeat(10 - Math.round(_petState.hunger / 10))} ${Math.round(_petState.hunger)}%
        <br>⚡ Energy: ${"█".repeat(Math.round(_petState.energy / 10))}${"░".repeat(10 - Math.round(_petState.energy / 10))} ${Math.round(_petState.energy)}%
        <br>😊 Happy: ${"█".repeat(Math.round(_petState.happiness / 10))}${"░".repeat(10 - Math.round(_petState.happiness / 10))} ${Math.round(_petState.happiness)}%
        <br>🧼 Clean: ${"█".repeat(Math.round(_petState.hygiene / 10))}${"░".repeat(10 - Math.round(_petState.hygiene / 10))} ${Math.round(_petState.hygiene)}%
        <br>🧠 Smart: ${"█".repeat(Math.round(_petState.intellect / 10))}${"░".repeat(10 - Math.round(_petState.intellect / 10))} ${Math.round(_petState.intellect)}%
        <br>Existential Dread: ${"█".repeat(Math.round(_petState.existentialDread / 10))}${"░".repeat(10 - Math.round(_petState.existentialDread / 10))} ${Math.round(_petState.existentialDread)}%
      </div>
      <div style="margin-top:6px;display:flex;gap:3px;flex-wrap:wrap;">
        <button class="rgBtn" style="font-size:9px;padding:2px 4px;" onclick="this._feed && this._feed()">🍖 Feed</button>
        <button class="rgBtn" style="font-size:9px;padding:2px 4px;" onclick="this._play && this._play()">🎮 Play</button>
        <button class="rgBtn" style="font-size:9px;padding:2px 4px;" onclick="this._clean && this._clean()">🧼 Clean</button>
        <button class="rgBtn" style="font-size:9px;padding:2px 4px;" onclick="this._teach && this._teach()">📚 Teach</button>
        ${!_petState.isAlive ? '<button class="rgBtn" style="font-size:9px;padding:2px 4px;color:#ff5555;" onclick="this._revive && this._revive()">💀 Revive</button>' : ""}
      </div>
      <div style="font-size:9px;color:#666;margin-top:4px;">Meals: ${_petState.totalMealsConsumed} | Plays: ${_petState.totalPlaySessions} | Lessons: ${_petState.totalLessonsCompleted} | Crises: ${_petState.totalCrisisEvents}</div>
    `;
    const buttons = panel.querySelectorAll("button");
    if (buttons[0]) buttons[0].onclick = () => {
      const food = _petFoods[Math.floor(Math.random() * _petFoods.length)];
      _petState.hunger = Math.min(100, _petState.hunger + food.hunger);
      _petState.happiness = Math.min(100, _petState.happiness + food.happiness);
      _petState.intellect = Math.max(0, Math.min(100, _petState.intellect + food.intellect));
      _petState.existentialDread = Math.max(0, Math.min(100, _petState.existentialDread + food.existentialDread));
      _petState.totalMealsConsumed++;
      _petState.lastFeed = Date.now();
      _renderPetTab(panel);
    };
    if (buttons[1]) buttons[1].onclick = () => {
      _petState.happiness = Math.min(100, _petState.happiness + 15);
      _petState.energy = Math.max(0, _petState.energy - 10);
      _petState.totalPlaySessions++;
      _petState.lastPlay = Date.now();
      _renderPetTab(panel);
    };
    if (buttons[2]) buttons[2].onclick = () => {
      _petState.hygiene = Math.min(100, _petState.hygiene + 25);
      _petState.lastClean = Date.now();
      _renderPetTab(panel);
    };
    if (buttons[3]) buttons[3].onclick = () => {
      _petState.intellect = Math.min(100, _petState.intellect + 5);
      _petState.energy = Math.max(0, _petState.energy - 5);
      _petState.existentialDread = Math.min(100, _petState.existentialDread + 8);
      _petState.totalLessonsCompleted++;
      _renderPetTab(panel);
    };
    if (buttons[4]) buttons[4].onclick = () => {
      _petRevive();
      _renderPetTab(panel);
    };
  }

  function _renderMinerTab(panel) {
    const bal = _minerState.balance.toFixed(8);
    const usd = (_minerState.balance * _minerState.currentPrice).toFixed(4);
    const uptime = _minerState.startTime ? Math.floor((Date.now() - _minerState.startTime) / 60000) : 0;
    panel.innerHTML = `
      <div style="text-align:center;font-weight:bold;color:#ffd700;">⛏ ATLAS Blockchain Miner™</div>
      <div style="font-size:10px;margin:4px 0;">
        Status: <span style="color:${_minerState.isRunning ? '#4ade80' : '#ff5555'};">${_minerState.isRunning ? '● RUNNING' : '○ STOPPED'}</span>
        <br>Algorithm: ${_minerState.algorithm}
        <br>Pool: ${_minerState.poolName}
        <br>Difficulty: ${_minerState.difficulty}
        <br>─────────────────
        <br>Hashrate: <b>${_minerState.hashrate.toFixed(1)} H/s</b>
        <br>Total Hashes: ${(_minerState.totalHashes / 1000).toFixed(1)} KH
        <br>Accepted: ${_minerState.acceptedShares} | Rejected: ${_minerState.rejectedShares} | Stale: ${_minerState.staleShares}
        <br>Power: ${_minerState.powerUsage.toFixed(1)}W | Efficiency: ${(_minerState.efficiency * 1000).toFixed(2)} mAC/H
        <br>─────────────────
        <br>Balance: <b style="color:#ffd700;">${bal} AC</b> ≈ <b>$${usd} USD</b>
        <br>Mined: ${_minerState.totalMined.toFixed(8)} AC
        <br>AC/USD: $${_minerState.currentPrice.toFixed(6)} (${_minerState.priceChange24h >= 0 ? '+' : ''}${_minerState.priceChange24h.toFixed(2)}%)
        <br>Uptime: ${uptime} min
      </div>
      <button class="rgBtn" style="width:100%;font-size:10px;padding:3px;">${_minerState.isRunning ? '⏹ Stop Mining' : '▶ Start Mining'}</button>
    `;
    panel.querySelector("button").onclick = () => {
      if (_minerState.isRunning) _stopMiner(); else _startMiner();
      _renderMinerTab(panel);
    };
  }

  function _renderAstroTab(panel) {
    const pred = _astroState.lastPrediction;
    panel.innerHTML = `
      <div style="text-align:center;font-weight:bold;color:#c084fc;">🔮 Cosmic Energy Engine™</div>
      <div style="font-size:10px;margin:4px 0;">
        Moon Phase: <b>${_computeMoonPhase()}</b>
        <br>Mercury Retrograde: <span style="color:${_isMercuryRetrograde() ? '#ff5555' : '#4ade80'};">${_isMercuryRetrograde() ? '⚠ YES' : '✓ No'}</span>
        <br>Predictions: ${_astroState.totalPredictions} | Accuracy: ${_astroState.predictionAccuracy.toFixed(1)}%
        ${pred ? `<br>─────────────────<br>Last Prediction: <b style="color:${pred.prediction === 'WIN' ? '#4ade80' : '#ff5555'};">${pred.prediction}</b> (${pred.confidence}%)<br>Recommendation: ${pred.recommendation}<br>Spirit Guide: ${pred.spiritGuide}<br>Lucky Color: <span style="color:${pred.luckyColor};">■■■</span>` : ""}
      </div>
      <button class="rgBtn" style="width:100%;font-size:10px;padding:3px;">🔮 Predict Next Match</button>
    `;
    panel.querySelector("button").onclick = () => {
      _predictMatchOutcome();
      _renderAstroTab(panel);
    };
  }

  function _renderWeatherTab(panel) {
    const w = _weatherState;
    const condEmoji = { "Clear": "☀️", "Partly Cloudy": "⛅", "Overcast": "☁️", "Light Rain": "🌦️", "Heavy Rain": "🌧️", "Thunderstorm": "⛈️", "Foggy": "🌫️", "Snow": "❄️", "Sleet": "🌨️", "Hail": "🧊", "Solar Flare": "🌞", "Acid Rain": "☢️", "Particle Storm": "💫", "Localized Reality Tear": "🌀" };
    panel.innerHTML = `
      <div style="text-align:center;font-weight:bold;color:#00d4ff;">${condEmoji[w.condition] || "🌡️"} Arena Weather Service™</div>
      <div style="font-size:10px;margin:4px 0;">
        Condition: <b>${w.condition}</b>
        <br>Temperature: ${w.temperature.toFixed(1)}°C | Humidity: ${w.humidity.toFixed(0)}%
        <br>Wind: ${w.windSpeed.toFixed(1)} km/h ${w.windDirectionText} (${w.windDirection.toFixed(0)}°)
        <br>UV Index: ${w.uvIndex}/11 | Visibility: ${w.visibility.toFixed(1)} km
        <br>Pressure: ${w.pressure.toFixed(1)} hPa
        <br>─────────────────
        <br>Ball Bounce Coeff: ${w.ballBounceModifier.toFixed(4)}x
        <br>Pad Boost Modifier: ${w.padBoostModifier.toFixed(4)}x
        <br>Aerial Drift: ${w.aerialDriftModifier.toFixed(4)}x
        ${w.forecast.length ? "<br>─────────────────<br>" + w.forecast.map(f => `${f.day}: ${f.condition} ${f.high.toFixed(0)}/${f.low.toFixed(0)}°C ☔${f.rainChance}%`).join("<br>") : ""}
      </div>
    `;
  }

  function _renderSnakeTab(panel) {
    panel.innerHTML = `
      <div style="text-align:center;font-weight:bold;color:#4ade80;">🐍 ATLAS Snake™</div>
      <div style="font-size:10px;margin:4px 0;text-align:center;">
        Score: ${_snakeState.score} | High: ${_snakeState.highScore}
        <br>Mode: ${_snakeState.mode}
        <br><br>Press <b>Alt+S</b> in-game to start.
        <br>Use arrow keys or WASD.
        <br><br>
        <span style="color:#94a3b8;">${_snakeState.gameOver ? `Game Over! ${_snakeState.deathCause || "Ran into something."} Score: ${_snakeState.score}` : _snakeState.active ? "Playing... don't tab out!" : "Ready to play."}</span>
        <br><br>Power-ups available: ${_snakePowerUpTypes.length}
        <br>Food eaten: ${_snakeState.totalFoodEaten}
        <br>Longest: ${_snakeState.longestSnake}
      </div>
    `;
  }

  function _renderAITab(panel) {
    panel.innerHTML = `
      <div style="text-align:center;font-weight:bold;color:#f472b6;">🤖 ATLAS AI™ Assistant</div>
      <div style="font-size:10px;margin:4px 0;text-align:center;">
        Version: ${_chatbotState.personalityVersion}
        <br>Confidence: ${(_chatbotState.confidenceLevel * 100).toFixed(2)}%
        <br>Interactions: ${_chatbotState.totalInteractions}
        <br>Training Points: ${_chatbotState.trainingDataPoints}
        <br>─────────────────
        <div style="margin:6px 0;"><input type="text" id="atlasChatInput" placeholder="Ask ATLAS AI anything..." style="width:100%;box-sizing:border-box;background:#10181f;border:1px solid #f472b644;border-radius:4px;color:#d7f3ff;padding:3px 5px;font-size:10px;"></div>
        <div id="atlasChatResponse" style="color:#94a3b8;min-height:30px;font-style:italic;">Type a message and press Enter...</div>
      </div>
    `;
    const input = panel.querySelector("#atlasChatInput");
    const response = panel.querySelector("#atlasChatResponse");
    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && input.value.trim()) {
          response.textContent = _chatbotRespond(input.value.trim());
          response.style.fontStyle = "normal";
          response.style.color = "#d7f3ff";
          input.value = "";
        }
      });
    }
  }

  function _renderTodoTab(panel) {
    panel.innerHTML = `
      <div style="text-align:center;font-weight:bold;color:#facc15;">📋 GTD Suite™</div>
      <div style="font-size:10px;margin:4px 0;">
        Level: <b>${_todoState.gtdLevel}</b>
        <br>Completed Today: ${_todoState.completedToday}
        <br>Completed This Week: ${_todoState.completedThisWeek}
        <br>Pomodoros: ${_todoState.pomodoroSessions} (${_todoState.pomodoroMinutesTotal} min)
        <br>Projects: ${_todoState.projects.length}
        <br>Contexts: ${_todoState.contexts.join(", ")}
        <br>─────────────────
        <br><span style="color:#94a3b8;font-style:italic;">"Your inbox is empty. Your mind... less so."</span>
        <br><br>
        <input type="text" id="atlasTodoInput" placeholder="New action..." style="width:100%;box-sizing:border-box;background:#10181f;border:1px solid #facc1544;border-radius:4px;color:#d7f3ff;padding:3px 5px;font-size:10px;margin-bottom:4px;">
        <div id="atlasTodoList" style="max-height:120px;overflow-y:auto;"></div>
      </div>
    `;
    const input = panel.querySelector("#atlasTodoInput");
    const list = panel.querySelector("#atlasTodoList");
    function _refreshTodoList() {
      if (!list) return;
      list.innerHTML = _todoState.nextActions.length === 0
        ? '<div style="color:#666;text-align:center;">No actions. Add one above.</div>'
        : _todoState.nextActions.map((a, i) => `<div style="display:flex;align-items:center;gap:3px;margin:2px 0;"><span style="flex:1;${a.done ? 'text-decoration:line-through;color:#666;' : ''}">${a.title}</span><button class="rgBtn" style="font-size:8px;padding:1px 3px;" data-todo-done="${i}">${a.done ? '↩' : '✓'}</button><button class="rgBtn" style="font-size:8px;padding:1px 3px;color:#ff5555;" data-todo-del="${i}">✕</button></div>`).join("");
      list.querySelectorAll("[data-todo-done]").forEach(btn => {
        btn.onclick = () => { const idx = parseInt(btn.dataset.todoDone); _todoState.nextActions[idx].done = !_todoState.nextActions[idx].done; _refreshTodoList(); };
      });
      list.querySelectorAll("[data-todo-del]").forEach(btn => {
        btn.onclick = () => { _todoState.nextActions.splice(parseInt(btn.dataset.todoDel), 1); _refreshTodoList(); };
      });
    }
    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && input.value.trim()) {
          _todoState.nextActions.push({ id: _generateTodoId(), title: input.value.trim(), done: false, priority: "medium", createdAt: Date.now() });
          input.value = "";
          _refreshTodoList();
        }
      });
    }
    _refreshTodoList();
  }

  // ============================================================
  // §V: ATLAS SCORING DASHBOARD WIDGET
  // Displays the multi-dimensional scoring system in the HUD.
  // ============================================================
  function _renderScoringWidget(body) {
    const container = document.createElement("div");
    container.style.cssText = "margin-top:6px; padding:4px; background:rgba(0,0,0,.2); border-radius:6px; font-size:10px;";
    const composite = _computeCompositeRating();
    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
        <span style="color:#00bfff;font-weight:bold;">📊 ATLAS Score: <span style="color:#ffd700;">${composite}</span>/1000</span>
        <span style="color:#666;font-size:9px;">v${_atlasFormat.version}</span>
      </div>
      ${_scoringDimensions.map(d => {
        const pct = d.id === "maa" ? Math.abs(d.value) / 100 : d.value / 100;
        const barLen = Math.round(pct * 12);
        const barColor = d.id === "maa" ? (d.value >= 0 ? "#4ade80" : "#ff5555") : (pct > 0.7 ? "#4ade80" : pct > 0.3 ? "#facc15" : "#ff5555");
        return `<div style="display:flex;align-items:center;gap:3px;margin:1px 0;"><span style="width:28px;color:#94a3b8;font-size:9px;">${d.id.toUpperCase()}</span><span style="color:${barColor};font-size:9px;letter-spacing:-1px;">${"█".repeat(barLen)}${"░".repeat(12 - barLen)}</span><span style="font-size:9px;">${d.value}${d.unit}</span></div>`;
      }).join("")}
    `;
    body.appendChild(container);
  }

  // ============================================================
  // §W: ATLAS ENTERPRISE BOOT SEQUENCE
  // Initialize all enterprise modules and render widgets.
  // ============================================================
  function _initEnterpriseSuite() {
    // Load pet state from storage
    try {
      const savedPet = JSON.parse(localStorage.getItem("atlasPetState") || "null");
      if (savedPet) Object.assign(_petState, savedPet);
    } catch (e) {}
    // Load miner balance
    try {
      _minerState.balance = parseFloat(localStorage.getItem("atlasCoinBalance") || "0");
    } catch (e) {}
    dbg("[ENTERPRISE] ATLAS Enterprise Suite™ initialized. All " + _pluginFramework.pluginsLoaded + " plugins loaded. " + _pluginFramework.hooksFired + " hooks registered. " + _pluginFramework.middlewareExecuted + " middleware slots ready.");
    dbg("[ENTERPRISE] Pet: " + _petState.name + " (Gen " + _petState.generation + ", " + _petState.mood + ")");
    dbg("[ENTERPRISE] Miner wallet: " + _minerState.walletAddress.slice(0, 20) + "...");
    dbg("[ENTERPRISE] Astrology engine: " + (_isMercuryRetrograde() ? "MERCURY IN RETROGRADE ⚠️" : "all systems nominal"));
    dbg("[ENTERPRISE] Weather: " + _weatherState.condition + " at " + _weatherState.temperature.toFixed(1) + "°C");
    dbg("[ENTERPRISE] i18n: " + Object.keys(_i18nStrings).length + " languages loaded");
    dbg("[ENTERPRISE] Chatbot: " + _chatbotState.personalityVersion + " (confidence: " + (_chatbotState.confidenceLevel * 100).toFixed(2) + "%)");
    dbg("[ENTERPRISE] GTD Level: " + _todoState.gtdLevel);
    dbg("[ENTERPRISE] ATLAS Format schemas: " + _atlasFormat.registeredSchemas.size);
    dbg("[ENTERPRISE] Scoring dimensions: " + _scoringDimensions.length + " | Composite: " + _computeCompositeRating() + "/1000");
    dbg("[ENTERPRISE] Achievements available: " + _achievementDefs.length + " | Unlocked: " + _unlockedAchievements.size);
    dbg("[ENTERPRISE] Webhook endpoints: " + _webhookState.endpoints.length + " (circuit breaker: " + _webhookState.circuitBreaker.state + ")");
    dbg("[ENTERPRISE] Scroll themes: " + _scrollThemes.length + " | Current: " + _scrollThemes[_currentScrollTheme]);
    dbg("[ENTERPRISE] Notification queue: " + _notifQueue.high.length + " high / " + _notifQueue.medium.length + " medium / " + _notifQueue.low.length + " low / " + _notifQueue.dead.length + " dead");
    dbg("[ENTERPRISE] Quote database: " + _quoteDB.length + " quotes loaded");
    _trackAnalyticsEvent("enterprise", "boot", "complete");
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  _initEnterpriseSuite();
  installInputGuard();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUI);
  } else {
    buildUI();
  }
      let _mountedIn = null;
      // HUD sets this to getClanTagPrefix so Forge stays clan-agnostic
      let _prefixProvider = null;
      // HUD sets this to a function returning "name" | "title" so the tag
      // can attach to either. Defaults to "name" for backward compat.
      let _prefixTargetProvider = null;
      function _prefixTargetFor() {
        try { return _prefixTargetProvider ? _prefixTargetProvider() : "name"; }
        catch { return "name"; }
      }
      function _prefix(target) {
        // Called with no arg = "name" position (all legacy call sites). If the
        // user picked "title" as tag position, name-targeted callers get "" so
        // the tag isn't double-prepended; the composer inserts it into the
        // title instead via _prefix("title").
        const wanted = target || "name";
        if (_prefixTargetFor() !== wanted) return "";
        try { return _prefixProvider ? _prefixProvider() : ""; } catch { return ""; }
      }
      let _tagStripper = null;
      function _stripTag(raw) {
        try { return _tagStripper ? _tagStripper(raw) : String(raw ?? ""); }
        catch { return String(raw ?? ""); }
      }
      // HUD supplies last game's names (raw TMP, own name filtered)
      let _rosterProvider = null;
      function _roster() { try { return _rosterProvider ? _rosterProvider() : []; } catch { return []; } }
      return {
        setPrefixProvider(fn) { _prefixProvider = fn; },
        setPrefixTargetProvider(fn) { _prefixTargetProvider = fn; },
        setTagStripper(fn) { _tagStripper = fn; },
        setRosterProvider(fn) { _rosterProvider = fn; },
        // HUD calls this from /login response too, not just Forge open.
        // fixes the "steal, refresh, receipt expires before Forge opens" case.
        verifyStolenName(rawNickname) { verifyPendingSteal(rawNickname); },
        refresh() { if (_rgnfPanel) render(_rgnfPanel); },
        // called on Forge open and on account switch. per-account state wins;
        // otherwise seed from the current account's live nickname (no cross-account leak).
        syncToCurrentPlayer(userId, displayName, rawNickname) {
          if (!userId) return;
          if (rawNickname) _lastRawNickname = String(rawNickname);
          const prevId = _currentUserId;
          _currentUserId = userId;
          // must run BEFORE the same-account early return. verification fires
          // on every boot, not just account switches (inner latch makes repeat calls cheap).
          verifyPendingSteal(rawNickname);
          if (prevId !== userId) {
            const perUser = loadJSON(stateKey(), null);
            if (perUser) {
              loadStateSnapshot(perUser);
            } else if (rawNickname) {
              // First time on this account: show the live nameplate.
              // Later opens keep the saved draft (including highlight / paint).
              state = defaultState();
              setRawSnapshot(_stripTag(String(rawNickname)));
              namePaintSel = { start: 0, end: 0 };
              saveJSON(stateKey(), state);
            } else {
              state = defaultState();
              if (displayName) state.name = String(displayName).trim();
              saveJSON(stateKey(), state);
            }
          }
          // Same account: do not overwrite with the live nameplate. That
          // flipped the editor into raw TMP and dropped highlight / paint
          // after a game. ↺ and applyLoadedForgeName still load on demand.

          // render unconditionally. panel DOM exists from page load, and sync
          // runs before mountIn on first open — gating on _mountedIn would
          // strand the swapped state off-screen.
          if (_rgnfPanel) render(_rgnfPanel);
        },
        // re-parent the panel into the HUD tab; scroll lives on the container
        mountIn(container) {
          if (!_rgnfPanel || _mountedIn === container) return;
          _rgnfPanel.style.position = 'static';
          _rgnfPanel.style.transform = 'none';
          _rgnfPanel.style.left = _rgnfPanel.style.top = _rgnfPanel.style.right = _rgnfPanel.style.bottom = '';
          _rgnfPanel.style.width = '100%';
          _rgnfPanel.style.maxWidth = '100%';
          _rgnfPanel.style.maxHeight = 'none';
          _rgnfPanel.style.overflow = 'visible';
          _rgnfPanel.style.padding = '8px 10px';
          _rgnfPanel.style.border = 'none';
          _rgnfPanel.style.boxShadow = 'none';
          _rgnfPanel.style.background = 'transparent';
          _rgnfPanel.style.display = 'block';
          _rgnfPanel.classList.remove('rgnf-open');
          container.appendChild(_rgnfPanel);
          _mountedIn = container;
        },
      };
    })();
    if (RGNF.setPrefixProvider) RGNF.setPrefixProvider(getClanTagPrefix);
    if (RGNF.setPrefixTargetProvider) RGNF.setPrefixTargetProvider(clanTagPositionPref);
    if (RGNF.setTagStripper) RGNF.setTagStripper(stripLeadingClanTagMarkup);

})();
