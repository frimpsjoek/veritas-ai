# U4 Routines: final service API (engine part 2)

Date: 2026-10-07. Matches u4-design.md section 2 with the details below. Types are in `agent-src/src/domain.d.ts`
(`Routine`, `RoutineDraft`, `RoutineView`, `RoutineSchedule`, `RoutineTarget`, `RoutineRun`) and `service.d.ts` (`routines`).

```ts
routines: {
  list(): Promise<RoutineView[]>;                       // Routine & { nextRun: string | null (ISO; null unless active), running: boolean }
  create(draft: RoutineDraft): Promise<Routine>;        // draft: { prompt (required), name?, skills?, depth?, schedule, target?, sources?, scope?, status? }
  update(id: string, patch: Partial<RoutineDraft>): Promise<Routine>;   // a changed schedule sets lastSlot = now
  runNow(id: string): Promise<{ started: boolean; reason?: string }>;   // returns at once; the run is recorded in lastRun
  pause(id: string): Promise<Routine>;
  resume(id: string): Promise<Routine>;                 // "restore" from Archived/Paused is resume
  archive(id: string): Promise<Routine>;
  adopt(records: Routine[]): Promise<string[]>;
}
```

- `list()` also returns one `BrokenRoutine` (`{ broken: true, id, file, name, problem }`) per routine file that could not be read
  (not JSON, no usable id, invalid schedule); `name` is the file name and `problem` a plain reason. They are never scheduled
  (the scheduler reads the store, which still skips them). The Routines view splits them off (`splitBroken`) and shows one line
  above the list: "1 routine file could not be read: <name> — <problem>". Tell them apart with `broken`.
- `Routine`: `id, name, prompt, skills[], depth, schedule, target, sources, scope, status, created, updated, lastSlot, lastDone?, lastRun, notify`.
  `lastDone` = ISO of the last run that finished `done` (the `since` window starts from it).
- `lastRun`: `{ at, slot, status: 'done'|'failed'|'skipped', reason?, added?, session?, review?, writes?, summary? }`.
  `reason` also carries "ran without skill X" notes on a `done` run, and the skip text (`Codex window 63% used at 07:30`).
- `target`: `{ kind:'artifact', session, result:{id} }` or `{ kind:'session' }`. `sources` is either a `Sources` object
  `{papers,notes,scholarly,web}` or `null` (default: library papers + scholarly).
- Artifact runs write a new version only when rows were added: `PapersResult.addedRows?: RowId[]`, step input
  `{ kind:'routine', routine, on, since }`, ActivityLine icon `search`, title "Routine found N new papers".
- Session runs: `conversations.create` conversation whose `meta` carries `routine: <id>` (`ConversationSummary.routine?`).
- `providers.status()[i].usage` = `{ kind:'rate_limit', percentUsed, windowMinutes, at, resetsAt? }` once a turn reported one.
- `ReviewProgress.usage?: string` = the last rate-limit notice text of that review ("Codex: 63% of the 5h window used").
- HTTP (agentd): `GET /routines`, `POST /routines`, `POST /routines/update {id, patch}`, `POST /routines/run {id}`,
  `POST /routines/pause|resume|archive {id}`, `POST /routines/adopt {records}`. `remote.js` mirrors them.
- Runtime deps: `createLocalRuntime({ clock?, routines?: { isOwner?, tickMs?, startupGraceMs? } })`.
