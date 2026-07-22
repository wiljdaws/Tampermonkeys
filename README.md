# Rocket Goal HUD

A live stats overlay for [Rocket Goal](https://rocketgoal.io) — shows your ratings, win rates, and equipped car right in the corner of the screen while you play.

This guide assumes you've never used Tampermonkey before. Just follow the steps in order.

---

## Step 1: Install the Tampermonkey extension

Tampermonkey is a free browser extension that lets you run small scripts (like this one) on websites. You only need to do this once, ever.

Pick your browser below and click the link:

- **Chrome**: [Tampermonkey on the Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- **Edge**: [Tampermonkey on the Edge Add-ons store](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)
- **Firefox**: [Tampermonkey on Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)

Click **Add to Chrome** (or **Add to Edge** / **Add to Firefox**), then confirm by clicking **Add extension** in the popup that appears.

---

## Step 2: Pin the extension so you can see it

1. Click the puzzle-piece icon (🧩) in your browser's toolbar, near the top right.
2. Find **Tampermonkey** in the list.
3. Click the pin icon 📌 next to it.

You should now see a little Tampermonkey icon (two black circles) in your toolbar at all times. This lets you quickly check if the script is running.

---

## Step 3: Turn on Developer Mode (Chrome and Edge only)

Chrome and Edge require an extra step for userscripts to actually work. Skip this step if you're using Firefox.

1. Go to `chrome://extensions` (or `edge://extensions` on Edge) by typing it into your address bar.
2. Look for a toggle labeled **Developer mode** in the top-right corner of the page.
3. Turn it **on**.

Don't worry, this doesn't make your browser less safe. It just allows extensions like Tampermonkey to run scripts you install yourself.

---

## Step 4: Install the Rocket Goal HUD script

1. Click this link: **[Install Rocket Goal HUD](https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/refs/heads/main/rg_hud.user.js)**
2. Tampermonkey will open a new tab showing the script's code and an **Install** button.
3. Click **Install**.

That's it, the script is now installed.

---

## Step 5: Allow the script to actually run on rocketgoal.io

The first time you visit [rocketgoal.io](https://rocketgoal.io) after installing, your browser may show a small popup asking whether to allow Tampermonkey (or the script itself) to run on that site. If you don't approve this, the HUD will silently never appear, with no error message telling you why.

- If you see a popup mentioning **rocketgoal.io** and asking to allow the extension, click **Allow**.
- If you don't see a popup at all, you likely won't need to do anything, some browsers don't ask. Just move on to Step 6 and confirm it's working.

If it still doesn't show up later, there's one more place to check:

1. Right-click the Tampermonkey icon in your toolbar and choose **Manage Extension** (wording may vary slightly by browser).
2. Look for a **Site access** section.
3. Make sure it's set to **On all sites** or specifically includes `rocketgoal.io`, not **On click** or **Restricted**.

---

## Step 6: Turn on frequent auto-updates

This makes sure you automatically get bug fixes and new features as soon as they're pushed, without having to reinstall anything yourself.

1. Click the Tampermonkey icon in your toolbar.
2. Click **Dashboard**.
3. Click the **Settings** tab at the top.
4. Scroll down to the **Userscript Update** section.
5. Set **Check Interval** to **Every 6 Hours**.
6. Check both boxes underneath it:
   - **Automatic installation**
   - **Update disabled scripts**

That's it, Tampermonkey will now silently check every 6 hours and install any updates on its own.

If you ever want to check for an update right now instead of waiting:

1. Tampermonkey icon → **Dashboard**
2. Click the **Utilities** tab at the top
3. Click **Check for userscript updates**

---

## Step 7: Confirm it's working

1. Go to [rocketgoal.io](https://rocketgoal.io) and log in.
2. You should see a small box in the top-right corner labeled **🚀 Rocket Goal HUD**.
3. It'll say "Waiting for data..." for a second, then fill in with your ratings and stats.

If you don't see the box at all:

- Click the Tampermonkey icon — it should show a number badge if a script is active on the current page. If it doesn't, the script may not have installed correctly; try Step 4 again.
- Make sure you only have **one** copy of "Rocket Goal HUD" installed. Go to Tampermonkey Dashboard → Installed Userscripts, and if you see more than one entry with that name, delete all but the newest one (trash can icon on the right).

---

## What the buttons do

- **Hide** — collapses the stats so they're out of the way
- **✏️ Rename** — change the name that shows up on the public leaderboard
- **📺 Sub** — opens the RootedEngineering YouTube channel
- **🏆 Board** — opens the live Rocket Goal leaderboard site
- **🐛 Bug** — report a problem with the script

---

## Found a bug or have a suggestion?

Click the **🐛 Bug** button in the HUD itself, or [open an issue here](https://github.com/wiljdaws/Tampermonkeys/issues/new) directly.
