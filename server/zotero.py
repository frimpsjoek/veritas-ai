"""Reads the local Zotero library as documents for the index: one per top-level item.

Each document holds the item's metadata, abstract, the user's child notes, PDF highlights and comments, and the
full text Zotero already extracted (storage/<attachment key>/.zotero-ft-cache), so no PDF is parsed here.

zotero.sqlite is read through SQLite's backup API into a private copy: consistent even while Zotero is open and
writing (the database is in WAL mode), and Zotero's own file is never opened for writing.
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import time
import unicodedata
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import abstracts
import paths

ZOTERO = Path(os.environ.get("KB_ZOTERO", Path.home() / "Zotero"))  # the default library
# The library the functions below read, when it is not the default one (several libraries, phase 2 task 3). A context
# variable, so one request or index stage switching library never changes what another thread reads.
_LIBRARY: ContextVar[Path | None] = ContextVar("zotero_library", default=None)


def root() -> Path:
    """The library being read: the one set by `library()`, else the default."""
    return _LIBRARY.get() or ZOTERO


@contextmanager
def library(path: Path):
    """Reads `path`'s library inside the block: `with zotero.library(lab): zotero.documents()`."""
    token = _LIBRARY.set(path)
    try:
        yield path
    finally:
        _LIBRARY.reset(token)
PREFIX = "zotero/"  # index paths look like zotero/ABCD1234; they are not vault files
SKIP_TYPES = ("attachment", "note", "annotation")
# Status tags written by Zotero plugins (#broken, #nosource, /unread, linter/error, zotmoov, notion): not topics.
HOUSEKEEPING_TAG = re.compile(r"^([#/]|linter/)|^(zotmoov|notion)$", re.I)
_TITLE_STOPWORDS = frozenset("the and for with from into using based study their this that".split())
MIN_TITLE_WORDS = 3  # a title with fewer judged words is "short": it needs its whole wording and the authors
MIN_TITLE_MATCH = 0.5  # the share of the title's words the top of a text must contain to count as this item's
# ... and never fewer than this many words: two words of a title ("density functional" of "Density functional
# theory") are in every text of the field. A three-word title therefore needs all three.
MIN_TITLE_HITS = 3
# A weaker title match still counts when the author line confirms it (the known false reject "Large scale GW
# calculations": one of three title words, both authors on the first page, no DOI in the text).
MIN_TITLE_WITH_AUTHORS = 0.25
MIN_AUTHOR_MATCH = 0.5
# The author line confirms only with at least this many surnames (all of them when the item has fewer): an author's
# own CV or statement carries that one name, a paper's first page carries its authors.
MIN_AUTHOR_HITS = 2
# Where a document names itself: its title, authors and DOI are on its first page, and a publisher's cover page adds
# one more. 4,000 folded characters cover a dense page plus a cover (measured on the real library 2026-11-04: every
# attachment whose own DOI or author line appears later than this was one of the doubtful cases, not a paper whose
# front matter came late). A reference list or a CV that merely cites this paper repeats its title and DOI, but
# much later in the text, so the whole text is no longer scanned.
HEAD_CHARS = 4000
# A cache with fewer characters (of any script, whitespace folded) holds no text to judge by: a scan, a picture.
MIN_TEXT_CHARS = 200
# Part of the index stamp (kb.py): a change here re-reads every library on the next ordinary index run.
#   1: DOI or half the title's words anywhere in the text.
#   2: DOI, title or authors in the first HEAD_CHARS only; author line as a second signal; near-empty caches dropped;
#      overrides (text_overrides.json); highlights of a rejected attachment dropped with its text.
#   3: DOI matched whole; a title alone must sit near the top; publication lists rejected; a text nothing can be
#      judged by is "unknown" and not admitted, instead of getting the benefit of the doubt.
#   4: "empty" measured in characters of any script, so a non-Latin text is judged; the verbatim title only for a
#      non-Latin title, whole; a short title needs its wording and the authors; a title alone needs three of its
#      words; the DOI matched on the text itself, punctuation kept; the authors confirm with two surnames; a CV
#      known by its section headings rejected; a library that cannot be read to judge refuses (fail closed).
TEXT_GUARD_VERSION = 4
MIN_EXACT_TITLE_CHARS = 8  # a shorter non-Latin title could turn up by chance
TITLE_NEAR_CHARS = 1200  # a paper's own title sits in its first lines; further down it may be a citation of it
# Words a CV or publication list carries near its top and a paper does not ("publications" alone is in publisher names).
LISTING_MARKERS = ("curriculum vitae", "list of publications", "selected publications", "peer reviewed publications",
                   "research experience", "work experience", "professional experience")
