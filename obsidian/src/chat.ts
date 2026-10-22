import { ItemView, WorkspaceLeaf } from "obsidian";
import type SecondBrainSearch from "./main";
// @ts-ignore -- ui-src is plain JS (checked against host.d.ts/domain.d.ts, not against this project's tsconfig);
// see ui-host.ts for the same import.
import { ChatView as SharedChatView } from "../../zotero-plugin/ui-src/src/index.js";
import { createObsidianHost } from "./ui-host";

// Second Brain AI (spec 002/003/004), now the shared chat moved into ui-src (spec 005 C3): Chat, Quick answer,
// Find papers and Research report, picked from the mode menu under the message box. This file is just the
// Obsidian shell — an ItemView that builds one UiHost (ui-host.ts) and mounts ui-src's ChatView into it; every
// behaviour (modes, source pills, history, the composer) lives in ui-src/src/chat/chat.js, unchanged from what
// Zotero runs (spec 005 C1/C2).

export const CHAT_VIEW = "second-brain-chat";

export class ChatView extends ItemView {
	private view: any = null; // SecondBrainUI.ChatView (ui-src, plain JS, not typechecked here)

	constructor(leaf: WorkspaceLeaf, private plugin: SecondBrainSearch) { super(leaf); }

	getViewType() { return CHAT_VIEW; }
	getDisplayText() { return "Second Brain AI"; }
	getIcon() { return "bot"; }

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("sb-chat-root");
		const host = createObsidianHost(this.plugin);
		this.view = new SharedChatView(host, root.ownerDocument);
		root.append(this.view.root);
	}

	async onClose() {
		this.view?.destroy();
		this.view = null;
	}

	/** "Ask about selection": a one-off Quick answer with the selection attached, without disturbing Chat state. */
	async askAboutSelection(text: string) {
		if (!this.view) return;
		this.view.setMode("ask");
		this.view.input.value = text;
		await this.view.submit();
	}

	/** Switches mode from outside the view (a command, e.g. "Open research report", or Home's Routines). */
	openMode(mode: "chat" | "ask" | "find" | "report" | "routines") {
		if (!this.view) return;
		this.view.setMode(mode);
		this.view.input.focus();
	}

	/** A stored session from Home, opened as the web app opens one: a saved Find papers search as its table,
	 *  anything else as its thread. */
	async openSession(id: string) {
		if (!this.view) return;
		await this.view.refreshList();
		const known = this.view.recent.find((c: { id: string }) => c.id === id);
		await (known ? this.view.openSession(known) : this.view.openConversation(id));
	}

	/** True while a turn is streaming (ui-src's ChatView.running) -- the updater (spec 006) treats this view as
	 *  busy and waits rather than swapping code out from under a live answer. */
	isRunning(): boolean {
		return !!this.view?.running;
	}
}
