"""Labelled queries for the retrieval benchmark (bench.py), made automatically from an existing index.

The generator opens kb.sqlite read-only and, with a fixed random seed, writes queries whose right answer is known
because the query was cut from that answer:

  known_item/title            a 4-6 word span of the paper's title
  known_item/author_year      first author's surname and the year ("Núñez 2021"); every paper that matches is gold
  known_item/doi              the DOI as stored
  known_item/citekey          the Better BibTeX citation key. Citekeys are kept only in notes.meta, which is not
                              indexed, so this type is expected to score near zero until that changes.
  abstract/abstract           one sentence of the abstract with the title's words taken out
  passage/passage             one sentence of a full-text chunk; gold = the paper and every chunk holding it
  entity/entity_hyphen        a 5-8 word span around a hyphenated token with a capital or digit (X-ray, K-edge)
  entity/entity_formula       ... around a formula-like token (TiO2, G0W0, CsPbBr3)
  entity/entity_accent        ... around a word with an accented letter (Núñez, Schrödinger)
  filtered/filtered_collection  a title span searched inside one of the paper's collections
  filtered/filtered_year      a title span searched within the paper's year +- 1
  no_answer/no_answer_pseudo  three made-up words that occur nowhere in the index
  no_answer/no_answer_words   three everyday English words that occur nowhere in the index

Gold papers: the source paper first, then every other copy of it in the library (same DOI or same title, which the
user files twice) and, for title spans and author-year, every paper the query names equally well. Sentences and
spans that occur in more than one paper are skipped, so each query has one answer.

These are sentence-copy queries: their words are the words of the answer, which favours keyword match. The scores
are a regression floor for exact recall (does a change lose papers that a copied phrase finds today?), not a
measure of how well search understands a paraphrased question. eval.py's hand-written paraphrases (private
vault only) are the meaning-side check.

The query file holds text from the library, so it is written outside the repository (bench.py refuses otherwise).
"""
from __future__ import annotations

import bisect
import json
import random
import re
import sqlite3
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote

STOPWORDS = set("""a an and are as at be but by did do does for from had has have how i in is it its my of on or
so that the their there this to was we were what when where which who why will with you your me about into via
using based new than then these those our not can also between under over toward towards""".split())

TYPES = {"title": "known_item", "author_year": "known_item", "doi": "known_item", "citekey": "known_item",
         "abstract": "abstract", "passage": "passage", "entity_hyphen": "entity", "entity_formula": "entity",
         "entity_accent": "entity", "filtered_collection": "filtered", "filtered_year": "filtered",
         "no_answer_pseudo": "no_answer", "no_answer_words": "no_answer"}

# Everyday words unlikely in a physics/chemistry library; only those absent from the index are used.
EVERYDAY = """trombone sandcastle umbrella pancake giraffe lullaby marmalade saxophone toboggan hammock pickleball
croissant flamingo lasagna kayak trampoline cupcake bagpipe scarecrow snorkel waffle accordion dandelion moccasin
porcupine tambourine walrus yodel zucchini burrito cactus doughnut eggplant gondola harmonica igloo jellybean ketchup
lemonade meatball noodle omelette parsnip quiche raccoon spaghetti tulip ukulele volleyball wombat yogurt badminton
cauliflower dumpling flipflop gingerbread hopscotch jukebox kangaroo lollipop mittens nutmeg origami pinball
pretzel rhubarb sombrero teapot unicycle vanilla windmill bobsled chimney dollhouse fireplace goldfish horseshoe
icicle jigsaw kitten ladybug muffin nightgown overalls popcorn quilt rollerblade slipper toothbrush wardrobe""".split()

SYLLABLES = [c + v for c in "bdfgklmnprstvz" for v in "aeiou"] + ["qua", "zor", "vex", "plim", "drub", "skon"]

YEAR = re.compile(r"(?<!\d)(?:19|20)\d{2}(?!\d)")
NUMBER = re.compile(r"(?<![\w.])\d+(?:\.\d+)?(?![\w.])")
SENTENCE_BREAK = re.compile(r"(?<=[.!?])\s+(?=[A-Z(\[\"'])")
HYPHEN = re.compile(r"(?<![\w-])[^\W_]+(?:-[^\W_]+)+(?![\w-])")
FORMULA = re.compile(r"(?<![\w-])(?:[A-Z][a-z]?\d*){2,}(?![\w-])")
WORD = re.compile(r"(?<![\w-])[^\W\d_]{3,}(?![\w-])")
SPECIAL_LATIN = set("øØłŁßæÆđĐðÐþÞıœŒ")


