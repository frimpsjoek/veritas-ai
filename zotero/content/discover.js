/* global Zotero, SecondBrain */
// Papers that aren't in the library yet: search the services each user picks (OpenAlex by meaning, Semantic
// Scholar, arXiv, Crossref, Europe PMC, bioRxiv/medRxiv, ChemRxiv) and merge them, or list what's around a paper (similar papers, the papers that cite it, its references), mark the
// ones already in the library, and add the others with Zotero's own DOI/arXiv lookup.

SecondBrain.Discover = class {
	static FIELDS = "id,doi,ids,display_name,publication_year,authorships,primary_location,cited_by_count,best_oa_location,open_access,type,abstract_inverted_index,related_works,referenced_works";

	constructor(sb) {
		this.sb = sb;
	}

	// ------------------------------------------------------------------ searching

	/** The services "Find new papers" can search; each user picks theirs (saved in extensions.secondbrain.sources).
	 *  Google Scholar has no API, so the window links out to it instead. */
	static SOURCES = [
		{ id: "openalex", label: "OpenAlex", on: true },
		{ id: "semanticscholar", label: "Semantic Scholar", on: true },
		{ id: "arxiv", label: "arXiv", on: true },
		{ id: "crossref", label: "Crossref", on: false },
		{ id: "europepmc", label: "PubMed / Europe PMC", on: false },
		{ id: "biorxiv", label: "bioRxiv / medRxiv", on: false },
		{ id: "chemrxiv", label: "ChemRxiv", on: false },
	];

	// ------------------------------------------------------------------ study type (spec 007 §1.1, §5.3)

	/** One source-stated label ("Randomized Controlled Trial", "MetaAnalysis", "review") to a StudyType, "other"
	 *  when the source names a type we have no bucket for (trial registry entry, case report, editorial), and null
	 *  when the label says nothing about study design (JournalArticle, article, preprint). Never inferred from
	 *  titles or abstracts. */
	static studyTypeOfLabel(label) {
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

	/** Several labels, the most specific stated type wins. `strict` (library tags, which people add freely):
	 *  labels that name different designs (a trial and a review) are ambiguous, so null. */
	static studyTypeOfLabels(labels, { strict = false } = {}) {
		const found = new Set((labels ?? []).map((l) => SecondBrain.Discover.studyTypeOfLabel(l)).filter(Boolean));
		if (!found.size) return null;
		if (strict) {
			const design = ["rct", "longitudinal"].filter((k) => found.has(k)).length + (["review", "systematic_review", "meta_analysis"].some((k) => found.has(k)) ? 1 : 0);
			if (design > 1) return null;
		}
		for (const k of ["meta_analysis", "systematic_review", "rct", "longitudinal", "review", "other"]) if (found.has(k)) return k;
		return null;
	}

	static CHEMRXIV = "S4393918830"; // OpenAlex source id; ChemRxiv's own API refuses programs (HTTP 403)

	chosenSources() {
		try {
			const saved = JSON.parse(Zotero.Prefs.get("extensions.secondbrain.sources", true) || "null");
			if (Array.isArray(saved) && saved.length) return saved;
		} catch (error) { /* fall back to the defaults */ }
		return SecondBrain.Discover.SOURCES.filter((s) => s.on).map((s) => s.id);
	}

	/** Search the chosen services at once and merge: one paper found by several of them shows once, labeled
	 *  with each. Results alternate between services so no single one fills the list. */
	async search(query, sources = this.chosenSources(), perSource = 15) {
		const runs = await Promise.allSettled(sources.map((id) => this.searchOne(id, query, perSource)));
		const lists = runs.map((run, i) => {
			if (run.status === "rejected") Zotero.logError(run.reason);
			const label = SecondBrain.Discover.SOURCES.find((s) => s.id === sources[i])?.label ?? sources[i];
			return run.status === "fulfilled" ? run.value.map((r) => ({ ...r, sources: [label] })) : [];
		});
		const failed = sources.filter((id, i) => runs[i].status === "rejected")
			.map((id) => SecondBrain.Discover.SOURCES.find((s) => s.id === id)?.label ?? id);
		const merged = [];
		const seen = new Map();
		for (let rank = 0; lists.some((list) => rank < list.length); rank++) {
			for (const list of lists) {
				const r = list[rank];
				if (!r?.title) continue;
				const keys = [r.doi && `doi:${r.doi.toLowerCase()}`, `title:${this.sb.normalizeTitle(r.title)}`].filter(Boolean);
				const earlier = keys.map((k) => seen.get(k)).find(Boolean);
				if (earlier) {
					earlier.sources = [...new Set([...earlier.sources, ...r.sources])];
					earlier.pdf ??= r.pdf;
					earlier.pdfUrl ??= r.pdfUrl;
					earlier.fullText = earlier.fullText || r.fullText;
					earlier.citations ??= r.citations;
					earlier.studyType ??= r.studyType;
					earlier.doi ??= r.doi;
					earlier.arxiv ??= r.arxiv;
					earlier.pmid ??= r.pmid;
					if (!earlier.abstract) earlier.abstract = r.abstract;
					continue;
				}
				keys.forEach((k) => seen.set(k, r));
				merged.push(r);
			}
		}
		const results = await this.mark(merged);
		results.failed = failed;
		return results;
	}

	async searchOne(id, query, limit) {
		switch (id) {
			case "openalex":
				return this.semantic(query, limit).catch(() => this.openAlex(`/works?search=${encodeURIComponent(query)}&per_page=${limit}&select=${SecondBrain.Discover.FIELDS}`)
					.then((data) => data.results.map((work) => this.fromOpenAlex(work))));
			case "chemrxiv": {
				const filter = `&filter=primary_location.source.id:${SecondBrain.Discover.CHEMRXIV}`;
				return this.semantic(query, limit, filter).catch(() => this.openAlex(`/works?search=${encodeURIComponent(query)}${filter}&per_page=${limit}&select=${SecondBrain.Discover.FIELDS}`)
					.then((data) => data.results.map((work) => this.fromOpenAlex(work))));
			}
			case "semanticscholar": {
				const data = await this.getJSON(`https://api.semanticscholar.org/graph/v1/paper/search?limit=${limit}&query=${encodeURIComponent(query)}&fields=title,year,authors,venue,externalIds,citationCount,openAccessPdf,abstract,publicationTypes`);
				return (data.data ?? []).map((paper) => this.fromSemanticScholar(paper));
			}
			case "arxiv": return this.arxiv(query, limit);
			case "crossref": return this.crossref(query, limit);
			case "europepmc": return this.europePMC(query, limit);
			case "biorxiv": return this.europePMC(`(${query}) AND SRC:PPR AND (PUBLISHER:"bioRxiv" OR PUBLISHER:"medRxiv")`, limit);
			default: return [];
		}
	}

	async getJSON(url) {
		const headers = {};
		const s2 = Zotero.Prefs.get("extensions.secondbrain.semanticScholarKey", true);
		if (s2 && url.startsWith("https://api.semanticscholar.org/")) headers["x-api-key"] = s2;
		const response = await Zotero.HTTP.request("GET", url, { responseType: "json", timeout: 20000, successCodes: false, headers });
		if (response.status === 429) throw new Error(`${new URL(url).host}: too many requests${url.includes("semanticscholar") && !s2 ? " (add a free Semantic Scholar key in settings)" : ""}`);
		if (response.status !== 200 || !response.response) throw new Error(`${new URL(url).host}: HTTP ${response.status}`);
		return response.response;
	}

	/** arXiv's own search: the meaningful words must all appear (its default ORs them), most relevant first.
	 *  Common words are dropped and at most five kept, or a question-like query finds nothing. */
	async arxiv(query, limit) {
		const STOP = new Set("the and for with from into between about over under using use how what which why when does can are was were this that these those its their our your how via of in on to by at an as is be or not".split(" "));
		const words = query.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 5);
		if (!words.length) return [];
		const url = `https://export.arxiv.org/api/query?search_query=${words.map((w) => `all:${encodeURIComponent(w)}`).join("+AND+")}&max_results=${limit}&sortBy=relevance`;
		const response = await Zotero.HTTP.request("GET", url, { timeout: 20000 });
		const xml = new (Zotero.getMainWindow().DOMParser)().parseFromString(response.responseText, "application/xml");
		const text = (node, tag) => node.getElementsByTagName(tag)[0]?.textContent?.replace(/\s+/g, " ").trim() ?? "";
		return [...xml.getElementsByTagName("entry")].map((entry) => {
			const id = text(entry, "id").replace(/^https?:\/\/arxiv\.org\/abs\//, "").replace(/v\d+$/, "");
			return {
				id: `arXiv:${id}`, doi: text(entry, "arxiv:doi") || null, arxiv: id, pmid: null,
				title: text(entry, "title"), authors: [...entry.getElementsByTagName("author")].map((a) => text(a, "name")),
				year: text(entry, "published").slice(0, 4), venue: "arXiv", cites: 0, citations: null,
				pdf: `https://arxiv.org/pdf/${id}`, pdfUrl: `https://arxiv.org/pdf/${id}`, fullText: true, studyType: null,
				type: "preprint", abstract: text(entry, "summary"),
			};
		});
	}

	/** Crossref: nearly every DOI. Supplementary files have their own DOIs (…​.s001); those are left out. */
	async crossref(query, limit) {
		const email = Zotero.Prefs.get("extensions.secondbrain.email", true);
		const types = ["journal-article", "posted-content", "proceedings-article", "book-chapter", "book"].map((t) => `type:${t}`).join(",");
		const data = await this.getJSON(`https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}&filter=${types}${email ? `&mailto=${encodeURIComponent(email)}` : ""}`);
		return (data.message?.items ?? []).filter((w) => w.title?.[0] && !/\.s\d+$/i.test(w.DOI)).map((w) => ({
			id: `doi:${w.DOI}`, doi: w.DOI, arxiv: null, pmid: null,
			title: w.title[0].replace(/<[^>]+>/g, ""),
			authors: (w.author ?? []).map((a) => [a.given, a.family].filter(Boolean).join(" ") || a.name).filter(Boolean),
			year: w.issued?.["date-parts"]?.[0]?.[0] ?? "", venue: w["container-title"]?.[0] ?? (w.type === "posted-content" ? "Preprint" : ""),
			cites: w["is-referenced-by-count"] ?? 0, citations: w["is-referenced-by-count"] ?? null,
			pdf: null, pdfUrl: null, fullText: false, studyType: null,
			type: w.type === "book" ? "book" : "article", abstract: (w.abstract ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
		}));
	}

	/** Europe PMC: PubMed, PubMed Central and preprints (bioRxiv, medRxiv…), with open-access PDFs when known. */
	async europePMC(query, limit) {
		const data = await this.getJSON(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json&resultType=core&pageSize=${limit}`);
		return (data.resultList?.result ?? []).map((r) => SecondBrain.Discover.fromEuropePMC(r));
	}

	static fromEuropePMC(r) {
		const pdf = (r.fullTextUrlList?.fullTextUrl ?? []).find((u) => u.documentStyle === "pdf" && /open|free/i.test(u.availability ?? ""))?.url ?? null;
		return {
			id: `${r.source}:${r.id}`, doi: r.doi ?? null, arxiv: null, pmid: r.pmid ?? null,
			title: (r.title ?? "").replace(/<[^>]+>/g, "").replace(/\.$/, ""),
			authors: (r.authorList?.author ?? []).map((a) => a.fullName).filter(Boolean),
			year: r.pubYear ?? "", venue: r.journalInfo?.journal?.title ?? r.bookOrReportDetails?.publisher ?? (r.source === "PPR" ? "Preprint" : ""),
			cites: r.citedByCount ?? 0, citations: r.citedByCount ?? null,
			pdf, pdfUrl: pdf, fullText: !!pdf || r.isOpenAccess === "Y",
			studyType: SecondBrain.Discover.studyTypeOfLabels(r.pubTypeList?.pubType),
			type: r.source === "PPR" ? "preprint" : "article", abstract: (r.abstractText ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
		};
	}

	async semantic(text, limit, filter = "") {
		const data = await this.openAlex(`/works?search.semantic=${encodeURIComponent(text.slice(0, 1200))}${filter}&per_page=${limit}&select=${SecondBrain.Discover.FIELDS}`);
		if (!data.results?.length) throw new Error("no semantic results");
		return data.results.map((work) => this.fromOpenAlex(work));
	}

	/** Papers like this one (OpenAlex's meaning-based search on its title and abstract), the papers citing it,
	 *  and its references. OpenAlex's own "related works" list proved too loose to show. */
	async related(item) {
		const work = await this.findWork(item);
		if (!work) return null;
		const ids = (list, n) => (list ?? []).slice(0, n).map((url) => url.split("/").pop());
		const about = `${item.getField("title")}. ${item.getField("abstractNote") || (work.abstract_inverted_index ? this.unInvert(work.abstract_inverted_index) : "")}`;
		const [related, references, citing] = await Promise.all([
			this.semantic(about, 21).then((list) => list.filter((r) => r.id !== work.id).slice(0, 20)).catch(() => []),
			this.works(ids(work.referenced_works, 50)),
			this.openAlex(`/works?filter=cites:${work.id.split("/").pop()}&sort=cited_by_count:desc&per_page=20&select=${SecondBrain.Discover.FIELDS}`)
				.then((data) => data.results.map((w) => this.fromOpenAlex(w))),
		]);
		references.sort((a, b) => b.cites - a.cites);
		return {
			work: this.fromOpenAlex(work),
			groups: [
				["Similar papers", await this.mark(related)],
				["Cites this paper", await this.mark(citing)],
				["In its references", await this.mark(references)],
			],
		};
	}

	async findWork(item) {
		const doi = this.doiOf(item);
		if (doi) {
			try {
				return await this.openAlex(`/works/doi:${encodeURIComponent(doi)}?select=${SecondBrain.Discover.FIELDS}`);
			} catch (error) { /* not in OpenAlex by DOI; try the title */ }
		}
		const title = this.sb.normalizeTitle(item.getField("title"));
		const data = await this.openAlex(`/works?filter=title.search:${encodeURIComponent(title)}&per_page=1&select=${SecondBrain.Discover.FIELDS}`);
		const work = data.results[0];
		return work && !this.sb.titlesDiffer(item, work.display_name) ? work : null;
	}

	async works(ids) {
		if (!ids.length) return [];
		const data = await this.openAlex(`/works?filter=openalex:${ids.join("|")}&per_page=${ids.length}&select=${SecondBrain.Discover.FIELDS}`);
		return data.results.map((work) => this.fromOpenAlex(work));
	}

	async openAlex(path) {
		const url = `https://api.openalex.org${path}`;
		this.sb.openAlexGuard(null);
		const response = await Zotero.HTTP.request("GET", url + this.sb.openAlexAuth(url.includes("?") ? "&" : "?"), {
			responseType: "json", timeout: 20000, successCodes: false,
		});
		this.sb.openAlexGuard(response);
		if (response.status !== 200 || !response.response) {
			throw new Error(response.response?.message || response.response?.error || `OpenAlex: HTTP ${response.status}`);
		}
		return response.response;
	}

	// ------------------------------------------------------------------ one shape for both services

	fromOpenAlex(work) {
		const abstract = work.abstract_inverted_index ? this.unInvert(work.abstract_inverted_index) : "";
		const arxiv = /arxiv\.org\/abs\/([^\s?#v]+)/i.exec(work.primary_location?.landing_page_url ?? "")?.[1]
			?? (work.ids?.arxiv ? String(work.ids.arxiv).split("/").pop() : null);
		return {
			id: work.id,
			pmid: work.ids?.pmid ? String(work.ids.pmid).split("/").pop() : null,
			doi: (work.doi ?? "").replace(/^https?:\/\/doi\.org\//i, "") || null,
			arxiv,
			title: work.display_name ?? "",
			authors: (work.authorships ?? []).map((a) => a.author?.display_name).filter(Boolean),
			year: work.publication_year ?? "",
			venue: work.primary_location?.source?.display_name ?? "",
			cites: work.cited_by_count ?? 0,
			citations: work.cited_by_count ?? null,
			pdf: work.best_oa_location?.pdf_url ?? null,
			pdfUrl: work.best_oa_location?.pdf_url ?? (work.open_access?.is_oa ? work.open_access.oa_url ?? null : null),
			fullText: !!(work.best_oa_location?.pdf_url || (work.open_access?.is_oa && work.open_access.oa_url)),
			studyType: work.type === "review" ? "review" : null,
			type: work.type ?? "article",
			abstract,
		};
	}

	fromSemanticScholar(paper) {
		return {
			id: paper.paperId,
			pmid: paper.externalIds?.PubMed ?? null,
			doi: paper.externalIds?.DOI ?? null,
			arxiv: paper.externalIds?.ArXiv ?? null,
			title: paper.title ?? "",
			authors: (paper.authors ?? []).map((a) => a.name),
			year: paper.year ?? "",
			venue: paper.venue ?? "",
			cites: paper.citationCount ?? 0,
			citations: paper.citationCount ?? null,
			pdf: paper.openAccessPdf?.url ?? null,
			pdfUrl: paper.openAccessPdf?.url ?? null,
			fullText: !!paper.openAccessPdf?.url,
			studyType: SecondBrain.Discover.studyTypeOfLabels(paper.publicationTypes),
			type: "article",
			abstract: paper.abstract ?? "",
		};
	}

	unInvert(index) {
		const words = [];
		for (const [word, positions] of Object.entries(index)) for (const at of positions) words[at] = word;
		return words.filter(Boolean).join(" ");
	}

	// ------------------------------------------------------------------ what's already in the library

	doiOf(item) {
		return (item.getField("DOI") || item.getExtraField?.("DOI") || "").replace(/^https?:\/\/doi\.org\//i, "").toLowerCase() || null;
	}

	/** DOIs and normalized titles of the library, read once and kept up to date as papers are added here. */
	async libraryIndex() {
		if (this.known) return this.known;
		const known = { dois: new Map(), titles: new Map() };
		const items = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true)).filter((item) => item.isRegularItem() && !item.deleted);
		await Zotero.Items.loadDataTypes(items, ["itemData"]);
		for (const item of items) this.remember(known, item);
		this.known = known;
		return known;
	}

	remember(known, item) {
		const doi = this.doiOf(item);
		if (doi) known.dois.set(doi, item.key);
		known.titles.set(this.sb.normalizeTitle(item.getField("title")), item.key);
	}

	async mark(results) {
		const known = await this.libraryIndex();
		for (const r of results) {
			r.key = (r.doi && known.dois.get(r.doi.toLowerCase())) || known.titles.get(this.sb.normalizeTitle(r.title)) || null;
		}
		return results;
	}

	// ------------------------------------------------------------------ adding

	/** Save a paper to the library (and the selected collection, or `collections` ids when given), filled in by Zotero's DOI or arXiv lookup when
	 *  possible, then attach a free PDF if one is known. Returns the new item. */
	async add(result, { collections: into } = {}) {
		const pane = Zotero.getActiveZoteroPane();
		const libraryID = Zotero.Libraries.userLibraryID;
		// Zotero 10 removed getSelectedCollection(); only look at the pane when the caller did not choose collections
		const collection = into ? null : pane?.getSelectedCollections?.()[0] ?? null;
		const collections = into ?? (collection && collection.libraryID === libraryID ? [collection.id] : []);
		let item = null;
		for (const identifier of [result.doi && { DOI: result.doi }, result.arxiv && { arXiv: result.arxiv }, result.pmid && { PMID: result.pmid }].filter(Boolean)) {
			try {
				const translate = new Zotero.Translate.Search();
				translate.setIdentifier(identifier);
				const translators = await translate.getTranslators();
				if (!translators.length) continue;
				translate.setTranslator(translators);
				[item] = await translate.translate({ libraryID, collections, saveAttachments: false });
				if (item) break;
			} catch (error) {
				Zotero.logError(error);
			}
		}
		// a lookup can save the item and still fail afterwards; don't make a second copy of it
		if (!item && result.doi) item = await this.itemByDOI(result.doi);
		if (!item) item = await this.create(result, collections);
		if (result.pdf && !(await this.sb.hasWorkingPDF(item))) {
			await this.sb.attachPDF(item, result.pdf, "Open Access PDF").catch((error) => Zotero.logError(error));
		}
		if (this.known) this.remember(this.known, item);
		return item;
	}

	async itemByDOI(doi) {
		const search = new Zotero.Search();
		search.libraryID = Zotero.Libraries.userLibraryID;
		search.addCondition("DOI", "is", doi);
		const [id] = await search.search().catch(() => []);
		return id ? Zotero.Items.get(id) : null;
	}

	/** Without a DOI or arXiv ID Zotero can look up, build the item from what the search returned. */
	async create(result, collections) {
		const item = new Zotero.Item(result.type === "book" ? "book" : "journalArticle");
		item.libraryID = Zotero.Libraries.userLibraryID;
		item.setField("title", result.title);
		if (result.year) item.setField("date", String(result.year));
		if (result.venue && item.itemType === "journalArticle") item.setField("publicationTitle", result.venue);
		if (result.doi && item.itemType === "journalArticle") item.setField("DOI", result.doi);
		if (result.abstract) item.setField("abstractNote", result.abstract);
		item.setCreators(result.authors.slice(0, 50).map((name) => {
			const parts = name.trim().split(/\s+/);
			return { creatorType: "author", lastName: parts.pop(), firstName: parts.join(" ") };
		}));
		item.setCollections(collections);
		await item.saveTx();
		return item;
	}
};
