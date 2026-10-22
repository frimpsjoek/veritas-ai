import { ItemView, WorkspaceLeaf } from "obsidian";
import type SecondBrainSearch from "./main";
import type { Hit } from "./api";
import { IconButton, SearchPanel } from "../../ui/src/index.js";

export const SEARCH_VIEW = "second-brain-search";

// The finer source filter behind "More" (the Papers / Notes pills are the coarse one; spec 005 D2). Every source the
// old dropdown had is still here.
const SOURCES: [string, string][] = [
	["", "Any source"],
	["personal", "My notes"],
	["zotero", "Zotero"],
	["pdf", "PDFs"],
	["image", "Images"],
	["People", "People"],
	["Notion", "Notion"],
	["Clippings", "Clippings"],
	["youtube", "YouTube"],
	["ai_notes", "AI notes"],
];
const HINT = "Search your notes and Zotero library by words or meaning.";

/** The server can't be reached: shown as the status line as it is, without "Search failed:". */
class Unreachable extends Error {}

/** Vault search: the shared SearchPanel (ui-src) with Obsidian's rows wired through `links` (open, new tab, context menu, drag, hover preview). */
export class SearchView extends ItemView {
	private panel!: SearchPanel;
	private hits: Hit[] = [];

	constructor(leaf: WorkspaceLeaf, private plugin: SecondBrainSearch) { super(leaf); }

	getViewType() { return SEARCH_VIEW; }
	getDisplayText() { return "Vault search"; }
	getIcon() { return "search-code"; }

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		const plugin = this.plugin;
		this.panel = new SearchPanel(root.ownerDocument, {
			placeholder: "Search by words or meaning…", hint: HINT, limit: 25, options: SOURCES,
			adapter: {
				search: async (query, scope, limit) => {
					if (!(await plugin.api.ensure())) throw new Unreachable(plugin.api.unreachableMessage());
					const params = new URLSearchParams({ q: query, limit: String(limit) });
					if (scope.source) params.set("source", scope.source);
					if (scope.exclude) params.set("exclude_source", scope.exclude);
					this.hits = await plugin.api.call<Hit[]>(`/search?${params}`);
					return this.hits;
				},
				open: (hit, { newTab, heading }) => plugin.links.open(hit as Hit, heading, newTab),
				decorate: (el, hit, heading) => plugin.links.wire(el, hit as Hit, SEARCH_VIEW, this, heading),
				unreachable: (error) => error instanceof Unreachable ? error.message : `Search failed: ${(error as Error).message}`,
				statusText: (hits) => `${hits.length} ${hits.length === 1 ? "result" : "results"}`,
			},
		});
		this.panel.tools.append(IconButton(root.ownerDocument, "duplicate", "Copy results as links", () => plugin.links.copy(this.hits)));
		root.append(this.panel.root);
	}

	focus() { this.panel?.focus(); }

	setQuery(query: string) { this.panel.setQuery(query); }
}
