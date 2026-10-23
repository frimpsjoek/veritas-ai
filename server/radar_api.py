"""Reading radar (spec 012) server routes: library items, scoring candidates against a scope, a seed profile, and
the digest note. The functions take a db connection or a Searcher; http_api.py owns LOCK and the routing."""
from __future__ import annotations

import json
import math
import re
import sqlite3
import tempfile
import threading
import time
import urllib.request
from collections import Counter
from pathlib import Path

import numpy as np

import kb
import media

MAX_ITEMS = 500
TEXT_CHARS = 2000
BATCH = 64
CENTROID_WEIGHT, POSITIVE_WEIGHT = 0.7, 0.3
DIGEST_FOLDER = "Second Brain/Digests"
DIGEST_MAX_BYTES = 512 * 1024
DIGEST_NAME = re.compile(r"^[\w .()-]{1,120}$")
# Words that fill every paper title and say nothing about a topic.
GENERIC = set("""study studies using use used based analysis approach approaches new novel method methods towards toward
via review case results effect effects role model models system systems paper two between under over through
their than can more its also are not one three high low these our such show been both
we here been being other some many most very however while whereas thus then them they those both each well
shown found present provide provides demonstrate demonstrated obtain obtained within without across among
different various several including results propose proposed report reported discuss discussed particular
recent recently existing well-known first second large small good important significant potential order
may might could would should often lead leads""".split())
WORD = re.compile(r"[a-z][a-z0-9-]{2,}")


class TooLarge(ValueError):
    pass


class BadName(ValueError):
    pass


def scope_keys(db, collections: list[str] | None) -> set[str] | None:
    if not collections:
        return None
    return kb.collection_descendants(db, [str(c) for c in collections])


def _rows(db, collections: list[str] | None, hidden: set[str] = frozenset()) -> list[tuple[str, str, dict]]:
    keys = scope_keys(db, collections)
    out = []
    for path, title, meta in db.execute("SELECT path, title, meta FROM notes WHERE source='zotero' ORDER BY path"):
        if path in hidden:
            continue
        info = json.loads(meta) if meta else {}
        if keys is not None and keys.isdisjoint(info.get("collection_keys", [])):
            continue
        out.append((path, title or "", info))
    return out


def abstracts(db, paths: list[str]) -> dict[str, str]:
    """The abstract is not in notes.meta; it is the chunk(s) under the "Abstract" heading of the item's document."""
    found: dict[str, list[str]] = {}
    wanted = set(paths)
    for path, text in db.execute(
            "SELECT path, text FROM chunks WHERE path LIKE 'zotero/%' AND (heading = 'Abstract' OR heading LIKE '% > Abstract') "
            "ORDER BY path, ord"):
        if path in wanted:
            found.setdefault(path, []).append(text)
    return {p: "\n\n".join(t).strip() for p, t in found.items()}


def items(db, collections: list[str] | None, hidden: set[str] = frozenset(), slim: bool = False) -> dict:
    """`slim` leaves out abstracts and keeps three authors: the web Library's table needs neither, and the whole
    library's abstracts are most of a 4 MB reply."""
    rows = _rows(db, collections, hidden)
    notes = {} if slim else abstracts(db, [p for p, _, _ in rows])
    out = []
    for path, title, info in rows:
        row = {"key": path.removeprefix("zotero/"), "doi": info.get("doi", ""), "title": title, "year": info.get("year", ""),
               "citekey": info.get("citekey", ""), "authors": info.get("authors", [])[:3] if slim else info.get("authors", []),
               "venue": info.get("venue", "")}
        if not slim:
            row["abstract"] = notes.get(path, "")
        out.append(row)
    return {"items": out}


def _unit(v: np.ndarray) -> np.ndarray:
    return v / max(float(np.linalg.norm(v)), 1e-9)


