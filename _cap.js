(function () {
  window._rgBuf = [];
  function stringify(a) {
    if (typeof a === "string") return a;
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }
  function push(kind, args) {
    try {
      var s = Array.prototype.map.call(args, stringify).join(" ");
      window._rgBuf.push("[" + (performance.now() / 1000).toFixed(2) + "s " + kind + "] " + s.slice(0, 1200));
    } catch (e) {}
  }
  var oL = console.log;
  var oW = console.warn;
  var oI = console.info;
  console.log = function () { push("log", arguments); oL.apply(console, arguments); };
  console.warn = function () { push("warn", arguments); oW.apply(console, arguments); };
  console.info = function () { push("info", arguments); oI.apply(console, arguments); };

  window.rgCap = function () {
    var out = window._rgBuf.join("\n");
    var t = document.createElement("textarea");
    t.value = out;
    t.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999999999;background:#000;color:#0f0;font:12px monospace;padding:8px;";
    var c = document.createElement("button");
    c.textContent = "Close";
    c.style.cssText = "position:fixed;top:8px;right:8px;z-index:9999999999;padding:6px 12px;font-size:14px;";
    c.onclick = function () { t.remove(); c.remove(); };
    document.body.appendChild(t);
    document.body.appendChild(c);
    t.focus();
    t.select();
    return "dumped " + window._rgBuf.length + " lines to on-page textarea; Cmd+A, Cmd+C, close, paste to chat";
  };

  window.rgCapReset = function () { window._rgBuf = []; console.log("capture cleared"); };

  console.log("capture armed - do your thing, then run rgCap()");
})();
