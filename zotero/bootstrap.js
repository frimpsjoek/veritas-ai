/* Second Brain for Zotero: notes on each paper, similar papers and search by meaning, and free-PDF finding.
   A client of the Veritas server (127.0.0.1:27182 by default), like the Obsidian plugin: notes, search and the
   assistant live on the server. */

var SecondBrain;
var chromeHandle;

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
	Services.scriptloader.loadSubScript(rootURI + "content/second-brain.js");
	Services.scriptloader.loadSubScript(rootURI + "content/editor.js");
	Services.scriptloader.loadSubScript(rootURI + "content/store.js");
	Services.scriptloader.loadSubScript(rootURI + "content/discover.js");
	Services.scriptloader.loadSubScript(rootURI + "content/pending-adds.js");
	Services.scriptloader.loadSubScript(rootURI + "content/agent.js");
	Services.scriptloader.loadSubScript(rootURI + "content/agent-host.js");
	Services.scriptloader.loadSubScript(rootURI + "content/updater.js");
	// The shared UI (ui-src/, spec 005 C1): ChatView, FindView, ReportView and the markdown renderer, built by
	// ui-src/build.mjs into the global SecondBrainUI. Loaded before the Zotero host adapter and the shells that
	// need it (chat.js's ChatTab, chat-sidebar.js's ChatSidebar).
	Services.scriptloader.loadSubScript(rootURI + "content/sb-ui.js");
	Services.scriptloader.loadSubScript(rootURI + "content/ui-host-zotero.js");
	Services.scriptloader.loadSubScript(rootURI + "content/chat.js");
	Services.scriptloader.loadSubScript(rootURI + "content/chat-sidebar.js");
	Services.scriptloader.loadSubScript(rootURI + "content/home.js");
	// chrome://second-brain/content/... for the search window
	const aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(Ci.amIAddonManagerStartup);
	const manifestURI = Services.io.newURI(rootURI + "manifest.json");
	chromeHandle = aomStartup.registerChrome(manifestURI, [["content", "second-brain", rootURI + "content/"]]);
	SecondBrain.init({ id, version, rootURI });
	for (const win of Zotero.getMainWindows()) SecondBrain.addToWindow(win);
}

function onMainWindowLoad({ window }) {
	SecondBrain?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	SecondBrain?.removeFromWindow(window);
}

function shutdown() {
	SecondBrain?.shutdown();
	SecondBrain = undefined;
	chromeHandle?.destruct();
	chromeHandle = null;
}
