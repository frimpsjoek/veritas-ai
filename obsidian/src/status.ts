import { ItemView, Modal, Notice, Setting, WorkspaceLeaf, App } from "obsidian";
import type SecondBrainSearch from "./main";
import { StateLine, StatusPanel, ago, duration, until } from "../../ui/src/index.js";
import type { StatusSpec } from "../../ui/src/panels/panels.js";

// The index at a glance: what it holds per source, how much is searchable by meaning, what indexing is doing
// right now, and buttons to run, stop or re-read. Polls the server every 2 s while open (Mac and phone).

export const STATUS_VIEW = "second-brain-status";

export interface Progress {
	running?: boolean; stage?: string; label?: string; done?: number; total?: number;
	rate_per_min?: number | null; eta_seconds?: number | null; started_at?: number; finished_at?: number;
	updated_at?: number; error?: string | null; result?: Record<string, unknown> | null;
}
interface Coverage { source: string; documents: number; chunks: number; with_vectors: number }
export interface Status {
	notes: number; chunks: number; chunks_with_vectors: number; indexed_at: string | null;
	coverage: Coverage[]; indexing: Progress; running: boolean; next_check_at: number | null;
}

const SOURCE_NAMES: Record<string, string> = {
	personal: "My notes", People: "People", Notion: "Notion", Clippings: "Clippings", youtube: "YouTube",
	ai_notes: "AI notes", copilot: "Copilot", zotero: "Zotero papers", pdf: "PDFs", image: "Images with text",
};

export class StatusView extends ItemView {
	private timer: number | null = null;
	private body!: HTMLElement;
	private panel: ReturnType<typeof StatusPanel> | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: SecondBrainSearch) { super(leaf); }

	getViewType() { return STATUS_VIEW; }
	getDisplayText() { return "Search index"; }
	getIcon() { return "database"; }

	async onOpen() {
		const outer = this.contentEl;
		outer.empty();
		outer.addClass("sb-p", "sb-p-pane-view");
		outer.createDiv({ cls: "sb-p-title", text: "Search index" });
		this.body = outer.createDiv();
		await this.refresh();
		this.timer = window.setInterval(() => this.refresh(), 2000);
		this.registerInterval(this.timer);
	}

	async refresh() {
		let status: Status;
		try {
			status = await this.plugin.api.call<Status>("/status");
		} catch {
			if (!(await this.plugin.api.ensure())) {
				this.panel = null;
				this.body.empty();
				this.body.append(StateLine(this.body.ownerDocument, "error", this.plugin.api.unreachableMessage()));
			}
			return;
		}
		this.render(status);
	}

	private spec(s: Status): StatusSpec {
		const p = s.indexing ?? {};
		const lines: string[] = [];
		let progress: StatusSpec["progress"] = null;
		if (s.running) {
			const total = p.total ?? 0, done = p.done ?? 0;
			if (total > 0) progress = { done, total };
			const parts = [total ? `${done.toLocaleString()} of ${total.toLocaleString()}` : "Working…"];
			if (p.rate_per_min) parts.push(`${Math.round(p.rate_per_min).toLocaleString()}/min`);
			if (p.eta_seconds) parts.push(`about ${duration(p.eta_seconds)} left`);
			lines.push(parts.join(" · "));
			if (p.started_at) lines.push(`Started ${ago(p.started_at)}`);
		} else {
			if (p.finished_at) lines.push(`Last run finished ${ago(p.finished_at)}`);
			if (p.error) lines.push(`Error: ${p.error}`);
			if (s.next_check_at) lines.push(`Next automatic check ${until(s.next_check_at)}`);
		}
		const actions: NonNullable<StatusSpec["actions"]> = s.running
			? [{ label: "Stop", danger: true, onClick: async () => {
				await this.plugin.api.call("/index/stop", "POST", {});
				new Notice("Stopping after the current batch. Work done so far is kept.");
				this.refresh();
			} }]
			: [
				{ label: "Update now", primary: true, onClick: () => this.start(null) },
				{ label: "Re-read Zotero", onClick: () => this.start("zotero") },
				{ label: "Re-read images & PDFs", onClick: () =>
					new ConfirmModal(this.app, "Re-read every image and PDF?",
						"Runs text recognition on all ~6,700 files again. It takes about 15–30 minutes; search keeps working meanwhile.",
						"Re-read", () => this.start("media")).open() },
			];
		const rows = s.coverage.filter((c) => !c.source.startsWith("_")).map((c) => ({
			label: SOURCE_NAMES[c.source] ?? c.source, count: c.documents,
			pct: c.chunks ? Math.round((c.with_vectors / c.chunks) * 100) : 100,
		}));
		const read = s.coverage.find((c) => c.source === "_media_read");
		const foot = [`${s.chunks.toLocaleString()} passages indexed`];
		if (read) foot.push(`${read.documents.toLocaleString()} images and PDFs read, ${read.chunks.toLocaleString()} with text`);
		return {
			state: s.running ? "running" : p.error ? "error" : "idle",
			label: s.running ? p.label ?? "Indexing" : p.label ?? "Idle",
			progress, lines, actions, rows,
			notes: [foot.join(" · "), "Keyword search covers everything immediately; search by meaning follows as passages are processed."],
		};
	}

	private render(s: Status) {
		if (!this.panel) {
			this.body.empty();
			this.panel = StatusPanel(this.body.ownerDocument);
			this.body.append(this.panel.el);
		}
		this.panel.render(this.spec(s));
	}

	private async start(reread: string | null) {
		try {
			await this.plugin.api.call("/index", "POST", reread ? { reread } : {});
			new Notice(reread ? `Re-reading ${reread === "zotero" ? "Zotero" : "images and PDFs"}…` : "Updating the index…");
		} catch (error) {
			new Notice(`Couldn't start: ${(error as Error).message}`);
		}
		this.refresh();
	}
}

class ConfirmModal extends Modal {
	constructor(app: App, private question: string, private detail: string, private action: string,
		private onConfirm: () => void) { super(app); }

	onOpen() {
		this.titleEl.setText(this.question);
		this.contentEl.createEl("p", { text: this.detail });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText(this.action).setCta().onClick(() => { this.close(); this.onConfirm(); }));
	}
}

export { duration };
