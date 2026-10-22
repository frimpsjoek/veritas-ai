import type SecondBrainSearch from "./main";
import type { Api, NoteRef } from "./api";

/** Obsidian's behaviour on a shared panel Row (ui-src): open, Cmd-click new tab, context menu, drag, hover preview (links.wire) and Enter on the focused row. */
export function wireRow(plugin: SecondBrainSearch, row: HTMLElement, ref: NoteRef, viewType: string, parent: unknown, heading: string | null = null) {
	row.classList.add("is-link");
	row.tabIndex = 0;
	plugin.links.wire(row, ref, viewType, parent, heading);
	row.addEventListener("keydown", (e) => {
		if (e.target === row && e.key === "Enter") plugin.links.open(ref, heading, e.metaKey || e.ctrlKey);
	});
}

/** The shared panels' `fetchJSON` over the plugin's Api: makes sure the server is up first, and keeps ApiError.status for the panels' 404 handling. */
export function panelFetch(api: Api) {
	return async (route: string, params?: Record<string, string | number>, init?: { method?: "GET" | "POST"; body?: unknown }) => {
		if (!(await api.ensure())) throw new Error(api.unreachableMessage());
		const query = params && Object.keys(params).length
			? `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}` : "";
		return api.call(route + query, init?.method, init?.body);
	};
}
