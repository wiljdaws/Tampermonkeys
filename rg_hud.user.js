// ==UserScript==
// @name         ATLAS
// @namespace    https://rocketgoal.io
// @version      12.7
// @description  The community-run live service for Rocket Goal — bearing the weight of a game the devs left behind. Full stats HUD, clan system with Clan Clash events, Name Forge for custom in-game names, and anti-cheat that actually works.
// @author       JesusDied4U
// @icon         https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/atlas/atlas.png
// @match        https://rocketgoal.io/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/rg_hud.user.js
// @downloadURL  https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/rg_hud.user.js
// @supportURL   https://github.com/wiljdaws/Tampermonkeys/issues
// ==/UserScript==

(function () {
    'use strict';

    let hud;

    // Custom ATLAS icon URL -- served from the same GitHub repo as the script,
    // reused as both Tampermonkey icon (via @icon in the header) and inline
    // in the HUD title bar. Rendered as an <img> so it stays crisp at any
    // scale (unlike the 🚀 emoji it replaced, which pulled from the system
    // font and looked flat/inconsistent across OSes).
    const ATLAS_ICON_URL = 'https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/atlas/atlas.png';
    const atlasIconHtml = () => `<img src="${ATLAS_ICON_URL}" alt="" style="height:16px;width:16px;vertical-align:middle;margin-right:4px;object-fit:contain;">`;

    // ---------- Settings (persisted in localStorage) ----------

    const DEFAULT_SETTINGS = {
        glowEnabled: true,
        glowSpeed: 5,        // speed level 1-10, higher = faster
        glowOpacity: 0.6,    // vibrancy
        glowColor1: "#ff7a00",
        glowColor2: "#00d4ff",
        // OG Title: when true, the neutral HUD title shows "🚀 Rocket Goal HUD"
        // (the original) instead of the ATLAS icon + name. Vibe-state titles
        // (Flow State, ON FIRE, KING, etc.) are untouched either way.
        ogTitle: false,
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

    // ---------- Device ID ----------
    // Random per-installation UUID persisted in localStorage; sent with every
    // Firestore write so cheaters can be blacklisted by device even after they
    // burn through source user IDs. Not a real fingerprint -- clearing
    // localStorage resets it, so it's friction, not a fortress. Paired with
    // server-side rules in firestore.rules (admin/blacklist doc).

    function getDeviceId() {
        let id = null;
        try { id = localStorage.getItem("rgHudDeviceId"); } catch (e) {}
        if (!id) {
            id = crypto.randomUUID?.()
                || (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12));
            try { localStorage.setItem("rgHudDeviceId", id); } catch (e) {}
        }
        return id;
    }

    // Version sent with every Firestore write, two forms:
    //  - SCRIPT_VERSION: the raw @version string (from Tampermonkey metadata,
    //    so it can't drift from the header; the literal is only a fallback).
    //  - SCRIPT_VERSION_NUM: parsed to a number so server rules can enforce
    //    "minimum version X and everything after" with a plain >= compare.
    //    CONSTRAINT: version numbers must stay decimal-orderly (11.9 -> 12.0,
    //    never 11.10 -- parseFloat("11.10") === 11.1).
    const SCRIPT_VERSION = (typeof GM_info !== "undefined" && GM_info?.script?.version) || "12.7";
    const SCRIPT_VERSION_NUM = parseFloat(SCRIPT_VERSION) || 0;

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
                    <span id="rgErrDot" title="" style="display:none;color:#ff5555;font-weight:bold;font-size:14px;">⚠</span>
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
                        <div class="rgSettingRow"><span>Glow</span><input type="checkbox" id="rgSetGlow"></div>
                        <div class="rgSettingRow"><span>Speed</span><input type="range" id="rgSetSpeed" min="1" max="10" step="0.5"></div>
                        <div class="rgSettingRow"><span>Vibrancy</span><input type="range" id="rgSetOpacity" min="0.1" max="1" step="0.05"></div>
                        <div class="rgSettingRow"><span>Color 1</span><input type="color" id="rgSetColor1"></div>
                        <div class="rgSettingRow"><span>Color 2</span><input type="color" id="rgSetColor2"></div>
                        <button id="rgSetReset" class="rgBtn" style="width:100%;margin-top:4px;">Reset to defaults</button>
                    </div>
                </div>
                <div id="rgClanView" style="display:none;">Loading clans...</div>
                <div id="rgForgeView" style="display:none;max-height:520px;overflow-y:auto;overflow-x:hidden;"></div>
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
            <div id="rgDialog">
                <div id="rgDialogMsg" class="rgDlgMsg"></div>
                <input type="text" id="rgDialogInput" style="display:none;" maxlength="200">
                <div style="display:flex;gap:6px;">
                    <button id="rgDialogOk" class="rgBtn">OK</button>
                    <button id="rgDialogCancel" class="rgBtn">Cancel</button>
                </div>
            </div>
            <div id="rgToast"></div>
        `;

        document.body.appendChild(hud);
        clampHudOnScreen();
        window.addEventListener("resize", clampHudOnScreen);
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
        document.getElementById("rgRename").onclick = () => {
            if (!lastKnownPlayerData) {
                showNameModal("Play a match or log in first!", "", false, () => {});
                hideNameModalSoon();
                return;
            }
            forceRenamePrompt = true;
            submitToLeaderboard(lastKnownPlayerData);
        };

        // Clan view toggle (shield icon) -- swaps stats view for clan view
        const statsView = document.getElementById("rgStatsView");
        const clanView = document.getElementById("rgClanView");
        const panel = document.getElementById("rgSettingsPanel");
        const forgeView = document.getElementById("rgForgeView");
        const actionRow = document.getElementById("rgActionRow");
        function showStatsOnly() {
            clanView.style.display = "none";
            forgeView.style.display = "none";
            panel.style.display = "none";
            statsView.style.display = "block";
            // Default: action row visible (relevant to stats and clan views).
            // The Forge tab explicitly re-hides it below since Rename edits the
            // leaderboard display name (not the in-game nickname Forge builds),
            // and Sub/Leaderboard aren't name-related at all.
            actionRow.style.display = "flex";
        }
        document.getElementById("rgClanBtn").onclick = () => {
            const showingClan = clanView.style.display !== "none";
            if (showingClan) { showStatsOnly(); return; }
            showStatsOnly();
            statsView.style.display = "none";
            clanView.style.display = "block";
            renderClanView();
        };
        document.getElementById("rgForgeBtn").onclick = () => {
            const showingForge = forgeView.style.display !== "none";
            if (showingForge) { showStatsOnly(); return; }
            showStatsOnly();
            statsView.style.display = "none";
            forgeView.style.display = "block";
            actionRow.style.display = "none"; // Forge context: hide unrelated leaderboard/sub actions
            if (RGNF.setPrefixProvider) RGNF.setPrefixProvider(getClanTagPrefix);
            // Sync Forge\'s Name field to this account\'s identity so a saved
            // state from a different account (or a fresh install) doesn\'t
            // greet the player with the wrong name.
            if (RGNF.syncToCurrentPlayer) RGNF.syncToCurrentPlayer(myUserId(), myGameNamePlain() || myName(), lastKnownPlayerData?.Nickname ?? "");
            RGNF.mountIn(forgeView);
        };

        // Settings panel wiring -- opening settings routes through showStatsOnly()
        // so any other open tab (Clan, Forge) closes cleanly first, and the action
        // row is correctly restored (matters when settings is opened from Forge,
        // which had hidden the row). Closing settings returns to the clean Stats
        // view. Without this, opening Settings from Forge left both views stacked.
        document.getElementById("rgSettingsBtn").onclick = () => {
            const opening = panel.style.display === "none";
            showStatsOnly();
            if (opening) panel.style.display = "block";
        };

        const setGlow = document.getElementById("rgSetGlow");
        const setSpeed = document.getElementById("rgSetSpeed");
        const setOpacity = document.getElementById("rgSetOpacity");
        const setColor1 = document.getElementById("rgSetColor1");
        const setColor2 = document.getElementById("rgSetColor2");

        const setOgTitle = document.getElementById("rgSetOgTitle");
        function syncSettingInputs() {
            setOgTitle.checked = !!settings.ogTitle;
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
            applyTitle(); // repaint immediately so users see the switch land
        };
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

        // Kick off the live countdown tick. Runs once for the lifetime of the
        // HUD; the handler itself early-returns when no banner is on screen.
        if (!countdownIntervalId) {
            countdownIntervalId = setInterval(tickCountdown, 1000);
        }
    }

    // Keeps the HUD reachable: if a saved/dragged position has pushed it (mostly)
    // off-screen, pull it back so at least a good chunk of the title bar stays
    // visible and grabbable. Prevents the "dragged off-screen and can't get it
    // back because it reloads off-screen" trap.
    function clampHudOnScreen() {
        if (!hud) return;
        // CRITICAL GUARD: while the HUD is hidden (display:none during
        // matches), getBoundingClientRect returns all zeros. Without this
        // guard, a window resize mid-match makes the clamp read the phantom
        // (0,0) rect as "off-screen", move the HUD to the top-left, and
        // PERSIST that -- so the HUD reappears top-left after every match.
        // Skip while hidden; setAutoVisible re-clamps on show with real dims.
        if (hud.style.display === "none" || hud.offsetWidth === 0) return;
        const rect = hud.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const MARGIN = 40; // keep at least this many px of the HUD on each edge

        let left = rect.left;
        let top = rect.top;

        // Horizontal: never fully off left/right.
        if (left + rect.width < MARGIN) left = MARGIN - rect.width;   // too far left
        if (left > vw - MARGIN) left = vw - MARGIN;                    // too far right
        // Vertical: keep the title bar row on-screen (top can't go above 0 or
        // below the viewport bottom minus a margin).
        if (top < 0) top = 0;
        if (top > vh - MARGIN) top = vh - MARGIN;

        if (left !== rect.left || top !== rect.top) {
            hud.style.left = left + "px";
            hud.style.top = top + "px";
            hud.style.right = "auto";
            // Persist the corrected position so it stays fixed next load too.
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
        // Now that it's visible with real dimensions, make sure it's actually
        // on-screen (covers the window having resized while it was hidden).
        if (visible) clampHudOnScreen();
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

    // ---------- Win/loss streak tracking ----------
    // The game only gives cumulative totals, not per-match results. But by
    // comparing this update's totals to the last, we can infer each match's
    // outcome as it happens and chain them into a streak. Overall (any mode).
    // A positive count = win streak (🔥), negative = loss streak (❄️). Persisted
    // in localStorage keyed to the session so it survives refreshes but resets
    // with the session / on account change.

    let streakData = null;
    try { streakData = JSON.parse(localStorage.getItem("rgHudStreak") ?? "null"); } catch (e) {}

    function saveStreak() {
        try { localStorage.setItem("rgHudStreak", JSON.stringify(streakData)); } catch (e) {}
    }

    function resetStreak(accountId, totalWins, totalMatches) {
        streakData = { accountId, streak: 0, lastWins: totalWins, lastMatches: totalMatches };
        saveStreak();
    }

    function updateStreak(data) {
        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        const totalWins = modes.reduce((s, m) => s + (data.ModesData?.[m]?.wins ?? 0), 0);
        const totalMatches = modes.reduce((s, m) => s + (data.ModesData?.[m]?.matchesPlayed ?? 0), 0);

        // First observation this session (or account change) -- establish a
        // baseline without counting anything, since we don't know prior outcomes.
        if (!streakData || streakData.accountId !== data.Id) {
            resetStreak(data.Id, totalWins, totalMatches);
            return;
        }

        const matchDiff = totalMatches - streakData.lastMatches;
        const winDiff = totalWins - streakData.lastWins;

        if (matchDiff <= 0) return; // no new matches since last check

        // Resolve each newly-played match in order. Usually just one, but if two
        // came in between updates we still tally them (all wins or all losses in
        // that gap -- we can't know the interleaving, so treat the block by net).
        const losses = matchDiff - winDiff;
        if (winDiff > 0 && losses === 0) {
            // pure win block
            streakData.streak = streakData.streak > 0 ? streakData.streak + winDiff : winDiff;
        } else if (losses > 0 && winDiff === 0) {
            // pure loss block
            streakData.streak = streakData.streak < 0 ? streakData.streak - losses : -losses;
        } else {
            // mixed block in one gap -- end on whichever was more recent is unknown,
            // so settle on the net sign, magnitude 1 (conservative).
            streakData.streak = winDiff >= losses ? 1 : -1;
        }

        streakData.lastWins = totalWins;
        streakData.lastMatches = totalMatches;
        saveStreak();
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

        // New session -> fresh streak baseline (don't count pre-session matches).
        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        const tw = modes.reduce((s, m) => s + (data.ModesData?.[m]?.wins ?? 0), 0);
        const tm = modes.reduce((s, m) => s + (data.ModesData?.[m]?.matchesPlayed ?? 0), 0);
        resetStreak(data.Id, tw, tm);

        // Account/session changed -> invalidate clan cache so it reloads for the
        // new account, and refresh the clan view if it's currently open.
        clanLoaded = false;
        clanLoadedForAccount = null;
        myClan = null;
        checkClanNotices(); // show any pending notice (e.g. kicked) for this account
        const clanView = document.getElementById("rgClanView");
        if (clanView && clanView.style.display !== "none") {
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
        flowState: 250,   // >= : "Flow State", the top tier -- fastest + most intense
        onFire:    150,   // >= : "ON FIRE", fast + bright glow
        heatingUp: 75,    // >= : "Heating Up", warmer/faster glow
        cold:      -20,   // <= : "Ice Cold", slow + dim glow
        shutEye:   -75,   // <= : easter egg
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
        if (net >= MOMENTUM_TIERS.flowState) return "flowState";
        if (net >= MOMENTUM_TIERS.onFire) return "onFire";
        if (net >= MOMENTUM_TIERS.heatingUp) return "heatingUp";
        return "neutral";
    }

    // Title priority: individual #1 crown beats clan-clash lead beats momentum beats default.
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
        // html:true = trusted markup from resolveTitle (only path with images
        // is our own ATLAS default). Emoji titles use textContent for safety.
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
        `;
    }

    let lastProcessedText = null;
    let lastProcessedKey = null;

    function tryParseAndUpdate(text) {
        // Fast path: raw-string dedupe catches identical bodies from either
        // hook cheaply.
        if (text === lastProcessedText) return;

        try {
            const data = JSON.parse(text);
            if (!(data && data.ModesGlicko)) return;

            // Slow path: fetch and console hooks can produce byte-different
            // strings for the same underlying event (whitespace, encoding).
            // Build a stable identity key from the actual player state so both
            // paths dedupe to the same fingerprint. Set BEFORE submit fires,
            // not after -- otherwise the two paths race past the guard while
            // the first submit is still awaiting Firestore.
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
            updateHUD(data);
            submitToLeaderboard(data);
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
            const { getFirestore, doc, setDoc, getDoc, collection, query, where, getDocs, addDoc, getCountFromServer, orderBy, limit, deleteDoc, serverTimestamp } =
                await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

            const app = initializeApp(FIREBASE_CONFIG);
            const db = getFirestore(app);

            firestoreReady = { db, doc, setDoc, getDoc, collection, query, where, getDocs, addDoc, getCountFromServer, orderBy, limit, deleteDoc, serverTimestamp };
            return firestoreReady;
        } catch (e) {
            console.error("[RG HUD] Firebase init failed:", e);
            showError("Firebase failed to load");
            return null;
        }
    }

    // ---------- Force-update gate ----------
    // admin/blacklist in Firestore holds { minVersion: 11.1 } (numeric).
    // If our versionNum < minVersion, server rules reject every write anyway --
    // so instead of spamming failed writes, check once per session, tell the
    // user to update, and skip submissions entirely until they do. HUD display
    // features keep working; only Firestore sync pauses.

    let updateRequiredChecked = false;
    let updateRequired = false;

    async function isUpdateRequired(fb) {
        if (updateRequiredChecked) return updateRequired;
        try {
            // minVersion lives on admin/blacklist (same doc the rules read, so
            // server-side the version + blacklist checks cost one read). Any
            // script version >= minVersion is allowed -- "X and everything after".
            const snap = await fb.getDoc(fb.doc(fb.db, "admin", "blacklist"));
            if (snap.exists()) {
                const minV = snap.data().minVersion;
                if (typeof minV === "number" && SCRIPT_VERSION_NUM < minV) {
                    updateRequired = true;
                    showError(`HUD v${SCRIPT_VERSION} is outdated -- update via Tampermonkey to resume leaderboard sync`);
                    showBanner("⬆️ HUD update required! Tampermonkey → Check for updates", "#ffcf5b");
                }
            }
        } catch (e) {
            // Config unreadable -- don't lock the user out over a transient error.
        }
        updateRequiredChecked = true;
        return updateRequired;
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

    // Clan tags: LETTERS ONLY, ALWAYS UPPERCASE. Enforced on input (live
    // filter as they type) AND on submit (defense in depth). Kept short so
    // the styled prefix reads cleanly in-game.
    function sanitizeClanTag(raw) {
        return String(raw || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
    }

        function containsProfanity(text) {
        return PROFANITY_REGEX.test(text);
    }

    // Rejects any name containing emoji / pictographic symbols, including all
    // flag forms (regional-indicator pairs and tag-sequence subdivision flags).
    const EMOJI_REGEX = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}|[\u{1F1E6}-\u{1F1FF}\u{1F3F3}\u{1F3F4}\u{E0020}-\u{E007F}\u{200D}]/u;
    function containsEmoji(text) {
        return EMOJI_REGEX.test(text);
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
    // input is focused, stop the game from seeing keys at all. Applies to ANY
    // text input inside the HUD (name modal, clan create form, etc.).
    ["keydown", "keyup", "keypress"].forEach(type => {
        window.addEventListener(type, e => {
            const active = document.activeElement;
            const inHud = active && hud && hud.contains(active)
                && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")
                && active.type !== "checkbox" && active.type !== "range" && active.type !== "color";
            if (inHud) {
                e.stopImmediatePropagation();
                // Enter in the name modal saves it
                if (type === "keydown" && e.key === "Enter" && active.id === "rgNameInput") {
                    const saveBtn = document.getElementById("rgNameSave");
                    if (saveBtn && !saveBtn.disabled) saveBtn.click();
                }
            }
        }, true); // capture phase -- runs before the game's own listeners
    });

    // Returns a promise that resolves with the chosen (validated) name.
    // Checks whether a display name is already used by a DIFFERENT player.
    // Best-effort: a Firestore read against existing leaderboard entries. Not
    // race-proof (two people picking the same name simultaneously could both
    // pass), but catches every normal collision.
    async function isNameTaken(fb, name, ownSourceUserId) {
        try {
            const q = fb.query(
                fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
                fb.where("name", "==", name)
            );
            const snap = await fb.getDocs(q);
            // Taken only if some matching entry belongs to a different player.
            return snap.docs.some(d => d.data().sourceUserId !== ownSourceUserId);
        } catch (e) {
            // If the check itself fails, don't block the user -- let it through.
            console.warn("[RG HUD] Name availability check failed:", e);
            return false;
        }
    }

    function askDisplayName(suggestion, isRename, fb, ownSourceUserId) {
        return new Promise(resolve => {
            const title = isRename
                ? "Enter your new leaderboard name:"
                : "Pick your leaderboard name to appear on the board:";
            showNameModal(title, suggestion, true, resolve);

            const input = document.getElementById("rgNameInput");
            const errEl = document.getElementById("rgNameError");
            const saveBtn = document.getElementById("rgNameSave");

            saveBtn.onclick = async () => {
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

                // Name-taken check (async). Disable Save while checking.
                errEl.style.color = "#7ec8ff";
                errEl.textContent = "Checking availability...";
                saveBtn.disabled = true;
                const taken = fb ? await isNameTaken(fb, entered, ownSourceUserId) : false;
                saveBtn.disabled = false;
                errEl.style.color = "#ff6b6b";

                if (taken) {
                    errEl.textContent = "That name is already taken. Pick another.";
                    return;
                }

                errEl.textContent = "";
                hideNameModal();
                resolve(entered);
            };

            document.getElementById("rgNameCancel").onclick = () => {
                hideNameModal();
                resolve(null); // no name chosen -> nothing gets submitted this time
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
        if (await isUpdateRequired(fb)) return; // outdated version -- rules would reject anyway

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
            // No saved name yet -- prompt with a suggestion, but a real name is
            // required. If they cancel without entering one, we submit nothing
            // and will ask again next time (no gibberish/default on the board).
            const cleaned = cleanName(data.Nickname).slice(0, 15);
            const suggestion = (cleaned && cleaned.toLowerCase() !== "player") ? cleaned : "";
            displayName = await askDisplayName(suggestion, isRename, fb, data.Id);
            if (!displayName) return; // cancelled without picking a name -- skip this submission
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
            sourceUserId: data.Id,
            deviceId: getDeviceId(),
            scriptVersion: SCRIPT_VERSION,
            versionNum: SCRIPT_VERSION_NUM,
            lastWriteAt: fb.serverTimestamp(),
        };

        // Make sure clan membership is known before the change check below, so
        // the clan tag can be part of the snapshot (otherwise a first-of-session
        // sync wouldn't know the tag yet).
        if (!clanLoaded || clanLoadedForAccount !== data.Id) {
            await loadClanData(true);
        }

        // Skip the actual network writes if nothing changed or synced very
        // recently -- but never skip a deliberate Rename. The clan tag is part
        // of the snapshot so a clan/tag change (which doesn't touch MMR or stats)
        // still forces a resync instead of being seen as "unchanged".
        const currentClanTag = (clanLoadedForAccount === data.Id && myClan) ? (myClan.tag ?? "") : "";
        const snapshotKey = JSON.stringify({
            displayName, ratings: payload.ratings, stats: payload.stats,
            xp: payload.xp, equippedSkinId: payload.equippedSkinId,
            clanTag: currentClanTag,
        });
        const now = Date.now();
        const unchanged = lastSyncSnapshot.get(data.Id) === snapshotKey;
        const withinCooldown = (now - (lastSyncTime.get(data.Id) ?? 0)) < SYNC_COOLDOWN_MS;

        if (!isRename && (unchanged || withinCooldown)) {
            // Still refresh ranks once per session even if the write is skipped.
            refreshRanks(fb, data);
            return;
        }

        lastSyncTime.set(data.Id, now);

        try {
            logWrite("script_submissions");
            await fb.setDoc(docRef, payload, { merge: true });
            // Cache the snapshot only AFTER a successful write -- otherwise a
            // rules-rejected write would look "unchanged" next time and never
            // be retried.
            lastSyncSnapshot.set(data.Id, snapshotKey);
            clearError();
        } catch (e) {
            console.error("[RG HUD] Leaderboard submission failed:", e);
            showError("Stats submission failed -- check console");
        }

        await syncToRealLeaderboard(fb, data, displayName);
        refreshRanks(fb, data, true);
        refreshClanViewIfOpen(); // live-update event score/contribution, no extra reads
        applyTitle(); // clan-lead status may have flipped since updateMomentum ran
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

            // Include identifying fields on EVERY write (not just doc creation),
            // so the rules blacklist check has something to check on merge writes.
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
                if (cachedId) {
                    logWrite(`leaderboard/${playlist} (cached id)`);
                    await fb.setDoc(fb.doc(fb.db, REAL_LEADERBOARD_COLLECTION, cachedId), fullFields, { merge: true });
                    clearError();
                    return true;
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
                    await fb.setDoc(fb.doc(fb.db, REAL_LEADERBOARD_COLLECTION, docId), fullFields, { merge: true });
                } else {
                    logWrite(`leaderboard/${playlist} (new doc)`);
                    const newDoc = await fb.addDoc(fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION), fullFields);
                    knownDocIds.set(cacheKey, newDoc.id);
                }
                clearError();
                return true;
            } catch (e) {
                console.error(`[RG HUD] Real leaderboard sync failed for ${playlist}:`, e);
                showError(`Leaderboard sync failed for ${playlist} -- check console`);
                return false;
            }
        });

        upsertLocks.set(lockKey, current);
        return current;
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

        // Determine clan tag (if any) to prefix on the leaderboard name, and
        // opportunistically keep the clan's stored MMR for this member current.
        const clanInfo = await updateMyClanMMR(fb, data);
        const shownName = clanInfo?.tag ? `[${clanInfo.tag}] ${displayName}` : displayName;

        const modeToPlaylist = {
            Competitive1v1: "1v1",
            Competitive2v2: "2v2",
            Competitive3v3: "3v3",
        };

        for (const [mode, playlist] of Object.entries(modeToPlaylist)) {
            const mmr = data.ModesGlicko?.[mode]?.displayRating;
            if (typeof mmr !== "number") continue; // player hasn't played this mode -- skip it
            await upsertIfChanged(fb, sourceUserId, playlist, { name: shownName, mmr });
        }

        const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
        const totalWins = modes.reduce((sum, m) => sum + (data.ModesData?.[m]?.wins ?? 0), 0);
        const totalMatches = modes.reduce((sum, m) => sum + (data.ModesData?.[m]?.matchesPlayed ?? 0), 0);

        await upsertIfChanged(fb, sourceUserId, "wins", {
            name: shownName,
            wins: totalWins,
            matches: totalMatches,
        });
    }

    // If this player is in a clan, refresh their stored ranked MMR within the
    // clan's members array and recompute the clan total (one extra write, only
    // for clan members, piggybacked on the match sync). Returns { tag } if in a
    // clan so the caller can prefix the leaderboard name. Best-effort.
    async function updateMyClanMMR(fb, data) {
        const uid = data.Id;
        try {
            // Use cached directory to find my clan cheaply (no extra read if warm).
            if (!clanLoaded || clanLoadedForAccount !== uid) await loadClanData(true);
            if (!myClan) return null;

            // Capture the tag up front -- this is what the leaderboard name needs,
            // and it must NOT depend on the MMR write below succeeding.
            const tag = myClan.tag ?? "";

            const g = data.ModesGlicko;
            const rankedModes = ["Competitive3v3", "Competitive2v2", "Competitive1v1"];
            const myMMR = rankedModes.reduce((s, m) =>
                s + (typeof g?.[m]?.displayRating === "number" ? g[m].displayRating : 0), 0);

            // Load event config (cheap, cached) so we know if a Clan Clash is on.
            await loadEventConfig(fb);

            const prevMine = (myClan.members ?? []).find(m => m.userId === uid)?.mmr;
            if (prevMine !== myMMR) {
                try {
                    const members = (myClan.members ?? []).map(m =>
                        m.userId === uid ? { ...m, mmr: myMMR } : m
                    );
                    const totalMMR = members.reduce((s, m) => s + (m.mmr ?? 0), 0);
                    // Stamp an unforgeable server time; we read it back to learn the
                    // authoritative clock for event-window decisions.
                    await fb.setDoc(fb.doc(fb.db, "clans", myClan.id),
                        { members, totalMMR, lastSyncAt: fb.serverTimestamp() }, { merge: true });
                    myClan.members = members;
                    myClan.totalMMR = totalMMR;

                    // Read back the server time we just wrote, to calibrate
                    // serverNow(). The offset doesn't drift within a session,
                    // so one calibration is enough -- skipping repeats saves a
                    // read on every subsequent match.
                    if (serverNowOffset === null) {
                        try {
                            const back = await fb.getDoc(fb.doc(fb.db, "clans", myClan.id));
                            const ts = back.exists() ? back.data().lastSyncAt : null;
                            if (ts?.toMillis) learnServerTime(ts.toMillis());
                        } catch (e) {}
                    }

                    // Routine MMR tick: throttled rebuild (patches my own view
                    // in memory instantly, hits Firestore at most every 3 min).
                    await refreshDirectoryThrottled(fb);
                } catch (writeErr) {
                    // MMR sync is best-effort; a failure here must not strip the tag.
                    console.warn("[RG HUD] Clan MMR write failed (tag still applies):", writeErr);
                }
            }

            // Event baseline: capture this member's starting MMR on their first
            // sync during an active event (uses server-authoritative timing).
            await maybeCaptureEventBaseline(fb, uid, myMMR);

            return { tag };
        } catch (e) {
            console.warn("[RG HUD] Clan lookup failed:", e);
            return null;
        }
    }

    async function upsertIfChanged(fb, sourceUserId, playlist, fields) {
        const stateKey = `${sourceUserId}_${playlist}`;
        const newState = JSON.stringify(fields);

        if (lastEntryState.get(stateKey) === newState) {
            return; // nothing about this entry changed -- skip the write entirely
        }

        const ok = await upsertPlaylistEntry(fb, sourceUserId, playlist, fields);
        // Only remember this state if the write actually succeeded -- otherwise a
        // failed write (e.g. rules rejection) would poison the cache and stop us
        // ever retrying with the same data.
        if (ok) {
            lastEntryState.set(stateKey, newState);
            saveEntryState();
        }
    }

    // ---------- Rank lookup ----------
    // Uses Firestore count aggregation: "how many entries in this playlist have
    // a higher mmr than mine" is a single cheap server-side count, not a full
    // collection download. Refreshed after our own data changes (force=true),
    // plus once per session as a baseline; cached in between.
    //
    // Read-cost note: we only re-query the modes whose MMR actually CHANGED
    // since last refresh. Your rank in a mode you didn't play can't move due
    // to your own actions -- someone else's climb could shuffle it, but that
    // rare drift isn't worth 4 reads/match. Cold session refreshes all modes.

    let ranksFetchedThisSession = false;
    let lastRankRefresh = 0;
    const RANK_REFRESH_COOLDOWN_MS = 60000;
    const lastRankedMMR = new Map(); // playlist -> mmr at time of last rank query

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

                // Skip modes whose MMR hasn't moved since we last queried them.
                // On a match-triggered refresh this typically skips 2 of 3 modes
                // (only the played mode's MMR changed), saving ~4 reads/match.
                // Cold session (no prior MMR recorded) still refreshes everything.
                if (ranksFetchedThisSession && lastRankedMMR.get(playlist) === mmr) continue;

                const q = fb.query(
                    fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
                    fb.where("playlist", "==", playlist),
                    fb.where("mmr", ">", mmr)
                );
                const snapshot = await fb.getCountFromServer(q);
                const rank = snapshot.data().count + 1;
                cachedRanks.set(playlist, rank);
                lastRankedMMR.set(playlist, mmr);

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

    // ---------- Clan events (Clan Clash) ----------
    // Event config lives in Firestore (events/current), editable by admin only,
    // so events can be scheduled/rescheduled without a script update. Timing uses
    // Firestore serverTimestamp() -- unforgeable, immune to device-clock spoofing.
    // Each member's baseline MMR is captured on THEIR first sync after the event
    // starts (fresh, not stale); event score = sum of (current - baseline) across
    // members, which can go negative.

    let eventConfig = null;       // { name, startTime(ms), endTime(ms) } or null
    let eventConfigLoaded = false;
    let serverNowOffset = null;   // (serverTime - deviceTime) learned from a write, ms

    // Event-time permission defaults. Every flag is checked via eventPerm()
    // below so an old-shape event doc (no `perms` field) still gets safe,
    // documented behavior. To change how an active event behaves, edit
    // events/current in Firestore -- no script redeploy needed.
    //   allowJoin        : new members can request+get approved to a clan
    //   allowLeave       : members can walk out of their clan
    //   allowKick        : leader (or eligible role) can remove a member
    //   allowApprove     : leader can accept pending join requests
    //   allowDisband     : solo-leader can disband their own clan
    //   allowRoleChange  : promote/demote (co-leader, elder, etc.)
    //   allowTransfer    : hand off leadership to another member
    //   allowRenameClan  : change clan name or tag string
    //   allowClanCreate  : anyone can spin up a brand-new clan mid-event
    const EVENT_PERM_DEFAULTS = {
        allowJoin:        true,   // people CAN join mid-event (was locked; opened per feedback)
        allowLeave:       false,  // but they CAN'T leave -- can't dodge a losing team
        allowKick:        true,   // leaders keep the ability to remove problem members
        allowApprove:     true,   // approvals fine since joining is fine
        allowDisband:     false,  // freezes rosters even for solo leaders
        allowRoleChange:  false,  // role changes = attribution changes, freeze during scoring
        allowTransfer:    false,  // no leadership handoff mid-event
        allowRenameClan:  false,  // clan identity freezes during event
        allowClanCreate:  true,   // new clans don\'t affect anyone else\'s roster
    };

    async function loadEventConfig(fb, force = false) {
        if (eventConfigLoaded && !force) return eventConfig;
        try {
            const snap = await fb.getDoc(fb.doc(fb.db, "events", "current"));
            if (snap.exists()) {
                const d = snap.data();
                // Merge stored perms over defaults so a partial `perms` object
                // (only overriding one or two keys) still gets safe values
                // for everything else. Undefined perms field -> all defaults.
                const storedPerms = (d.perms && typeof d.perms === "object") ? d.perms : {};
                eventConfig = {
                    name: d.name ?? "Clan Event",
                    startTime: d.startTime?.toMillis ? d.startTime.toMillis() : (d.startTime ?? 0),
                    endTime: d.endTime?.toMillis ? d.endTime.toMillis() : (d.endTime ?? 0),
                    // Top-level (not inside perms) because it applies always,
                    // not just during an active event window.
                    maxMembers: (typeof d.maxMembers === "number") ? d.maxMembers : null,
                    perms: { ...EVENT_PERM_DEFAULTS, ...storedPerms },
                };
            } else {
                eventConfig = null;
            }
            eventConfigLoaded = true;
        } catch (e) {
            console.warn("[RG HUD] Event config load failed:", e);
        }
        return eventConfig;
    }

    // eventPerm(key): true when the action is allowed RIGHT NOW.
    //   - Outside an active event, everything is allowed (no lockdown).
    //   - Inside an active event, look up the flag; missing -> default.
    // Every clan-mutation guard should route through this so the source of
    // truth is one Firestore doc that a maintainer can edit live.
    function eventPerm(key) {
        if (eventPhase() !== "active") return true;
        const p = eventConfig?.perms || EVENT_PERM_DEFAULTS;
        return p[key] !== false; // defaults are all "true or false"; missing key -> allow
    }

    // Best estimate of authoritative server time. We learn an offset from device
    // time whenever a write round-trips a serverTimestamp; until then we fall back
    // to device time (only affects the cosmetic countdown, never scoring).
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

    // Capture this member's baseline the first time they sync during an active
    // event. Stored on the clan doc: eventBaseline[userId] = mmrAtFirstSync.
    // A stable id for the current event window, so baselines from a previous
    // event are recognized as stale and re-captured rather than reused.
    function currentEventId() {
        return eventConfig ? String(eventConfig.startTime) : null;
    }

    async function maybeCaptureEventBaseline(fb, uid, currentMMR) {
        if (!myClan || eventPhase() !== "active") return;
        const evId = currentEventId();

        // If the stored baseline belongs to a different (old) event, wipe it so
        // this event starts fresh for everyone.
        let baseline = myClan.eventBaseline ?? {};
        if (myClan.eventId !== evId) {
            baseline = {}; // stale from a previous event -- reset
        }
        if (baseline[uid] != null && myClan.eventId === evId) return; // already captured this event

        try {
            baseline[uid] = currentMMR;
            await fb.setDoc(fb.doc(fb.db, "clans", myClan.id),
                { eventBaseline: baseline, eventId: evId, eventName: eventConfig.name }, { merge: true });
            myClan.eventBaseline = baseline;
            myClan.eventId = evId;
        } catch (e) {
            console.warn("[RG HUD] Event baseline capture failed:", e);
        }
    }

    // A clan's baseline only counts if it belongs to the current event.
    function clanBaselineForCurrentEvent(clan) {
        if (!clan || !clan.eventBaseline) return null;
        if (clan.eventId !== currentEventId()) return null; // stale -> no score yet
        return clan.eventBaseline;
    }

    function computeClanEventScore(clan) {
        const baseline = clanBaselineForCurrentEvent(clan);
        if (!baseline) return 0;
        return (clan.members ?? []).reduce((sum, m) => {
            const base = baseline[m.userId];
            if (base == null || typeof m.mmr !== "number") return sum;
            return sum + (m.mmr - base);
        }, 0);
    }

    function myEventContribution(clan, uid) {
        const baseline = clanBaselineForCurrentEvent(clan);
        if (!baseline) return null;
        const base = baseline[uid];
        const me = (clan.members ?? []).find(m => m.userId === uid);
        if (base == null || !me || typeof me.mmr !== "number") return null;
        return me.mmr - base;
    }

    // Human-readable countdown string. Always includes seconds so the 1s tick
    // has something to change even during multi-day windows.
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

    // 1s tick: updates the countdown text in place and triggers a full banner
    // re-render on phase transitions (upcoming -> active -> ended). Reads the
    // target time and phase from data-* attrs on the countdown span, so it's a
    // no-op when the span isn't in the DOM (clan view closed / no event).
    let countdownIntervalId = null;
    function tickCountdown() {
        const el = document.getElementById("rgEventCountdown");
        if (!el) return;

        const targetMs = parseInt(el.getAttribute("data-target-ms"), 10);
        if (!Number.isFinite(targetMs)) return;
        const phase = el.getAttribute("data-phase");

        // Crossed the phase boundary -- structure of the banner (and possibly
        // the HUD title) needs to change, so trigger a full re-render.
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

    // Standings for the current event, ranked by eventScore desc. Only clans
    // whose baseline belongs to the current event count.
    function eventStandings() {
        const evId = currentEventId();
        return clanDirectory
            .filter(c => c.eventId === evId)
            .slice()
            .sort((a, b) => (b.eventScore ?? 0) - (a.eventScore ?? 0));
    }

    // True if there's an active event AND our clan is #1 in the current
    // standings. Drives the "👑 Leading the Clash" HUD title, mirroring the
    // "👑 Rocket Goal KING" treatment used for individual-mode #1s.
    function isMyClanLeadingClash() {
        if (eventPhase() !== "active") return false;
        if (!myClan) return false;
        const standings = eventStandings();
        return standings.length > 0 && standings[0].id === myClan.id;
    }

    // Builds the event banner HTML for the clan tab. `clan` may be null (shown to
    // clanless players too, minus the personal/score bits). Returns "" if no event.
    // Layout: header row (title + countdown) then a two-column body during active
    // phase. Left column = your clan's numbers, right column = leader or challenger.
    function eventBannerHtml(clan, uid) {
        const phase = eventPhase();
        if (phase === "none") return "";

        const gold = "#ffd700";
        const standings = eventStandings();
        const leader = standings[0];

        // Header row: title left, live-ticking countdown right -- one line.
        // The countdown span carries data-* attrs that tickCountdown reads to
        // update the text every second (and to detect phase transitions).
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

                // Rank badge with hover tooltip -- mirrors the main-HUD rankBadge
                // pattern but on clan-event standings. Tooltip shows event-score
                // (MMR delta) needed to catch the clan directly above you.
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
                    // Show total ("of N") only when there's actually competition;
                    // "#1/1" is meaningless clutter when you're alone in the event.
                    const totalPart = standings.length > 1
                        ? `<span style="opacity:.55;font-weight:normal;"> of ${standings.length}</span>`
                        : "";
                    rankBadgeHtml = `<span class="rgHasTip" data-tip="${tip}" style="color:${rankColor};font-weight:bold;font-size:11px;">#${myRank}${totalPart}</span>`;
                }

                // Left column: your clan's numbers.
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

                // Right column: leader (if not you) or challenger (if you lead) or lonely-message.
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
                // Clanless viewer: single line showing who's on top.
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

    // Clan max member cap. Reads events/current.maxMembers with 5 as the
    // fallback default, so a maintainer can change the cap live in Firestore
    // (raise to 6, drop to 4, etc.) without a script redeploy. Kept as a
    // function call rather than a captured constant so late-arriving event
    // config picks up automatically on next render.
    const DEFAULT_CLAN_MAX_MEMBERS = 5;
    function clanMaxMembers() {
        const n = eventConfig?.maxMembers;
        return (typeof n === "number" && n > 0 && n <= 50) ? n : DEFAULT_CLAN_MAX_MEMBERS;
    }

    function myUserId() { return lastKnownPlayerData?.Id ?? null; }

    // Plain-text letters of the player's ACTUAL in-game name: first line of
    // the raw nickname from the game's login response, TMP tags stripped,
    // leading [TAG] clan prefix removed (the clan-tag prefix feature owns
    // that separately now). This is what Name Forge should seed its Name
    // field with -- the in-game name, not the leaderboard display name.
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

    // Roles that can approve/reject join requests.
    function canManageRequests(role) {
        return role === "leader" || role === "coleader" || role === "elder";
    }

    async function loadClanData(force = false) {
        const uid = myUserId();
        if (!uid) return;

        // Account changed since last load -> force a fresh load and clear stale state.
        if (clanLoadedForAccount !== uid) {
            force = true;
            myClan = null;
            clanDirectory = [];
            clanLoaded = false;
        }

        if (clanLoaded && !force) return;
        const fb = await initFirebase();
        if (!fb) return;

        try {
            // Directory: one read for the browse list.
            const dirSnap = await fb.getDoc(fb.doc(fb.db, "clans_directory", "index"));
            clanDirectory = dirSnap.exists() ? (dirSnap.data().clans ?? []) : [];

            // Find my clan (if any) by scanning the directory for my membership.
            myClan = null;
            const mine = clanDirectory.find(c => (c.memberIds ?? []).includes(uid));
            if (mine) {
                const clanSnap = await fb.getDoc(fb.doc(fb.db, "clans", mine.id));
                if (clanSnap.exists()) myClan = { id: mine.id, ...clanSnap.data() };
            }
            clanLoaded = true;
            clanLoadedForAccount = uid;
        } catch (e) {
            console.warn("[RG HUD] Clan load failed:", e);
        }
    }

    // Rebuild the directory doc from scratch off current clans -- simple and
    // safe for a small number of clans. Called after any membership change.
    //
    // COST NOTE: this reads EVERY clan doc + 1 write. Fine for structural
    // changes (create/join/kick/leave -- rare), too expensive to run on every
    // match's MMR tick. Routine MMR updates go through
    // refreshDirectoryThrottled below instead.

    // Patch only MY clan's entry in the in-memory directory: zero reads, keeps
    // my own standings/title/event views instantly fresh between throttled
    // Firestore rebuilds.
    function patchMyClanInDirectory() {
        if (!myClan) return;
        const entry = clanDirectory.find(c => c.id === myClan.id);
        if (!entry) return;
        entry.name = myClan.name;
        entry.tag = myClan.tag ?? "";
        entry.memberCount = (myClan.members ?? []).length;
        entry.memberIds = (myClan.members ?? []).map(m => m.userId);
        entry.totalMMR = myClan.totalMMR ?? 0;
        entry.eventScore = computeClanEventScore(myClan);
        entry.eventId = myClan.eventId ?? null;
        applyTitle(); // clan-lead status may have flipped
    }

    // Throttled directory rebuild for routine per-match MMR changes. Other
    // players and Pal's site see standings at most DIR_REFRESH_THROTTLE_MS
    // stale; my own HUD stays live via patchMyClanInDirectory. Structural
    // changes still call refreshDirectory directly (immediate).
    let lastDirRefreshAt = 0;
    const DIR_REFRESH_THROTTLE_MS = 3 * 60 * 1000;

    async function refreshDirectoryThrottled(fb) {
        patchMyClanInDirectory();
        const now = Date.now();
        if (now - lastDirRefreshAt < DIR_REFRESH_THROTTLE_MS) return;
        lastDirRefreshAt = now;
        await refreshDirectory(fb);
    }


    // Renders the Tag Style panel with a big Forge-style preview, palette
    // chips, gradient endpoints, bold/italic, wave (alternating rotate),
    // static rotate slider. Every control updates the preview live so leaders
    // can dial in the exact look before hitting Save. Members see just the
    // preview + opt-in checkbox.
    function renderClanTagPanel() {
        const body = document.getElementById("rgClanTagBody");
        if (!body || !myClan) return;
        const isLeader = myClan.leaderId === myUserId();
        const st = myClan.tagStyle || {};
        const tagText = String(myClan.tag || "").trim();

        // Working copy separate from myClan.tagStyle so live edits don't feel
        // committed. Sync back on Save.
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

        // Build the visible preview HTML for the current working style.
        // Brackets get their own color when work.bracketColor is set; gradient
        // then runs over just the tag LETTERS so the blend isn\'t interrupted
        // by contrast-colored brackets on either end.
        function buildPreviewHtml() {
            if (!tagText) return '<span style="color:#888;font-style:italic;font-size:14px;">(clan has no tag set)</span>';
            const escCh = ch => ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch;
            const tagChars = [...tagText];
            const bracketColor = /^#[0-9a-fA-F]{6}$/.test(work.bracketColor || "") ? work.bracketColor : null;
            const stops = work.mode === "gradient" ? activeStops() : null;

            // Rotation per emitted char index (wave alternates, static rotate
            // applies same value to all)
            const rotFor = wi => work.waveOn ? (wi % 2 === 0 ? work.waveAmp : -work.waveAmp)
                : (work.rotateDeg && !work.waveOn ? work.rotateDeg : 0);
            const spanFor = (ch, color, wi) => {
                const rot = rotFor(wi);
                const tf = rot ? "display:inline-block;transform:rotate(" + rot + "deg);" : "";
                const co = color ? "color:" + color + ";" : "";
                return '<span style="' + co + tf + '">' + escCh(ch) + '</span>';
            };

            // Color resolver for tag LETTER at position i out of tagChars.length
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
            // Bracket color: use bracketColor if set, else defer to mode
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

        // Big preview box (Forge style)
        html += '<div style="background:radial-gradient(120% 140% at 50% 0%, #101a3a 0%, #070a16 70%);border:1px solid #00bfff44;border-radius:10px;padding:16px;text-align:center;min-height:60px;display:flex;align-items:center;justify-content:center;margin-bottom:10px;">'
            + '<span id="rgTagPreviewInner">' + buildPreviewHtml() + '</span></div>';

        if (isLeader && tagText) {
            // Mode selector
            html += '<div style="font-size:10px;font-weight:bold;color:#00bfff;margin:6px 0 4px;">STYLE MODE</div>';
            html += '<div style="display:flex;gap:4px;">';
            for (const m of ["none","solid","gradient"]) {
                const active = work.mode === m;
                html += '<button class="rgBtn rgTagMode" data-mode="' + m + '" style="flex:1;padding:5px;font-size:11px;'
                    + (active ? 'background:#00bfff33;border:1px solid #00bfff;color:#00bfff;' : '') + '">'
                    + m.charAt(0).toUpperCase() + m.slice(1) + '</button>';
            }
            html += '</div>';

            // Solid color row
            html += '<div id="rgTagSolidRow" style="margin-top:8px;display:' + (work.mode === "solid" ? "flex" : "none") + ';gap:8px;align-items:center;font-size:11px;">'
                + 'Color: <input type="color" id="rgTagColor" value="' + work.color + '" style="width:40px;height:24px;padding:0;border:none;background:transparent;cursor:pointer;">'
                + '<span id="rgTagColorHex" style="opacity:.7;font-family:monospace;">' + work.color + '</span>'
                + '</div>';

            // Gradient section: palettes + custom endpoints + preview bar
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

            // Bold + Italic
            html += '<div style="margin-top:10px;display:flex;gap:16px;font-size:11px;">'
                + '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;"><input type="checkbox" id="rgTagBold"' + (work.bold ? " checked" : "") + '> <b>Bold</b></label>'
                + '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;"><input type="checkbox" id="rgTagItalic"' + (work.italic ? " checked" : "") + '> <i>Italic</i></label>'
                + '</div>';

            // Brackets: optional separate color for [ and ]. When cleared,
            // brackets follow the main style (participate in gradient/solid).
            html += '<div style="font-size:10px;font-weight:bold;color:#00bfff;margin:10px 0 4px;">BRACKETS</div>';
            html += '<div style="display:flex;gap:8px;align-items:center;font-size:11px;">'
                + 'Color: <input type="color" id="rgTagBracketColor" value="' + (work.bracketColor || "#ffffff") + '" style="width:40px;height:24px;padding:0;border:none;background:transparent;cursor:pointer;">'
                + '<button id="rgTagBracketMatch" class="rgBtn" style="padding:3px 8px;font-size:10px;'
                + (!work.bracketColor ? 'background:#00bfff33;border:1px solid #00bfff;' : '') + '">Match tag</button>'
                + '<span style="opacity:.6;font-size:10px;">' + (work.bracketColor ? work.bracketColor : "matches") + '</span>'
                + '</div>';

            // Effects: wave + static rotate. Wave overrides static rotate.
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
        } else if (!isLeader && !tagText) {
            html += '<div style="font-size:11px;color:#888;text-align:center;margin-top:4px;">Leader hasn\'t set a tag yet.</div>';
        }

        // Opt-in (all members)
        if (tagText) {
            html += '<hr style="border:none;border-top:1px solid #00bfff22;margin:10px 0 8px;">';
            html += '<label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;">'
                + '<input type="checkbox" id="rgUseTag"' + (useClanTagPref() ? " checked" : "") + '>'
                + ' Prepend clan tag to my in-game name</label>';
        }

        body.innerHTML = html;

        // ---- Wire live-update handlers ----
        if (isLeader && tagText) {
            // Mode buttons
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
            // Palette chips: pick preset or "Custom" (returns to user start/end)
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

            // Bracket color: picking one sets it; "Match tag" clears it so
            // brackets rejoin the main style.
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
                    await fb.setDoc(fb.doc(fb.db, "clans", myClan.id), { tagStyle: newStyle }, { merge: true });
                    myClan.tagStyle = newStyle;
                    // Inline confirmation on the button itself -- the bottom
                    // toast is easy to miss from deep in a scrolled panel.
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
                    showToast("Tag style saved -- members see it on their next clan tab visit.");
                } catch (e) { console.error("[RG HUD] Save tag style failed:", e); showToast("Save failed."); }
            };
        }

        // Opt-in handler
        const useTagCb = document.getElementById("rgUseTag");
        if (useTagCb) {
            useTagCb.onchange = () => {
                setUseClanTagPref(useTagCb.checked);
                // The prefix reaches the actual in-game name only when the
                // player hits Apply in Name Forge -- say so, so the checkbox
                // doesn't feel like it silently did nothing.
                showToast(useTagCb.checked
                    ? "Tag armed! Open 🎨 Name Forge and hit Apply to update your name."
                    : "Tag prefix off -- hit Apply in 🎨 Name Forge to update your name.");
                if (typeof RGNF !== "undefined" && RGNF.refresh) RGNF.refresh();
            };
        }
    }

    async function refreshDirectory(fb) {
        try {
            const snap = await fb.getDocs(fb.collection(fb.db, "clans"));
            const clans = [];
            snap.forEach(docSnap => {
                const d = docSnap.data();
                clans.push({
                    id: docSnap.id,
                    name: d.name,
                    tag: d.tag ?? "",
                    tagStyle: d.tagStyle || null,
                    memberCount: (d.members ?? []).length,
                    memberIds: (d.members ?? []).map(m => m.userId),
                    totalMMR: d.totalMMR ?? 0,
                    // Event score for the current event (0 if their baseline is
                    // stale/absent), so standings can rank clans by event gain.
                    eventScore: computeClanEventScore({ ...d, id: docSnap.id }),
                    eventId: d.eventId ?? null,
                });
            });
            await fb.setDoc(fb.doc(fb.db, "clans_directory", "index"), { clans });
            clanDirectory = clans;
        } catch (e) {
            console.warn("[RG HUD] Directory refresh failed:", e);
        }
        // Directory drives the clan-lead HUD title; refresh it so any standings
        // change flips the title in/out of "Leading the Clash" immediately.
        applyTitle();
    }

    // Sum of this player's 3v3+2v2+1v1 displayRatings (no casual).
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

        // Event lockdown: gated by allowClanCreate. Default TRUE (creating a
        // new clan doesn\'t affect existing rosters), but a maintainer can
        // freeze it in events/current if needed.
        if (!eventPerm("allowClanCreate")) {
            showToast("New clans can\'t be created during this event.");
            return;
        }

        // Uniqueness check against directory (best-effort).
        if (clanDirectory.some(c => c.name.toLowerCase() === name.toLowerCase())) {
            showToast("A clan with that name already exists.");
            return;
        }

        try {
            const clan = {
                name,
                tag: tag || "",
                tagStyle: null,
                leaderId: uid,
                members: [{ userId: uid, name: myName(), role: "leader" }],
                joinRequests: [],
                totalMMR: myRankedMMR(),
                createdAt: new Date().toISOString(),
            };
            const ref = await fb.addDoc(fb.collection(fb.db, "clans"), clan);
            myClan = { id: ref.id, ...clan };
            await refreshDirectory(fb);
            renderClanView();
        } catch (e) {
            console.error("[RG HUD] Create clan failed:", e);
            showToast("Couldn't create clan (see console).");
        }
    }

    async function requestJoin(clanId) {
        const fb = await initFirebase();
        if (!fb) return;
        const uid = myUserId();
        if (!uid) return;

        // Event lockdown: gated by allowJoin. Default is TRUE (join is open),
        // but a maintainer can flip it off in events/current if a specific
        // event needs frozen rosters.
        if (!eventPerm("allowJoin")) {
            showToast("Clan joins are locked during this event.");
            return;
        }

        try {
            const clanSnap = await fb.getDoc(fb.doc(fb.db, "clans", clanId));
            if (!clanSnap.exists()) return;
            const clan = clanSnap.data();

            if ((clan.members ?? []).length >= clanMaxMembers()) {
                showToast("That clan is full.");
                return;
            }
            if ((clan.joinRequests ?? []).some(r => r.userId === uid)) {
                showToast("You already requested to join.");
                return;
            }
            const joinRequests = [...(clan.joinRequests ?? []), { userId: uid, name: myName() }];
            await fb.setDoc(fb.doc(fb.db, "clans", clanId), { joinRequests }, { merge: true });
            showToast("Join request sent!");
            renderClanView();
        } catch (e) {
            console.error("[RG HUD] Request join failed:", e);
        }
    }

    async function approveRequest(userId, approve) {
        const fb = await initFirebase();
        if (!fb || !myClan) return;

        // Event lockdown: approvals gated by allowApprove. Default TRUE now.
        // Denies (approve === false) are always allowed since removing a
        // stale request never grows the roster.
        if (approve && !eventPerm("allowApprove")) {
            showToast("Approvals are locked during this event.");
            return;
        }

        try {
            const req = (myClan.joinRequests ?? []).find(r => r.userId === userId);
            const joinRequests = (myClan.joinRequests ?? []).filter(r => r.userId !== userId);
            let members = myClan.members ?? [];

            if (approve && req && members.length < clanMaxMembers()
                && !members.some(m => m.userId === userId)) {
                members = [...members, { userId: req.userId, name: req.name, role: "member" }];
            }

            await fb.setDoc(fb.doc(fb.db, "clans", myClan.id), { joinRequests, members }, { merge: true });
            myClan.joinRequests = joinRequests;
            myClan.members = members;
            await refreshDirectory(fb);
            renderClanView();
        } catch (e) {
            console.error("[RG HUD] Approve request failed:", e);
        }
    }

    async function kickMember(userId, message) {
        const fb = await initFirebase();
        if (!fb || !myClan) return;
        const myUid = myUserId();

        // Event lockdown: gated by allowKick. Default TRUE (leaders keep the
        // ability to remove problem members even mid-event -- a scored player
        // shouldn\'t be trapped in a clan). Flip off if you want fully frozen
        // rosters during a specific event.
        if (!eventPerm("allowKick")) {
            showToast("Kicking is locked during this event.");
            return;
        }

        try {
            const target = (myClan.members ?? []).find(m => m.userId === userId);
            if (!target || target.role === "leader") return; // never kick the leader
            // Only leader/coleader may kick (defense in depth beyond the UI gating).
            const me = (myClan.members ?? []).find(m => m.userId === myUid);
            if (!me || (me.role !== "leader" && me.role !== "coleader")) return;

            const members = (myClan.members ?? []).filter(m => m.userId !== userId);
            await fb.setDoc(fb.doc(fb.db, "clans", myClan.id), { members }, { merge: true });
            myClan.members = members;

            // Leave a one-time notice the kicked player's HUD will show + clear.
            const notice = {
                type: "kicked",
                clanName: myClan.name,
                message: (message ?? "").slice(0, 200),
                at: new Date().toISOString(),
            };
            await fb.setDoc(fb.doc(fb.db, "clan_notices", userId), notice);

            await refreshDirectory(fb);
            renderClanView();
        } catch (e) {
            console.error("[RG HUD] Kick failed:", e);
            showToast("Couldn't kick member (see console).");
        }
    }

    // On load, check if this player has a pending clan notice (e.g. was kicked)
    // and show it once, then clear it.
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
                if (n.type === "kicked") {
                    const extra = n.message ? `  Message: "${n.message}"` : "";
                    showDialog({
                        message: `You were removed from clan "${n.clanName}".${extra}`,
                        okLabel: "OK",
                        cancelLabel: "Dismiss",
                    });
                }
                await fb.deleteDoc(ref);
            }
        } catch (e) {
            // notices are best-effort
        }
    }

    // ---------- Role management (Stage 2) ----------
    // Hierarchy: leader > coleader > elder > member. Clash-style: multiple
    // coleaders/elders allowed. Permission gating (who can change whom) is
    // enforced here in-script (honor system).

    const ROLE_RANK = { leader: 3, coleader: 2, elder: 1, member: 0 };

    // Can `actorRole` set `targetCurrentRole` to `newRole`?
    function canSetRole(actorRole, targetCurrentRole, newRole) {
        const a = ROLE_RANK[actorRole] ?? -1;
        // Only leader/coleader manage roles at all.
        if (a < ROLE_RANK.coleader) return false;
        // Can't touch someone at or above your own rank (coleader can't touch coleader/leader).
        if ((ROLE_RANK[targetCurrentRole] ?? 0) >= a) return false;
        // Can't promote someone to at/above your own rank.
        if ((ROLE_RANK[newRole] ?? 0) >= a) return false;
        // Nobody assigns "leader" via this path -- that's transferLeadership only.
        if (newRole === "leader") return false;
        return true;
    }

    async function setMemberRole(userId, newRole) {
        const fb = await initFirebase();
        if (!fb || !myClan) return;
        const myUid = myUserId();
        const me = (myClan.members ?? []).find(m => m.userId === myUid);
        const target = (myClan.members ?? []).find(m => m.userId === userId);
        if (!me || !target) return;

        // Event lockdown: gated by allowRoleChange. Default FALSE -- role
        // changes shift attribution and could confuse the "who contributed
        // what" audit during scoring.
        if (!eventPerm("allowRoleChange")) {
            showToast("Role changes are locked during this event.");
            return;
        }

        if (!canSetRole(me.role, target.role, newRole)) {
            showToast("You can't change that member's role.");
            return;
        }

        try {
            const members = (myClan.members ?? []).map(m =>
                m.userId === userId ? { ...m, role: newRole } : m
            );
            await fb.setDoc(fb.doc(fb.db, "clans", myClan.id), { members }, { merge: true });
            myClan.members = members;
            await refreshDirectory(fb);
            renderClanView();
        } catch (e) {
            console.error("[RG HUD] Set role failed:", e);
            showToast("Couldn't change role (see console).");
        }
    }

    async function editClan(newName, newTag) {
        const fb = await initFirebase();
        if (!fb || !myClan) return;
        if (myClan.leaderId !== myUserId()) return; // leader only

        // Event lockdown: gated by allowRenameClan. Default FALSE -- clan
        // identity freezes during scoring so leaderboards don\'t get mid-event
        // rebrands.
        if (!eventPerm("allowRenameClan")) {
            showToast("Clan renames are locked during this event.");
            return;
        }

        // Uniqueness (ignore our own clan).
        const nameClash = clanDirectory.some(c => c.id !== myClan.id && (c.name ?? "").toLowerCase() === newName.toLowerCase());
        const tagClash = clanDirectory.some(c => c.id !== myClan.id && (c.tag ?? "").toLowerCase() === newTag.toLowerCase());
        if (nameClash) { showToast("A clan with that name already exists."); return; }
        if (tagClash) { showToast("That tag is already taken."); return; }

        try {
            await fb.setDoc(fb.doc(fb.db, "clans", myClan.id), { name: newName, tag: newTag }, { merge: true });
            myClan.name = newName;
            myClan.tag = newTag;
            await refreshDirectory(fb);
            showToast("Clan updated! Tag refreshes on members' next match.");
            renderClanView();
        } catch (e) {
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

    async function transferLeadership(userId) {
        const fb = await initFirebase();
        if (!fb || !myClan) return;
        const myUid = myUserId();
        if (myClan.leaderId !== myUid) return; // only the leader can transfer

        // Event lockdown: gated by allowTransfer. Default FALSE -- leadership
        // handoff mid-event could obscure attribution.
        if (!eventPerm("allowTransfer")) {
            showToast("Leadership transfers are locked during this event.");
            return;
        }

        try {
            const members = (myClan.members ?? []).map(m => {
                if (m.userId === userId) return { ...m, role: "leader" };
                if (m.userId === myUid) return { ...m, role: "coleader" }; // old leader -> coleader
                return m;
            });
            await fb.setDoc(fb.doc(fb.db, "clans", myClan.id), { members, leaderId: userId }, { merge: true });
            myClan.members = members;
            myClan.leaderId = userId;
            await refreshDirectory(fb);
            renderClanView();
        } catch (e) {
            console.error("[RG HUD] Transfer leadership failed:", e);
            showToast("Couldn't transfer leadership (see console).");
        }
    }


    // ---------- Clan tag styling ----------
    // Leader owns clan.tagStyle: { color?: hex, bold?: bool, wrap: 'brackets'|'angle'|'none' }
    // Each member opts in via localStorage (no server writes per-member so the
    // clan doc doesn't inflate). When a member has opted in AND their clan has
    // a tag string set, getClanTagPrefix() returns the TMP-formatted markup to
    // prepend before their in-game nickname (via Name Forge's apply path).

    const CLAN_TAG_OPTIN_KEY = "rgHudUseClanTag";

    function useClanTagPref() {
        try { return localStorage.getItem(CLAN_TAG_OPTIN_KEY) === "1"; } catch { return false; }
    }
    function setUseClanTagPref(on) {
        try { localStorage.setItem(CLAN_TAG_OPTIN_KEY, on ? "1" : "0"); } catch {}
    }

    // Interpolate two #RRGGBB hex colors at t in [0,1].
    function _interpHex(a, b, t) {
        const ar = parseInt(a.slice(1,3),16), ag = parseInt(a.slice(3,5),16), ab_ = parseInt(a.slice(5,7),16);
        const br = parseInt(b.slice(1,3),16), bg = parseInt(b.slice(3,5),16), bb = parseInt(b.slice(5,7),16);
        const r = Math.round(ar + (br-ar)*t), g = Math.round(ag + (bg-ag)*t), bl = Math.round(ab_ + (bb-ab_)*t);
        return '#' + r.toString(16).padStart(2,'0') + g.toString(16).padStart(2,'0') + bl.toString(16).padStart(2,'0');
    }

    // Sample an N-stop gradient at t in [0,1]. Stops are evenly spaced.
    // Same math Name Forge uses so tag gradients match name gradients.
    function _sampleStops(stops, t) {
        if (!stops || stops.length === 0) return "#ffffff";
        if (stops.length === 1) return stops[0];
        const scaled = t * (stops.length - 1);
        const i = Math.min(Math.floor(scaled), stops.length - 2);
        return _interpHex(stops[i], stops[i + 1], scaled - i);
    }

    // Palette presets (mirrors Name Forge). start/end stored on tagStyle for
    // arbitrary user gradients; palette selection just overwrites those with
    // a preset\'s stop array (stored as tagStyle.stops when a preset picked).
    const CLAN_TAG_PALETTES = [
        { key: 'fire',    label: '🔥 Fire',    stops: ['#FF4D00', '#FFB800', '#FF0000'] },
        { key: 'ocean',   label: '🌊 Ocean',   stops: ['#00FFFF', '#00CFFF'] }, // exact [KING] shimmer: K,I,N,G sample to #00FFFF,#00EFFF,#00DFFF,#00CFFF
        { key: 'rainbow', label: '🌈 Rainbow', stops: ['#FF0000', '#FFFF00', '#00FF00', '#00BFFF', '#8B00FF'] },
        { key: 'sunset',  label: '🌇 Sunset',  stops: ['#FF6B6B', '#FFB347', '#8E44AD'] },
        { key: 'toxic',   label: '☢️ Toxic',   stops: ['#39FF14', '#CCFF00', '#00FF9F'] },
        { key: 'ice',     label: '❄️ Ice',     stops: ['#E0FFFF', '#7DD3FC', '#2563EB'] },
    ];

    // Effective color stops for the tag: palette stops if a palette is picked,
    // otherwise the two user-picked gradient endpoints. Returns null if not
    // in a gradient mode.
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

    // Returns the TMP-formatted markup for this member\'s clan tag prefix.
    // Always uses [TAG] wrapping. Mode: 'none' | 'solid' | 'gradient'.
    // Optional effects: bold, italic, wave (alternating rotate), rotate
    // (static). Gradient emits per-character <#RRGGBB> tags; when combined
    // with wave, each character also gets its own <rotate=±waveAmp>.
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

        // Emits color+wave markup for one character at "gradient position" gi
        // out of total-1. When bracketColor is set for gradient mode, gi runs
        // over TAG LETTERS ONLY so the blend distributes cleanly inside the
        // brackets. Brackets themselves use bracketColor.
        function emitChar(ch, gi, giMax, forceColor, waveIdx) {
            let piece = "";
            if (waveOn) piece += "<rotate=" + (waveIdx % 2 === 0 ? waveAmp : -waveAmp) + ">";
            if (forceColor) {
                piece += "<" + forceColor + ">";
            } else if (stops) {
                const t = giMax === 0 ? 0 : gi / giMax;
                piece += "<" + _sampleStops(stops, t).toUpperCase() + ">";
            } else if (mode === "solid" && /^#[0-9a-fA-F]{6}$/.test(st.color || "")) {
                // Always emit the solid color for letters in the per-char path:
                // the bracket's color tag persists in TMP until changed, so a
                // letter without its own tag wears the bracket color. (This
                // was gated on waveOn before -- solid + bracket color + no
                // wave rendered the whole tag bracket-colored.)
                piece += "<" + st.color.toUpperCase() + ">";
            }
            return piece + ch;
        }

        let out = "";
        if (!waveOn && rotateDeg !== 0) out += "<rotate=" + rotateDeg + ">";

        // Fast path: solid color, no wave, no separate bracket color -- one wrap
        if (mode === "solid" && /^#[0-9a-fA-F]{6}$/.test(st.color || "") && !waveOn && !bracketColor) {
            out += "<" + st.color.toUpperCase() + ">[" + tag + "]";
        } else {
            let wi = 0; // wave index counts every emitted char including brackets
            // Opening bracket
            out += emitChar("[", 0, Math.max(0, tagChars.length - 1), bracketColor, wi++);
            // Tag letters: gradient distributes over these when bracketColor set
            for (let i = 0; i < tagChars.length; i++) {
                const gi = bracketColor ? i : i + 1;
                const giMax = bracketColor ? Math.max(0, tagChars.length - 1) : tagChars.length + 1;
                out += emitChar(tagChars[i], gi, giMax, null, wi++);
            }
            // Closing bracket
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

        // Event lockdown: members can't leave mid-event unless allowLeave is
        // explicitly turned on in the event doc. Leader isn't checked here --
        // sole-leader disband is a separate action gated by allowDisband.
        if (!eventPerm("allowLeave") && myClan.leaderId !== uid) {
            showToast("Can't leave during an active event -- ask leader to kick.");
            return;
        }

        try {
            const isLeader = myClan.leaderId === uid;
            const isSoloLeader = isLeader && (myClan.members ?? []).length === 1;
            // Event lockdown: solo leader disband gated by allowDisband. Default
            // FALSE -- disbanding mid-event would erase every contribution the
            // clan has scored so far. Non-solo leaders hit the transfer flow
            // below, which is gated by allowTransfer instead.
            if (isSoloLeader && !eventPerm("allowDisband")) {
                showToast("Disbanding is locked during this event.");
                return;
            }
            if (isLeader && (myClan.members ?? []).length > 1) {
                showToast("Transfer leadership or remove others before leaving.");
                return;
            }
            if (isLeader) {
                // Last member & leader -> disband.
                await fb.deleteDoc(fb.doc(fb.db, "clans", myClan.id));
            } else {
                const members = (myClan.members ?? []).filter(m => m.userId !== uid);
                await fb.setDoc(fb.doc(fb.db, "clans", myClan.id), { members }, { merge: true });
            }
            myClan = null;
            await refreshDirectory(fb);
            renderClanView();
        } catch (e) {
            console.error("[RG HUD] Leave clan failed:", e);
        }
    }

    // ---------- Clan view rendering ----------

    async function renderClanView() {
        const view = document.getElementById("rgClanView");
        if (!view) return;

        if (!lastKnownPlayerData) {
            view.innerHTML = `<div style="opacity:.8;">Log in or play a match first to use clans.</div>`;
            return;
        }

        view.innerHTML = `<div style="opacity:.8;">Loading clans...</div>`;
        await loadClanData(true);
        const fb = await initFirebase();
        if (fb) await loadEventConfig(fb, true);

        renderClanViewFromMemory();
    }

    // Re-renders the clan tab from whatever's already in myClan/clanDirectory --
    // no Firestore reads. Called after a match sync (which already refreshed
    // myClan in memory) so the event score updates live, piggybacking on data
    // we already have instead of reading again.
    function renderClanViewFromMemory() {
        const view = document.getElementById("rgClanView");
        if (!view) return;
        myClan ? renderMyClan(view) : renderNoClan(view);
    }

    // If the clan tab is currently open, refresh it in place (no reads).
    function refreshClanViewIfOpen() {
        const view = document.getElementById("rgClanView");
        if (view && view.style.display !== "none") {
            renderClanViewFromMemory();
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
                        ${c.tag ? `<span style="opacity:.7;">[${c.tag}]</span>` : ""}
                        <b>${escapeHtml(c.name)}</b>
                        <span style="opacity:.6;font-size:10px;">(${c.memberCount}/${clanMaxMembers()})</span>
                    </span>
                    <span style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
                        <span style="color:#00ff66;font-size:11px;">${c.totalMMR}</span>
                        <button class="rgBtn rgJoinBtn" data-clan="${c.id}" style="padding:2px 6px;font-size:10px;" ${c.memberCount >= clanMaxMembers() ? "disabled" : ""}>Join</button>
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
        [nameEl, tagEl].forEach(el => {
            el.addEventListener("keydown", e => e.stopPropagation(), true);
        });
        // Live tag hygiene: uppercase and letter-only as they type, so the
        // visual field never shows an illegal character even for a moment.
        tagEl.style.textTransform = "uppercase";
        tagEl.addEventListener("input", () => {
            const clean = sanitizeClanTag(tagEl.value);
            if (tagEl.value !== clean) tagEl.value = clean;
        });

        document.getElementById("rgClanCreateGo").onclick = () => {
            const name = nameEl.value.trim();
            const tag = sanitizeClanTag(tagEl.value);
            if (name.length === 0 || name.length > 24) { errEl.textContent = "Name must be 1-24 characters."; return; }
            if (tag.length < 2 || tag.length > 4) { errEl.textContent = "Tag: 2-4 letters, no numbers or symbols."; return; }
            if (containsProfanity(name) || containsEmoji(name)) { errEl.textContent = "That name isn't allowed."; return; }
            if (containsProfanity(tag) || containsEmoji(tag)) { errEl.textContent = "That tag isn't allowed."; return; }
            if (clanDirectory.some(c => (c.tag ?? "").toLowerCase() === tag.toLowerCase())) {
                errEl.textContent = "That tag is already taken."; return;
            }
            createClan(name, tag);
        };
        document.getElementById("rgClanCreateCancel").onclick = renderClanView;
    }

    function renderMyClan(view) {
        const uid = myUserId();
        const me = (myClan.members ?? []).find(m => m.userId === uid);
        const myRole = me?.role ?? "member";
        const rank = [...clanDirectory].sort((a, b) => (b.totalMMR ?? 0) - (a.totalMMR ?? 0))
            .findIndex(c => c.id === myClan.id) + 1;

        // Leaders and co-leaders can kick + manage roles. Can't act on yourself or the leader.
        const canManage = (myRole === "leader" || myRole === "coleader");
        // Per-member event contribution: current MMR minus their baseline
        // captured at first sync during this event. Only meaningful while the
        // event is active AND the baseline map belongs to the current event
        // (clanBaselineForCurrentEvent handles the staleness guard).
        const eventActive = eventPhase() === "active";
        const eventBaselines = eventActive ? (clanBaselineForCurrentEvent(myClan) || {}) : {};
        const contribFor = (member) => {
            if (!eventActive) return null;
            const base = eventBaselines[member.userId];
            if (base == null || typeof member.mmr !== "number") return null;
            return member.mmr - base;
        };

        const memberRows = (myClan.members ?? [])
            .slice()
            .sort((a, b) => (ROLE_RANK[b.role] ?? 0) - (ROLE_RANK[a.role] ?? 0))
            .map(m => {
                const actable = canManage && m.userId !== uid && m.role !== "leader"
                    && (ROLE_RANK[m.role] ?? 0) < (ROLE_RANK[myRole] ?? 0);
                const contrib = contribFor(m);
                // Contribution chip: green for gain, red for loss, gray dash for
                // "hasn't played this event yet." Only shown during active event.
                const contribHtml = eventActive
                    ? (contrib == null
                        ? `<span title="Hasn't played during this event yet" style="opacity:.4;font-size:10px;font-family:monospace;">—</span>`
                        : `<span title="Event contribution (current MMR - baseline)" style="color:${contrib >= 0 ? "#00ff66" : "#ff6b6b"};font-size:10px;font-weight:bold;font-family:monospace;">${contrib >= 0 ? "+" : ""}${contrib}</span>`)
                    : "";
                return `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;gap:6px;">
                    <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        ${escapeHtml(m.name)}
                        ${typeof m.mmr === "number" ? `<span style="opacity:.5;font-size:10px;">${m.mmr}</span>` : ""}
                    </span>
                    <span style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
                        ${contribHtml}
                        <span style="opacity:.7;font-size:10px;text-transform:uppercase;">${m.role}</span>
                        ${actable ? `<button class="rgBtn rgManage" data-uid="${m.userId}" data-name="${escapeHtml(m.name)}" data-role="${m.role}" style="padding:1px 6px;font-size:10px;">⋯</button>` : ""}
                    </span>
                </div>`;
            }).join("");

        let requestsSection = "";
        if (canManageRequests(myRole) && (myClan.joinRequests ?? []).length > 0) {
            const reqRows = myClan.joinRequests.map(r => `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;gap:6px;">
                    <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.name)}</span>
                    <span style="display:flex;gap:4px;flex-shrink:0;">
                        <button class="rgBtn rgApprove" data-uid="${r.userId}" style="padding:1px 6px;font-size:10px;">✓</button>
                        <button class="rgBtn rgReject" data-uid="${r.userId}" style="padding:1px 6px;font-size:10px;">✗</button>
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
                    ${isLeader ? `<button id="rgEditClan" class="rgBtn" style="padding:1px 6px;font-size:10px;">✏️</button>` : ""}
                    <span style="color:#ffd700;font-size:11px;">Rank #${rank || "-"}</span>
                </span>
            </div>
            <div style="font-size:11px;opacity:.75;margin:2px 0 6px;">
                Total MMR: <span style="color:#00ff66;">${myClan.totalMMR ?? 0}</span>
                &nbsp;•&nbsp; ${(myClan.members ?? []).length}/${clanMaxMembers()} members
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

        if (isLeader) {
            const editBtn = document.getElementById("rgEditClan");
            if (editBtn) editBtn.onclick = showEditClanForm;
        }

        // Members list is collapsed by default to reserve HUD vertical space;
        // clicking the header (or the little arrow) toggles it.
        const mHeader = document.getElementById("rgMembersHeader");
        if (mHeader) {
            mHeader.onclick = () => {
                const list = document.getElementById("rgMembersList");
                const arrow = document.getElementById("rgMembersArrow");
                const open = list.style.display !== "none";
                list.style.display = open ? "none" : "block";
                arrow.textContent = open ? "▶" : "▼";
            };
        }
        // Clan Tag Style collapsible toggle -- mirrors Members. Collapsed by
        // default; renderClanTagPanel() still runs so the body is ready when
        // the header is clicked open (and its live preview stays warm too).
        const tHeader = document.getElementById("rgClanTagHeader");
        if (tHeader) {
            tHeader.onclick = () => {
                const body = document.getElementById("rgClanTagBody");
                const arrow = document.getElementById("rgClanTagArrow");
                const open = body.style.display !== "none";
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
        // Event lockdown UI: gray out Leave button for non-leader members
        // when allowLeave is off. Leader\'s own leave/disband is separate.
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

    // Themed replacements for native alert/confirm/prompt.
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

    // Themed confirm/prompt. Returns a promise:
    //  - confirm mode -> resolves true/false
    //  - prompt mode  -> resolves the string, or null if cancelled
    function showDialog({ message, withInput = false, inputPlaceholder = "", okLabel = "OK", cancelLabel = "Cancel" }) {
        return new Promise(resolve => {
            createHUD();
            const dlg = document.getElementById("rgDialog");
            const msgEl = document.getElementById("rgDialogMsg");
            const input = document.getElementById("rgDialogInput");
            const okBtn = document.getElementById("rgDialogOk");
            const cancelBtn = document.getElementById("rgDialogCancel");

            msgEl.textContent = message;
            okBtn.textContent = okLabel;
            cancelBtn.textContent = cancelLabel;
            input.style.display = withInput ? "block" : "none";
            input.value = "";
            input.placeholder = inputPlaceholder;
            dlg.style.display = "flex";
            if (withInput) setTimeout(() => input.focus(), 50);

            const close = result => {
                dlg.style.display = "none";
                okBtn.onclick = null;
                cancelBtn.onclick = null;
                resolve(result);
            };
            okBtn.onclick = () => close(withInput ? input.value.trim() : true);
            cancelBtn.onclick = () => close(withInput ? null : false);
        });
    }

    // A small action menu for managing one member -- rendered into the clan view
    // temporarily. Options depend on the actor's role and the target's role.
    async function showManageMemberMenu(userId, name, targetRole, actorRole, actorIsLeader) {
        const view = document.getElementById("rgClanView");
        if (!view) return;

        // Build the list of allowed actions.
        const actions = [];
        // Role changes: offer any role strictly below the actor that isn't the current one.
        const assignable = ["coleader", "elder", "member"].filter(r =>
            r !== targetRole && canSetRole(actorRole, targetRole, r)
        );
        for (const r of assignable) {
            const verb = (ROLE_RANK[r] > ROLE_RANK[targetRole]) ? "Promote to" : "Demote to";
            actions.push({ label: `${verb} ${r}`, run: () => setMemberRole(userId, r) });
        }
        // Transfer leadership: leader only.
        if (actorIsLeader) {
            actions.push({ label: "👑 Transfer leadership", danger: true, run: async () => {
                const sure = await showDialog({
                    message: `Make ${name} the clan leader? You'll become co-leader.`,
                    okLabel: "Transfer", cancelLabel: "Cancel",
                });
                if (sure) transferLeadership(userId);
            }});
        }
        // Kick.
        actions.push({ label: "❌ Kick from clan", danger: true, run: async () => {
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
            console.log("[RG HUD] loaded and running, waiting for login/matchEnd data...");
        }
    }, 100);


    // ==================================================================
    // 🎨 NAME FORGE (integrated) -- gradient/rich-text in-game nickname
    // builder. Lives in its own scope: it shares helper names (esc, el,
    // render...) with the HUD, so the wrapper prevents collisions. Its
    // draggable 🎨 bubble + Alt+N shortcut work as in the standalone;
    // the HUD's "🎨 Name" button toggles the same panel. Presets/history
    // use the same localStorage keys as the standalone, so users' saved
    // work carries over automatically. NOTE: this edits the IN-GAME
    // nickname (rich TMP text); the ✏️ Rename button edits the separate
    // 15-char LEADERBOARD display name.
    // ==================================================================
    const RGNF = (function () {
      let _rgnfFab = null, _rgnfPanel = null;

  // ------------------------------------------------------------------
  // Constants
  // ------------------------------------------------------------------
  const API_URL = 'https://us-central1-rocketball-23c12.cloudfunctions.net/v0304_player/nickname';
  const STORE_KEY = 'rgNameForge.presets.v1';
  const STATE_KEY_LEGACY = 'rgNameForge.lastState.v1';
  // Per-account state key so switching accounts loads that account\'s last
  // customized name instead of leaking the previous account\'s work. The
  // legacy key is read as a one-time fallback when the per-account slot is
  // empty (so users don\'t lose their existing customization on upgrade).
  let _currentUserId = null;
  let _lastRawNickname = ''; // latest known in-game name markup, for the Reset button
  const stateKey = () => _currentUserId ? ('rgNameForge.state.v5.' + _currentUserId) : STATE_KEY_LEGACY;
  const HISTORY_KEY = 'rgNameForge.history.v1';
  const FABPOS_KEY = 'rgNameForge.fabPos.v1';
  const PALETTES = [
    { label: '🔥 Fire', stops: ['#FF4D00', '#FFB800', '#FF0000'] },
    { label: '🌊 Ocean', stops: ['#00FFFF', '#0000FF'] }, // signature ramp -- matches RootedEngineering (green channel descends, blue pinned)
    { label: '🌈 Rainbow', stops: ['#FF0000', '#FFFF00', '#00FF00', '#00BFFF', '#8B00FF'] },
    { label: '🌇 Sunset', stops: ['#FF6B6B', '#FFB347', '#8E44AD'] },
    { label: '☢️ Toxic', stops: ['#39FF14', '#CCFF00', '#00FF9F'] },
    { label: '❄️ Ice', stops: ['#E0FFFF', '#7DD3FC', '#2563EB'] },
  ];
  // Sprite atlas mapped from in-game screenshot (0-15, left to right)
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

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
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
    // Title now has its OWN styling parallel to the name. Previously title
    // borrowed the name\'s stops/bold/etc, which meant "customize title" was a
    // half-lie. Full independence: separate palette, gradient, style toggles.
    titleStops: ['#ff8fb1', '#a78bfa'],
    titlePaletteKey: null,
    titleBold: false,
    titleItalic: false,
    titleUnderline: false,
    titleStrike: false,
    titleAlpha: 255,                  // 0-255 alpha on titleColor (solid only)
    // Alpha for the NAME\'s solid color, so trailing text like the URL line
    // can be dimmed (Dawson\'s own name uses <#ffffff44> for exactly this).
    solidAlpha: 255,
    scoredMode: 'default',            // 'default' | 'hide' | 'tiny' | 'styled'
    scoredColor: '#22d3ee',
    scoredSizePct: 100,
    rawCode: null,                    // when set: exact current in-game markup, used verbatim
  });

  let state = loadJSON(stateKey(), null) || loadJSON(STATE_KEY_LEGACY, defaultState());
  // backfill any new fields if an old state was saved
  state = Object.assign(defaultState(), state);

  // ------------------------------------------------------------------
  // Utilities
  // ------------------------------------------------------------------
  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* ignore */ }
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

  // Multi-stop gradient sample at t in [0,1]
  function gradientAt(stops, t) {
    if (stops.length === 1) return stops[0].toUpperCase();
    const seg = 1 / (stops.length - 1);
    const idx = Math.min(Math.floor(t / seg), stops.length - 2);
    const localT = (t - idx * seg) / seg;
    return lerpColor(stops[idx], stops[idx + 1], localT);
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
  function colorizeText(text, mode, solid, stops, skipSpaces, waveAmp = 0) {
    const wave = waveAmp !== 0;

    // Fast paths when no per-letter work is needed
    if (!wave && mode === 'none') return text;
    if (!wave && mode === 'solid') return `<${solid.toUpperCase()}>` + text;

    const tokens = tokenize(text);
    const paintable = tokens.filter(t => t.type === 'char' && !(skipSpaces && t.value === ' '));
    const n = paintable.length;
    if (n === 0) return mode === 'solid' ? `<${solid.toUpperCase()}>` + text : text;

    let i = 0;
    let lastColor = null;
    let out = '';
    if (mode === 'solid') {
      const aaN = (s.solidAlpha ?? 255) < 255 ? alphaHex(s.solidAlpha) : '';
      out += `<${solid.toUpperCase()}${aaN}>`;
    }
    for (const tok of tokens) {
      if (tok.type === 'sprite') { out += tok.value; continue; }
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
    if (wave) out += '<rotate=0>'; // reset so trailing text (title/Scored!) sits level
    return out;
  }

  // Split text into chars, but keep <sprite=N> tags intact as single tokens
  function tokenize(text) {
    const tokens = [];
    const re = /<sprite=\d+>/g;
    let lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      for (const ch of text.slice(lastIndex, m.index)) tokens.push({ type: 'char', value: ch });
      tokens.push({ type: 'sprite', value: m[0] });
      lastIndex = m.index + m[0].length;
    }
    for (const ch of text.slice(lastIndex)) tokens.push({ type: 'char', value: ch });
    return tokens;
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

    const nameCode = colorizeText(s.name, s.colorMode, s.solidColor, s.stops, s.skipSpaces, s.waveOn ? s.waveAmp : 0);

    let code = open + nameCode + close;

    // Title line -- fully independent styling from the name.
    // Colors: solid gets <#RRGGBB> or <#RRGGBBAA> (alpha < 255 emits 8-digit).
    // Gradient uses titleStops via colorizeText (same function name works both).
    if (s.titleOn && s.titleText.trim().length > 0) {
      let t = s.titleText;
      if (s.titleColorMode === 'solid') {
        const aa = (s.titleAlpha ?? 255) < 255 ? alphaHex(s.titleAlpha) : '';
        t = `<${s.titleColor.toUpperCase()}${aa}>` + t;
      } else if (s.titleColorMode === 'gradient') {
        t = colorizeText(t, 'gradient', s.titleColor, s.titleStops, s.skipSpaces);
        // Alpha on gradient: append the alpha byte to every <#RRGGBB> tag in
        // one pass, so title gradient can be transparent like solid can.
        const aaG = (s.titleAlpha ?? 255) < 255 ? alphaHex(s.titleAlpha) : '';
        if (aaG) t = t.replace(/<(#[0-9A-Fa-f]{6})>/g, `<$1${aaG}>`);
      }
      let tOpen = '', tClose = '';
      if (s.titleSizePct !== 100) tOpen += `<size=${s.titleSizePct}%>`;
      if (s.titleSub) { tOpen += '<sub>'; tClose = '</sub>' + tClose; }
      if (s.titleBold) { tOpen += '<b>'; tClose = '</b>' + tClose; }
      if (s.titleItalic) { tOpen += '<i>'; tClose = '</i>' + tClose; }
      if (s.titleUnderline) { tOpen += '<u>'; tClose = '</u>' + tClose; }
      if (s.titleStrike) { tOpen += '<s>'; tClose = '</s>' + tClose; }
      code += '<br>' + tOpen + t + tClose;
    }

    // Scored! treatment — trailing tags style whatever the game appends
    switch (s.scoredMode) {
      case 'hide': code += '<size=0>'; break;
      case 'tiny': code += '<sub><size=25%>'; break;
      case 'styled': code += `<size=${s.scoredSizePct}%><${s.scoredColor.toUpperCase()}>`; break;
      default: break;
    }

    return code;
  }

  // ------------------------------------------------------------------
  // Preview rendering (approximation of TMP output)
  // ------------------------------------------------------------------
  function renderPreview(s) {
    const wrap = document.createElement('div');
    wrap.className = 'rgnf-preview-inner';

    const nameLine = document.createElement('div');
    nameLine.className = 'rgnf-preview-name';

    const styles = [];
    if (s.bold) styles.push('font-weight:700');
    if (s.italic) styles.push('font-style:italic');
    // Per-letter decoration mirror: the in-game TMP tags wrap each character
    // (<u>a</u><u>b</u>...) so we do the same in the preview. Setting
    // text-decoration only on the parent nameLine gets visually overpowered
    // when child spans set their own color, and breaks entirely for spans
    // that use rotate transforms (each inline-block becomes its own
    // decoration context). Applied per-span below via decoCSS.
    if (s.sizePct !== 100) styles.push(`font-size:${Math.max(8, 18 * s.sizePct / 100)}px`);
    if (s.markOn) styles.push(`background:${s.markColor}${alphaHex(s.markAlpha)}`);
    nameLine.style.cssText = styles.join(';');

    // Clan tag prefix: minimally parses "<b>", "<#XXXXXX>" wrappers so the
    // preview reflects what will actually be sent. Anything unrecognized is
    // shown as plain text so we never render markup like literal <color> tags.
    // Clan tag prefix: render TMP-style markup ( <b>, <i>, <#RRGGBB>,
    // <rotate=N> ) into styled DOM. Supports gradient (per-char color) and
    // wave/rotate (per-char rotation) markup so preview matches in-game.
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
        const colorTag = rest.match(/^<(#[0-9A-Fa-f]{6})>/);
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

    const tokens = tokenize(s.name);
    const paintable = tokens.filter(t => t.type === 'char' && !(s.skipSpaces && t.value === ' '));
    const n = paintable.length;
    let i = 0;
    for (const tok of tokens) {
      const span = document.createElement('span');
      if (tok.type === 'sprite') {
        const num = Number(tok.value.match(/\d+/)[0]);
        span.textContent = spriteEmoji(num);
        span.title = tok.value;
      } else {
        span.textContent = tok.value;
        if (tok.value !== ' ' || !s.skipSpaces) {
          if (s.colorMode === 'solid') {
            const aa = (s.solidAlpha ?? 255) < 255 ? alphaHex(s.solidAlpha) : '';
            span.style.color = s.solidColor + aa;
          }
          else if (s.colorMode === 'gradient' && n > 0 && tok.value !== ' ') {
            const t = n === 1 ? 0 : i / (n - 1);
            span.style.color = gradientAt(s.stops, t);
          }
        }
        // Per-span decoration: applied here (not on the parent) so it
        // survives rotate transforms and inherits each glyph's own color.
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
          i++;
        }
      }
      if (!s.waveOn && s.rotateDeg !== 0) {
        span.style.display = 'inline-block';
        span.style.transform = `rotate(${s.rotateDeg}deg)`;
      }
      nameLine.appendChild(span);
    }
    wrap.appendChild(nameLine);

    if (s.titleOn && s.titleText.trim()) {
      const titleLine = document.createElement('div');
      titleLine.className = 'rgnf-preview-title';
      titleLine.style.fontSize = `${Math.max(7, 18 * s.titleSizePct / 100)}px`;
      if (s.titleSub) titleLine.style.verticalAlign = 'sub';
      if (s.titleBold) titleLine.style.fontWeight = '700';
      if (s.titleItalic) titleLine.style.fontStyle = 'italic';
      const titleDeco = [];
      if (s.titleUnderline) titleDeco.push('underline');
      if (s.titleStrike) titleDeco.push('line-through');
      if (titleDeco.length) titleLine.style.textDecorationLine = titleDeco.join(' ');
      if (s.titleColorMode === 'solid') {
        titleLine.textContent = s.titleText;
        // Match TMP 8-digit hex: append alpha byte when < 255 (browsers accept it).
        const aa = (s.titleAlpha ?? 255) < 255 ? alphaHex(s.titleAlpha) : '';
        titleLine.style.color = s.titleColor + aa;
      } else if (s.titleColorMode === 'gradient') {
        // Fix: use s.titleStops (not s.stops -- that was the name\'s palette
        // leaking through). Apply titleAlpha across every letter for gradient
        // transparency parity with solid mode.
        const chars = [...s.titleText];
        const paint = chars.filter(c => c !== ' ').length;
        const aa = (s.titleAlpha ?? 255) < 255 ? alphaHex(s.titleAlpha) : '';
        let j = 0;
        for (const c of chars) {
          const sp = document.createElement('span');
          sp.textContent = c;
          if (c !== ' ') {
            sp.style.color = gradientAt(s.titleStops, paint === 1 ? 0 : j / (paint - 1)) + aa;
            j++;
          }
          titleLine.appendChild(sp);
        }
      } else {
        titleLine.textContent = s.titleText;
      }
      wrap.appendChild(titleLine);
    }

    // Simulated Scored! suffix
    const scored = document.createElement('span');
    scored.className = 'rgnf-preview-scored';
    scored.textContent = ' Scored!';
    switch (s.scoredMode) {
      case 'hide': scored.style.display = 'none'; break;
      case 'tiny': scored.style.fontSize = '6px'; scored.style.verticalAlign = 'sub'; break;
      case 'styled':
        scored.style.color = s.scoredColor;
        scored.style.fontSize = `${Math.max(6, 14 * s.scoredSizePct / 100)}px`;
        break;
      default: scored.style.color = '#cbd5e1'; break;
    }
    nameLine.appendChild(scored);

    return wrap;
  }

  // ------------------------------------------------------------------
  // Auth: fresh Firebase ID token (SDK first, IndexedDB fallback + refresh)
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

    // 3) Token expired — refresh it
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
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Bearer ' + token,
      },
      body: new URLSearchParams({ nickname: code }),
    });
    const body = await res.text();
    return { ok: res.ok && body.trim() === 'true', status: res.status, body };
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
      /* Base: block that fills its container. The fly-out fixed positioning
         and 360px width come from .rgnf-open below, so the panel is fine to
         embed inside the HUD's Forge tab without any width-fighting. */
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
      min-height: 56px; display: flex; align-items: center; justify-content: center;
      /* Sticky: pins to the top of the scrolling tab container. Placed as a
         direct child of the panel (not nested inside secPreview) so its
         parent extent is the full scrollable body -- otherwise sticky would
         unmoor the moment secPreview's shorter box scrolled past. */
      position: sticky; top: 0; z-index: 5;
      box-shadow: 0 6px 8px -6px rgba(0,0,0,0.6);
      margin-bottom: 8px;
    }
    .rgnf-preview-name { font-size: 18px; font-weight: 400; word-break: break-word; }
    .rgnf-preview-title { margin-top: 2px; }
    .rgnf-code {
      margin-top: 8px; background: var(--rgnf-panel); border: 1px solid var(--rgnf-line);
      border-radius: 8px; padding: 8px; font: 11px/1.5 ui-monospace, Menlo, Consolas, monospace;
      color: #9fb3ff; word-break: break-all; max-height: 90px; overflow-y: auto; user-select: all;
    }
    .rgnf-meta { display: flex; justify-content: space-between; color: var(--rgnf-muted); font-size: 11px; margin-top: 4px; }
    .rgnf-btn {
      border: none; border-radius: 10px; padding: 9px 12px; font-weight: 700; cursor: pointer; font-size: 13px;
      min-width: 0; /* let flex children shrink below their content width */
    }
    .rgnf-btn-apply {
      flex: 1; color: #06121a;
      background: linear-gradient(90deg, var(--rgnf-accent), var(--rgnf-accent-2));
    }
    .rgnf-btn-ghost { background: var(--rgnf-panel); color: var(--rgnf-text); border: 1px solid var(--rgnf-line); flex-shrink: 0; }
    /* Rows wrap when the panel is embedded narrow; keeps buttons on-screen. */
    .rgnf-row { flex-wrap: wrap; }
    .rgnf-status { margin-top: 8px; font-size: 12px; min-height: 16px; }
    .rgnf-status.ok { color: #34d399; }
    .rgnf-status.err { color: #f87171; }
    .rgnf-presets { display: flex; flex-direction: column; gap: 6px; }
    .rgnf-preset { display: flex; align-items: center; gap: 6px; }
    .rgnf-preset span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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

  function buildUI() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const fab = el('button', { class: 'rgnf-fab', title: 'Name Forge (Alt+N) — drag to move', text: '??' });
    const panel = el('div', { class: 'rgnf-panel' });


    // Restore saved FAB position (stored as left/top in px)
    const savedPos = loadJSON(FABPOS_KEY, null);
    if (savedPos && typeof savedPos.left === 'number' && typeof savedPos.top === 'number') {
      applyFabPos(fab, savedPos.left, savedPos.top);
    }

    // Keep the FAB on-screen if the window was resized smaller since last visit
    window.addEventListener('resize', () => clampFab(fab));

    makeFabDraggable(fab, panel);

    fab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanel(fab, panel); }
    });

    window.addEventListener('keydown', (e) => {
      if (e.altKey && e.code === 'KeyN' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
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

  // Position the panel next to the FAB, flipping sides/vertical as needed to stay on-screen
  function positionPanel(fab, panel) {
    const f = fab.getBoundingClientRect();
    const gap = 12;
    const pw = 360; // matches CSS width
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    // Horizontal: prefer left-aligned with FAB, flip left if it would overflow right edge
    let left = f.left;
    if (left + pw > window.innerWidth - 8) left = Math.max(8, f.right - pw);
    // Vertical: prefer opening upward from the FAB; if not enough room, open downward
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
    // If still anchored via right/bottom (never moved), leave it alone
    if (fab.style.left === '' || fab.style.left === 'auto') return;
    const maxLeft = window.innerWidth - r.width - 6;
    const maxTop = window.innerHeight - r.height - 6;
    const left = Math.max(6, Math.min(r.left, maxLeft));
    const top = Math.max(6, Math.min(r.top, maxTop));
    applyFabPos(fab, left, top);
  }

  function makeFabDraggable(fab, panel) {
    let sx, sy, ox, oy, dragging = false, moved = false;
    const DRAG_THRESHOLD = 4; // px before a press counts as a drag not a click

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


  // Render raw TMP-style nickname markup into DOM for the preview. Handles
  // the tags Rocket Goal names actually use: <#RRGGBB>/<#RRGGBBAA> colors,
  // <b> <i> <sub> (open/close), <size=N%>, <rotate=N>, <mark=#hex>, <br>,
  // <sprite=N> (shown via the SPRITES emoji map). Unknown tags are skipped
  // so preview shows the intent, never literal angle-bracket soup.
  function renderRawTMP(raw) {
    const root = document.createElement('div');
    root.style.lineHeight = '1.35';
    const st = { color: null, bold: false, italic: false, sub: false, sizePct: 100, rotate: 0, mark: null };
    let line = document.createElement('div');
    root.appendChild(line);
    let i = 0;
    const spriteEmoji = n => (SPRITES.find(x => x.n === n) || {}).e || '❔';
    while (i < raw.length) {
      const rest = raw.slice(i);
      let m;
      if ((m = rest.match(/^<br\s*\/?\s*>/i))) { line = document.createElement('div'); root.appendChild(line); i += m[0].length; continue; }
      if ((m = rest.match(/^<(#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?)>/))) { st.color = m[1]; i += m[0].length; continue; }
      if ((m = rest.match(/^<b>/i)))   { st.bold = true;  i += m[0].length; continue; }
      if ((m = rest.match(/^<\/b>/i))) { st.bold = false; i += m[0].length; continue; }
      if ((m = rest.match(/^<i>/i)))   { st.italic = true;  i += m[0].length; continue; }
      if ((m = rest.match(/^<\/i>/i))) { st.italic = false; i += m[0].length; continue; }
      if ((m = rest.match(/^<sub>/i)))   { st.sub = true;  i += m[0].length; continue; }
      if ((m = rest.match(/^<\/sub>/i))) { st.sub = false; i += m[0].length; continue; }
      if ((m = rest.match(/^<size=(\d+)%?>/i))) { st.sizePct = Number(m[1]) || 100; i += m[0].length; continue; }
      if ((m = rest.match(/^<\/size>/i))) { st.sizePct = 100; i += m[0].length; continue; }
      if ((m = rest.match(/^<rotate=(-?\d+)>/i))) { st.rotate = Number(m[1]) || 0; i += m[0].length; continue; }
      if ((m = rest.match(/^<mark=(#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?)>/i))) { st.mark = m[1]; i += m[0].length; continue; }
      if ((m = rest.match(/^<\/mark>/i))) { st.mark = null; i += m[0].length; continue; }
      if ((m = rest.match(/^<sprite=(\d+)>/i))) {
        const sp = document.createElement('span');
        sp.textContent = spriteEmoji(Number(m[1]));
        line.appendChild(sp); i += m[0].length; continue;
      }
      if ((m = rest.match(/^<[^>]*>/))) { i += m[0].length; continue; } // unknown tag: skip
      const ch = raw[i];
      const span = document.createElement('span');
      span.textContent = ch;
      if (st.color) span.style.color = st.color;
      if (st.bold) span.style.fontWeight = '700';
      if (st.italic) span.style.fontStyle = 'italic';
      if (st.mark) span.style.background = st.mark;
      let size = 18 * (st.sizePct / 100);
      if (st.sub) { size *= 0.65; span.style.verticalAlign = 'sub'; }
      span.style.fontSize = Math.max(7, size) + 'px';
      if (st.rotate) { span.style.display = 'inline-block'; span.style.transform = 'rotate(' + st.rotate + 'deg)'; }
      line.appendChild(span);
      i++;
    }
    return root;
  }

  function render(panel) {
    panel.innerHTML = '';
    saveJSON(stateKey(), state);

    // ---- Header (draggable in fly-out mode; inert inside HUD tab) ----
    // The ✕ close button was removed when Forge became a HUD tab: closing is
    // now done by clicking the 🎨 header icon again, matching Clans/Settings.
    const head = el('div', { class: 'rgnf-head' }, [
      el('b', { text: 'Name Forge' }),
    ]);
    makeDraggable(panel, head);
    panel.appendChild(head);

    // Touch-to-exit for raw mode: attached once to the panel (persists across
    // innerHTML rebuilds). Fires ONLY on genuine user interaction -- pointer
    // or key -- never programmatically, which is what made the old timer
    // heuristic dangerous. Interacting with any styling control clears the
    // raw snapshot so the control's own handler proceeds against rebuild
    // state; the mode bar is removed inline so there's no stale banner and
    // no focus-stealing re-render mid-interaction.
    if (!panel._rgnfRawExitWired) {
      panel._rgnfRawExitWired = true;
      const exitRawIfStylingTouch = (e) => {
        if (!state.rawCode) return;
        const t = e.target;
        if (!t || !t.closest) return;
        if (t.closest('.rgnf-modebar') || t.closest('.rgnf-actions-sec')
            || t.closest('.rgnf-preview-sec') || t.closest('.rgnf-preview')
            || t.closest('.rgnf-head')) return;
        state.rawCode = null;
        saveJSON(stateKey(), state);
        const bar = panel.querySelector('.rgnf-modebar');
        if (bar) bar.remove();
      };
      panel.addEventListener('pointerdown', exitRawIfStylingTouch, true);
      panel.addEventListener('keydown', exitRawIfStylingTouch, true);
    }

    // ---- Preview + code ----
    // The rendered preview BOX is appended directly to the panel (Forge's
    // outer container) rather than nested inside secPreview, because CSS
    // sticky only holds while the PARENT is in the viewport. Nested inside
    // secPreview it would let go the moment the code block scrolled the
    // section past. Appended directly to the panel, its parent is the entire
    // scrollable tab -- so it stays pinned no matter how far you scroll.
    // The section header/code/meta stay in secPreview and scroll normally.
    const pv = el('div', { class: 'rgnf-preview' });
    pv.appendChild(renderPreview(state));
    panel.appendChild(pv);

    const secPreview = el('div', { class: 'rgnf-sec rgnf-preview-sec' });
    // Header row: "Preview" label + a minimal ↺ reset icon that reloads the
    // player's exact current in-game name (markup, colors, everything). No
    // banner, no block -- just the one small escape hatch, always available.
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
          onclick: () => { state.rawCode = _lastRawNickname; render(panel); },
        }));
      }
      secPreview.appendChild(hrow);
    }
    const codeDiv = el('div', { class: 'rgnf-code', text: buildCode(state) });
    secPreview.appendChild(codeDiv);
    // Editable raw markup box: shown instead of the readonly code div while
    // raw mode is active. Direct edits to the markup update the preview live
    // -- this is how minor surgical edits to complex names happen (e.g.
    // deleting the [TAG] chunk) without rebuilding the whole design.
    const rawEdit = el('textarea', { class: 'rgnf-code' });
    rawEdit.style.cssText = 'display:none;width:100%;box-sizing:border-box;min-height:90px;resize:vertical;background:var(--rgnf-panel);border:1px solid var(--rgnf-line);border-radius:8px;padding:8px;font:11px/1.5 ui-monospace, Menlo, Consolas, monospace;color:#9fb3ff;';
    rawEdit.addEventListener('input', () => {
      state.rawCode = rawEdit.value;
      const rawPfx = _prefix();
      pv.replaceChildren(renderRawTMP(rawPfx + state.rawCode));
      charSpan.textContent = `${(rawPfx + state.rawCode).length} chars`;
      const plainLetters = state.rawCode.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
      letterSpan.textContent = `${[...plainLetters].length} letters`;
      saveJSON(stateKey(), state);
    });
    secPreview.appendChild(rawEdit);
    const charSpan = el('span', { text: '' });
    const letterSpan = el('span', { text: '' });
    secPreview.appendChild(el('div', { class: 'rgnf-meta' }, [charSpan, letterSpan]));
    panel.appendChild(secPreview);

    // Update just the preview/code/meta without rebuilding the panel,
    // so the name field keeps focus and cursor position while typing.
    const refreshPreview = () => {
      if (state.rawCode) {
        // Raw mode: the editable box holds the raw name for surgical edits
        // (e.g. deleting an old hardcoded [TAG] chunk). The clan-tag prefix
        // applies HERE TOO -- checkbox on means the tag prepends in every
        // mode, no exceptions (the old raw-mode exclusion made the clan-tag
        // feature silently dead for anyone in raw mode, i.e. everyone).
        // If a raw name still contains its old hardcoded tag, the preview
        // will show it doubled -- the fix is deleting it in the box below.
        const rawPfx = _prefix();
        pv.replaceChildren(renderRawTMP(rawPfx + state.rawCode));
        codeDiv.style.display = 'none';
        rawEdit.style.display = 'block';
        if (rawEdit.value !== state.rawCode) rawEdit.value = state.rawCode;
        charSpan.textContent = `${(rawPfx + state.rawCode).length} chars`;
        const plainLetters = state.rawCode.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
        letterSpan.textContent = `${[...plainLetters].length} letters`;
        saveJSON(stateKey(), state);
        return;
      }
      codeDiv.style.display = 'block';
      rawEdit.style.display = 'none';
      const code = _prefix() + buildCode(state);
      pv.replaceChildren(renderPreview(state));
      codeDiv.textContent = code;
      charSpan.textContent = `${code.length} chars`;
      letterSpan.textContent = `${[...state.name].length} letters`;
      saveJSON(stateKey(), state);
    };
    refreshPreview();

    // ---- Name ----
    const secName = el('div', { class: 'rgnf-sec' });
    secName.appendChild(el('h4', { text: 'Name' }));
    const nameInput = el('input', {
      type: 'text', value: state.name,
      placeholder: 'Type your name…',
      oninput: (e) => { state.name = e.target.value; refreshPreview(); },
    });
    secName.appendChild(el('div', { class: 'rgnf-row' }, [
      nameInput,
      el('button', {
        class: 'rgnf-chip', text: '✕ Clear', title: 'Clear the name field',
        onclick: () => { state.name = ''; nameInput.value = ''; refreshPreview(); nameInput.focus(); },
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
    const modeRow = el('div', { class: 'rgnf-row' });
    ['none', 'solid', 'gradient'].forEach((m) => {
      modeRow.appendChild(el('button', {
        class: `rgnf-chip ${state.colorMode === m ? 'rgnf-on' : ''}`,
        text: m[0].toUpperCase() + m.slice(1),
        onclick: () => { state.colorMode = m; render(panel); },
      }));
    });
    secColor.appendChild(modeRow);

    if (state.colorMode === 'solid') {
      secColor.appendChild(el('div', { class: 'rgnf-row' }, [
        el('label', { text: 'Color' }),
        el('input', { type: 'color', value: state.solidColor, oninput: (e) => { state.solidColor = e.target.value; render(panel); } }),
        el('label', { text: 'Opacity' }, [
          el('input', { type: 'range', min: 32, max: 255, value: state.solidAlpha ?? 255,
            oninput: (e) => { state.solidAlpha = Number(e.target.value); refreshPreview(); },
            style: 'width:80px;margin-left:6px;',
          }),
        ]),
      ]));
    }

    if (state.colorMode === 'gradient') {
      const stopsWrap = el('div', { class: 'rgnf-stops' });
      state.stops.forEach((c, idx) => {
        const stop = el('div', { class: 'rgnf-stop' }, [
          el('input', { type: 'color', value: c, oninput: (e) => { state.stops[idx] = e.target.value; render(panel); } }),
        ]);
        if (state.stops.length > 2) {
          stop.appendChild(el('button', { text: '✕', onclick: () => { state.stops.splice(idx, 1); render(panel); } }));
        }
        stopsWrap.appendChild(stop);
      });
      if (state.stops.length < 5) {
        stopsWrap.appendChild(el('button', {
          class: 'rgnf-chip', text: '+ stop',
          onclick: () => { state.stops.push(state.stops[state.stops.length - 1]); render(panel); },
        }));
      }
      secColor.appendChild(stopsWrap);
      const bar = el('div', { class: 'rgnf-gradbar' });
      bar.style.background = `linear-gradient(90deg, ${state.stops.join(',')})`;
      secColor.appendChild(bar);

      // One-click palettes + tools
      const palRow = el('div', { class: 'rgnf-row' });
      PALETTES.forEach((p) => {
        palRow.appendChild(el('button', {
          class: 'rgnf-chip', text: p.label, title: p.stops.join(' → '),
          onclick: () => { state.stops = [...p.stops]; render(panel); },
        }));
      });
      palRow.appendChild(el('button', {
        class: 'rgnf-chip', text: '⇄ Reverse', title: 'Flip gradient direction',
        onclick: () => { state.stops.reverse(); render(panel); },
      }));
      palRow.appendChild(el('button', {
        class: 'rgnf-chip', text: '🎲 Random', title: 'Roll a random vivid gradient',
        onclick: () => { state.stops = randomStops(); render(panel); },
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

    secStyle.appendChild(sliderRow(panel, 'Size', 'sizePct', 25, 200, '%'));
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
      // Text input
      secTitle.appendChild(el('div', { class: 'rgnf-row' }, [
        el('input', { type: 'text', placeholder: 'e.g. RGC FINALIST', value: state.titleText, oninput: (e) => { state.titleText = e.target.value; refreshPreview(); } }),
      ]));
      // Color mode
      const tm = el('div', { class: 'rgnf-row' });
      [['inherit', 'Inherit'], ['solid', 'Solid'], ['gradient', 'Gradient']].forEach(([v, label]) => {
        tm.appendChild(el('button', {
          class: `rgnf-chip ${state.titleColorMode === v ? 'rgnf-on' : ''}`, text: label,
          onclick: () => { state.titleColorMode = v; render(panel); },
        }));
      });
      secTitle.appendChild(tm);
      // Solid: color picker (opacity moved below so it also applies to gradient)
      if (state.titleColorMode === 'solid') {
        secTitle.appendChild(el('div', { class: 'rgnf-row' }, [
          el('input', { type: 'color', value: state.titleColor, oninput: (e) => { state.titleColor = e.target.value; refreshPreview(); } }),
        ]));
      }
      // Gradient: own palette chips + own editable stops (mirrors Name gradient)
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
              state.titlePaletteKey = null; // hand-edited: no longer a preset
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
      // Size + Sub
      // Opacity: applies to solid AND gradient title colors (via 8-digit hex).
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
      // Size: cap raised to 180% so titles can go bigger than the name if the
      // player wants a headline-style tagline.
      secTitle.appendChild(sliderRow(panel, 'Size', 'titleSizePct', 25, 180, '%'));
      // Style toggles: Bold/Italic/Underline/Strike + <sub> layout toggle
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

    // ---- Scored! ----
    const secScored = el('div', { class: 'rgnf-sec' });
    secScored.appendChild(el('h4', { text: '"Scored!" text' }));
    const sRow = el('div', { class: 'rgnf-row' });
    [['default', 'Default'], ['hide', 'Hide'], ['tiny', 'Tiny'], ['styled', 'Styled']].forEach(([v, label]) => {
      sRow.appendChild(el('button', {
        class: `rgnf-chip ${state.scoredMode === v ? 'rgnf-on' : ''}`, text: label,
        onclick: () => { state.scoredMode = v; render(panel); },
      }));
    });
    secScored.appendChild(sRow);
    if (state.scoredMode === 'styled') {
      secScored.appendChild(el('div', { class: 'rgnf-row' }, [
        el('label', { text: 'Color' }),
        el('input', { type: 'color', value: state.scoredColor, oninput: (e) => { state.scoredColor = e.target.value; render(panel); } }),
      ]));
      secScored.appendChild(sliderRow(panel, 'Size', 'scoredSizePct', 25, 150, '%'));
    }
    panel.appendChild(secScored);

    // ---- Presets ----
    const secPresets = el('div', { class: 'rgnf-sec' });
    secPresets.appendChild(el('h4', { text: 'Presets' }));
    const presets = loadJSON(STORE_KEY, []);
    const listWrap = el('div', { class: 'rgnf-presets' });
    presets.forEach((p, idx) => {
      listWrap.appendChild(el('div', { class: 'rgnf-preset' }, [
        el('span', { text: p.label }),
        el('button', { class: 'rgnf-chip', text: 'Load', onclick: () => { state = Object.assign(defaultState(), p.state); render(panel); } }),
        el('button', {
          class: 'rgnf-chip', text: '??',
          onclick: () => { presets.splice(idx, 1); saveJSON(STORE_KEY, presets); render(panel); },
        }),
      ]));
    });
    listWrap.appendChild(el('button', {
      class: 'rgnf-chip', text: '+ Save current as preset',
      onclick: () => {
        const label = prompt('Preset name:', state.name.replace(/<[^>]*>/g, '').slice(0, 30) || 'Preset');
        if (!label) return;
        presets.push({ label, state: JSON.parse(JSON.stringify(state)) });
        saveJSON(STORE_KEY, presets);
        render(panel);
      },
    }));
    secPresets.appendChild(listWrap);

    // Share presets with the squad
    secPresets.appendChild(el('div', { class: 'rgnf-row' }, [
      el('button', {
        class: 'rgnf-chip', text: '📤 Export', title: 'Copy all presets as JSON to share',
        onclick: async (e) => {
          const b = e.currentTarget;
          try {
            await navigator.clipboard.writeText(JSON.stringify(presets));
            b.textContent = 'Copied ✓';
          } catch (err) { b.textContent = 'Failed'; }
          setTimeout(() => { b.textContent = '📤 Export'; }, 1200);
        },
      }),
      el('button', {
        class: 'rgnf-chip', text: '📥 Import', title: 'Paste preset JSON from a friend',
        onclick: () => {
          const raw = prompt('Paste preset JSON:');
          if (!raw) return;
          try {
            const incoming = JSON.parse(raw);
            if (!Array.isArray(incoming)) throw new Error('not an array');
            const merged = presets.concat(incoming.filter(p => p && p.label && p.state));
            saveJSON(STORE_KEY, merged);
            render(panel);
          } catch (err) {
            alert('That JSON was as valid as a screen-door submarine. Import failed.');
          }
        },
      }),
    ]));

    // Recently applied history
    const hist = loadJSON(HISTORY_KEY, []);
    if (hist.length) {
      secPresets.appendChild(el('h4', { text: 'Recently applied' }));
      const histWrap = el('div', { class: 'rgnf-presets' });
      hist.forEach((h) => {
        histWrap.appendChild(el('div', { class: 'rgnf-preset' }, [
          el('span', { text: h.plain, title: h.code }),
          el('button', {
            class: 'rgnf-chip', text: 'Re-apply',
            onclick: async (e) => {
              const b = e.currentTarget;
              b.textContent = '…';
              try {
                const r = await applyNickname(h.code);
                b.textContent = r.ok ? '✓' : '✗';
              } catch (err) { b.textContent = '✗'; }
              setTimeout(() => { b.textContent = 'Re-apply'; }, 1500);
            },
          }),
        ]));
      });
      histWrap.appendChild(el('button', {
        class: 'rgnf-chip', text: 'Clear history',
        onclick: () => { saveJSON(HISTORY_KEY, []); render(panel); },
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
          const codeApplied = _prefix() + (state.rawCode ? state.rawCode : buildCode(state));
          _lastRawNickname = codeApplied; // Reset now returns to what was just applied
          const result = await applyNickname(codeApplied);
          if (result.ok) {
            statusLine.className = 'rgnf-status ok';
            statusLine.textContent = '✓ Nickname updated';
            const hist = loadJSON(HISTORY_KEY, []);
            const plain = state.name.replace(/<[^>]*>/g, '').slice(0, 24) || '(sprites only)';
            hist.unshift({ code: codeApplied, plain, ts: Date.now() });
            saveJSON(HISTORY_KEY, hist.slice(0, 5));
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
          await navigator.clipboard.writeText(_prefix() + (state.rawCode ? state.rawCode : buildCode(state)));
          copyBtn.textContent = 'Copied ✓';
          setTimeout(() => { copyBtn.textContent = 'Copy code'; }, 1200);
        } catch (e) {
          copyBtn.textContent = 'Copy failed';
          setTimeout(() => { copyBtn.textContent = 'Copy code'; }, 1200);
        }
      },
    });
    secActions.appendChild(el('div', { class: 'rgnf-row' }, [applyBtn, copyBtn]));
    secActions.appendChild(statusLine);
    panel.appendChild(secActions);
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
  // Input capture guard — MUST register before the game's own handlers.
  // rocketgoal.io binds control keys at the window CAPTURE phase and
  // preventDefault()s them, which kills typing in our fields. Because same-phase
  // listeners fire in registration order, we run at document-start and register
  // FIRST, then stopImmediatePropagation for any event aimed at our UI so the
  // game never sees it. stopImmediatePropagation does NOT preventDefault, so the
  // character still lands in the input.
  // ------------------------------------------------------------------
  function installInputGuard() {
    const inUI = (t) => t && t.closest && (t.closest('.rgnf-panel') || t.closest('.rgnf-fab'));
    const isTextField = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');

    // Primary handler: we take over editing entirely for our own text fields.
    // The game cancels the browser's default text insertion, so instead of
    // fighting for it, we mutate the field's value ourselves and fire a synthetic
    // 'input' event. This works no matter what the game does with the keystroke.
    window.addEventListener('keydown', (e) => {
      const t = e.target;
      if (!inUI(t)) return;
      if (e.altKey && e.code === 'KeyN') return; // let the global toggle through

      // Always hide the event from the game's global handlers.
      e.stopImmediatePropagation();

      if (!isTextField(t) || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;

      const start = t.selectionStart ?? t.value.length;
      const end = t.selectionEnd ?? t.value.length;
      let handled = false;

      if (e.key.length === 1) {
        // printable character (already shifted/cased by the browser)
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
      // Arrows / Home / End / Tab etc. fall through: we already stopped the game
      // from seeing them, and the browser's own caret movement still works.

      if (handled) {
        e.preventDefault();
        t.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, true);

    // Keep keyup/keypress away from the game too.
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
  // Boot
  // ------------------------------------------------------------------
  installInputGuard(); // register immediately at document-start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUI);
  } else {
    buildUI();
  }
      let _mountedIn = null;
      // External prefix provider: HUD sets this to getClanTagPrefix. Called
      // by buildCode()/renderPreview() so Forge stays clan-agnostic.
      let _prefixProvider = null;
      function _prefix() { try { return _prefixProvider ? _prefixProvider() : ""; } catch { return ""; } }
      return {
        setPrefixProvider(fn) { _prefixProvider = fn; },
        // Re-render the Forge panel in place (e.g. after the clan-tag opt-in
        // toggles, so the prefix appears/disappears in the preview live).
        refresh() { if (_rgnfPanel) render(_rgnfPanel); },
        // Called by HUD when Forge opens (or when the player switches accounts).
        // Two paths:
        //   1. Per-account state exists -> honor completely. This player has
        //      already customized Forge under this account; whatever they
        //      typed is their intent, don\'t clobber it.
        //   2. No per-account state -> fresh seed. Copy STYLING from the
        //      legacy shared state if it exists (so the visual design carries
        //      over the first time), but ALWAYS use the current account\'s
        //      displayName for state.name -- never inherit another account\'s
        //      name text. This is the fix for cross-account name leakage.
        syncToCurrentPlayer(userId, displayName, rawNickname) {
          if (!userId) return;
          if (rawNickname) _lastRawNickname = String(rawNickname);
          const prevId = _currentUserId;
          _currentUserId = userId;
          if (prevId === userId) return;
          const perUser = loadJSON(stateKey(), null);
          if (perUser) {
            state = Object.assign(defaultState(), perUser);
          } else {
            // TRULY fresh seed: the player's WHOLE current in-game name,
            // exactly as the game returns it, loaded as a raw snapshot.
            // Preview shows it faithfully, Apply is a no-op round-trip, and
            // the first styling edit clears the snapshot to rebuild from
            // scratch. state.name gets the full plain-text letters (all
            // lines, tags stripped) as the rebuild starting point.
            state = defaultState();
            const raw = String(rawNickname || "").trim();
            if (raw) {
              state.rawCode = raw;
              state.name = raw.replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
            } else {
              state.name = String(displayName || "").trim();
            }
            saveJSON(stateKey(), state);
          }

          // CRITICAL: re-render immediately and unconditionally. The panel DOM
          // exists from page load whether or not it has been re-parented into
          // the HUD tab yet -- and sync runs BEFORE mountIn on first open, so
          // gating this render on _mountedIn meant the swapped state never
          // reached the screen. That gate was the bug behind two failed fixes:
          // the seed logic worked, the pixels didn't.
          if (_rgnfPanel) render(_rgnfPanel);
        },
        // Re-parent Forge's panel into the HUD's rgForgeView on first open.
        // Everything Forge does (render, presets, keyboard guard, apply)
        // keeps working once its DOM tree is under a different parent.
        mountIn(container) {
          if (!_rgnfPanel || _mountedIn === container) return;
          // Reset absolute-positioning styles from the fly-out design so the
          // panel flows naturally inside the HUD tab body. The scroll now lives
          // on the parent container (rgForgeView), so the panel itself is a
          // simple block with tightened padding and no border/shadow that would
          // clash with the HUD's own frame.
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
          container.appendChild(_rgnfPanel);
          _mountedIn = container;
        },
      };
    })();

})();
