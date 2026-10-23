# Reading radar

Every morning the reading radar writes a digest of new papers close to your work and shows it on **Home**.

## How it chooses papers

1. **Seeds.** It starts from the papers you wrote (found through OpenAlex by your name or ORCID; you tick which
   ones count), and from any papers or Zotero collections you add as further seeds.
2. **Calibration.** When the radar is created, it measures how close your seed papers are to each other, to papers
   from unrelated fields, and to the day's papers in your own field. The threshold sits where those separate, so
   a long methods paper cannot pull in the whole field.
3. **Candidates.** Each run looks at what was published since the last run (at most 7 days back) in arXiv,
   journals, the databases you switch on and the RSS feeds you follow.
4. **Scoring.** Each candidate is compared with each seed. Papers that pass on the abstract are read whole (arXiv
   full text) and scored again.
5. **Digest.** Up to 15 papers a day are kept. Each one says which of your papers it is close to.

## Sources

Settings > Reading radar lists the sources: arXiv (on by default), journals, databases such as OpenAlex, Crossref,
Europe PMC, bioRxiv, medRxiv and ChemRxiv, and any RSS or Atom feed (paste its address). Each feed shows how many
items it gave in the last 7 days and how many were kept, so a feed that never gives anything relevant is easy to
drop.

## Likes and dislikes

Each paper has three buttons: **Add to Zotero**, **Like** and **Dislike**. Likes and dislikes adjust later scores,
together with the authors, journals and topics you follow.

## Where digests live

Each run writes `Second Brain/Digests/<date> <radar name>.md` in your output folder. The chat can read them: ask
"What was my reading digest today about?".