# Section headings of a CV: a line that is nothing but one of these. One such line proves little (a journal prints
# "Education" as an article type, a publisher's logo reads "Publications"); two different ones in the head of a text
# make it a CV. "References" is left out: papers have that section.
CV_HEADINGS = frozenset((
    "education", "publications", "employment", "employment history", "appointments", "academic appointments",
    "professional appointments", "awards", "honors", "honours", "honors and awards", "awards and honors", "skills",
    "technical skills", "research interests"))
MIN_CV_HEADINGS = 2
DOI_SHAPE = re.compile(r"10\.\d{4,9}/\S+")
OVERRIDES_FILE = "text_overrides.json"  # in the data folder (paths.data_dir): {attachment key: "mine" | "foreign"}
OVERRIDE_VALUES = ("mine", "foreign")


def _folded(text: str) -> str:
    """Lower case letters and digits only, words kept apart, tags and accents dropped, for comparing text."""
    plain = unicodedata.normalize("NFKD", re.sub(r"<[^>]+>", " ", html.unescape(text or "")))
    return re.sub(r"[^a-z0-9]+", " ", plain.encode("ascii", "ignore").decode().lower())


@dataclass(frozen=True)
class TextDecision:
    """Why an attachment's cached text is, or is not, taken as its item's. Carries no text."""
    accepted: bool
    reason: str  # override:mine, override:foreign, override:invalid, empty, listing, doi, title, title+authors,
    #              title_exact, title_short, unknown, unverified, foreign
    doi_hit: bool = False
    title_fraction: float = 0.0  # share of the title's judged words in the head of the text
    author_fraction: float = 0.0  # share of the authors' surnames in the head of the text
    chars: int = 0  # characters in the cache, of any script, whitespace folded

    @property
    def foreign(self) -> bool:
        """Rejected as another document's, or as impossible to judge or to check (not merely empty)."""
        return not self.accepted and self.reason != "empty"


def overrides_file() -> Path:
    return paths.data_dir() / OVERRIDES_FILE


def overrides_stamp() -> str:
    """Changes when the overrides file changes, for the index stamp: an edit there must re-read Zotero (spec 026 R3)."""
    try:
        return hashlib.sha1(overrides_file().read_bytes()).hexdigest()
    except OSError:
        return ""


def _exact(text: str) -> str:
    """Case and whitespace folded, every script kept: `_folded` drops what is not Latin, this does not."""
    return " ".join(unicodedata.normalize("NFKC", html.unescape(re.sub(r"<[^>]+>", " ", text or ""))).casefold().split())


