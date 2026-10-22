import type { AgentProvider } from "./provider";
import type { ToolRegistry } from "./tools";

export type StageId = "plan" | "research" | "screen" | "synthesize";

export interface ReviewSpec {
  question: string;
  scope: { kind: "library" | "collection" | "tag" | "saved-search"; ref?: string };
  sources: { library: boolean; scholarly: boolean; web: boolean };
  yearRange?: [number, number];
  depth: "quick" | "standard" | "deep";           // sets sub-question / researcher-agent count
  providers: { lead: string; researcher: string; writer: string };  // provider ids
  planApproval: "pause" | "auto";
}

export interface PlanOutput { subQuestions: { text: string; searchStrategy: string }[] }
export interface Claim { text: string; sources: { ref: unknown; quote: string }[]; confidence: "low" | "medium" | "high" }
export interface FindingsOutput { bySubQuestion: { subQuestion: string; claims: Claim[] }[] }
export interface ScreenedOutput { claims: Claim[]; outOfLibraryPapers: { title: string; doi?: string; citekey?: string }[] }
export interface ReportOutput { markdown: string; sections: string[] }        // 7 sections, checked by caller

/** Matches spec.md's REVIEW_STAGES table exactly: run() is pure given its input, outputFile is the resume marker.
 *  No separate status field anywhere — the source of truth for "what's done" is which files exist on disk. */
export interface ReviewStage<I, O> {
  id: StageId;
  outputFile: string;                 // e.g. "plan.json"
  run(input: I, ctx: StageContext): Promise<O>;
}

export interface StageContext {
  spec: ReviewSpec;
  registry: ToolRegistry;
  providers: Map<string, AgentProvider>;  // role -> provider, resolved from spec.providers
  cap: ParallelCap;
  signal: AbortSignal;
  emit(event: ReviewEvent): void;
}

export type ReviewEvent =
  | { type: "stage_started"; stage: StageId }
  | { type: "stage_completed"; stage: StageId }
  | { type: "agent_status"; stage: StageId; agentIndex: number; status: "running" | "done" | "error" }
  | { type: "paper_found"; title: string; inLibrary: boolean }
  | { type: "cancelled" }
  | { type: "failed"; stage: StageId; message: string };

/** A plain counting semaphore. The single enforcement point for the parallel-researcher cap (default 3, max 5,
 *  per grounding.md's "14 parallel processes swapped this Mac"); shared across every review the owning process
 *  runs, not one per review, since the constraint is on the process's total concurrency. */
export class ParallelCap {
  constructor(_max: number) { throw new Error("not implemented"); }
  withSlot<T>(_fn: () => Promise<T>): Promise<T> { throw new Error("not implemented"); }
}

export class ReviewRunner {
  private constructor(_dir: string, _stages: ReviewStage<any, any>[]) { throw new Error("not implemented"); }

  static start(_dir: string, _spec: ReviewSpec, _ctx: Omit<StageContext, "spec" | "emit">): ReviewRunner {
    throw new Error("not implemented");
  }

  /** Resume = read the review dir, find the first stage whose outputFile is missing, continue from there. This
   *  function IS the resume feature; there is no separate "resumability" module. */
  static resume(_dir: string, _ctx: Omit<StageContext, "spec" | "emit">): ReviewRunner {
    throw new Error("not implemented");
  }

  run(): AsyncIterable<ReviewEvent> { throw new Error("not implemented"); }
  cancel(): Promise<void> { throw new Error("not implemented"); }   // aborts the shared AbortController
}

export const REVIEW_STAGES: ReviewStage<any, any>[] = [
  { id: "plan", outputFile: "plan.json", run: () => { throw new Error("not implemented"); } },
  { id: "research", outputFile: "findings.json", run: () => { throw new Error("not implemented"); } },
  { id: "screen", outputFile: "screened.json", run: () => { throw new Error("not implemented"); } },
  { id: "synthesize", outputFile: "report.md", run: () => { throw new Error("not implemented"); } },
];
