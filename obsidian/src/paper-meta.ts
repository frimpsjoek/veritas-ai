// Study type, open-access link and citation count for outside papers (spec 007 E4). Pure, no `obsidian` import,
// so `node --test` runs it. Mirrors zotero-plugin/content/discover.js (which also maps S2 and Europe PMC);
// Obsidian only searches OpenAlex. Only what the source states is mapped; anything else is null, never guessed.

export type StudyType = "review" | "systematic_review" | "meta_analysis" | "rct" | "longitudinal" | "other";

export interface PaperMeta {
	studyType: StudyType | null;
	fullText: boolean;
	pdfUrl: string | null;
	citations: number | null;
}

/** One source-stated label to a StudyType; "other" for a type named but not bucketed; null when it says nothing
 *  about design (article, JournalArticle, preprint). */
export function studyTypeOfLabel(label: unknown): StudyType | null {
	const t = String(label ?? "").toLowerCase().replace(/[^a-z]+/g, "");
	if (!t) return null;
	if (t === "metaanalysis") return "meta_analysis";
	if (t === "systematicreview") return "systematic_review";
	if (t === "randomizedcontrolledtrial" || t === "rct") return "rct";
	if (t === "longitudinalstudies" || t === "longitudinalstudy" || t === "cohortstudies") return "longitudinal";
	if (t === "review" || t === "reviewarticle" || t === "literaturereview") return "review";
	if (["clinicaltrial", "casereport", "casereports", "editorial", "lettersandcomments", "letter", "comment", "news", "study", "observationalstudy", "comparativestudy"].includes(t)) return "other";
	return null;
}

/** OpenAlex work -> metadata. OpenAlex's `type` says "review" for reviews and nothing more specific, so that is
 *  the only study type it can give. `oa_url` counts as a link only when the work is open access. */
export function metaFromOpenAlex(work: any): PaperMeta {
	const pdf: string | null = work?.best_oa_location?.pdf_url ?? null;
	const oa: string | null = work?.open_access?.is_oa ? (work.open_access.oa_url ?? null) : null;
	const cites = work?.cited_by_count;
	return {
		studyType: work?.type === "review" ? "review" : null,
		fullText: !!(pdf || oa),
		pdfUrl: pdf ?? oa,
		citations: typeof cites === "number" ? cites : null,
	};
}