def _embed(searcher, texts: list[str], lock, query: bool = False) -> np.ndarray:
    out = np.zeros((len(texts), kb.DIM), dtype=np.float32)
    for i in range(0, len(texts), BATCH):
        # The lock is taken per batch, not for the whole call, so searches run between batches of a long scoring.
        with lock:
            if searcher.embed is None:
                searcher.embed = kb.Embedder()
            out[i:i + BATCH] = searcher.embed(texts[i:i + BATCH], query=query)
    return out


# ---------------------------------------------------------------- seeds (spec 021)
# A radar with seeds compares each new paper with every seed and keeps the closest, instead of with one average of the
# library. A seed in the library is its whole-paper vector (the normalised mean of its chunks, Zotero full text
# included); a paper of the user's that is not in the library is its abstract, embedded here.
MAX_SEEDS = 500
FULLTEXT_MAX = 40          # whole papers read per call
FULLTEXT_CHUNKS = 40       # chunks of one paper embedded (about 56,000 characters)
ARXIV_SPACING = 3.0        # seconds between requests to arxiv.org (its terms of use)
PDF_MAX_BYTES = 40_000_000
_arxiv_lock = threading.Lock()
_arxiv_last = [0.0]


def seed_matrix(searcher, seeds: dict, lock, hidden: set[str] = frozenset()) -> tuple[np.ndarray, list[str]]:
    """Unit vectors of the seeds and their labels ("zotero/KEY", or "text:<title>"). `seeds`: {"keys": [Zotero keys],
    "collections": [collection keys], "texts": [{"title", "text"}]}."""
    keys = {f"zotero/{k}" for k in seeds.get("keys") or []}
    collections = seeds.get("collections") or []
    vectors, labels = [], []
    with lock:
        searcher._refresh()
        if collections:
            keys |= {p for p, _, _ in _rows(searcher.db, collections, hidden)}
        for path in sorted(keys - set(hidden)):
            if path in searcher.note_index:
                vectors.append(searcher.note_matrix[searcher.note_index[path]].astype(np.float32))
                labels.append(path)
    texts = [t for t in (seeds.get("texts") or []) if str(t.get("text", "")).strip()]
    if texts:
        embedded = _embed(searcher, [f"{t.get('title', '')}. {t['text']}"[:TEXT_CHARS] for t in texts], lock)
        vectors.extend(embedded)
        labels.extend(f"text:{t.get('title', '')}" for t in texts)
    if len(vectors) > MAX_SEEDS:
        raise ValueError(f"at most {MAX_SEEDS} seed papers")
    matrix = np.array([_unit(v) for v in vectors], dtype=np.float32) if vectors else np.zeros((0, kb.DIM), dtype=np.float32)
    return matrix, labels


def _closest(matrix: np.ndarray, labels: list[str], vector: np.ndarray, base: np.ndarray | None = None) -> tuple[float, str | None, float]:
    """(margin, label, similarity) of the closest seed. `base` (one value per seed) is subtracted first: a seed that is
    close to everything in the field (a long methods paper, say) would otherwise be the closest seed of almost every
    paper. The margin is what thresholds compare; the plain similarity is what people read."""
    if not len(matrix):
        return 0.0, None, 0.0
    raw = matrix @ vector.astype(np.float32)
    sims = raw - base if base is not None else raw
    best = int(sims.argmax())
    return float(sims[best]), labels[best], float(raw[best])


def _baseline(body: dict, labels: list[str], kind: str) -> np.ndarray | None:
    """The calibration's per-seed baseline for `kind` ("abstract" or "full"), lined up with `labels`; seeds it does not
    know (added since) get 0."""
    base = (body.get("baseline") or {})
    values = dict(zip(base.get("labels") or [], base.get(kind) or []))
    if not values:
        return None
    return np.array([float(values.get(label, 0.0)) for label in labels], dtype=np.float32)


