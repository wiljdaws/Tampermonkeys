(function () {
  var e = document.getElementById("rgMembersList");
  if (!e) {
    console.log("[ATLAS diag] #rgMembersList not found — open the Clan panel first");
    return "no element";
  }
  var chain = [];
  var cur = e;
  while (cur && cur !== document.documentElement) {
    chain.push({
      tag: cur.tagName,
      id: cur.id || "-",
      cls: (typeof cur.className === "string" ? cur.className : "") || "-",
      inlineDisplay: cur.style.display || "-",
      computedDisplay: getComputedStyle(cur).display,
      offsetH: cur.offsetHeight
    });
    cur = cur.parentElement;
  }
  var out = JSON.stringify(chain, null, 2);
  console.log("--- ATLAS members diag ---\n" + out + "\n--- end ---");
  return out;
})();
