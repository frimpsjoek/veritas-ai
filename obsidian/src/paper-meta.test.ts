// Run with: node --experimental-strip-types --test src/paper-meta.test.ts (invented papers only)
import { test } from "node:test";
import assert from "node:assert/strict";
import { metaFromOpenAlex, studyTypeOfLabel } from "./paper-meta.ts";

test("metaFromOpenAlex: table", () => {
	const cases: [string, any, any][] = [
		["review with pdf", { type: "review", cited_by_count: 12, best_oa_location: { pdf_url: "https://x.example/a.pdf" }, open_access: { is_oa: true, oa_url: "https://x.example/landing" } },
			{ studyType: "review", fullText: true, pdfUrl: "https://x.example/a.pdf", citations: 12 }],
		["article, oa_url only", { type: "article", cited_by_count: 0, best_oa_location: null, open_access: { is_oa: true, oa_url: "https://y.example/p" } },
			{ studyType: null, fullText: true, pdfUrl: "https://y.example/p", citations: 0 }],
		["closed, oa_url ignored", { type: "article", cited_by_count: 3, open_access: { is_oa: false, oa_url: "https://z.example/p" } },
			{ studyType: null, fullText: false, pdfUrl: null, citations: 3 }],
		["nothing given", {}, { studyType: null, fullText: false, pdfUrl: null, citations: null }],
		["preprint type is not a study type", { type: "preprint", cited_by_count: 5 }, { studyType: null, fullText: false, pdfUrl: null, citations: 5 }],
	];
	for (const [name, work, want] of cases) assert.deepEqual(metaFromOpenAlex(work), want, name);
});

test("studyTypeOfLabel: table", () => {
	const cases: [unknown, string | null][] = [
		["Meta-Analysis", "meta_analysis"], ["MetaAnalysis", "meta_analysis"], ["Systematic Review", "systematic_review"],
		["Randomized Controlled Trial", "rct"], ["Longitudinal Studies", "longitudinal"], ["Review", "review"],
		["ClinicalTrial", "other"], ["Case Reports", "other"], ["JournalArticle", null], ["research-article", null], [null, null], ["", null],
	];
	for (const [label, want] of cases) assert.equal(studyTypeOfLabel(label), want, String(label));
});
