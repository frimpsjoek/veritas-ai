// @ts-check
// agent-src/src/estimate.js. What a research report costs before it runs, in model turns (spec 011 U1).
// Pure: it reads the depth tables and the batch sizes the stages themselves use, so it moves with them.
// A "turn" is one model call. Elicit shows an invented usage multiplier; turns are what we can count.

import { DEPTH_PRESETS, REPORT_CAPS, SYSTEMATIC_CAPS } from './prompts.js';
import { PAPERS_PER_TURN } from './extract.js';

/**
 * What a typical run reaches. Live runs 2026-10-07: quick found 23 of 60 and included 13; standard found 28 of 150 and
 * extracted 12. Papers found barely grow with the cap (the researchers stop when they run dry), so the typical haul is
 * a base plus a little per sub-question, capped at a share of the cap; about half of what is found gets included.
 */
const FOUND_BASE = 15;
const FOUND_PER_SUBQUESTION = 3;
const FOUND_SHARE_CAP = 0.4;
const INCLUDED_SHARE = 0.5;

/** @typedef {{ turns: number; low: number; high: number; range: string }} ReportEstimate `range` reads "12-20", or "12" when they agree. */

/**
 * @param {"fastest" | "quick" | "standard" | "deep"} depth
 * @param {{ systematic?: boolean; text?: "abstract" | "head" | "best"; autoApprove?: boolean }} [options]
 * @returns {ReportEstimate} `turns` is a typical run; `low` finds few papers and no retries; `high` fills every cap and retries each researcher once.
 */
export function estimateReport(depth, options = {}) {
  const preset = DEPTH_PRESETS[depth] ?? DEPTH_PRESETS.standard;
  const caps = (options.systematic ? SYSTEMATIC_CAPS : REPORT_CAPS)[depth] ?? REPORT_CAPS.standard;
  // Fastest reads abstracts only and, outside a systematic review, has no screening turn at all.
  const fastest = depth === 'fastest';
  const text = fastest ? 'abstract' : (options.text ?? 'head');
  const perScreen = PAPERS_PER_TURN.head;
  const perExtract = PAPERS_PER_TURN[text] ?? PAPERS_PER_TURN.head;
  const fixed = (options.autoApprove ? 0 : 1) + 1 + 1; // clarify, plan, writer

  /** @param {number} found @param {number} researcherTurns */
  const total = (found, researcherTurns) => {
    const skipScreen = fastest && !options.systematic;
    const included = Math.min(caps.extract, skipScreen ? found : Math.round(found * INCLUDED_SHARE));
    return fixed + researcherTurns + (skipScreen ? 0 : Math.ceil(found / perScreen)) + Math.ceil(included / perExtract);
  };
  const typicalFound = Math.min(Math.round(caps.candidates * FOUND_SHARE_CAP), FOUND_BASE + FOUND_PER_SUBQUESTION * preset.subQuestions);
  const turns = total(typicalFound, preset.subQuestions);
  const low = Math.min(turns, total(Math.round(typicalFound / 2), preset.subQuestions));
  const high = Math.max(turns, total(Math.min(caps.candidates, typicalFound * 2), preset.subQuestions * 2));
  return { turns, low, high, range: low === high ? String(low) : `${low}-${high}` };
}
