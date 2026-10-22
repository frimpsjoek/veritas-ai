// Spec 012 (Reading radar) data shapes. See specs/012-reading-radar/plan.md section 2.
import type { Scope } from "./domain";

export type ScholarlySource = "openalex" | "semanticscholar" | "arxiv" | "crossref" | "europepmc" | "biorxiv" | "chemrxiv";
export type Origin = "seed" | "user" | "learned";
/** `papers`: how many liked papers taught a learned topic (spec 017), shown as "from 3 papers you kept". */
export interface Weighted { text: string; weight: number; origin: Origin; papers?: number }
/** `match` is how OpenAlex described the person or journal it matched ("Giulia Galli, U Chicago, 781 works"), kept so the
 *  setup sheet can show it again on edit; null when nothing matched. */
export interface Followed { name: string; openalexId: string | null; weight: number; origin: Origin; match?: string | null }
export interface RadarProfile { topics: Weighted[]; authors: Followed[]; journals: Followed[] }

export type RadarSource = { id: string; on: boolean } & (
  | { kind: "database"; db: ScholarlySource }
  | { kind: "feed"; url: string; title: string }
  | { kind: "journal"; openalexId: string; name: string; issn: string | null }
  | { kind: "author"; openalexId: string; name: string }
  | { kind: "mcp"; server: string; tool: string; args?: Record<string, unknown> });

export interface RadarConfig {
  scope: Scope;
  profile: RadarProfile;
  sources: RadarSource[];
  /** `discover` is the cap on "Might interest you" rows (spec 014); absent on radars saved before it, which get the default. */
  size: { fresh: number; older: number; discover?: number };
  note: boolean;
  /** Spec radar-seeds: the papers new ones are compared with, one by one. Absent on radars made before it (centroid scoring). */
  seeds?: RadarSeeds;
  /** Spec radar-seeds G4: calibrated on the user's library when the seeds were chosen. */
  threshold?: RadarThreshold;
}

/** One of the user's own papers (found through OpenAlex). `key` when it is in the Zotero library (its whole-paper
 *  vector is used); otherwise its abstract stands in. */
export interface MyPaper { title: string; year: number | null; doi: string | null; key: string | null; abstract: string; openalexId: string | null }
export interface RadarSeeds {
  /** The user's own papers they ticked. */
  mine: MyPaper[];
  /** Further library papers (Zotero keys) and whole collections (keys). */
  papers: string[];
  collections: string[];
  author: { name: string; orcid: string | null; openalexId: string | null } | null;
  /** arXiv categories the seeds were posted in, most first (cond-mat.mtrl-sci); arXiv lists them whole each run. */
  categories: string[];
}
export interface ThresholdStats { threshold: number; overlap: boolean; related: Record<string, number>; unrelated: Record<string, number>; n_related: number; n_unrelated: number;
  /** The similarity that keeps the closest tenth of the seeds' own field; the threshold is never below it. */
  field_cut?: number }
/** Per seed, its mean similarity to recent papers of its own field; subtracted before the closest seed is taken. */
export interface SeedBaseline { labels: string[]; abstract: number[]; full: number[] }
export interface RadarThreshold {
  /** A new paper judged on its abstract is kept at or above this. */
  abstract: number;
  /** One read whole from arXiv, at or above this; null until calibrated with whole papers. */
  full: number | null;
  calibration?: { abstract: ThresholdStats; full: ThresholdStats | null; seeds: number; at: string; baseline?: SeedBaseline | null; field?: { abstracts: number; whole: number } } | null;
}

/** What a fetcher returns before normalising: scholarly.js results, feed items and MCP text rows all fit. */
export interface RawPaper {
  doi?: string | null; arxiv?: string | null; openalexId?: string | null; title?: string; authors?: string[];
  venue?: string; date?: string | null; year?: number | null; abstract?: string; url?: string | null;
  /** The source's record type (OpenAlex `type`, Crossref `type` mapped, arXiv `preprint`); absent for feeds and MCP rows. */
  kind?: string | null;
  /** The source's own keywords or concepts for the paper (OpenAlex concepts); phrase learning reads them (spec 017). */
  keywords?: string[];
}

export type PaperId = string; // 'doi:<lower>' | 'arxiv:<id>' | 'title:<normalised>'

export interface RadarWhy {
  similarity: number; author: number; journal: number; topic: number; negative: number;
  /** Spec radar-seeds: the closest seed ("zotero/KEY" or "text:<title>"), its title, and whether the paper was read whole. */
  seed?: { label: string; title: string; whole: boolean; margin?: number };
  /** Worth reading rows: how many library papers cite it (and up to 3 titles), and how many of this run's New rows. */
  citedBy?: { count: number; titles: string[]; newCount?: number };
  /** The learned topic this row matched (spec 017): the why-line says so. */
  learned?: string;
}

export interface RadarItem {
  id: PaperId; doi: string | null; arxiv: string | null; openalexId: string | null;
  title: string; authors: string[]; venue: string; date: string | null; year: number | null;
  abstract: string; url: string | null; links: string[]; sources: string[]; kind?: string | null; keywords?: string[];
  score?: number; why?: RadarWhy;
  /** Worth reading rows: OpenAlex citation count and the plain-language reason shown on the row. */
  cites?: number; reason?: string;
}