def text_overrides(file: Path | None = None) -> dict[str, str]:
    """{attachment key: "mine" | "foreign"} from the data folder's text_overrides.json (or `file`, another install's).
    A missing file is no override; a malformed file is reported once per read and treated as no override (the
    heuristic still applies, so nothing is admitted by the failure); an entry with any other value is kept and
    judged as "invalid", which rejects that attachment's text, since the user meant to decide it by hand."""
    file = file or overrides_file()
    try:
        raw = json.loads(file.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as error:
        print(f"zotero: {file} ignored: {error}", file=sys.stderr)
        return {}
    if not isinstance(raw, dict):
        print(f"zotero: {file} ignored: expected an object of attachment keys", file=sys.stderr)
        return {}
    return {str(k).strip(): (v.strip().lower() if isinstance(v, str) else repr(v)) for k, v in raw.items()}


def _doi_pattern(doi: str) -> re.Pattern | None:
    """Matches the item's DOI in `_exact` text, whole. The text's own punctuation is kept: folded to spaces,
    10.1000/abc also matched 10.1000/abc.def. Not preceded by a letter, digit or dot; not followed by a letter or
    digit, nor by DOI punctuation and then one (so a sentence's full stop after the DOI is fine, ".def" is not). A
    line break after a punctuation mark inside the DOI is allowed. None when the field holds no DOI."""
    bare = re.sub(r"^(https?://(dx\.)?doi\.org/|doi:\s*)", "", _exact(doi)).strip()
    if not DOI_SHAPE.fullmatch(bare):
        return None
    inner = "".join(re.escape(c) + ("" if c.isalnum() else " ?") for c in bare)
    return re.compile(r"(?<![0-9a-z.])" + inner + r"(?![0-9a-z])(?![./_:;()<>\[\]#+-][0-9a-z])")


def _non_latin(title: str) -> bool:
    """True when most of the title's letters are lost by `_folded` (Chinese, Cyrillic, Greek, Arabic ...), so its
    words cannot be counted and only the verbatim title can be looked for."""
    letters = sum(c.isalnum() for c in _exact(title))
    return letters > 0 and 2 * len(_folded(title).replace(" ", "")) < letters


def _cv_headings(text: str) -> int:
    """How many different CV section headings stand on a line of their own in the head of the text."""
    return len({_folded(line).strip() for line in text[:HEAD_CHARS].splitlines()} & CV_HEADINGS)


def judge_text(title: str, doi: str, text: str, authors: list[str] | tuple[str, ...] = (),
               attachment_key: str = "", overrides: dict[str, str] | None = None) -> TextDecision:
    """Whether an attachment's cached text is this item's document, and why.

    Zotero keeps an attachment's .zotero-ft-cache even after the file has moved or been replaced, so a cache can hold
    another document, including a private one. Such text must not be indexed, shown or cited under this item's name.
    Only the head of the text is read (HEAD_CHARS): a document names itself at the start, while a document that
    merely cites this item (a reference list, a CV) does so later.

    A cache with fewer than MIN_TEXT_CHARS characters of any script is "empty": not indexed, and not called
    foreign, since there is nothing to judge by. Rejected next: a text with a CV or publication-list marker, or two
    CV section headings ("listing"). Then, in order:
    - the item's whole DOI in the head;
    - for a non-Latin title, the title verbatim and whole in the first TITLE_NEAR_CHARS, else "unknown";
    - for a short title (fewer than MIN_TITLE_WORDS judged words), the title's wording near the top together with
      the authors; "unknown" when the item has no usable author or title;
    - at least half the title's judged words (longer than three letters, not a stopword), and at least
      MIN_TITLE_HITS of them, in the first TITLE_NEAR_CHARS;
    - a quarter of the title's words in the head together with the authors.
    "The authors" means half the surnames and at least MIN_AUTHOR_HITS of them (all, when the item has fewer).
    A text none of these can speak to is "unknown" and not admitted. A heuristic cannot be right every time:
    `text_overrides.json` is the backstop for both a false reject and a false accept.
    """
    override = (overrides if overrides is not None else text_overrides()).get(attachment_key) if attachment_key else None
    if override is not None:
        if override == "mine":
            return TextDecision(True, "override:mine")
        return TextDecision(False, "override:foreign" if override == "foreign" else "override:invalid")
    exact = _exact(text)
    if len(exact) < MIN_TEXT_CHARS:
        return TextDecision(False, "empty", chars=len(exact))
    body = _folded(text).strip()
    head = f" {body[:HEAD_CHARS]} "
    near = f" {body[:TITLE_NEAR_CHARS]} "
    doi_pattern = _doi_pattern(doi)
    doi_hit = bool(doi_pattern and doi_pattern.search(exact[:HEAD_CHARS]))
    words = [w for w in _folded(title).split() if len(w) > 3 and w not in _TITLE_STOPWORDS]
    surnames = [s for s in (_folded(a).split()[-1] if _folded(a).split() else "" for a in authors) if len(s) > 3]
    title_fraction = sum(f" {w} " in head for w in words) / len(words) if words else 0.0
    near_hits = sum(f" {w} " in near for w in words)
    author_hits = sum(f" {s} " in head for s in surnames)
    author_fraction = author_hits / len(surnames) if surnames else 0.0
    authors_confirm = bool(surnames) and author_fraction >= MIN_AUTHOR_MATCH and author_hits >= min(MIN_AUTHOR_HITS, len(surnames))
    facts = dict(doi_hit=doi_hit, title_fraction=round(title_fraction, 3), author_fraction=round(author_fraction, 3), chars=len(exact))
    if any(f" {marker} " in head for marker in LISTING_MARKERS) or _cv_headings(text) >= MIN_CV_HEADINGS:
        return TextDecision(False, "listing", **facts)
    if doi_hit:
        return TextDecision(True, "doi", **facts)
    if _non_latin(title):
        exact_title = _exact(title)
        found = len(exact_title) >= MIN_EXACT_TITLE_CHARS and re.search(
            rf"(?<!\w){re.escape(exact_title)}(?!\w)", exact[:TITLE_NEAR_CHARS])
        return TextDecision(bool(found), "title_exact" if found else "unknown", **facts)
    if len(words) < MIN_TITLE_WORDS:
        wording = _folded(title).strip()
        if not wording or not surnames:
            return TextDecision(False, "unknown", **facts)
        found = f" {wording} " in near and authors_confirm
        return TextDecision(found, "title_short" if found else "foreign", **facts)
    if near_hits >= max(MIN_TITLE_HITS, MIN_TITLE_MATCH * len(words)):
        return TextDecision(True, "title", **facts)
    if title_fraction >= MIN_TITLE_WITH_AUTHORS and authors_confirm:
        return TextDecision(True, "title+authors", **facts)
    return TextDecision(False, "foreign", **facts)


def text_belongs_to_item(title: str, doi: str, text: str, authors: list[str] | tuple[str, ...] = (),
                         attachment_key: str = "", overrides: dict[str, str] | None = None) -> bool:
    """True when `judge_text` accepts the text (see there)."""
    return judge_text(title, doi, text, authors, attachment_key, overrides).accepted


def _read_cache(cache: Path) -> str:
    return cache.read_text(encoding="utf-8", errors="replace")


def attachment_text_decision(att_key: str) -> TextDecision | None:
    """The guard's decision for one attachment key (for routes that hand out the attachment's file): None when the
    attachment has no cached text to judge by, is not in the library or has no parent item. When the library
    cannot be read to judge (the copy of zotero.sqlite failed, or its rows cannot be queried), the decision is a
    rejection, "unverified": failing open would hand out exactly the files the guard exists to hold back."""
    try:
        db = snapshot("reader", max_age=60)
    except (sqlite3.Error, OSError, RuntimeError):
        return TextDecision(False, "unverified")
    try:
        row = db.execute(
            """SELECT a.parentItemID FROM itemAttachments a JOIN items i USING(itemID) WHERE i.key=?""", (att_key,)).fetchone()
        if not row or row[0] is None:
            return None
        fields = {name: str(value) for name, value in db.execute(
            """SELECT f.fieldName, v.value FROM itemData d JOIN fields f USING(fieldID) JOIN itemDataValues v USING(valueID)
               WHERE d.itemID=?""", (row[0],))}
        authors = [" ".join(p for p in (first, last) if p) for first, last in db.execute(
            """SELECT c.firstName, c.lastName FROM itemCreators ic JOIN creators c USING(creatorID)
               WHERE ic.itemID=? ORDER BY ic.orderIndex""", (row[0],))]
    except sqlite3.Error:
        return TextDecision(False, "unverified")
    finally:
        db.close()
    cache = root() / "storage" / att_key / ".zotero-ft-cache"
    if not cache.is_file():
        return None
    return judge_text(fields.get("title") or fields.get("shortTitle") or "", fields.get("DOI", ""), _read_cache(cache),
                      authors, att_key)


def _judged_items(overrides: dict[str, str] | None = None):
    """Every item of the default library that has an attachment with cached text, with the guard's decision for each:
    (item key, the item's own texts, [(attachment key, decision, cached text, the user's highlights and comments)]).
    The own texts are the title, abstract and child notes. Reads its own copy of the database ("audit"), so it
    never touches the indexer's copy. The texts are for deciding and for building probes; callers never print them."""
    db = snapshot("audit")
    q = lambda sql, *args: db.execute(sql, args).fetchall()  # noqa: E731
    try:
        deleted = {r[0] for r in q("SELECT itemID FROM deletedItems")}
        items = q("SELECT i.itemID, i.key, t.typeName FROM items i JOIN itemTypes t USING(itemTypeID) WHERE i.libraryID = 1")
        fields: dict[int, dict[str, str]] = {}
        for item_id, name, value in q("""SELECT d.itemID, f.fieldName, v.value FROM itemData d JOIN fields f USING(fieldID)
                                         JOIN itemDataValues v USING(valueID)"""):
            fields.setdefault(item_id, {})[name] = str(value)
        creators: dict[int, list[str]] = {}
        for item_id, first, last in q("""SELECT ic.itemID, c.firstName, c.lastName FROM itemCreators ic
                                        JOIN creators c USING(creatorID) ORDER BY ic.itemID, ic.orderIndex"""):
            creators.setdefault(item_id, []).append(" ".join(p for p in (first, last) if p))
        attachments: dict[int, list[int]] = {}
        for item_id, parent in q("SELECT itemID, parentItemID FROM itemAttachments WHERE parentItemID IS NOT NULL"):
            if item_id not in deleted:
                attachments.setdefault(parent, []).append(item_id)
        notes: dict[int, list[str]] = {}
        for item_id, parent, note in q("SELECT itemID, parentItemID, note FROM itemNotes WHERE parentItemID IS NOT NULL"):
            if item_id not in deleted:
                notes.setdefault(parent, []).append(_note_text(note))
        marks: dict[int, list[str]] = {}
        for item_id, parent, text, comment in q("SELECT itemID, parentItemID, text, comment FROM itemAnnotations"):
            if item_id not in deleted:
                marks.setdefault(parent, []).extend(m for m in (text, comment) if m)
        keys = {item_id: key for item_id, key, _ in items}
    finally:
        db.close()
    overrides = text_overrides() if overrides is None else overrides
    for item_id, key, type_name in items:
        if type_name in SKIP_TYPES or item_id in deleted:
            continue
        f = fields.get(item_id, {})
        judged = []
        for attachment in attachments.get(item_id, []):
            cache = root() / "storage" / keys[attachment] / ".zotero-ft-cache"
            if not cache.is_file():
                continue
            text = _read_cache(cache)
            decision = judge_text(f.get("title") or f.get("shortTitle") or key, f.get("DOI", ""), text,
                                  creators.get(item_id, []), keys[attachment], overrides)
            judged.append((keys[attachment], decision, text, marks.get(attachment, [])))
        if judged:
            abstract = f.get("abstractNote") or ((abstracts.cached(f["DOI"]) or [""])[0] if f.get("DOI") else "")
            yield key, [f.get("title", ""), abstract, *notes.get(item_id, [])], judged


def audit_text() -> list[dict]:
    """One row per attachment with a cached text, for `kb.py audit-text`: item key, attachment key, decision, reason,
    doi_hit, title_fraction, author_fraction, chars. Never carries text."""
    rows = []
    for key, _own, judged in _judged_items():
        for attachment, d, _text, _marks in judged:
            rows.append({"item": key, "attachment": attachment, "decision": "mine" if d.accepted else ("empty" if d.reason == "empty" else ("unknown" if d.reason == "unknown" else "foreign")),
                         "reason": d.reason, "doi_hit": d.doi_hit, "title_fraction": d.title_fraction,
                         "author_fraction": d.author_fraction, "chars": d.chars})
    return rows


def rejected_items(overrides: dict[str, str] | None = None) -> list[dict]:
    """For `kb.py verify-guard`: every item with an attachment whose cached text the guard rejects (foreign, unknown,
    listing or by override; an empty cache is not a rejection). Per item: `item`; `accepted`, the number of its
    attachments whose text is accepted; `rejected`, per rejected attachment its key, reason and `texts` (the cached
    text and the user's highlights and comments on it, which must be in no index); and `own`, the texts rightly
    indexed under the item (title, abstract, notes, accepted attachments' texts and highlights; an empty cache's
    highlights too). The texts are held in memory to build probes from and are never printed."""
    out = []
    for key, own, judged in _judged_items(overrides):
        rejected = [{"attachment": a, "reason": d.reason, "texts": [text, *marks]} for a, d, text, marks in judged if d.foreign]
        if not rejected:
            continue
        for _a, d, text, marks in judged:
            if not d.foreign:
                own = own + ([text] if d.accepted else []) + marks
        out.append({"item": key, "accepted": sum(d.accepted for _a, d, _t, _m in judged), "rejected": rejected, "own": own})
    return out


def audit_line(row: dict) -> str:
    """The audit's output line: keys, words, booleans and numbers only."""
    return (f"{row['item']} {row['attachment']} {row['decision']} {row['reason']} doi={int(row['doi_hit'])} "
            f"title={row['title_fraction']:.2f} authors={row['author_fraction']:.2f} chars={row['chars']}")


@dataclass
class ZoteroDoc:
    key: str
    title: str
    text: str
    tags: list[str]
    signature: float  # changes whenever the item, its notes, highlights or full text change
    meta: dict = field(default_factory=dict)

    @property
    def path(self) -> str:
        return PREFIX + self.key


def available() -> bool:
    return (root() / "zotero.sqlite").is_file()


def fingerprint() -> tuple[float, float]:
    """Cheap change check: the database's mtime (with its WAL) and the newest full-text cache."""
    db = max((root() / n).stat().st_mtime for n in ("zotero.sqlite", "zotero.sqlite-wal") if (root() / n).exists())
    newest = 0.0
    storage = root() / "storage"
    if storage.is_dir():
        for entry in os.scandir(storage):
            cache = os.path.join(entry.path, ".zotero-ft-cache")
            try:
                newest = max(newest, os.stat(cache).st_mtime)
            except OSError:
                pass
    return db, newest


def snapshot(name: str = "index", max_age: float = 0) -> sqlite3.Connection:
    """A private copy of zotero.sqlite. Each user (the indexer, the reading view) keeps its own file, so one
    never reads a copy the other is rewriting; `max_age` reuses a recent copy instead of taking a new one."""
    # One copy per library and user, so two libraries never share a copy.
    tag = hashlib.sha1(str(root()).encode()).hexdigest()[:8]
    path = os.path.join(tempfile.gettempdir(), f"kb-zotero-{name}-{tag}.sqlite")
    if max_age and os.path.exists(path) and time.time() - os.path.getmtime(path) < max_age:
        return sqlite3.connect(path)
    database = root() / "zotero.sqlite"
    source = sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=2)
    try:
        source.execute("SELECT 1 FROM sqlite_master LIMIT 1")
    except sqlite3.OperationalError:
        # Zotero holds an exclusive lock while it runs, and a normal backup would wait on it forever. Copy the
        # files instead: the database and its write-ahead log, where Zotero keeps its latest changes until a
        # checkpoint (reading the database alone, as immutable=1 does, misses them). Opening the copy replays the
        # log. Keep it only if it is consistent, since a write may be under way.
        source.close()
        wal = Path(str(database) + "-wal")
        for _ in range(5):
            with tempfile.TemporaryDirectory() as tmp:
                base = Path(tmp) / "zotero.sqlite"
                shutil.copyfile(database, base)
                if wal.exists():
                    shutil.copyfile(wal, Path(str(base) + "-wal"))
                try:
                    source = sqlite3.connect(base)
                    ok = source.execute("PRAGMA quick_check").fetchone()[0] == "ok"
                    if ok:
                        copy = sqlite3.connect(path)
                        source.backup(copy)
                        source.close()
                        return copy
                    source.close()
                except sqlite3.DatabaseError:
                    pass
            time.sleep(2)
        raise RuntimeError("couldn't take a consistent copy of zotero.sqlite while Zotero is writing to it")
    copy = sqlite3.connect(path)
    source.backup(copy)
    source.close()
    return copy


