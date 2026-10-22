// Spec 015 B2: where a web link goes in Obsidian. Pure (no obsidian import), so it is tested directly.

export const WEB_VIEWER = "webviewer";
export const NOTICE_PREF = "webViewerNoticeShown";
export const NOTICE_TEXT = "Turn on Web viewer in Settings → Core plugins to open links inside Obsidian.";

export type LinkPlan = "viewer" | "outside" | "outside-with-notice" | "scheme";

export interface LinkState {
	/** The `openLinks` pref: 'outside' sends every link to the system browser; anything else means inside. */
	mode: unknown;
	/** The Web viewer core plugin is switched on. */
	viewerOn: boolean;
	/** The one-time notice has been shown. */
	noticed: boolean;
}

/** Where a link goes. Pure, so it can be tested without Obsidian. */
export function planLink(url: string, opts: { outside?: boolean } | undefined, state: LinkState): LinkPlan {
	if (!/^https?:\/\//i.test(url)) return "scheme";
	if (opts?.outside || state.mode === "outside") return "outside";
	if (!state.viewerOn) return state.noticed ? "outside" : "outside-with-notice";
	return "viewer";
}