def sentences(text: str) -> list[str]:
    """Sentences of `text` with whitespace collapsed (line breaks inside a sentence become spaces)."""
    flat = " ".join(text.split())
    return [s for s in SENTENCE_BREAK.split(flat) if s]


def is_reference_like(sentence: str) -> bool:
    """True for bibliography entries, URLs and number-heavy lines: poor queries, and not prose about the paper."""
    lower = sentence.lower()
    if "et al" in lower or "http" in lower or "www." in lower or "doi" in lower:
        return True
    if len(YEAR.findall(sentence)) >= 2 or re.search(r"\((?:19|20)\d{2}\)", sentence):
        return True
    if re.search(r"\b[A-Z][\w'-]+, [A-Z]\.", sentence):  # "Surname, I."
        return True
    if re.search(r"\b(?:Phys|Chem|Rev|Lett|Mater|Nat|Proc|Sci|Soc|Am|Appl)\.\s", sentence):
        return True
    if len(NUMBER.findall(sentence)) >= 6:
        return True
    digits = sum(c.isdigit() for c in sentence)
    return digits > 0.15 * max(len(sentence), 1)


def _prose(sentence: str, low: int = 10, high: int = 40) -> bool:
    words = sentence.split()
    letters = sum(c.isalpha() for c in sentence)
    return (low <= len(words) <= high and sentence[:1].isupper() and sentence[-1:] in ".!?"
            and letters >= 0.6 * len(sentence) and not is_reference_like(sentence))


def _title_words(title: str) -> set[str]:
    return {w.lower() for w in re.findall(r"[\w-]+", title) if len(w) > 2} - STOPWORDS


def strip_title_words(sentence: str, title: str) -> str:
    """`sentence` without the title's content words (and their plural/singular), keeping its final punctuation."""
    title_words = _title_words(title)
    stems = {w.rstrip("s") for w in title_words}
    kept = []
    for token in sentence.split():
        core = token.strip(".,;:!?()[]\"'").lower()
        if core in title_words or (len(core) > 3 and core.rstrip("s") in stems):
            continue
        kept.append(token)
    out = " ".join(kept)
    end = sentence[-1:]
    if end in ".!?" and not out.endswith(end):
        out = out.rstrip(".,;:") + end
    return out


def _accented(word: str) -> bool:
    for ch in word:
        if ord(ch) < 128 or not ch.isalpha():
            continue
        if ch in SPECIAL_LATIN or any(unicodedata.combining(c) for c in unicodedata.normalize("NFKD", ch)):
            return True
    return False


def entity_tokens(text: str) -> dict[str, list[str]]:
    """Hyphenated tokens with a capital or digit (X-ray, K-edge), formula-like tokens (TiO2, G0W0) and words
    with accented Latin letters (Núñez), each list unique and in order of appearance."""
    out: dict[str, list[str]] = {"hyphen": [], "formula": [], "accent": []}
    for tok in HYPHEN.findall(text):
        if any(c.isalpha() for c in tok) and any(c.isupper() or c.isdigit() for c in tok) and len(tok) <= 30:
            out["hyphen"].append(tok)
    for tok in FORMULA.findall(text):
        if any(c.isdigit() for c in tok) and len(tok) >= 3:
            out["formula"].append(tok)
    for tok in WORD.findall(text):
        if _accented(tok):
            out["accent"].append(tok)
    return {k: list(dict.fromkeys(v)) for k, v in out.items()}


def surname(author: str) -> str:
    author = author.strip()
    if not author:
        return ""
    if "," in author:
        return author.split(",")[0].strip()
    return author.split()[-1]


def _norm(text: str) -> str:
    return " ".join(text.split()).lower()


def _norm_doi(doi) -> str:
    return re.sub(r"^(https?://(dx\.)?doi\.org/|doi:)", "", str(doi or "").strip().lower())


def _norm_title(title: str) -> str:
    return " ".join(re.findall(r"\w+", (title or "").lower()))


# ---------------------------------------------------------------- reading the index

def connect_readonly(db_path: Path) -> sqlite3.Connection:
    """The index opened read-only (never written, never checkpointed). A WAL-mode file in a folder we may not
    write falls back to immutable mode, which is safe while nothing else writes it."""
    path = quote(str(Path(db_path).resolve()))
    try:
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        db.execute("SELECT 1 FROM notes LIMIT 1").fetchall()
        return db
    except sqlite3.OperationalError:
        return sqlite3.connect(f"file:{path}?immutable=1", uri=True)


