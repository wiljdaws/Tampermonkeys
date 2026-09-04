// Loads rocketgoal.io in Playwright's WebKit engine with an iPhone viewport,
// captures console messages, page errors, and every network request.
// Writes a summary to /tmp/rg-webkit-probe.json.

import { webkit, devices } from "playwright";
import { writeFileSync } from "node:fs";

const TARGETS = [
  "https://rocketgoal.io/",
  "https://rocketgoal-proxy.therootedengineer.workers.dev/",
];

const target = process.argv[2] || TARGETS[0];
const waitMs = Number(process.argv[3] || 20000);

const browser = await webkit.launch({ headless: true });
const context = await browser.newContext(devices["iPhone 15"]);
const page = await context.newPage();

const consoleMsgs = [];
const pageErrors = [];
const requests = [];
const responses = [];

page.on("console", msg => {
  consoleMsgs.push({
    type: msg.type(),
    text: msg.text(),
    location: msg.location(),
  });
});
page.on("pageerror", err => {
  pageErrors.push({ name: err.name, message: err.message, stack: err.stack });
});
page.on("request", req => {
  requests.push({ method: req.method(), url: req.url(), resourceType: req.resourceType() });
});
page.on("response", res => {
  responses.push({ status: res.status(), url: res.url() });
});

try {
  await page.goto(target, { waitUntil: "networkidle", timeout: waitMs }).catch(err => {
    consoleMsgs.push({ type: "navigate-error", text: err.message });
  });
} finally {
  await page.waitForTimeout(3000);
  const title = await page.title().catch(() => null);
  const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || "").catch(() => "");

  const summary = {
    target,
    title,
    bodyPreview: bodyText,
    consoleCount: consoleMsgs.length,
    errorCount: pageErrors.length,
    requestCount: requests.length,
    console: consoleMsgs,
    errors: pageErrors,
    requestsByHost: requests.reduce((acc, r) => {
      const host = new URL(r.url).host;
      acc[host] = (acc[host] || 0) + 1;
      return acc;
    }, {}),
    firebaseRequests: requests.filter(r => /firebase|googleapis|identitytoolkit/.test(r.url)).map(r => r.url),
    adNetworkRequests: requests.filter(r => /playgama|doubleclick|googlesyndication|googletagservices|adservice|imasdk|applovin|unityads/.test(r.url)).map(r => r.url),
    failedResponses: responses.filter(r => r.status >= 400).map(r => ({ status: r.status, url: r.url })),
  };
  writeFileSync("/tmp/rg-webkit-probe.json", JSON.stringify(summary, null, 2));
  await browser.close();
  console.log(JSON.stringify({
    target,
    title,
    consoleCount: summary.consoleCount,
    errorCount: summary.errorCount,
    requestCount: summary.requestCount,
    firebaseHits: summary.firebaseRequests.length,
    adHits: summary.adNetworkRequests.length,
    failedResponses: summary.failedResponses.length,
    detailsAt: "/tmp/rg-webkit-probe.json",
  }, null, 2));
}