def score(searcher, body: dict, lock, hidden: set[str] = frozenset()) -> dict:
    batch = body.get("items") or []
    if len(batch) > MAX_ITEMS:
        raise ValueError(f"at most {MAX_ITEMS} items per call")
    collections = (body.get("scope") or {}).get("collections")
    centroid = None
    with lock:
        searcher._refresh()
        paths = [p for p, _, _ in _rows(searcher.db, collections, hidden) if p in searcher.note_index]
        if paths:
            rows = searcher.note_matrix[[searcher.note_index[p] for p in paths]].astype(np.float32)
            centroid = _unit(rows.mean(axis=0))
    clip = lambda texts: [str(t)[:TEXT_CHARS] for t in texts if str(t).strip()]  # noqa: E731
    positives, negatives = clip(body.get("positives") or []), clip(body.get("negatives") or [])
    if positives:
        mean = _embed(searcher, positives, lock).mean(axis=0)
        centroid = _unit(mean) if centroid is None else _unit(CENTROID_WEIGHT * centroid + POSITIVE_WEIGHT * mean)
    negative_vectors = _embed(searcher, negatives, lock) if negatives else None
    vectors = _embed(searcher, [str(i.get("text", ""))[:TEXT_CHARS] for i in batch], lock) if batch else np.zeros((0, kb.DIM))
    seeds = seed_matrix(searcher, body["seeds"], lock, hidden) if body.get("seeds") else None
    base = _baseline(body, seeds[1], "abstract") if seeds is not None else None
    scores = {}
    for item, vector in zip(batch, vectors):
        similarity = float(vector @ centroid) if centroid is not None else 0.0
        negative = float((negative_vectors @ vector).max()) if negative_vectors is not None else 0.0
        scores[str(item["id"])] = {"similarity": similarity, "negative": negative}
        if seeds is not None:
            near, label, raw = _closest(*seeds, _unit(vector), base)
            scores[str(item["id"])].update(seed_max=near, seed_best=label, seed_raw=raw)
    return {"scores": scores}


# ---------------------------------------------------------------- whole new papers from arXiv (spec 021 G3)