@dataclass
class Paper:
    path: str
    title: str
    meta: dict
    abstract: str = ""
    full_text: list[tuple[int, str]] = field(default_factory=list)  # (chunk id, text)
    chunks: list[tuple[int, str]] = field(default_factory=list)


class Corpus:
    def __init__(self, db_path: Path) -> None:
        db = connect_readonly(db_path)
        self.papers: dict[str, Paper] = {}
        for path, title, meta in db.execute("SELECT path, title, meta FROM notes WHERE source='zotero' ORDER BY path"):
            self.papers[path] = Paper(path, title or "", json.loads(meta) if meta else {})
        abstracts: dict[str, list[str]] = {}
        texts: list[str] = []
        for cid, path, heading, text in db.execute(
                "SELECT c.id, c.path, c.heading, c.text FROM chunks c ORDER BY c.path, c.ord"):
            texts.append(_norm(text or ""))
            paper = self.papers.get(path)
            if paper is None:
                continue
            paper.chunks.append((cid, text or ""))
            heading = heading or ""
            section = heading[len(paper.title) + 3:].split(" > ")[0] if heading.startswith(paper.title + " > ") else ""
            if section == "Abstract":
                abstracts.setdefault(path, []).append(text or "")
            elif section == "Full text":
                paper.full_text.append((cid, text or ""))
        for path, parts in abstracts.items():
            self.papers[path].abstract = "\n\n".join(parts)
        titles = [_norm(t or "") + " " + (tags or "").lower() for t, tags in db.execute("SELECT title, tags FROM notes")]
        self.all_text = "\x00".join(texts + titles)  # every source, for "occurs nowhere" checks
        self.collections = {key: parent for key, parent in db.execute("SELECT key, parent FROM collections")}
        self.n_chunks = len(texts)
        db.close()
        self._groups()
        self._group_blobs()

    def _groups(self) -> None:
        """Copies of one paper (same DOI or same title) are one answer."""
        parent = {p: p for p in self.papers}

        def find(x: str) -> str:
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        first: dict[str, str] = {}
        for path, paper in self.papers.items():
            for key in ("t:" + _norm_title(paper.title), "d:" + _norm_doi(paper.meta.get("doi"))):
                if key in ("t:", "d:"):
                    continue
                if key in first:
                    parent[find(path)] = find(first[key])
                else:
                    first[key] = path
        groups: dict[str, list[str]] = {}
        for path in self.papers:
            groups.setdefault(find(path), []).append(path)
        self.group_of = {p: find(p) for p in self.papers}
        self.members = {root: sorted(paths) for root, paths in groups.items()}

    def _group_blobs(self) -> None:
        roots = sorted(self.members)
        parts, self._starts, self._roots, offset = [], [], [], 0
        for root in roots:
            blob = "\x00".join(_norm(text) for path in self.members[root] for _, text in self.papers[path].chunks)
            self._starts.append(offset)
            self._roots.append(root)
            parts.append(blob)
            offset += len(blob) + 1
        self._blob = "\x01".join(parts)

    def groups_containing(self, phrase: str, cap: int = 2) -> set[str]:
        """Groups (by root path) whose text holds `phrase` (normalised), stopping after `cap` groups."""
        phrase = _norm(phrase)
        found: set[str] = set()
        start = self._blob.find(phrase)
        while start >= 0 and len(found) < cap:
            i = bisect.bisect_right(self._starts, start) - 1
            found.add(self._roots[i])
            nxt = self._starts[i + 1] if i + 1 < len(self._starts) else len(self._blob)
            start = self._blob.find(phrase, nxt)
        return found

    def gold(self, path: str) -> list[str]:
        """The source paper first, then its copies."""
        return [path] + [p for p in self.members[self.group_of[path]] if p != path]

    def descendants(self, key: str) -> set[str]:
        out, stack = set(), [key]
        while stack:
            k = stack.pop()
            if k not in out:
                out.add(k)
                stack += [c for c, p in self.collections.items() if p == k]
        return out

    def chunks_with(self, paths: list[str], sentence: str) -> list[int]:
        s = _norm(sentence)
        return [cid for p in paths for cid, text in self.papers[p].chunks if s in _norm(text)]

    def occurs(self, word: str) -> bool:
        return word.lower() in self.all_text


