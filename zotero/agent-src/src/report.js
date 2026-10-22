// @ts-check
// agent-src/src/report.js. Pure functions only: screen() deduplicates a set of per-sub-question Findings into
// one Screened result, and renderReport() turns a Report (the writer's structured output, plus references we
// attach ourselves) into the note body. Both are exercised by golden-file tests (test/report.test.js), so
// neither may read a clock, a file or a network: every input they need is a parameter.

/** @param {string} title */
function normTitle(title) {
  return (title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** @param {import("./domain").Source} a @param {import("./domain").Source} b picks the richer of two records for the same paper */
function mergeSource(a, b) {
  return {
    citekey: a.citekey ?? b.citekey ?? null,
    doi: a.doi ?? b.doi ?? null,
    url: a.url ?? b.url ?? null,
    title: a.title || b.title,
    year: a.year ?? b.year ?? null,
    inLibrary: a.inLibrary || b.inLibrary,
  };
}

/**
 * Deduplicates by DOI, citekey and normalized title: a source is folded into an existing bucket if it matches
 * that bucket on any one of the three, so the same paper found once by DOI (scholarly) and once by citekey
 * (library) still collapses to one entry. Out-of-library sources (no citekey) are split out, never merged into
 * `sources`, so the caller can offer them for "Add to Zotero" without re-deriving inLibrary itself.
 * @param {import("./domain").Findings[]} all
 * @returns {import("./domain").Screened}
 */
export function screen(all) {
  const findings = [];
  const searchLog = [];
  const buckets = []; // { doi, citekey, normTitle, source }

  function findBucket(src) {
    const nt = normTitle(src.title);
    const doi = src.doi ? src.doi.toLowerCase() : null;
    return buckets.find((b) => (doi && b.doi === doi) || (src.citekey && b.citekey === src.citekey) || (nt && b.normTitle === nt));
  }

  function absorb(src) {
    const bucket = findBucket(src);
    if (!bucket) {
      buckets.push({ doi: src.doi ? src.doi.toLowerCase() : null, citekey: src.citekey ?? null, normTitle: normTitle(src.title), source: src });
      return;
    }
    bucket.source = mergeSource(bucket.source, src);
    bucket.doi = bucket.doi ?? (src.doi ? src.doi.toLowerCase() : null);
    bucket.citekey = bucket.citekey ?? src.citekey ?? null;
  }

  for (const f of all) {
    findings.push(...f.findings);
    searchLog.push(...f.searchLog);
    for (const finding of f.findings) for (const src of finding.sources) absorb(src);
  }

  const merged = buckets.map((b) => b.source);
  return {
    findings,
    sources: merged.filter((s) => s.inLibrary),
    outside: merged.filter((s) => !s.inLibrary),
    searchLog,
  };
}

/** Drops every [@key] in a skill report's body whose key was not given to the writer, so each link lands.
 *  Handles grouped citations ([@a; @b]) by keeping only the allowed keys.
 * @param {string} body @param {Set<string>} allowed */
export function stripUnknownCitations(body, allowed) {
  return body.replace(/ ?\[(@[^\]]*)\]/g, (whole, inner) => {
    const kept = inner.split(/[;,]/).map((k) => k.trim()).filter((k) => /^@\S+$/.test(k) && allowed.has(k.slice(1)));
    if (!kept.length) return '';
    return `${whole.startsWith(' ') ? ' ' : ''}[${kept.join('; ')}]`;
  });
}

/** A skill report: the writer's body with unknown citations removed, and the fields a themed report would fill left empty.
 * @param {{ title: string; scope: string; method: string; body: string }} out @param {Set<string>} allowed
 * @param {import("./domain").Source[]} references
 * @returns {import("./domain").Report} */
export function skillReport(out, allowed, references) {
  return { title: out.title, scope: out.scope, method: out.method, body: stripUnknownCitations(String(out.body ?? ''), allowed), themes: [], evidence: [], disagreements: '', gaps: '', references };
}

/** `scope` may be a pre-Z3 persisted value (`request` is read straight off request.json, never rewritten):
 *  `{ kind: "collection"; name }` still renders by its name directly, no key resolution needed for display text.
 * @param {import("./domain").Scope | { kind: "collection"; name: string }} scope */
function scopeLabel(scope) {
  if (scope.kind === 'library') return 'the whole library';
  if (scope.kind === 'collection') return `the "${scope.name}" collection`;
  if (scope.kind === 'collections') return scope.keys.length === 1 ? 'the selected collection' : scope.keys.length ? `the ${scope.keys.length} selected collections` : 'the selected collections';
  if (scope.kind === 'tag') return `papers tagged "${scope.name}"`;
  return `the "${scope.name}" saved search`;
}

/** Best-effort APA-style entry. domain.d.ts's Source carries no author field (tools never return one), so this
 *  renders title, year and an identifier rather than full author-year APA; see rationale.md's P5 reconciliation. */
function apaEntry(source) {
  const year = source.year ? ` (${source.year}).` : '.';
  const id = source.doi ? ` https://doi.org/${source.doi}` : (source.url ? ` ${source.url}` : '');
  const key = source.citekey ? ` [@${source.citekey}]` : '';
  return `${source.title}${year}${id}${key}`.replace(/[ \t]+/g, ' ').trim();
}

function methodSection(report, searchLog) {
  const rows = searchLog.length
    ? searchLog.map((e) => `| ${e.query.replace(/\|/g, '\\|')} | ${e.source} | ${e.results} |`).join('\n')
    : '| (no searches logged) | | |';
  return `${report.method}\n\n| Query | Source | Results |\n| --- | --- | --- |\n${rows}`;
}

function evidenceSection(evidence) {
  if (!evidence.length) return '(No evidence table entries.)';
  const rows = evidence.map((e) => `| ${e.claim.replace(/\|/g, '\\|')} | ${e.sources.map((k) => `[@${k}]`).join(', ') || '(none)'} | ${e.strength}${e.unverified ? ' (abstract not checked)' : ''} |`).join('\n');
  return `| Claim | Sources | Strength |\n| --- | --- | --- |\n${rows}`;
}

/**
 * @typedef {object} ReportExtras
 * @property {{ candidates: number; included: number; excluded: number; extracted: number }} counts
 * @property {import("./domain").Screening} screening
 * @property {import("./domain").ReviewTable} table
 * @property {import("./domain").Protocol | null} [protocol] systematic reviews: the PICOS protocol, reported first in the method
 */

/** "212 papers found, 164 screened out (…), 48 included, 40 extracted", every number from the files. @param {ReportExtras} x */
function methodCounts(x) {
  const { counts, screening } = x;
  const lines = [];
  if (x.protocol) {
    const p = x.protocol;
    const rows = [['Population', p.population], ['Intervention', p.intervention], ['Comparison', p.comparison], ['Outcomes', p.outcomes], ['Study designs', p.studyDesigns?.join(', ') ?? null]];
    lines.push(`\n\nProtocol:\n\n${rows.map(([k, v]) => `- ${k}: ${v ?? 'not applicable'}`).join('\n')}`);
    if (screening.criteria.length) lines.push(`\n\nCriteria:\n\n${screening.criteria.map((c) => `- ${c.text} (${c.strict ? 'strict' : 'preferred'})`).join('\n')}`);
  }
  lines.push(`\n\n${counts.candidates} papers were found. ${counts.excluded} were screened out, ${counts.included} were included, and ${counts.extracted} had data extracted.`);
  const rows = x.table?.rows ?? [];
  const unchecked = rows.filter((r) => r.abstractStatus === 'unverified');
  const blank = rows.filter((r) => r.abstractStatus === 'none');
  if (unchecked.length) lines.push(`\n\n${unchecked.length} of the ${rows.length} papers with data extracted are outside the library. Their abstracts were transcribed by the search model and could not be checked against the papers, so what was read from them is marked as unverified.`);
  if (blank.length) lines.push(`\n\n${blank.length} outside paper${blank.length === 1 ? ' came' : 's came'} back with no abstract, so nothing could be read from ${blank.length === 1 ? 'it' : 'them'}; their cells say "not reported".`);
  const by = screening.criteria.filter((c) => c.strict && screening.perCriterion[c.id]);
  if (by.length) lines.push(`\n\nExcluded by criterion: ${by.map((c) => `${c.text} (${screening.perCriterion[c.id]})`).join('; ')}.`);
  const restored = Object.values(screening.decisions).filter((d) => d.user === 'include' && d.ai === 'exclude').length;
  const removed = Object.values(screening.decisions).filter((d) => d.user === 'exclude' && d.ai !== 'exclude').length;
  if (restored || removed) lines.push(`\n\nThe researcher restored ${restored} and removed ${removed} paper${removed === 1 ? '' : 's'} after the AI's screening.`);
  return lines.join('');
}

/** @param {import("./domain").ReviewTable} table */
function extractionTable(table) {
  const cell = (c) => (c?.state === 'filled' ? c.value : c?.state === 'not_found' ? 'not reported' : '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
  const head = ['Paper', ...table.columns.map((c) => c.name.replace(/\|/g, '\\|'))];
  const rows = table.rows.map((r) => [r.ref.kind === 'paper' ? `[@${r.ref.citekey}]` : r.title.replace(/\|/g, '\\|'), ...table.columns.map((c) => cell(table.cells[r.id]?.[c.id]))]);
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

/**
 * Pure. Report + the request it answers + generation metadata -> the note body (the 7 sections) and the extra
 * front-matter fields the caller should merge into whatever its NoteSink already writes (type, review id,
 * title and date are the sink's job, per content/agent-host.js's LocalNoteSink and agent_api.py's create_ai_note).
 * @param {import("./domain").Report} report
 * @param {import("./domain").ReviewRequest} request
 * @param {{ model: string; date: string }} meta
 * @param {import("./domain").SearchLogEntry[]} searchLog the merged log from screen()'s Screened result
 * @param {ReportExtras} [extras] pipeline 2 (spec 007 §2.1): counts, screening and the extraction table
 * @returns {{ markdown: string; frontMatter: { question: string; scope: string; model: string; sources: string[] } }}
 */
export function renderReport(report, request, meta, searchLog, extras) {
  const references = [...report.references].sort((a, b) => a.title.localeCompare(b.title)).map((s) => `- ${apaEntry(s)}`).join('\n') || '(No references.)';
  const themes = report.themes.length
    ? report.themes.map((t) => `### ${t.heading}\n\n${t.body}`).join('\n\n')
    : '(No themes identified.)';

  const markdown = report.body ? [
    report.body.trim(),
    `## Method`,
    `${request.question}\n\nScope: ${scopeLabel(request.scope)}. Sources: ${request.sources.join(', ')}.\n\n${methodSection(report, searchLog)}${extras ? methodCounts(extras) : ''}`,
    `## References`,
    references,
  ].join('\n\n') : [
    `## Question and scope`,
    `${request.question}\n\nScope: ${scopeLabel(request.scope)}. Sources: ${request.sources.join(', ')}.`,
    `## Method`,
    methodSection(report, searchLog) + (extras ? methodCounts(extras) : ''),
    `## Themes`,
    themes,
    `## Evidence table`,
    evidenceSection(report.evidence),
    `## Disagreements`,
    report.disagreements || 'None found.',
    `## Gaps and future work`,
    report.gaps || '(None noted.)',
    `## References`,
    references,
    ...(extras?.table && extras.table.rows.length ? [`## Extraction table`, extractionTable(extras.table)] : []),
  ].join('\n\n');

  return {
    markdown,
    frontMatter: { question: request.question, scope: scopeLabel(request.scope), model: meta.model, sources: request.sources },
  };
}