def _epoch(stamp: str | None) -> float:
    if not stamp:
        return 0.0
    try:
        return datetime.strptime(stamp[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return 0.0


def _note_text(note_html: str) -> str:
    text = re.sub(r"<br\s*/?>|</p>|</h\d>|</li>|</div>", "\n", note_html or "", flags=re.I)
    text = re.sub(r"<h(\d)[^>]*>", lambda m: "\n" + "#" * min(int(m.group(1)) + 2, 6) + " ", text, flags=re.I)
    text = re.sub(r"<li[^>]*>", "- ", text, flags=re.I)
    text = html.unescape(re.sub(r"<[^>]+>", "", text))
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def documents() -> list[ZoteroDoc]:
    db = snapshot("index")
    q = lambda sql, *args: db.execute(sql, args).fetchall()  # noqa: E731
    deleted = {r[0] for r in q("SELECT itemID FROM deletedItems")}
    items = q("""SELECT i.itemID, i.key, t.typeName, i.dateModified FROM items i JOIN itemTypes t USING(itemTypeID)
                 WHERE i.libraryID = 1""")
    fields: dict[int, dict[str, str]] = {}
    for item_id, name, value in q("""SELECT d.itemID, f.fieldName, v.value FROM itemData d JOIN fields f USING(fieldID)
                                     JOIN itemDataValues v USING(valueID)"""):
        fields.setdefault(item_id, {})[name] = str(value)
    creators: dict[int, list[str]] = {}
    for item_id, first, last in q("""SELECT ic.itemID, c.firstName, c.lastName FROM itemCreators ic
                                    JOIN creators c USING(creatorID) ORDER BY ic.itemID, ic.orderIndex"""):
        creators.setdefault(item_id, []).append(" ".join(p for p in (first, last) if p))
    tags: dict[int, list[str]] = {}
    for item_id, name in q("SELECT it.itemID, t.name FROM itemTags it JOIN tags t USING(tagID)"):
        if not HOUSEKEEPING_TAG.match(name.strip()):
            tags.setdefault(item_id, []).append(re.sub(r"\s+", "-", name.strip()))
    collections: dict[int, list[str]] = {}
    collection_keys: dict[int, list[str]] = {}
    for item_id, name, ckey in q(
            "SELECT ci.itemID, c.collectionName, c.key FROM collectionItems ci JOIN collections c USING(collectionID)"):
        collections.setdefault(item_id, []).append(name)
        collection_keys.setdefault(item_id, []).append(ckey)
    modified = {item_id: _epoch(stamp) for item_id, _, _, stamp in items}
    keys = {item_id: key for item_id, key, _, _ in items}

    notes: dict[int, list[tuple[int, str]]] = {}
    for item_id, parent, note in q("SELECT itemID, parentItemID, note FROM itemNotes WHERE parentItemID IS NOT NULL"):
        if item_id not in deleted:
            notes.setdefault(parent, []).append((item_id, _note_text(note)))
    attachments: dict[int, list[int]] = {}
    for item_id, parent in q("SELECT itemID, parentItemID FROM itemAttachments WHERE parentItemID IS NOT NULL"):
        if item_id not in deleted:
            attachments.setdefault(parent, []).append(item_id)
    annotations: dict[int, list[tuple]] = {}
    for item_id, parent, text, comment, page, sort in q(
            "SELECT itemID, parentItemID, text, comment, pageLabel, sortIndex FROM itemAnnotations"):
        if item_id not in deleted and (text or comment):
            annotations.setdefault(parent, []).append((sort, page, text, comment, item_id))

    # abstracts the library lacks, from OpenAlex (abstracts.py); Zotero itself is never changed
    if os.environ.get("KB_ABSTRACTS", "1") != "0":
        abstracts.fill([fields.get(i, {}).get("DOI", "") for i, _, t, _ in items
                        if t not in SKIP_TYPES and i not in deleted and not fields.get(i, {}).get("abstractNote")])
    overrides = text_overrides()  # read once per pass
    docs = []
    for item_id, key, type_name, _ in items:
        if type_name in SKIP_TYPES or item_id in deleted:
            continue
        f = fields.get(item_id, {})
        title = f.get("title") or f.get("shortTitle") or key
        authors = creators.get(item_id, [])
        year = (re.search(r"\d{4}", f.get("date", "")) or [""])[0]
        venue = f.get("publicationTitle") or f.get("proceedingsTitle") or f.get("bookTitle") or f.get("websiteTitle") or ""
        byline = ", ".join(authors[:6]) + (" et al." if len(authors) > 6 else "")
        parts = [f"# {title}", " · ".join(p for p in (byline, year, venue, f.get("DOI", "")) if p)]
        signature = modified.get(item_id, 0.0)
        if f.get("abstractNote"):
            parts += ["## Abstract", f["abstractNote"]]
        elif f.get("DOI") and (filled := abstracts.cached(f["DOI"])):
            parts += ["## Abstract", filled[0]]
            signature = max(signature, filled[2])  # re-index the item once its abstract arrives
        child_notes = notes.get(item_id, [])
        if child_notes:
            parts.append("## My notes")
            parts += [text for _, text in child_notes if text]
            signature = max([signature] + [modified.get(n, 0.0) for n, _ in child_notes])
        highlights = []
        full_texts = []
        for attachment in attachments.get(item_id, []):
            signature = max(signature, modified.get(attachment, 0.0))
            marks = []
            for sort, page, text, comment, annotation in sorted(annotations.get(attachment, [])):
                signature = max(signature, modified.get(annotation, 0.0))
                line = f"> {text.strip()}" if text else ""
                if comment:
                    line += ("\n" if line else "") + f"Comment: {comment.strip()}"
                marks.append(line + (f" (p. {page})" if page else ""))
            cache = root() / "storage" / keys[attachment] / ".zotero-ft-cache"
            if cache.is_file():
                signature = max(signature, cache.stat().st_mtime)
                cached_text = _read_cache(cache)
                decision = judge_text(title, f.get("DOI", ""), cached_text, authors, keys[attachment], overrides)
                if decision.accepted:
                    full_texts.append(cached_text)
                elif decision.foreign:
                    # Highlights on a foreign attachment are the user's marks on the wrong document and quote it.
                    marks = []
            highlights += marks
        if highlights:
            parts += ["## Highlights"] + highlights
        for text in full_texts:
            parts += ["## Full text", text]
        text = "\n\n".join(p for p in parts if p)
        docs.append(ZoteroDoc(
            key=key, title=title, text=text, signature=signature,
            tags=tags.get(item_id, []),
            meta={"authors": authors, "year": year, "venue": venue, "doi": f.get("DOI", ""), "url": f.get("url", ""),
                  "citekey": f.get("citationKey", ""), "type": type_name,
                  "collections": sorted(collections.get(item_id, [])),
                  "collection_keys": sorted(collection_keys.get(item_id, [])),
                  "zotero_uri": f"zotero://select/library/items/{key}"}))
    db.close()
    return docs


def collection_tree() -> list[dict]:
    """Every collection in the library: its key, name, and its parent's key (None at the top level). Read fresh
    from Zotero's own `collections` table; kb.index_zotero rewrites the `collections` table in kb.sqlite from
    this on each pass that actually re-reads Zotero."""
    db = snapshot("index", max_age=60)
    rows = db.execute(
        "SELECT collectionID, collectionName, parentCollectionID, key FROM collections WHERE libraryID=1").fetchall()
    db.close()
    key_of = {collection_id: key for collection_id, _, _, key in rows}
    return [{"key": key, "name": name, "parent": key_of.get(parent)} for _, name, parent, key in rows]


ANNOTATION_TYPES = {1: "highlight", 2: "note", 3: "image", 4: "ink", 5: "underline", 6: "text"}


def _position(raw: str | None) -> dict | None:
    """An annotation's stored position ({pageIndex, rects} in PDF points for highlights), so a reader can draw it."""
    try:
        position = json.loads(raw or "")
    except ValueError:
        return None
    return position if isinstance(position, dict) else None


def _abstract(fields: dict) -> dict:
    """The item's abstract, or one found in OpenAlex when Zotero has none (with where it came from)."""
    if fields.get("abstractNote") or not fields.get("DOI"):
        return {"abstract": fields.get("abstractNote", "")}
    filled = abstracts.cached(fields["DOI"])
    return {"abstract": filled[0], "abstract_source": filled[1]} if filled else {"abstract": ""}


def item_detail(key: str, full_text: bool = False) -> dict | None:
    """One item, structured for reading: metadata, abstract, notes, highlights (with colour and page), PDFs,
    and optionally the full text. Reads a copy of the database at most a minute old."""
    db = snapshot("reader", max_age=60)
    q = lambda sql, *args: db.execute(sql, args).fetchall()  # noqa: E731
    try:
        row = q("SELECT i.itemID, t.typeName FROM items i JOIN itemTypes t USING(itemTypeID) WHERE i.key=? AND i.libraryID=1", key)
        if not row:
            return None
        item_id, type_name = row[0]
        deleted = {r[0] for r in q("SELECT itemID FROM deletedItems")}
        fields = {name: str(value) for name, value in q(
            """SELECT f.fieldName, v.value FROM itemData d JOIN fields f USING(fieldID) JOIN itemDataValues v USING(valueID)
               WHERE d.itemID=?""", item_id)}
        creators = [{"name": " ".join(p for p in (first, last) if p), "role": role} for first, last, role in q(
            """SELECT c.firstName, c.lastName, ct.creatorType FROM itemCreators ic JOIN creators c USING(creatorID)
               JOIN creatorTypes ct USING(creatorTypeID) WHERE ic.itemID=? ORDER BY ic.orderIndex""", item_id)]
        tags = sorted(name for (name,) in q("SELECT t.name FROM itemTags it JOIN tags t USING(tagID) WHERE it.itemID=?", item_id)
                      if not HOUSEKEEPING_TAG.match(name.strip()))
        collections = sorted(n for (n,) in q(
            "SELECT c.collectionName FROM collectionItems ci JOIN collections c USING(collectionID) WHERE ci.itemID=?", item_id))
        note_rows = [(note_key, _note_text(note)) for note_id, note_key, note in q(
            """SELECT n.itemID, i.key, n.note FROM itemNotes n JOIN items i USING(itemID)
               WHERE n.parentItemID=? ORDER BY n.itemID""", item_id) if note_id not in deleted]
        notes = [text for _, text in note_rows]
        note_keys = [key for key, _ in note_rows]
        overrides = text_overrides()
        item_title = fields.get("title") or fields.get("shortTitle") or key
        author_names = [c["name"] for c in creators]
        attachments = []
        for att_id, att_key, content_type, path, title in q(
                """SELECT a.itemID, i.key, a.contentType, a.path,
                          (SELECT v.value FROM itemData d JOIN fields f USING(fieldID) JOIN itemDataValues v USING(valueID)
                           WHERE d.itemID=a.itemID AND f.fieldName='title')
                   FROM itemAttachments a JOIN items i USING(itemID) WHERE a.parentItemID=?""", item_id):
            if att_id in deleted:
                continue
            highlights = [{"type": ANNOTATION_TYPES.get(kind, "highlight"), "text": (text or "").strip(),
                           "comment": (comment or "").strip(), "color": color or "", "page": page or "",
                           "key": annotation_key, "sort_index": sort_index or "", "position": _position(position)}
                          for annotation_id, kind, text, comment, color, page, sort_index, annotation_key, position in q(
                              """SELECT a.itemID, a.type, a.text, a.comment, a.color, a.pageLabel, a.sortIndex, i.key, a.position
                                 FROM itemAnnotations a JOIN items i USING(itemID)
                                 WHERE a.parentItemID=? ORDER BY a.sortIndex""", att_id)
                          if annotation_id not in deleted and (text or comment or kind == 3) and annotation_key]  # 3: image selection
            cache = root() / "storage" / att_key / ".zotero-ft-cache"
            entry = {"key": att_key, "title": title or "", "content_type": content_type or "", "highlights": highlights,
                     "has_full_text": False,
                     "open_uri": f"zotero://open-pdf/library/items/{att_key}" if content_type == "application/pdf" else ""}
            if cache.is_file():
                # Judged whenever a cache exists, so has_full_text is never a claim about text the guard rejects.
                cached_text = _read_cache(cache)
                decision = judge_text(item_title, fields.get("DOI", ""), cached_text, author_names, att_key, overrides)
                entry["has_full_text"] = decision.accepted
                if decision.accepted and full_text:
                    entry["full_text"] = cached_text
                elif decision.foreign:
                    # The user's highlights on a foreign attachment are marks on the wrong document, and quote it.
                    entry.update(full_text_mismatch=True, text_guard=decision.reason, highlights=[],
                                 highlights_hidden=len(highlights))
            attachments.append(entry)
        return {
            "key": key, "type": type_name, "title": item_title,
            # dates are stored as "2022-03-00 March 2022": the part after the space is the one people typed
            "creators": creators, "date": fields.get("date", "").split(" ", 1)[-1],
            "year": (re.search(r"\d{4}", fields.get("date", "")) or [""])[0],
            "venue": fields.get("publicationTitle") or fields.get("proceedingsTitle") or fields.get("bookTitle")
                     or fields.get("websiteTitle") or "",
            "volume": fields.get("volume", ""), "issue": fields.get("issue", ""), "pages": fields.get("pages", ""),
            "doi": fields.get("DOI", ""), "url": fields.get("url", ""), "citekey": fields.get("citationKey", ""),
            **_abstract(fields), "tags": tags, "collections": collections, "notes": notes, "note_keys": note_keys,
            "attachments": attachments, "zotero_uri": f"zotero://select/library/items/{key}",
        }
    finally:
        db.close()