# ---------------------------------------------------------------- generation

def _title_span(title: str, rng: random.Random) -> str | None:
    words = title.split()
    if len(words) < 4:
        return None
    for _ in range(6):
        n = rng.randint(4, min(6, len(words)))
        start = rng.randint(0, len(words) - n)
        span = words[start:start + n]
        span[0] = span[0].lstrip("([\"'")
        span[-1] = span[-1].rstrip(".,;:)]\"'?!")
        if sum(w.lower() not in STOPWORDS for w in span) >= 2 and all(span):
            return " ".join(span)
    return None


def _papers_with_title_span(corpus: Corpus, span: str) -> list[str]:
    needle = f" {_norm_title(span)} "
    return [p for p, paper in corpus.papers.items() if needle in f" {_norm_title(paper.title)} "]


def _ordered(first: str, others) -> list[str]:
    return [first] + sorted(set(others) - {first})


def _entity_window(sentence: str, token: str, kind: str, rng: random.Random) -> str | None:
    words = sentence.split()
    hits = [i for i, w in enumerate(words) if token in entity_tokens(w)[kind]]
    if not hits or len(words) < 5:
        return None
    i = rng.choice(hits)
    n = rng.randint(5, min(8, len(words)))
    start = rng.randint(max(0, i - n + 1), min(i, len(words) - n))
    span = " ".join(words[start:start + n]).strip(".,;:()[]")
    return span if token in entity_tokens(span)[kind] else None


