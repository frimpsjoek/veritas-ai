import { App, ItemView, Modal, Notice, Setting, TFile, WorkspaceLeaf } from "obsidian";
import type SecondBrainSearch from "./main";
import { DuplicatesPanel } from "../../zotero-plugin/ui-src/src/index.js";
import { panelFetch } from "./panel-rows";

export const DUPLICATES_VIEW = "second-brain-duplicates";

/**
 * Notes that are the same note twice. It never deletes on its own: every removal is a click, goes to the trash
 * set in Obsidian's settings (so it can be restored), and bulk removal is offered only for byte-identical copies.
 */
export class DuplicatesView extends ItemView {
	constructor(leaf: WorkspaceLeaf, private plugin: SecondBrainSearch) { super(leaf); }

	getViewType() { return DUPLICATES_VIEW; }
	getDisplayText() { return "Duplicate notes"; }
	getIcon() { return "copy"; }

	async onOpen() {
		const plugin = this.plugin;
		const outer = this.contentEl;
		outer.empty();
		outer.addClass("sb-p-scroll");
		const panel = DuplicatesPanel(outer.ownerDocument, {
			fetchJSON: panelFetch(plugin.api),
			open: (ref, heading, event) => plugin.links.open(ref, heading, !!(event?.metaKey || event?.ctrlKey)),
			decorate: (el, ref, heading) => plugin.links.decorate(el, ref, DUPLICATES_VIEW, this, heading),
			onTrash: (paths, row) => this.trash(paths, row),
			onCompare: (left, right) => { void compare(this.app, left, right); },
		});
		outer.append(panel.el);
		await panel.check();
	}

	/** Resolves once the removal is done, so the panel re-checks after a batch; a cancelled or empty request never resolves. */
	private trash(paths: string[], row: HTMLElement | null): Promise<void> {
		return new Promise((resolve) => {
			const files = paths.map((p) => this.app.vault.getAbstractFileByPath(p)).filter((f): f is TFile => f instanceof TFile);
			if (!files.length) { new Notice("Already gone."); return; }
			const what = files.length === 1 ? `"${files[0].basename}"` : `${files.length} notes`;
			new ConfirmModal(this.app, `Move ${what} to the trash?`, "You can restore from the trash.", async () => {
				for (const file of files) await this.app.fileManager.trashFile(file);
				new Notice(`Moved ${what} to the trash.`);
				row?.addClass("sb-p-removed");
				resolve();
			}).open();
		});
	}
}

async function compare(app: App, left: string, right: string) {
	const a = app.vault.getAbstractFileByPath(left), b = app.vault.getAbstractFileByPath(right);
	if (!(a instanceof TFile) || !(b instanceof TFile)) return new Notice("One of the notes no longer exists.");
	await app.workspace.getLeaf("tab").openFile(a);
	await app.workspace.getLeaf("split").openFile(b);
}

class ConfirmModal extends Modal {
	constructor(app: App, private question: string, private detail: string, private onConfirm: () => Promise<void>) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText(this.question);
		this.contentEl.createEl("p", { text: this.detail });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Move to trash").setWarning().onClick(async () => {
				this.close();
				await this.onConfirm();
			}));
	}
}