export interface LibraryItem { key: string; doi: string | null; title: string; year: number | null; citekey: string | null; authors?: string[]; venue?: string; abstract?: string }

export type ScoreScope = { collections: string[] | null };
/** What the server needs to know the seeds by (radar_api.seed_matrix). */
export interface SeedBody { keys: string[]; collections: string[]; texts: { title: string; text: string }[] }
export interface ScoreRequest { scope: ScoreScope; positives: string[]; negatives: string[]; items: { id: string; text: string }[]; seeds?: SeedBody; baseline?: SeedBaseline | null }
/** `seed_max`: the margin over the closest seed's baseline (what thresholds compare); `seed_raw`: its plain similarity (what is shown). */
export interface SeedScore { similarity: number; negative: number; seed_max?: number; seed_best?: string | null; seed_raw?: number }
export interface SeedProfile { topics: { text: string; weight: number }[]; authors: { name: string; count: number }[]; journals: { name: string; count: number }[] }

/** `liked`: a thumbs-up, a positive example like `later` but nothing is saved. */
export type Verdict = "shown" | "added" | "later" | "liked" | "dismissed";
export interface Example { id: PaperId; text: string; at: string }
/** `suggestRemove`: three dismissals in a row from this source (spec 012 section 7); the setup sheet shows it quietly. */
export interface SourceStatus { at: string; items: number; error: string | null; quietRuns: number; suggestRemove?: boolean;
  /** Spec radar-seeds G2b: the last 7 days of runs, how many items it gave and how many were kept. */
  history?: { at: string; items: number; kept: number }[];
  /** Records the run left out as not papers (datasets, theses, repository uploads), for databases, journals and authors. */
  skipped?: number }
/** What feedback needs to know about a paper a digest showed, kept for the newest rows only. */
export interface ShownPaper { keys: string[]; title: string; text: string; authors: string[]; venue: string; sources: string[]; keywords?: string[] }
/** A change the radar made to its own profile after an Add: `created` means the entry did not exist before. */
export interface LearnedEntry { id: string; paper: PaperId; title: string; kind: "author" | "venue"; name: string; created: boolean; at: string }
/** A phrase seen in liked papers but not yet a search topic (spec 017). `key` is the folded, stemmed, sorted word set. */
export interface PhraseCandidate { key: string; text: string; papers: PaperId[] }
/** Spec 017: the learning list, phrases never to learn again, the run counter that picks the rotating search slot,
 *  and phrases promoted since the last digest (its summary says "Now also searching"). */
export interface PhraseLedger { learning: PhraseCandidate[]; blocked: string[]; rotation: number; announce: string[] }
/** One change a click made to the profile's learned topics or the ledger; `revert` replays them backwards. */
export type PhraseDelta =
  | { kind: "counted"; key: string }
  | { kind: "promoted"; key: string; candidate: PhraseCandidate; evicted?: Weighted }
  | { kind: "weight"; key: string; delta: number; papers: number }
  | { kind: "dropped"; topic: Weighted; blocked: boolean; announced: boolean };
/** Exactly what one verdict changed, so `undo` can put it back. */
export interface UndoRecord {
  verdict: Exclude<Verdict, "shown">;
  /** The verdict this one replaced (re-applied when this one is undone). */
  replaced: Exclude<Verdict, "shown"> | null;
  seen: Record<string, Verdict | null>;
  pushed: { list: "positive" | "negative"; id: PaperId } | null;
  /** Examples the cap pushed out of the front of the list that was pushed to. */
  dropped: Example[];
  learned: string[];
  streaks: Record<string, { streak: number | null; suggestRemove: boolean | null }>;
  /** Spec 017: what the click taught or took back (absent on records made before it). */
  phrases?: PhraseDelta[];
}
export type FeedbackVerdict = "added" | "later" | "liked" | "dismissed" | "undo";
export interface RadarState {
  seen: Record<PaperId, { at: string; verdict: Verdict }>;
  sourceStatus: Record<string, SourceStatus>;
  feedCache: Record<string, { etag: string | null; modified: string | null }>;
  refs: Record<string, { at: string; ids: string[]; id?: string }>;
  examples: { positive: Example[]; negative: Example[] };
  /** spec 012 R4: the newest rows' details (for examples and learning), the log of self-made profile changes, dismissals in
   *  a row per source, and the undo record of each paper's last verdict. */
  shown: Record<PaperId, ShownPaper>;
  learned: LearnedEntry[];
  streaks: Record<string, number>;
  undo: Record<PaperId, UndoRecord>;
  /** Spec 017; absent in state files written before it, read as empty. */
  phrases: PhraseLedger;
}

/** A journal OpenAlex knows, as the setup sheet offers it. */
export interface JournalOption { openalexId: string; name: string; issn: string | null; match: string }
/** What `radar.checkSource` makes of what the user typed. `error` is a plain sentence for the user. */
export type SourceCheck =
  | { kind: "feed"; url: string; title: string; items: number }
  | { kind: "feed-blocked"; url: string; reason: string; journals: JournalOption[] }
  | { kind: "journals"; options: JournalOption[] }
  | ({ kind: "journal" } & JournalOption)
  | { kind: "error"; message: string };
