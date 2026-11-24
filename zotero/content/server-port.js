/* global SecondBrain */
// Loaded into bootstrap.js's scope after second-brain.js. How the plugin finds the Veritas desktop app's server.
// The app runs its server on 27182 when that port is free, else on any free one, and writes the port it took to
// `server-port` in its data folder (app/src-tauri/src/server.rs). The plugin reads that file, checks that a server
// answers there, and uses it unless the user chose a server in the plugin's settings.

SecondBrain.ServerPort = {
	APP_ID: "io.github.frimpsjoek.veritas",
	USUAL: "http://127.0.0.1:27182",

	/** The port file's path. `os` is "mac", "win" or "linux"; `home`, `appData` (Windows' Roaming folder) and
	 *  `xdgData` ($XDG_DATA_HOME) are this computer's folders, as Tauri's app_data_dir picks them. */
	file({ os, home, appData, xdgData }) {
		if (os === "win") return `${appData}\\${this.APP_ID}\\server-port`;
		const base = os === "mac" ? `${home}/Library/Application Support` : (xdgData || `${home}/.local/share`);
		return `${base}/${this.APP_ID}/server-port`;
	},

	/** The port in the file's text, or null for anything but a port number. */
	parse(text) {
		const digits = String(text ?? "").trim();
		if (!/^\d{1,5}$/.test(digits)) return null;
		const port = Number(digits);
		return port >= 1 && port <= 65535 ? port : null;
	},

	/** The app's server address, or null when there is no file or nothing answers at its port.
	 *  `read(path)` resolves to the file's text; `ping(url)` resolves true when a Veritas server answers at url. */
	async find({ read, ping, ...where }) {
		let port;
		try {
			port = this.parse(await read(this.file(where)));
		} catch {
			return null;
		}
		if (!port) return null;
		const url = `http://127.0.0.1:${port}`;
		try {
			return (await ping(url)) ? url : null;
		} catch {
			return null;
		}
	},

	/** The address the plugin talks to: the one chosen in its settings, else the app's, else the usual port. */
	address(chosen, found) {
		return String(chosen || found || this.USUAL).replace(/\/+$/, "");
	},
};
