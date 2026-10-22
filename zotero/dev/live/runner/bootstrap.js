var timer;
function install() {} function uninstall() {}
async function startup() {
  const Q = PathUtils.join(Services.env.get("SB_LIVE_DIR"), "q");
  timer = setInterval(async () => {
    const kids = await IOUtils.getChildren(Q);
    for (const f of kids.filter((p) => p.endsWith(".js")).sort()) {
      const src = await IOUtils.readUTF8(f);
      await IOUtils.remove(f);
      let out;
      try { const AsyncFunction = (async () => {}).constructor; out = await new AsyncFunction("Zotero", "win", src)(Zotero, Zotero.getMainWindow()); }
      catch (e) { out = "ERR " + e + "\n" + e.stack; }
      await IOUtils.writeUTF8(f.replace(/\.js$/, ".out"), typeof out === "string" ? out : JSON.stringify(out, null, 1));
    }
  }, 300);
}
function shutdown() { clearInterval(timer); }