def _cache(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    db.execute("CREATE TABLE IF NOT EXISTS fulltext (arxiv TEXT PRIMARY KEY, text TEXT, at REAL)")
    return db


def arxiv_id(value: str) -> str | None:
    """2410.01234 or 2410.01234v2, or an old-style id such as cond-mat/0601001; None for anything else."""
    value = str(value or "").strip()
    match = re.fullmatch(r"(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(v\d+)?", value)
    return match.group(1) if match else None


def fetch_arxiv_pdf(arxiv: str, fetch=None) -> bytes:
    """One PDF from arxiv.org, at most one request every ARXIV_SPACING seconds across the whole server."""
    with _arxiv_lock:
        wait = _arxiv_last[0] + ARXIV_SPACING - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        try:
            if fetch:
                return fetch(arxiv)
            request = urllib.request.Request(f"https://arxiv.org/pdf/{arxiv}", headers={"User-Agent": "SecondBrain/1.0 (reading radar)"})
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read(PDF_MAX_BYTES + 1)
            if len(data) > PDF_MAX_BYTES:
                raise ValueError("PDF too large")
            return data
        finally:
            _arxiv_last[0] = time.monotonic()


def paper_text(arxiv: str, cache_path: Path, fetch=None) -> str:
    """The text of an arXiv paper, read once and kept in the cache (the PDF itself is not kept)."""
    db = _cache(cache_path)
    try:
        row = db.execute("SELECT text FROM fulltext WHERE arxiv=?", (arxiv,)).fetchone()
        if row:
            return row[0]
        data = fetch_arxiv_pdf(arxiv, fetch)
        with tempfile.NamedTemporaryFile(suffix=".pdf") as tmp:
            tmp.write(data)
            tmp.flush()
            text = media.pdf_text(Path(tmp.name), max_pages=60, ocr=False)
        db.execute("INSERT OR REPLACE INTO fulltext VALUES (?,?,?)", (arxiv, text, time.time()))
        db.commit()
        return text
    finally:
        db.close()


def whole_vector(searcher, text: str, lock) -> np.ndarray | None:
    """The same kind of vector the index keeps for a library paper: the normalised mean of its chunks."""
    chunks = [c.text for c in kb.chunk_note(text)][:FULLTEXT_CHUNKS]
    if not chunks:
        return None
    return _unit(_embed(searcher, chunks, lock).mean(axis=0))


def fulltext(searcher, body: dict, lock, hidden: set[str] = frozenset(), cache_path: Path | None = None, fetch=None) -> dict:
    """POST /radar/fulltext {"seeds", "items": [{"id", "arxiv"}]}: each paper read whole from arXiv and compared with
    the seeds. A paper that cannot be read says why and keeps its abstract score on the caller's side."""
    batch = body.get("items") or []
    if len(batch) > FULLTEXT_MAX:
        raise ValueError(f"at most {FULLTEXT_MAX} papers per call")
    seeds = seed_matrix(searcher, body.get("seeds") or {}, lock, hidden)
    base = _baseline(body, seeds[1], "full")
    cache_path = cache_path or kb.data_dir() / "radar-fulltext.sqlite"
    scores = {}
    for item in batch:
        key = str(item.get("id"))
        arxiv = arxiv_id(item.get("arxiv", ""))
        if not arxiv:
            scores[key] = {"error": "not an arXiv paper"}
            continue
        try:
            text = paper_text(arxiv, cache_path, fetch)
        except Exception as error:  # noqa: BLE001 - one unreadable PDF must not sink the rest
            scores[key] = {"error": f"{type(error).__name__}: {error}"[:200]}
            continue
        vector = whole_vector(searcher, text, lock)
        if vector is None:
            scores[key] = {"error": "no text in the PDF"}
            continue
        near, label, raw = _closest(*seeds, vector, base)
        scores[key] = {"seed_max": near, "seed_best": label, "seed_raw": raw, "chars": len(text)}
    return {"scores": scores}


# ---------------------------------------------------------------- calibration (spec 021 G4)

def _threshold(positive: list[float], negative: list[float]) -> dict:
    """Where seeds close to each other and unrelated papers separate: midway between the 25th percentile of the first
    and the 95th of the second; if they overlap, just above the unrelated ones (and say so)."""
    pos, neg = np.array(positive or [0.0]), np.array(negative or [0.0])
    low, high = float(np.quantile(pos, 0.25)), float(np.quantile(neg, 0.95))
    overlap = low <= high
    value = high + 0.01 if overlap else (low + high) / 2
    stats = lambda a: {k: round(float(np.quantile(a, q)), 3) for k, q in (("p05", .05), ("p25", .25), ("p50", .5), ("p75", .75), ("p95", .95))}  # noqa: E731
    return {"threshold": round(value, 3), "overlap": overlap, "related": stats(pos), "unrelated": stats(neg),
            "n_related": len(positive), "n_unrelated": len(negative)}


# Of a day's papers in the user's own field, about this share should pass: the closest tenth.
FIELD_KEEP = 0.90


def _whole_vectors(searcher, papers: list[dict], limit: int, lock, cache_path: Path, fetch) -> list[np.ndarray]:
    out = []
    for u in papers:
        if len(out) >= limit:
            break
        arxiv = arxiv_id(u.get("arxiv", ""))
        if not arxiv:
            continue
        try:
            vector = whole_vector(searcher, paper_text(arxiv, cache_path, fetch), lock)
        except Exception:  # noqa: BLE001 - a PDF that cannot be read is left out
            continue
        if vector is not None:
            out.append(vector)
    return out


def _abstract_vectors(searcher, papers: list[dict], lock) -> list[np.ndarray]:
    texts = [f"{u.get('title', '')}. {u.get('abstract', '')}"[:TEXT_CHARS] for u in papers if str(u.get("abstract", "")).strip()]
    return [_unit(v) for v in _embed(searcher, texts, lock)] if texts else []


def calibrate(searcher, body: dict, lock, hidden: set[str] = frozenset(), cache_path: Path | None = None, fetch=None) -> dict:
    """POST /radar/calibrate {"seeds", "unrelated": [...], "field": [...]}; each paper {"title", "abstract", "arxiv"?}.

    `field`: recent papers from the seeds' own arXiv categories. Their mean similarity to each seed is that seed's
    baseline, subtracted before taking the closest seed, so a seed close to the whole field stops winning by default.
    Related: each library seed (abstract, and whole paper) against the other seeds; unrelated: papers from far fields.
    The threshold sits where related and unrelated separate, and never below the closest tenth of the field."""
    seeds_body = body.get("seeds") or {}
    matrix, labels = seed_matrix(searcher, seeds_body, lock, hidden)
    if len(labels) < 3:
        raise ValueError("calibration needs at least 3 seed papers")
    cache_path = cache_path or kb.data_dir() / "radar-fulltext.sqlite"
    field, unrelated = body.get("field") or [], body.get("unrelated") or []
    full_n = int(body.get("full_papers", 8))
    zero = np.zeros(len(labels), dtype=np.float32)

    def adjusted(vectors, base, skip=None):
        out = []
        for k, v in enumerate(vectors):
            sims = matrix @ v - base
            if skip is not None:
                sims = np.delete(sims, skip[k])
            out.append(float(sims.max()))
        return out

    # abstracts
    field_abs = _abstract_vectors(searcher, field, lock)
    base_abs = np.mean([matrix @ v for v in field_abs], axis=0).astype(np.float32) if field_abs else zero
    library = [i for i, label in enumerate(labels) if label.startswith("zotero/")]
    with lock:
        notes = abstracts(searcher.db, [labels[i] for i in library])
    with_abstract = [i for i in library if notes.get(labels[i])]
    seed_abs = [_unit(v) for v in _embed(searcher, [notes[labels[i]][:TEXT_CHARS] for i in with_abstract], lock)] if with_abstract else []
    abstract = _threshold(adjusted(seed_abs, base_abs, with_abstract), adjusted(_abstract_vectors(searcher, unrelated, lock), base_abs))
    if field_abs:
        field_cut = float(np.quantile(adjusted(field_abs, base_abs), FIELD_KEEP))
        abstract.update(field_cut=round(field_cut, 3), threshold=round(max(abstract["threshold"], field_cut), 3))

    # whole papers
    field_full = _whole_vectors(searcher, field, full_n, lock, cache_path, fetch)
    base_full = np.mean([matrix @ v for v in field_full], axis=0).astype(np.float32) if field_full else zero
    un_full = _whole_vectors(searcher, unrelated, full_n, lock, cache_path, fetch)
    full = None
    if un_full:
        full = _threshold(adjusted([matrix[i] for i in library], base_full, library), adjusted(un_full, base_full))
        if field_full:
            field_cut = float(np.quantile(adjusted(field_full, base_full), FIELD_KEEP))
            full.update(field_cut=round(field_cut, 3), threshold=round(max(full["threshold"], field_cut), 3))
    return {"abstract": abstract, "full": full, "seeds": len(labels), "at": time.time(),
            "baseline": {"labels": labels, "abstract": [round(float(x), 4) for x in base_abs],
                         "full": [round(float(x), 4) for x in base_full]},
            "field": {"abstracts": len(field_abs), "whole": len(field_full)}}


def _terms(text: str) -> list[str]:
    """Unigrams and bigrams; a bigram only joins two adjacent words that both survive the stopword filter."""
    words = [w if w not in kb.STOPWORDS and w not in GENERIC else None for w in WORD.findall(text.lower())]
    grams = [w for w in words if w]
    grams += [f"{a} {b}" for a, b in zip(words, words[1:]) if a and b]
    return grams


def _phrases(title: str) -> list[str]:
    """Two- and three-word runs of a title with no stopword inside; a title's own phrasing makes a usable search."""
    words = [w if w not in kb.STOPWORDS and w not in GENERIC else None for w in WORD.findall(title.lower())]
    out = []
    for n in (2, 3):
        out += [" ".join(run) for run in zip(*(words[i:] for i in range(n))) if all(run)]
    return out


def _stem(phrase: str) -> str:
    """Singular and plural count as one phrase ("quantum dot" / "quantum dots")."""
    return " ".join(w[:-1] if len(w) > 3 and w.endswith("s") and not w.endswith("ss") else w for w in phrase.split())


def profile(db, collections: list[str] | None, hidden: set[str] = frozenset(), keys: list[str] | None = None) -> dict:
    """Seed topics are title phrases, scored by how often the scope uses them against how common they are in the
    whole library, longer phrases first: single words ("quantum", "materials") made poor search queries. `keys`
    narrows the scope to those papers (a radar's seeds, spec 021 G2)."""
    scope = _rows(db, collections, hidden)
    if keys is not None:
        wanted = {f"zotero/{k}" for k in keys}
        scope = [row for row in scope if row[0] in wanted]
    df = Counter(_stem(g) for (title,) in db.execute("SELECT title FROM notes WHERE source='zotero'") for g in set(_phrases(title or "")))
    n = max(db.execute("SELECT count(*) FROM notes WHERE source='zotero'").fetchone()[0], 1)
    surface: dict[str, Counter] = {}
    tf = Counter()
    for _, title, _ in scope:
        for g in set(_phrases(title or "")):
            tf[_stem(g)] += 1
            surface.setdefault(_stem(g), Counter())[g] += 1
    # A two-word phrase that is mostly half of a longer one ("covalent organic" in "covalent organic frameworks")
    # gives way to the longer phrase.
    for gram, c in list(tf.items()):
        if gram.count(" ") == 2:
            words = gram.split()
            for half in (" ".join(words[:2]), " ".join(words[1:])):
                if half in tf and c >= 0.6 * tf[half]:
                    tf[half] = 0
    floor = 3 if len(scope) >= 50 else 2 if len(scope) >= 5 else 1
    whole = len(scope) >= 0.9 * n
    def value(gram: str, c: int) -> float:
        rarity = 1.0 if whole else math.log((n + 1) / (df[gram] + 1)) + 1
        return c * rarity * (1 + 0.5 * (gram.count(" ")))
    ranked = sorted(((value(g, c), g) for g, c in tf.items() if c >= floor), reverse=True)
    top: list[tuple[float, str]] = []
    for score, gram in ranked:
        if any(gram in chosen or chosen in gram for _, chosen in top):
            continue  # "density functional" next to "density functional theory" says the same thing
        top.append((score, gram))
        if len(top) == 12:
            break
    best = top[0][0] if top else 1.0
    count = lambda values: [{"name": k, "count": c} for k, c in Counter(v for v in values if v).most_common(15)]  # noqa: E731
    return {"topics": [{"text": surface[g].most_common(1)[0][0], "weight": round(v / best, 3)} for v, g in top],
            "authors": count(a for _, _, info in scope for a in info.get("authors", [])),
            "journals": count(info.get("venue", "") for _, _, info in scope)}


def put_digest(name: str, text: str) -> dict:
    if not isinstance(name, str) or not DIGEST_NAME.match(name) or name.strip(" .") != name or ".." in name:
        raise BadName("a digest name is letters, digits, spaces and . ( ) - _ (at most 120), with no slashes")
    data = text.encode("utf-8")
    if len(data) > DIGEST_MAX_BYTES:
        raise TooLarge("a digest is at most 512 KB")
    folder = kb.VAULT / DIGEST_FOLDER
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{name}.md"
    if folder.is_symlink() or target.is_symlink() or target.resolve().parent != folder.resolve():
        raise BadName("that digest path is outside the Digests folder")
    with tempfile.NamedTemporaryFile(dir=folder, prefix=".digest-", delete=False) as tmp:
        tmp.write(data)
    Path(tmp.name).replace(target)  # atomic: Obsidian never sees half a file
    return {"path": f"{DIGEST_FOLDER}/{name}.md", "size": len(data)}
