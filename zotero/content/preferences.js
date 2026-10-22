/* global Zotero */
// Second Brain's settings pane (Zotero Settings → Second Brain). The pane is the shared SettingsView (ui/src/settings,
// spec 016): the same table of rows Obsidian and the web app draw. This file supplies what only Zotero has: where its
// values are stored, the colours, the key test and the server check. The server address and access token
// (extensions.secondbrain.server / .token) are plain rows of that table.

var SecondBrainPrefs = {
	COLORS: [
		["background", "Writing background"],
		["text", "Text"],
		["accent", "Links, cursor and focus ring"],
		["highlight", "Highlighted text (==…==)"],
	],
	DEFAULT_SERVER: "http://127.0.0.1:27182",

	pref(name) { return Zotero.Prefs.get(`extensions.secondbrain.${name}`, true); },
	set(name, value) {
		if (value === "" || value === undefined) Zotero.Prefs.clear(`extensions.secondbrain.${name}`, true);
		else Zotero.Prefs.set(`extensions.secondbrain.${name}`, value, true);
	},

	init(root) {
		const doc = root.ownerDocument;
		const mount = doc.getElementById("sb-settings");
		const sb = Zotero.SecondBrain;
		if (!sb?.UI) { mount.textContent = "Second Brain isn't loaded."; return null; }
		return this.mount(doc, mount, sb);
	},

	/** Draws the shared Settings into `mount`. `sb` is Zotero.SecondBrain (or a stand-in with ai(), as the harness test uses). */
	mount(doc, mount, sb) {
		sb.addUiStyles(doc, sb.rootURI);
		const base = sb.createZoteroHost(sb, doc.defaultView, { placement: "tab" });
		const self = this;
		const host = {
			...base,
			prefs: {
				get: (key) => base.prefs.get(key),
				set(key, value) {
					// the server address is kept without a trailing slash, as second-brain.js reads it; the token without spaces
					const clean = typeof value !== "string" ? value : key === "server" ? value.trim().replace(/\/+$/, "") : key === "token" ? value.trim() : value;
					self.set(key, clean);
				},
			},
		};
		return sb.UI.SettingsView(host, doc, mount, {
			renderers: {
				zoteroColors: (_row, ctx) => this.colors(ctx.doc),
				version: (_row, ctx) => { const el = ctx.doc.createElementNS("http://www.w3.org/1999/xhtml", "span"); el.textContent = sb.version ?? ""; return el; },
			},
			actions: {
				testKeys: (_row, say) => this.testKeys(say),
				checkUpdates: async (_row, say) => {
					say("Checking…");
					return sb.updater ? sb.updater.checkNow() : "Second Brain isn't loaded";
				},
			},
			onChange: (row) => { if (row.key === "server" || row.key === "token") void this.check().then((text) => host.notice(`Server: ${text}`)); },
		});
	},

	/** One colour per writing-space setting, each with "Use Zotero's" to go back. */
	colors(doc) {
		const html = (tag, props = {}) => Object.assign(doc.createElementNS("http://www.w3.org/1999/xhtml", tag), props);
		const grid = html("div", { className: "sb-pref-colors" });
		for (const [name, label] of this.COLORS) {
			const key = `color.${name}`;
			const input = html("input", { type: "color", value: this.pref(key) || this.zoteroColor(doc, name) });
			const reset = html("button", { type: "button", textContent: "Use Zotero's" });
			const mark = () => { reset.disabled = !this.pref(key); input.classList.toggle("is-default", !this.pref(key)); };
			input.addEventListener("input", () => { this.set(key, input.value); mark(); });
			reset.addEventListener("click", () => { this.set(key, ""); input.value = this.zoteroColor(doc, name); mark(); });
			mark();
			grid.append(html("label", { textContent: label }), input, reset);
		}
		return grid;
	},

	/** A color input can't be empty, so it starts at the color Zotero is using right now. */
	zoteroColor(doc, name) {
		const style = doc.defaultView.getComputedStyle(doc.documentElement);
		const raw = {
			background: style.getPropertyValue("--material-background"),
			text: style.color,
			accent: style.getPropertyValue("--color-accent") || style.getPropertyValue("--accent-blue"),
			highlight: "#ffd400",
		}[name].trim();
		const probe = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
		probe.style.color = raw;
		doc.documentElement.append(probe);
		const rgb = doc.defaultView.getComputedStyle(probe).color.match(/\d+(\.\d+)?/g)?.slice(0, 3).map(Number) ?? [128, 128, 128];
		probe.remove();
		return "#" + rgb.map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
	},

	/** One lookup of a known open-access paper on each service, so a wrong key shows up here and not mid-run. The keys
	 *  are already saved: the shared rows write on change. Returns the line the Test keys row shows. */
	async testKeys(say) {
		const sb = Zotero.SecondBrain;
		const doi = "10.1038/nature12373";
		const probe = async (url) => {
			const response = await Zotero.HTTP.request("GET", url, { timeout: 15000, successCodes: false, responseType: "json" });
			if (response.status === 200) return "works ✓";
			return response.response?.message || response.response?.error || (response.status ? `HTTP ${response.status}` : "no connection");
		};
		say("Checking…");
		const unpaywall = sb.unpaywallAuth()
			? await probe(`https://api.unpaywall.org/v2/${doi}?${sb.unpaywallAuth()}`)
			: "add a key or an email";
		const openalex = await probe(`https://api.openalex.org/works/doi:${doi}?select=id${sb.openAlexAuth("&")}`);
		let s2 = "no key";
		if (this.pref("semanticScholarKey")) {
			const response = await Zotero.HTTP.request("GET", `https://api.semanticscholar.org/graph/v1/paper/DOI:${doi}?fields=title`,
				{ timeout: 15000, successCodes: false, headers: { "x-api-key": this.pref("semanticScholarKey") } });
			s2 = response.status === 200 ? "works ✓" : response.status === 403 ? "key not accepted" : `HTTP ${response.status}`;
		}
		return `Unpaywall: ${unpaywall} · OpenAlex: ${this.pref("openalexKey") ? openalex : `${openalex} (no key: small daily limit)`} · Semantic Scholar: ${s2}`;
	},

	/** Pings the Veritas server with the access token, as every other server call sends it. */
	async check() {
		const sb = Zotero.SecondBrain;
		const base = (this.pref("server") || this.DEFAULT_SERVER).replace(/\/+$/, "");
		try {
			const response = await Zotero.HTTP.request("GET", `${base}/ping`, { headers: sb?.serverHeaders ? sb.serverHeaders() : {}, timeout: 3000, successCodes: false });
			return response.status === 200 ? "Connected ✓"
				: response.status === 401 ? "The server did not accept the access token"
				: response.status ? `Not available (HTTP ${response.status})` : "Veritas server is not running";
		} catch (error) {
			return "Veritas server is not running";
		}
	},
};

// Zotero may load this script before or after it inserts the pane, so set up whenever both are there.
(function setUp(tries = 0) {
	const root = document.getElementById("second-brain-prefs");
	if (root && !root.dataset.ready) {
		root.dataset.ready = "1";
		SecondBrainPrefs.init(root);
	} else if (!root && tries < 100) {
		setTimeout(() => setUp(tries + 1), 100);
	}
})();
