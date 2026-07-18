// ==UserScript==
// @name         Rocket Goal HUD
// @namespace    https://rocketgoal.io
// @version      9.3
// @description  Live stats HUD for Rocket Goal - ratings, ranks, session deltas, win rates, auto leaderboard sync, customizable glow
// @author       JesusDied4U
// @match        https://rocketgoal.io/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/rg_hud.js
// @downloadURL  https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/rg_hud.js
// @supportURL   https://github.com/wiljdaws/Tampermonkeys/issues
// ==/UserScript==

(function () {
    'use strict';

    let hud;

    // ---------- Settings (persisted in localStorage) ----------

    const DEFAULT_SETTINGS = {
        glowEnabled: true,
        glowSpeed: 5,        // speed level 1-10, higher = faster
        glowOpacity: 0.6,    // vibrancy
        glowColor1: "#ff7a00",
        glowColor2: "#00d4ff",
    };

    let settings = { ...DEFAULT_SETTINGS };
    try {
        settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("rgHudSettings") ?? "{}") };
    } catch (e) {}

    function saveSettings() {
        try { localStorage.setItem("rgHudSettings", JSON.stringify(settings)); } catch (e) {}
    }

    function hexToRgba(hex, alpha) {
        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        if (!m) return hex;
        return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
    }

    // Regenerates the glow keyframes from current settings and applies them.
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
        // Speed level 1-10 maps to rotation duration 20s (crawl) down to ~1.5s (fast).
        // Momentum applies a speed multiplier on top (on fire = faster, cold = slower).
        const baseDuration = 22 - (settings.glowSpeed * 2.05);
        const duration = baseDuration / momentumGlow.speedMult;
        hud.style.boxShadow = "";
        hud.style.animation = `rgGlowSpin ${duration.toFixed(2)}s linear infinite`;
    }

    // ---------- HUD ----------

    function createHUD() {
        if (hud) return;

        hud = document.createElement("div");
        hud.id = "rgHUD";

        // Restore last dragged position if saved
        let pos = { top: "110px", left: "", right: "20px" };
        try {
            const saved = JSON.parse(localStorage.getItem("rgHudPos") ?? "null");
            if (saved && saved.top && saved.left) {
                pos = { top: saved.top, left: saved.left, right: "auto" };
            }
        } catch (e) {}

        hud.style.cssText = `
            position:fixed;
            top:${pos.top};
            ${pos.left ? `left:${pos.left};` : ""}
            right:${pos.right};
            width:250px;
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
            </style>
            <div style="display:flex;align-items:center;justify-content:space-between;cursor:move;gap:8px;" id="rgDragHandle">
                <span id="rgTitle" style="font-size:16px;font-weight:bold;color:#00bfff;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">🚀 Rocket Goal HUD</span>
                <div style="display:flex;align-items:center;gap:5px;flex-shrink:0;">
                    <span id="rgErrDot" title="" style="display:none;color:#ff5555;font-weight:bold;font-size:14px;">⚠</span>
                    <button id="rgSettingsBtn" class="rgIconBtn" title="Settings">⚙</button>
                    <button id="rgMinimize" class="rgIconBtn" title="Minimize">–</button>
                </div>
            </div>
            <hr>
            <div id="rgBody">
                <div id="rgContent">Waiting for data...</div>
                <div id="rgSettingsPanel" style="display:none;border-top:1px solid #00bfff44;margin-top:8px;padding-top:6px;">
                    <div class="rgSettingRow"><span>Glow</span><input type="checkbox" id="rgSetGlow"></div>
                    <div class="rgSettingRow"><span>Speed</span><input type="range" id="rgSetSpeed" min="1" max="10" step="0.5"></div>
                    <div class="rgSettingRow"><span>Vibrancy</span><input type="range" id="rgSetOpacity" min="0.1" max="1" step="0.05"></div>
                    <div class="rgSettingRow"><span>Color 1</span><input type="color" id="rgSetColor1"></div>
                    <div class="rgSettingRow"><span>Color 2</span><input type="color" id="rgSetColor2"></div>
                    <button id="rgSetReset" class="rgBtn" style="width:100%;margin-top:4px;">Reset to defaults</button>
                </div>
                <div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap;">
                    <button id="rgRename" class="rgBtn">✏️ Rename</button>
                    <button id="rgSub" class="rgBtn">📺 Sub</button>
                    <button id="rgLeaderboard" class="rgBtn">🏆 Board</button>
                    <button id="rgReportBug" class="rgBtn">🐛 Bug</button>
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
        `;

        document.body.appendChild(hud);
        dragElement(hud, document.getElementById("rgDragHandle"));
        applyGlowSettings();

        // Custom themed tooltip (replaces native title= tooltips, which can't be
        // styled and have a slow show delay). One shared element, positioned near
        // the cursor whenever hovering anything with a data-tip.
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
            // Position above-right of cursor, nudged to stay on screen.
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

        document.getElementById("rgMinimize").onclick = () => manualToggle();
        document.getElementById("rgSub").onclick = () => {
            window.open("https://www.youtube.com/@RootedEngineering", "_blank", "noopener");
        };
        document.getElementById("rgLeaderboard").onclick = () => {
            window.open("https://abuarqob.github.io/rgleaderboard/", "_blank", "noopener");
        };
        document.getElementById("rgReportBug").onclick = () => {
            window.open("https://github.com/wiljdaws/Tampermonkeys/issues/new", "_blank", "noopener");
        };
        document.getElementById("rgRename").onclick = () => {
            if (!lastKnownPlayerData) {
                showNameModal("Play a match or log in first!", "", false, () => {});
                hideNameModalSoon();
                return;
            }
            forceRenamePrompt = true;
            submitToLeaderboard(lastKnownPlayerData);
        };

        // Settings panel wiring
        const panel = document.getElementById("rgSettingsPanel");
        document.getElementById("rgSettingsBtn").onclick = () => {
            panel.style.display = panel.style.display === "none" ? "block" : "none";
        };

        const setGlow = document.getElementById("rgSetGlow");
        const setSpeed = document.getElementById("rgSetSpeed");
        const setOpacity = document.getElementById("rgSetOpacity");
        const setColor1 = document.getElementById("rgSetColor1");
        const setColor2 = document.getElementById("rgSetColor2");

        function syncSettingInputs() {
            setGlow.checked = settings.glowEnabled;
            setSpeed.value = settings.glowSpeed;
            setOpacity.value = settings.glowOpacity;
            setColor1.value = settings.glowColor1;
            setColor2.value = settings.glowColor2;
        }
        syncSettingInputs();

        setGlow.onchange = () => { settings.glowEnabled = setGlow.checked; saveSettings(); applyGlowSettings(); };
        setSpeed.oninput = () => { settings.glowSpeed = parseFloat(setSpeed.value); saveSettings(); applyGlowSettings(); };
        setOpacity.oninput = () => { settings.glowOpacity = parseFloat(setOpacity.value); saveSettings(); applyGlowSettings(); };
        setColor1.oninput = () => { settings.glowColor1 = setColor1.value; saveSettings(); applyGlowSettings(); };
        setColor2.oninput = () => { settings.glowColor2 = setColor2.value; saveSettings(); applyGlowSettings(); };
        document.getElementById("rgSetReset").onclick = () => {
            settings = { ...DEFAULT_SETTINGS };
            saveSettings();
            syncSettingInputs();
            applyGlowSettings();
        };
    }

    function dragElement(el, handle) {
        let dx = 0, dy = 0;

        handle.onmousedown = e => {
            if (e.target.closest(".rgIconBtn")) return; // buttons handle their own clicks
            e.preventDefault();
            dx = e.clientX;
            dy = e.clientY;
            document.onmousemove = drag;
            document.onmouseup = () => {
                document.onmousemove = null;
                document.onmouseup = null;
                try {
                    localStorage.setItem("rgHudPos", JSON.stringify({
                        top: el.style.top,
                        left: el.style.left,
                    }));
                } catch (err) {}
            };
        };

        function drag(e) {
            e.preventDefault();
            const moveX = dx - e.clientX;
            const moveY = dy - e.clientY;
            dx = e.clientX;
            dy = e.clientY;
            el.style.top = (el.offsetTop - moveY) + "px";
            el.style.left = (el.offsetLeft - moveX) + "px";
            el.style.right = "auto";
        }
    }

    function manualToggle() {
        const body = document.getElementById("rgBody");
        const visible = body.style.display !== "none";
        body.style.display = visible ? "none" : "block";
        document.getElementById("rgMinimize").textContent = visible ? "+" : "–";
        document.getElementById("rgMinimize").title = visible ? "Restore" : "Minimize";
    }

    function setAutoVisible(visible) {
        if (!hud) return;
        hud.style.display = visible ? "block" : "none";
    }

    // ---------- Error indicator ----------

    function showError(message) {
        const dot = document.getElementById("rgErrDot");
        if (dot) {
            dot.style.display = "inline";
            dot.title = message;
        }
    }

    function clearError() {
        const dot = document.getElementById("rgErrDot");
        if (dot) dot.style.display = "none";
    }

    // ---------- Session deltas ----------

    // A "session" is a continuous play run. It resets when: the account changes,
    // OR there's been a gap of no activity longer than SESSION_IDLE_MS (e.g. you
    // played last night, slept, and came back today). Stored in localStorage with
    // a timestamp so a plain page refresh keeps the session, but a long break
    // starts a fresh one -- which sessionStorage alone couldn't distinguish.
    const SESSION_IDLE_MS = 2 * 60 * 60 * 1000; // 2 hours

    let sessionStart = null;
    try { sessionStart = JSON.parse(localStorage.getItem("rgHudSessionStart") ?? "null"); } catch (e) {}

    function captureSessionStart(data) {
        const now = Date.now();
        const sameAccount = sessionStart && sessionStart.accountId === data.Id;
        const idledOut = sessionStart && (now - (sessionStart.lastSeen ?? 0)) > SESSION_IDLE_MS;

        if (sameAccount && !idledOut) {
            // Continuing the same session -- just refresh the activity timestamp.
            sessionStart.lastSeen = now;
            try { localStorage.setItem("rgHudSessionStart", JSON.stringify(sessionStart)); } catch (e) {}
            return;
        }

        // New session: fresh baseline. Also clear the per-entry write cache and
        // momentum so a new run doesn't inherit yesterday's state.
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

    // playlist -> rank number; refreshed after our own data changes.
    const cachedRanks = new Map();
    // playlist -> mmr needed to pass the person one rank above you (null if #1).
    const cachedMmrToNext = new Map();

    function rankBadge(playlist) {
        const r = cachedRanks.get(playlist);
        if (!r) return "";

        // Tiered colors: gold for top 3, purple for top 10, cyan for top 25, gray beyond
        let color;
        if (r <= 3) color = "#ffd700";
        else if (r <= 10) color = "#c77dff";
        else if (r <= 25) color = "#00d4ff";
        else color = "#9aa5ad";

        // Hover tooltip (custom-styled): how much MMR to pass the next rank up.
        const gap = cachedMmrToNext.get(playlist);
        let tip;
        if (r === 1) tip = "You're #1! 👑";
        else if (typeof gap === "number") tip = `+${gap} MMR to reach #${r - 1}`;
        else tip = `Rank #${r}`;

        return ` <span class="rgHasTip" data-tip="${tip}" style="color:${color};font-size:10px;font-weight:bold;">#${r}</span>`;
    }

    // ---------- Crown system ----------
    // Title becomes KING while holding any #1; a coronation banner fires the
    // moment a #1 is newly taken, and a dethroned alert fires when it's lost.

    const prevRanks = new Map(); // playlist -> last known rank

    // ---------- Momentum system ----------
    // Based on net MMR gained/lost across all modes this session. Changes the
    // title and the glow speed/intensity (NOT the user's chosen colors).

    const MOMENTUM_TIERS = {
        onFire:    150,   // >= : "ON FIRE", fast + bright glow
        heatingUp: 75,    // >= : "Heating Up", warmer/faster glow
        cold:      -75,   // <= : "Ice Cold", slow + dim glow
        shutEye:   -200,  // <= : easter egg
    };

    // Rotating easter-egg messages so a rough session doesn't repeat. Ribbing, not mean.
    const SHUT_EYE_MESSAGES = [
        "😴 Maybe it's time for some shut-eye?",
        "😴 The ball will still be here tomorrow...",
        "🛌 Consider: a strategic nap.",
        "☕ Touch grass? Or at least grab a coffee.",
        "😅 Rough one. Shake it off, champ.",
    ];
    let shutEyeMessage = SHUT_EYE_MESSAGES[Math.floor(Math.random() * SHUT_EYE_MESSAGES.length)];

    // Read by applyGlowSettings; momentum only changes speed & intensity, not colors.
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
        if (net >= MOMENTUM_TIERS.onFire) return "onFire";
        if (net >= MOMENTUM_TIERS.heatingUp) return "heatingUp";
        return "neutral";
    }

    // Title priority: crown (#1) beats momentum beats default.
    function resolveTitle() {
        const holdingAnyFirst = [...cachedRanks.values()].some(r => r === 1);
        if (holdingAnyFirst) return { text: "👑 Rocket Goal KING", color: "#ffd700" };

        switch (currentMomentumState) {
            case "shutEye":   return { text: shutEyeMessage, color: "#9aa5ad" };
            case "cold":      return { text: "❄️ Ice Cold", color: "#7ec8ff" };
            case "onFire":    return { text: "🔥 ON FIRE", color: "#ff5b1f" };
            case "heatingUp": return { text: "🔥 Heating Up", color: "#ff9a3c" };
            default:          return { text: "🚀 Rocket Goal HUD", color: "#00bfff" };
        }
    }

    function applyTitle() {
        const titleEl = document.getElementById("rgTitle");
        if (!titleEl) return;
        const { text, color } = resolveTitle();
        titleEl.textContent = text;
        titleEl.style.color = color;
    }

    function updateMomentum(forceState = null) {
        const newState = forceState ?? computeMomentumState(netSessionMMR());
        const changed = newState !== currentMomentumState;
        currentMomentumState = newState;

        switch (newState) {
            case "onFire":    momentumGlow = { speedMult: 2.2, intensity: 1.5 }; break;
            case "heatingUp": momentumGlow = { speedMult: 1.5, intensity: 1.2 }; break;
            case "cold":      momentumGlow = { speedMult: 0.5, intensity: 0.7 }; break;
            case "shutEye":   momentumGlow = { speedMult: 0.35, intensity: 0.55 }; break;
            default:          momentumGlow = { speedMult: 1, intensity: 1 };
        }

        applyGlowSettings();
        applyTitle();

        if (changed) {
            if (newState === "onFire") showBanner("🔥 YOU'RE ON FIRE!", "#ff5b1f");
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

            // Coronation: newly took #1 (only if we knew a previous, non-#1 rank --
            // avoids firing just because a session started while already on top)
            if (rank === 1 && typeof prev === "number" && prev !== 1) {
                showBanner(`👑 NEW #1 IN ${playlist.toUpperCase()}!`, "#ffd700");
            }

            // Dethroned: was #1, now isn't
            if (prev === 1 && rank !== 1) {
                showBanner(`⚔️ Dethroned in ${playlist.toUpperCase()}!`, "#ff6b6b");
            }

            prevRanks.set(playlist, rank);
        }

        applyTitle(); // crown state may have changed
    }

    // ---------- HUD content ----------

    function updateHUD(data) {
        createHUD();
        lastKnownPlayerData = data;
        captureSessionStart(data);
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
            <div style="display:flex;">
                <div style="flex:1.15;">
                    <b>🏆 Ratings</b><br>
                    3v3: <span style="color:#00ff66">${rating("Competitive3v3")}</span>${rankBadge("3v3")}${deltaBadge("Competitive3v3", ratingVal("Competitive3v3"))}<br>
                    2v2: <span style="color:#00ff66">${rating("Competitive2v2")}</span>${rankBadge("2v2")}${deltaBadge("Competitive2v2", ratingVal("Competitive2v2"))}<br>
                    1v1: <span style="color:#00ff66">${rating("Competitive1v1")}</span>${rankBadge("1v1")}${deltaBadge("Competitive1v1", ratingVal("Competitive1v1"))}<br>
                    Casual: <span style="color:#00ff66">${rating("Casual")}</span>${deltaBadge("Casual", ratingVal("Casual"))}
                </div>
                <div style="width:1px;background:#00bfff88;margin:0 8px;"></div>
                <div style="flex:1;">
                    <b>📊 Win Rates</b><br>
                    3v3 <span style="color:#00ff66">${wr("Competitive3v3")}%</span><br>
                    2v2 <span style="color:#00ff66">${wr("Competitive2v2")}%</span><br>
                    1v1 <span style="color:#00ff66">${wr("Competitive1v1")}%</span><br>
                    Casual <span style="color:#00ff66">${wr("Casual")}%</span>
                </div>
            </div>

            <hr style="border:none;border-top:1px solid #00bfff88;margin:10px 0;">

            Wins: <span style="color:#00ff66">${totalWins}</span><br>
            Matches Played: <span style="color:#00ff66">${totalMatches}</span>
        `;
    }

    let lastProcessedText = null;

    function tryParseAndUpdate(text) {
        // The game's own code logs the exact same response text to console.log
        // that our fetch hook also sees separately, so the identical event can
        // reach here twice in a row. Skip the repeat instead of double-processing.
        if (text === lastProcessedText) return;

        try {
            const data = JSON.parse(text);
            if (data && data.ModesGlicko) {
                lastProcessedText = text;
                updateHUD(data);
                submitToLeaderboard(data);
            }
        } catch (e) {}
    }

    // ---------- Leaderboard submission ----------

    // Pal's Firebase web config -- this is the public client config, not a secret.
    // Set to null to disable all leaderboard submission.
    const FIREBASE_CONFIG = {
        apiKey: "AIzaSyD29s2Jku_DZ42keIQAETgKg7HWt__QEwY",
        authDomain: "rgleaderboard.firebaseapp.com",
        projectId: "rgleaderboard",
        storageBucket: "rgleaderboard.firebasestorage.app",
        messagingSenderId: "247848634543",
        appId: "1:247848634543:web:6a7e506d60544d46cc6c5a",
        measurementId: "G-JW3Q972P9T",
    };

    // Raw per-player data dump, separate from the "leaderboard" collection the
    // site renders. Keeps the full stats snapshot (all modes, xp, raw nickname,
    // chosen displayName) as a record, while syncToRealLeaderboard below pushes
    // just the site-shaped entries into the real "leaderboard" collection.
    const LEADERBOARD_COLLECTION = "script_submissions";

    let firestoreReady = null; // holds the loaded Firestore SDK handles once initialized

    async function initFirebase() {
        if (!FIREBASE_CONFIG) return null;
        if (firestoreReady) return firestoreReady;

        try {
            const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
            const { getFirestore, doc, setDoc, getDoc, collection, query, where, getDocs, addDoc, getCountFromServer, orderBy, limit } =
                await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

            const app = initializeApp(FIREBASE_CONFIG);
            const db = getFirestore(app);

            firestoreReady = { db, doc, setDoc, getDoc, collection, query, where, getDocs, addDoc, getCountFromServer, orderBy, limit };
            return firestoreReady;
        } catch (e) {
            console.error("[RG HUD] Firebase init failed:", e);
            showError("Firebase failed to load");
            return null;
        }
    }

    // Strips TextMeshPro rich-text tags (<#rrggbb>, <br>, <sub>, etc.) so a
    // decorated in-game nickname has a sane plain-text fallback to suggest.
    function cleanName(name) {
        return (name ?? "")
            .replace(/<[^>]*>/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    // Not exhaustive, but catches common attempts. Word-boundary matching so it
    // doesn't falsely flag innocent words (e.g. "classic", "assassin").
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

    function containsProfanity(text) {
        return PROFANITY_REGEX.test(text);
    }

    // Skip brand-new accounts that haven't played anything yet.
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

    // Unity captures keyboard events at the window level (capture phase) and
    // preventDefaults printable characters, which kills typing in our input
    // before the event ever reaches it. Intercept one step earlier: while our
    // input is focused, stop the game from seeing keys at all.
    ["keydown", "keyup", "keypress"].forEach(type => {
        window.addEventListener(type, e => {
            const input = document.getElementById("rgNameInput");
            if (input && document.activeElement === input) {
                e.stopImmediatePropagation();
                // Enter still saves
                if (type === "keydown" && e.key === "Enter") {
                    const saveBtn = document.getElementById("rgNameSave");
                    if (saveBtn) saveBtn.click();
                }
            }
        }, true); // capture phase -- runs before the game's own listeners
    });

    // Returns a promise that resolves with the chosen (validated) name.
    function askDisplayName(suggestion, isRename) {
        return new Promise(resolve => {
            const title = isRename
                ? "Enter your new leaderboard name:"
                : "First stats submission! Pick your leaderboard name:";
            showNameModal(title, suggestion, true, resolve);

            const input = document.getElementById("rgNameInput");
            const errEl = document.getElementById("rgNameError");

            document.getElementById("rgNameSave").onclick = () => {
                const entered = input.value.trim();
                if (entered.length === 0 || entered.length > 15) {
                    errEl.textContent = "Name must be 1-15 characters.";
                    return;
                }
                if (containsProfanity(entered)) {
                    errEl.textContent = "That name isn't allowed. Pick something else.";
                    return;
                }
                hideNameModal();
                resolve(entered);
            };

            document.getElementById("rgNameCancel").onclick = () => {
                hideNameModal();
                resolve(suggestion); // cancelled -> fall back to suggestion, don't nag
            };

            // Key handling (including Enter-to-save) happens in the window-level
            // capture listener above, which runs before the game's own handlers.
        });
    }

    // ---------- Write-reduction caches ----------
    // Together these keep Firebase traffic to the minimum: nothing is read
    // twice per session, and nothing is written unless it actually changed.

    // Running counter logged to console for every real Firestore write.
    let firestoreWriteCount = 0;
    function logWrite(label) {
        firestoreWriteCount++;
        console.log(`[RG HUD] Firestore write #${firestoreWriteCount} (${label})`);
    }

    // Resolved display name per player (skips the getDoc re-read).
    const cachedDisplayNames = new Map();

    // Full payload snapshot per player (skips everything if nothing changed).
    const lastSyncSnapshot = new Map();

    // Real leaderboard doc ID per player+mode (skips the lookup query).
    const knownDocIds = new Map();

    // Safety-net cooldown: max one full sync per player per window.
    const SYNC_COOLDOWN_MS = 20000;
    const lastSyncTime = new Map();

    let forceRenamePrompt = false;

    // Serializes submitToLeaderboard per player so near-simultaneous events
    // can't race each other into double prompts or duplicate writes.
    const submitLocks = new Map();

    async function submitToLeaderboard(data) {
        const lockKey = data.Id;
        const previous = submitLocks.get(lockKey) || Promise.resolve();
        const current = previous.then(() => submitToLeaderboardInner(data));
        submitLocks.set(lockKey, current);
        await current;
    }

    async function submitToLeaderboardInner(data) {
        if (!hasPlayedAnything(data)) return; // brand new account, nothing to show yet

        const fb = await initFirebase();
        if (!fb) return; // disabled or failed to load, silently skip

        const docRef = fb.doc(fb.db, LEADERBOARD_COLLECTION, data.Id);

        // Only ask for a display name once per player, ever -- unless Rename
        // forces it. Cached in memory so repeat calls skip the Firestore read.
        let existingDisplayName = cachedDisplayNames.get(data.Id) ?? null;

        if (!existingDisplayName || forceRenamePrompt) {
            try {
                const existing = await fb.getDoc(docRef);
                if (existing.exists() && existing.data().displayName) {
                    existingDisplayName = existing.data().displayName;
                }
            } catch (e) {
                // couldn't read existing doc -- fall through and ask
            }
        }

        let displayName = (!forceRenamePrompt && existingDisplayName) ? existingDisplayName : null;
        const isRename = forceRenamePrompt && !!existingDisplayName;
        forceRenamePrompt = false;

        if (!displayName) {
            const suggestion = (existingDisplayName || cleanName(data.Nickname)).slice(0, 15) || "Player";
            displayName = await askDisplayName(suggestion, isRename);
        }

        cachedDisplayNames.set(data.Id, displayName);

        const payload = {
            nickname: (data.Nickname ?? "").slice(0, 500),
            displayName,
            ratings: {
                Competitive3v3: data.ModesGlicko?.Competitive3v3?.displayRating ?? null,
                Competitive2v2: data.ModesGlicko?.Competitive2v2?.displayRating ?? null,
                Competitive1v1: data.ModesGlicko?.Competitive1v1?.displayRating ?? null,
                Casual: data.ModesGlicko?.Casual?.displayRating ?? null,
            },
            stats: {
                Competitive3v3: data.ModesData?.Competitive3v3 ?? null,
                Competitive2v2: data.ModesData?.Competitive2v2 ?? null,
                Competitive1v1: data.ModesData?.Competitive1v1 ?? null,
                Casual: data.ModesData?.Casual ?? null,
            },
            xp: data.AccountXp ?? 0,
            equippedSkinId: data.EquippedSkinId ?? null,
            lastUpdated: new Date().toISOString(),
        };

        // Skip the actual network writes if nothing changed or synced very
        // recently -- but never skip a deliberate Rename.
        const snapshotKey = JSON.stringify({
            displayName, ratings: payload.ratings, stats: payload.stats,
            xp: payload.xp, equippedSkinId: payload.equippedSkinId,
        });
        const now = Date.now();
        const unchanged = lastSyncSnapshot.get(data.Id) === snapshotKey;
        const withinCooldown = (now - (lastSyncTime.get(data.Id) ?? 0)) < SYNC_COOLDOWN_MS;

        if (!isRename && (unchanged || withinCooldown)) {
            // Still refresh ranks once per session even if the write is skipped.
            refreshRanks(fb, data);
            return;
        }

        lastSyncSnapshot.set(data.Id, snapshotKey);
        lastSyncTime.set(data.Id, now);

        try {
            logWrite("script_submissions");
            await fb.setDoc(docRef, payload, { merge: true });
            clearError();
        } catch (e) {
            console.error("[RG HUD] Leaderboard submission failed:", e);
            showError("Stats submission failed -- check console");
        }

        await syncToRealLeaderboard(fb, data, displayName);
        refreshRanks(fb, data, true);
    }

    const REAL_LEADERBOARD_COLLECTION = "leaderboard";

    // Serializes calls per player+mode so two near-simultaneous writes for the
    // same key can never race each other into creating two documents.
    const upsertLocks = new Map();

    // Finds this player's entry for one playlist by sourceUserId and updates it,
    // whether created by the script OR a pre-existing manually-curated entry Pal
    // tagged with a matching sourceUserId. merge:true means hand-set fields like
    // flag/icons/glowColor are never touched. Creates a fresh entry if none match.
    async function upsertPlaylistEntry(fb, sourceUserId, playlist, fields) {
        const lockKey = `${sourceUserId}_${playlist}`;
        const previous = upsertLocks.get(lockKey) || Promise.resolve();

        const current = previous.then(async () => {
            const cacheKey = `${sourceUserId}_${playlist}`;
            const cachedId = knownDocIds.get(cacheKey);

            try {
                if (cachedId) {
                    logWrite(`leaderboard/${playlist} (cached id)`);
                    await fb.setDoc(fb.doc(fb.db, REAL_LEADERBOARD_COLLECTION, cachedId), fields, { merge: true });
                    clearError();
                    return;
                }

                const q = fb.query(
                    fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
                    fb.where("sourceUserId", "==", sourceUserId),
                    fb.where("playlist", "==", playlist)
                );

                const existing = await fb.getDocs(q);
                if (existing.size > 1) {
                    console.warn(
                        `[RG HUD] ⚠️ Found ${existing.size} leaderboard documents matching sourceUserId=${sourceUserId} playlist=${playlist}. ` +
                        `Only the first one found will be updated; the rest will go stale. Delete the extras in Firestore.`
                    );
                }
                if (!existing.empty) {
                    const docId = existing.docs[0].id;
                    knownDocIds.set(cacheKey, docId);
                    logWrite(`leaderboard/${playlist} (found via query)`);
                    await fb.setDoc(fb.doc(fb.db, REAL_LEADERBOARD_COLLECTION, docId), fields, { merge: true });
                } else {
                    logWrite(`leaderboard/${playlist} (new doc)`);
                    const newDoc = await fb.addDoc(fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION), {
                        ...fields,
                        sourceUserId,
                        playlist,
                    });
                    knownDocIds.set(cacheKey, newDoc.id);
                }
                clearError();
            } catch (e) {
                console.error(`[RG HUD] Real leaderboard sync failed for ${playlist}:`, e);
                showError(`Leaderboard sync failed for ${playlist} -- check console`);
            }
        });

        upsertLocks.set(lockKey, current);
        await current;
    }

    // Last-written state per player+playlist. A 3v3 match only changes the 3v3
    // and wins entries, so 1v1/2v2 skip their writes entirely. Backed by
    // sessionStorage so a page refresh doesn't trigger a redundant full burst.
    const lastEntryState = new Map(
        (() => {
            try { return JSON.parse(sessionStorage.getItem("rgHudEntryState") ?? "[]"); }
            catch (e) { return []; }
        })()
    );

    function saveEntryState() {
        try {
            sessionStorage.setItem("rgHudEntryState", JSON.stringify([...lastEntryState]));
        } catch (e) {}
    }

    async function syncToRealLeaderboard(fb, data, displayName) {
        const sourceUserId = data.Id;
        const modeToPlaylist = {
            Competitive1v1: "1v1",
            Competitive2v2: "2v2",
            Competitive3v3: "3v3",
        };

        for (const [mode, playlist] of Object.entries(modeToPlaylist)) {
            const mmr = data.ModesGlicko?.[mode]?.displayRating;
            if (typeof mmr !== "number") continue; // player hasn't played this mode -- skip it
            await upsertIfChanged(fb, sourceUserId, playlist, { name: displayName, mmr });
        }

        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        const totalWins = modes.reduce((sum, m) => sum + (data.ModesData?.[m]?.wins ?? 0), 0);
        const totalMatches = modes.reduce((sum, m) => sum + (data.ModesData?.[m]?.matchesPlayed ?? 0), 0);

        await upsertIfChanged(fb, sourceUserId, "wins", {
            name: displayName,
            wins: totalWins,
            matches: totalMatches,
        });
    }

    async function upsertIfChanged(fb, sourceUserId, playlist, fields) {
        const stateKey = `${sourceUserId}_${playlist}`;
        const newState = JSON.stringify(fields);

        if (lastEntryState.get(stateKey) === newState) {
            return; // nothing about this entry changed -- skip the write entirely
        }

        await upsertPlaylistEntry(fb, sourceUserId, playlist, fields);
        lastEntryState.set(stateKey, newState);
        saveEntryState();
    }

    // ---------- Rank lookup ----------
    // Uses Firestore count aggregation: "how many entries in this playlist have
    // a higher mmr than mine" is a single cheap server-side count, not a full
    // collection download. Refreshed after our own data changes (force=true),
    // plus once per session as a baseline; cached in between.

    let ranksFetchedThisSession = false;
    let lastRankRefresh = 0;
    const RANK_REFRESH_COOLDOWN_MS = 60000;

    async function refreshRanks(fb, data, force = false) {
        const now = Date.now();
        if (!force && ranksFetchedThisSession) return;
        if (now - lastRankRefresh < RANK_REFRESH_COOLDOWN_MS && ranksFetchedThisSession) return;

        const modeToPlaylist = {
            Competitive1v1: "1v1",
            Competitive2v2: "2v2",
            Competitive3v3: "3v3",
        };

        try {
            for (const [mode, playlist] of Object.entries(modeToPlaylist)) {
                const mmr = data.ModesGlicko?.[mode]?.displayRating;
                if (typeof mmr !== "number") continue;

                const q = fb.query(
                    fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
                    fb.where("playlist", "==", playlist),
                    fb.where("mmr", ">", mmr)
                );
                const snapshot = await fb.getCountFromServer(q);
                const rank = snapshot.data().count + 1;
                cachedRanks.set(playlist, rank);

                // Gap to next rank up: fetch the lowest-MMR entry still above us
                // (the one directly ahead). Skipped entirely when already #1.
                if (rank > 1) {
                    try {
                        const nextQ = fb.query(
                            fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
                            fb.where("playlist", "==", playlist),
                            fb.where("mmr", ">", mmr),
                            fb.orderBy("mmr", "asc"),
                            fb.limit(1)
                        );
                        const nextSnap = await fb.getDocs(nextQ);
                        if (!nextSnap.empty) {
                            const nextMmr = nextSnap.docs[0].data().mmr;
                            cachedMmrToNext.set(playlist, Math.max(0, nextMmr - mmr + 1));
                        }
                    } catch (e) {
                        // gap is a nice-to-have on top of rank -- ignore if it fails
                    }
                } else {
                    cachedMmrToNext.delete(playlist);
                }
            }

            ranksFetchedThisSession = true;
            lastRankRefresh = now;

            checkRankTransitions();

            // Re-render with fresh ranks
            if (lastKnownPlayerData) updateHUD(lastKnownPlayerData);
        } catch (e) {
            // Rank display is nice-to-have -- never let it break anything else.
            console.warn("[RG HUD] Rank lookup failed:", e);
        }
    }

    // ---------- Network capture ----------

    // Track the currently equipped skin so partial-response endpoints (equipSkin) can update it
    let lastKnownPlayerData = null;

    const API_HOST_FRAGMENT = "us-central1-rocketball-23c12.cloudfunctions.net";

    const oldFetch = window.fetch;
    window.fetch = async function (...args) {
        const response = await oldFetch.apply(this, args);
        try {
            const url = args[0]?.toString?.() ?? "";
            if (!url.includes(API_HOST_FRAGMENT)) return response;

            const clone = response.clone();
            const text = await clone.text();

            if (url.includes("/v0304_player/matchEnd")) {
                tryParseAndUpdate(text);
                setAutoVisible(true); // match ended -> bring the whole HUD back
            } else if (url.includes("/v0304_login/login")) {
                tryParseAndUpdate(text);
            } else if (url.includes("/v0304_player/equipSkin")) {
                // response is just a bare quoted skin id, e.g. "body.2"
                try {
                    const skinId = JSON.parse(text);
                    if (lastKnownPlayerData) {
                        lastKnownPlayerData.EquippedSkinId = skinId;
                    }
                } catch (e) {}
            }
        } catch (e) {}
        return response;
    };

    const oldLog = console.log;
    console.log = function (...args) {
        oldLog.apply(console, args);
        for (const arg of args) {
            if (typeof arg !== "string") continue;

            if (arg.includes('"ModesGlicko"')) {
                const json = arg.substring(arg.indexOf("{"));
                tryParseAndUpdate(json);
            }

            // Only fires when a real match with real teams is forming --
            // never for an empty party or just sitting in a lobby.
            if (arg.includes("[PlayerDataManager] Initialized stats for player")) {
                setAutoVisible(false);
            }

            // Back in a party/lobby room means not mid-match anymore.
            // Catches early-quit cases where matchEnd never fires.
            if (arg.includes("OnJoinedRoom Party")) {
                setAutoVisible(true);
            }
        }
    };

    // ---------- Boot ----------

    // ---------- Boot ----------

    const wait = setInterval(() => {
        if (document.body) {
            clearInterval(wait);
            createHUD();
            console.log("[RG HUD] loaded and running, waiting for login/matchEnd data...");
        }
    }, 100);

})();
