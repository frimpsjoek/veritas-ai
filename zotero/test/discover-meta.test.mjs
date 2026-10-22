// Run with: node --test zotero-plugin/test/discover-meta.test.mjs
// Loads content/discover.js (a plain script that assigns SecondBrain.Discover) in a bare context; invented papers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

globalThis.SecondBrain = {};
globalThis.Zotero = {};
vm.runInThisContext(readFileSync(fileURLToPath(new URL("../content/discover.js", import.meta.url)), "utf8"));
const D = SecondBrain.Discover;
const d = new D({});

test("OpenAlex mapping", () => {
	const r = d.fromOpenAlex({ id: "W1", display_name: "A review of tides", type: "review", cited_by_count: 40,
		best_oa_location: { pdf_url: "https://x.example/a.pdf" }, open_access: { is_oa: true, oa_url: "https://x.example/l" } });
	assert.equal(r.studyType, "review"); assert.equal(r.citations, 40); assert.equal(r.fullText, true); assert.equal(r.pdfUrl, "https://x.example/a.pdf");
	const closed = d.fromOpenAlex({ id: "W2", display_name: "Closed", type: "article", open_access: { is_oa: false, oa_url: "https://z.example" } });
	assert.deepEqual([closed.studyType, closed.citations, closed.fullText, closed.pdfUrl], [null, null, false, null]);
});

test("Semantic Scholar mapping", () => {
	const cases = [
		[["Review", "JournalArticle"], "review"], [["MetaAnalysis", "Review"], "meta_analysis"], [["ClinicalTrial"], "other"],
		[["JournalArticle"], null], [null, null], [[], null],
	];
	for (const [types, want] of cases) assert.equal(d.fromSemanticScholar({ paperId: "p", title: "t", publicationTypes: types }).studyType, want, JSON.stringify(types));
	const p = d.fromSemanticScholar({ paperId: "p", title: "t", citationCount: 7, openAccessPdf: { url: "https://s2.example/p.pdf" } });
	assert.deepEqual([p.citations, p.fullText, p.pdfUrl], [7, true, "https://s2.example/p.pdf"]);
	assert.deepEqual([d.fromSemanticScholar({ paperId: "q", title: "t" }).citations], [null]);
});

test("Europe PMC mapping", () => {
	const cases = [
		[["Journal Article", "Randomized Controlled Trial"], "rct"], [["Review", "Systematic Review"], "systematic_review"],
		[["Meta-Analysis", "Review"], "meta_analysis"], [["research-article"], null], [undefined, null], [["Editorial"], "other"],
	];
	for (const [pubType, want] of cases) assert.equal(D.fromEuropePMC({ source: "MED", id: "1", title: "t.", pubTypeList: pubType && { pubType } }).studyType, want, JSON.stringify(pubType));
	const r = D.fromEuropePMC({ source: "MED", id: "1", title: "Tide study.", citedByCount: 3, isOpenAccess: "Y",
		fullTextUrlList: { fullTextUrl: [{ documentStyle: "pdf", availability: "Open access", url: "https://e.example/f.pdf" }] } });
	assert.deepEqual([r.citations, r.fullText, r.pdfUrl, r.title], [3, true, "https://e.example/f.pdf", "Tide study"]);
});

test("library tags: conflicting labels are ambiguous", () => {
	assert.equal(D.studyTypeOfLabels(["Review", "Systematic Review"], { strict: true }), "systematic_review");
	assert.equal(D.studyTypeOfLabels(["Review", "Randomized Controlled Trial"], { strict: true }), null);
	assert.equal(D.studyTypeOfLabels(["tides", "ocean"], { strict: true }), null);
});