def generate(db_path: Path, seed: int = 0, per_type: int = 200) -> dict:
    corpus = Corpus(Path(db_path))
    rng = random.Random(seed)
    paths = sorted(corpus.papers)
    queries: list[dict] = []
    counts: dict[str, int] = {}

    def add(subtype: str, query: str, gold: list[str], **extra) -> None:
        n = counts.get(subtype, 0)
        counts[subtype] = n + 1
        queries.append({"id": f"{subtype}-{n:04d}", "type": TYPES[subtype], "subtype": subtype, "query": query,
                        "gold_papers": gold, "gold_chunks": extra.pop("gold_chunks", []),
                        "filters": extra.pop("filters", {}), **extra})

    def shuffled(items):
        items = list(items)
        rng.shuffle(items)
        return items

    def full(subtype: str) -> bool:
        return counts.get(subtype, 0) >= per_type

    # known item: title span
    for path in shuffled(paths):
        if full("title"):
            break
        span = _title_span(corpus.papers[path].title, rng)
        if span:
            add("title", span, _ordered(path, (q for p in _papers_with_title_span(corpus, span) for q in corpus.gold(p))))

    # known item: first author + year
    by_name: dict[tuple[str, str], list[str]] = {}
    for path, paper in corpus.papers.items():
        authors, year = paper.meta.get("authors") or [], str(paper.meta.get("year") or "")
        if authors and year and surname(authors[0]):
            by_name.setdefault((surname(authors[0]).casefold(), year), []).append(path)
    for path in shuffled(paths):
        if full("author_year"):
            break
        paper = corpus.papers[path]
        authors, year = paper.meta.get("authors") or [], str(paper.meta.get("year") or "")
        name = surname(authors[0]) if authors else ""
        if name and year and any(c.isalpha() for c in name):
            same = by_name[(name.casefold(), year)]
            add("author_year", f"{name} {year}", _ordered(path, (q for p in same for q in corpus.gold(p))),
                ambiguous=len(same))

    # known item: DOI, citekey
    for subtype, key in (("doi", "doi"), ("citekey", "citekey")):
        for path in shuffled(paths):
            if full(subtype):
                break
            value = (corpus.papers[path].meta.get(key) or "").strip()
            if value:
                add(subtype, value, corpus.gold(path))

    # abstract sentence without the title's words
    for path in shuffled(paths):
        if full("abstract"):
            break
        paper = corpus.papers[path]
        options = [s for s in sentences(paper.abstract) if _prose(s, 8, 45)]
        rng.shuffle(options)
        for sentence in options:
            query = strip_title_words(sentence, paper.title)
            if len(query.split()) >= 6 and len(corpus.groups_containing(sentence)) == 1:
                gold = corpus.gold(path)
                add("abstract", query, gold, source_sentence=sentence, gold_chunks=corpus.chunks_with(gold, sentence),
                    title_words_removed=len(sentence.split()) - len(query.split()))
                break

    # passage: a sentence of a full-text chunk (papers drawn uniformly, so long reviews do not dominate)
    for path in shuffled(p for p in paths if corpus.papers[p].full_text):
        if full("passage"):
            break
        chunks = [(cid, t) for cid, t in corpus.papers[path].full_text
                  if len(YEAR.findall(t)) < 8 and t.lower().count("et al") < 4]
        rng.shuffle(chunks)
        for cid, text in chunks[:5]:
            options = [s for s in sentences(text) if _prose(s)]
            if not options:
                continue
            sentence = rng.choice(options)
            if len(corpus.groups_containing(sentence)) == 1:
                gold = corpus.gold(path)
                add("passage", sentence, gold, gold_chunks=corpus.chunks_with(gold, sentence))
                break

    # entity and formula forms: a short span around the token, from the abstract or full text
    entity_cache: dict[str, dict[str, list[tuple[str, str]]]] = {}

    def entity_options(path: str, kind: str) -> list[tuple[str, str]]:
        if path not in entity_cache:
            paper = corpus.papers[path]
            found: dict[str, list[tuple[str, str]]] = {"hyphen": [], "formula": [], "accent": []}
            for t in [paper.abstract] + [t for _, t in paper.full_text]:
                for s in sentences(t):
                    if _prose(s, 5, 60):
                        for k, toks in entity_tokens(s).items():
                            found[k] += [(s, tok) for tok in toks]
            entity_cache[path] = found
        return entity_cache[path][kind]

    for kind in ("hyphen", "formula", "accent"):
        subtype = f"entity_{kind}"
        for path in shuffled(paths):
            if full(subtype):
                break
            options = entity_options(path, kind)
            if not options:
                continue
            sentence, token = rng.choice(options)
            span = _entity_window(sentence, token, kind, rng)
            if span and len(corpus.groups_containing(span)) == 1:
                add(subtype, span, corpus.gold(path), token=token)

    # filtered known item: a title span inside one collection, or within the year +- 1
    for path in shuffled(paths):
        if full("filtered_collection"):
            break
        keys = corpus.papers[path].meta.get("collection_keys") or []
        span = _title_span(corpus.papers[path].title, rng)
        if keys and span:
            key = rng.choice(sorted(keys))
            inside = corpus.descendants(key)
            gold = [p for p in _ordered(path, (q for p in _papers_with_title_span(corpus, span) for q in corpus.gold(p)))
                    if set(corpus.papers[p].meta.get("collection_keys") or []) & inside]
            add("filtered_collection", span, gold, filters={"collections": [key]})
    for path in shuffled(paths):
        if full("filtered_year"):
            break
        year = str(corpus.papers[path].meta.get("year") or "")
        span = _title_span(corpus.papers[path].title, rng)
        if year.isdigit() and span:
            y = int(year)
            gold = [p for p in _ordered(path, (q for p in _papers_with_title_span(corpus, span) for q in corpus.gold(p)))
                    if str(corpus.papers[p].meta.get("year") or "").isdigit()
                    and y - 1 <= int(corpus.papers[p].meta["year"]) <= y + 1]
            add("filtered_year", span, gold, filters={"year_from": y - 1, "year_to": y + 1})

    # no answer: words that occur nowhere in the index (roots checked too, since keyword search stems)
    def absent(word: str) -> bool:
        root = re.sub(r"(?:es|s|ing|ed)$", "", word) if len(word) > 5 else word
        return not corpus.occurs(word) and not corpus.occurs(root)

    attempts = 0
    while not full("no_answer_pseudo") and attempts < per_type * 50:
        attempts += 1
        words = ["".join(rng.choice(SYLLABLES) for _ in range(rng.randint(2, 3))) for _ in range(3)]
        if all(absent(w) for w in words):
            add("no_answer_pseudo", " ".join(words), [])
    everyday = [w for w in EVERYDAY if absent(w)]
    if len(everyday) >= 3:
        for _ in range(per_type):
            add("no_answer_words", " ".join(rng.sample(everyday, 3)), [])

    return {"version": 1, "seed": seed, "per_type": per_type, "db": str(db_path),
            "index": {"chunks": corpus.n_chunks, "papers": len(corpus.papers),
                      "full_text_papers": sum(bool(p.full_text) for p in corpus.papers.values()),
                      "everyday_words_usable": len(everyday)},
            "counts": counts, "queries": queries}
