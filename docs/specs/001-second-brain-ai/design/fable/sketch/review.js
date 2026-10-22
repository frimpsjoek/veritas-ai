// Literature review: a stage table over per-actor files. start === resume === "run the first stage whose output is missing".
/** @typedef {import("./types").ReviewInput} ReviewInput */
/** @typedef {import("./types").ReviewState} ReviewState */
/** @typedef {import("./types").ReviewEvent} ReviewEvent */

/**
 * @typedef {object} ReviewCtx
 * @property {import("./types").ReviewId} id
 * @property {ReviewInput} input
 * @property {import("./store").ReviewStore} store       reads/writes data/reviews/<id>/*
 * @property {(role: "lead"|"researcher"|"writer", request: import("./types").TurnRequest, signal: AbortSignal) => Promise<import("./types").TurnResult>} turn  a gated structured turn on the role's provider
 * @property {import("./types").ToolSet} tools
 * @property {(ev: ReviewEvent) => void} emit
 * @property {AbortSignal} signal
 * @property {(title: string, fm: object, body: string) => Promise<{path: string}>} writeReport
 */

/** @type {{ id: import("./types").StageId, output: string, run: (ctx: ReviewCtx) => Promise<void> }[]} */
export const REVIEW_STAGES = [
  { id: "plan",       output: "plan.json",     run: planStage },
  { id: "research",   output: "findings.done", run: researchStage },   // marker written after every findings/<sq>.json exists
  { id: "screen",     output: "screened.json", run: screenStage },
  { id: "synthesize", output: "report.md",     run: synthesizeStage },
];

/** Depth → sub-question count and researcher parallelism (still capped by the runtime Gate). */
export const DEPTH = { quick: { subQuestions: 3, parallel: 2 }, standard: { subQuestions: 5, parallel: 3 }, deep: { subQuestions: 8, parallel: 5 } };

/**
 * Runs stages from the first missing output. Idempotent: rerunning after a crash or cancel redoes only unfinished work.
 * Stops with status awaiting-approval after plan.json when input.autoApprovePlan is false and approved.json is absent.
 * @returns {Promise<ReviewState>}
 */
export async function runReview(ctx) { throw new Error("not implemented"); }

/** Pure. State from what exists on disk plus whether the signal is aborted. */
export function deriveState(id, input, files, aborted) { throw new Error("not implemented"); }

/** Lead: structured PlanOutput via ctx.turn("lead", { schema: PLAN_SCHEMA }); writes plan.json. */
async function planStage(ctx) { throw new Error("not implemented"); }

/**
 * Researchers: one gated turn per sub-question without a findings/<sq>.json, at most DEPTH[depth].parallel in flight.
 * Each writes only its own file (per-actor state). Emits agent.status and paper.found as claims arrive.
 */
async function researchStage(ctx) { throw new Error("not implemented"); }

/** Pure merge + dedupe by DOI then citekey; marks inLibrary through tools.call("search_library"). No model call. */
async function screenStage(ctx) { throw new Error("not implemented"); }

/** Writer: the seven sections from screened.json; validates citations; writeReport(); writes report.md and its path. */
async function synthesizeStage(ctx) { throw new Error("not implemented"); }

/** Pure. Report front matter (type: literature-review, question, scope, models, date, sources) and body from ScreenedOutput + writer text. */
export function renderReport(input, screened, writerText) { throw new Error("not implemented"); }
