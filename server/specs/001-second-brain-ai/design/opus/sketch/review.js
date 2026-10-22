// @ts-check
// agent-src/review.js. The literature review as a stage table over files in reviews/<id>/.
// Resume = first stage whose output file is missing. Status is derived from the files, never stored beside them.
/** @typedef {import("./domain").ReviewRequest} ReviewRequest */
/** @typedef {import("./domain").ReviewStatus} ReviewStatus */
/** @typedef {import("./domain").StageId} StageId */
/** @typedef {import("./domain").Plan} Plan */
/** @typedef {import("./domain").Report} Report */
/** @typedef {import("./domain").NotePath} NotePath */

/**
 * Where a finished report goes. Sidecar: POST /ai-note on the Python server (collision-safe create under WRITE_LOCK,
 * ai_notes/Literature Reviews/YYYY-MM-DD <title>.md). Zotero standalone: the plugin's local notes folder.
 * `reviewId` is written into front matter, so a second call finds the existing note instead of creating a copy.
 * @typedef {{ publish(reviewId: string, markdown: string, title: string): Promise<NotePath> }} NoteSink
 */

/**
 * @typedef {object} StageCtx
 * @property {ReviewRequest} request
 * @property {(file: string) => Promise<any>} read        reads an earlier stage's output
 * @property {(file: string, value: unknown) => Promise<void>} write  atomic; a partial file never exists
 * @property {(file: string) => Promise<boolean>} has
 * @property {import("./core").TurnRunner} turns          role-aware: picks ModelChoice from settings, takes a slot
 * @property {NoteSink} notes
 * @property {{ autoApprove: boolean }} settings
 * @property {AbortSignal} signal
 */

/**
 * @typedef {object} Stage
 * @property {StageId} id
 * @property {string} output        the file whose existence means "done"
 * @property {(ctx: StageCtx) => Promise<unknown | typeof WAIT>} run   returns WAIT when a human must act first
 */

export const WAIT = Symbol("wait-for-human");

/** @type {Stage[]} */
export const REVIEW_STAGES = [
  { id: "plan",       output: "plan.json",          run: planStage },       // lead turn, outputSchema = Plan
  { id: "approve",    output: "approved-plan.json", run: approveStage },    // copies plan when autoApprove, else WAIT
  { id: "research",   output: "findings.json",      run: researchStage },   // fan-out; per-sub-question files inside
  { id: "screen",     output: "screened.json",      run: screenStage },     // pure: dedupe by DOI then citekey, split outside-library
  { id: "synthesize", output: "report.json",        run: synthesizeStage }, // writer turn, outputSchema = Report
  { id: "publish",    output: "note.json",          run: publishStage },    // renderReport (pure) -> NoteSink -> {path}
];

/**
 * Runs from the first missing output to the end, or to WAIT. Safe to call twice: the second caller joins the
 * in-flight run (one AbortController per review id in the runtime), and a crash at any point resumes cleanly
 * because every output is written atomically after its stage finishes.
 * @param {StageCtx} ctx
 * @returns {Promise<void>}
 */
export async function runReview(ctx) { throw new Error("not implemented"); }

/**
 * Research resumes per sub-question, not per stage: findings/<sqId>.json is written as each researcher finishes,
 * and only missing ones run again. Researchers run through ctx.turns with role "researcher", so the runtime-wide
 * slot pool (not this function) enforces the cap. When all exist, merge into findings.json.
 * @param {StageCtx} ctx
 */
/** @param {StageCtx} ctx */ async function researchStage(ctx) {
  // const plan = await ctx.read("approved-plan.json");
  // const todo = plan.subQuestions.filter(sq => !(await ctx.has(`findings/${sq.id}.json`)));
  // await Promise.allSettled(todo.map(sq => ctx.turns.structured("researcher", researcherPrompt(ctx.request, sq), FINDINGS_SCHEMA,
  //   { scope: ctx.request.scope, sources: sq.sources, agentId: sq.id }, ctx.signal).then(f => ctx.write(`findings/${sq.id}.json`, f))));
  // a failed researcher leaves its file missing: stage fails as "stopped", Resume retries only that one
  throw new Error("not implemented");
}

/** Pure. @param {import("./domain").Findings[]} all @returns {import("./domain").Screened} */
export function screen(all) { throw new Error("not implemented"); }

/** Pure. Report -> Markdown with the seven sections, front matter (type, question, scope, model, date, sources, reviewId), APA references. */
export function renderReport(/** @type {Report} */ report, /** @type {ReviewRequest} */ request, /** @type {object} */ meta) { throw new Error("not implemented"); }

/**
 * Status from the directory listing alone: note.json -> done; approve missing and plan present and not autoApprove
 * -> awaiting_approval; stopped.json (reason) present -> stopped; else running at the first missing stage.
 * @param {string[]} files @param {boolean} inFlight @returns {ReviewStatus}
 */
export function deriveStatus(files, inFlight) { throw new Error("not implemented"); }

/** @param {StageCtx} ctx */ async function planStage(ctx) { throw new Error("not implemented"); }
/** @param {StageCtx} ctx */ async function approveStage(ctx) { throw new Error("not implemented"); }
/** @param {StageCtx} ctx */ async function screenStage(ctx) { throw new Error("not implemented"); }
/** @param {StageCtx} ctx */ async function synthesizeStage(ctx) { throw new Error("not implemented"); }
/** @param {StageCtx} ctx */ async function publishStage(ctx) { throw new Error("not implemented"); }
