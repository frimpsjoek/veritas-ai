"""zotero.py: an attachment's cached text that is plainly another document's is not treated as the item's.

The guard (judge_text, TEXT_GUARD_VERSION 2) reads only the head of a text: a document names itself at the start,
a reference list or CV that cites the item does so later. The texts here are padded past MIN_TEXT_CHARS, since a
near-empty cache is dropped as "empty", not judged.
"""
from __future__ import annotations

import json

import zotero

TITLE = "Generalized and Facile Synthesis of Semiconducting Metal Sulfide Nanocrystals"
AUTHORS = ["Jin Joo", "Hyon Bin Na", "Taeghwan Hyeon"]
FILLER = "We report a synthesis and characterise the product. " * 10  # > MIN_TEXT_CHARS, no title words
TAIL = "lorem ipsum dolor sit amet " * 400  # pushes anything after it past HEAD_CHARS


def test_text_with_the_title_belongs():
    assert zotero.text_belongs_to_item(TITLE, "", f"J. Am. Chem. Soc. {TITLE}. {FILLER}")


def test_text_of_another_document_does_not_belong():
    assert not zotero.text_belongs_to_item(TITLE, "", "Examples of language model applications in chemistry. " * 50)


def test_private_form_does_not_belong():
    assert not zotero.text_belongs_to_item("Colloidal quantum dot electronics", "", "Questionnaire for public trust positions " * 40)


def test_a_doi_in_the_text_is_enough_even_if_the_title_is_reworded():
    assert zotero.text_belongs_to_item(TITLE, "10.1021/ja0357902", f"Rewritten heading. doi:10.1021/ja0357902 {FILLER}")


def test_a_different_doi_does_not_rescue_another_document():
    assert not zotero.text_belongs_to_item(TITLE, "10.1021/ja0357902", "Unrelated. doi:10.1000/other body text " * 20)


def test_a_text_nothing_can_judge_is_not_admitted():
    """No benefit of the doubt: an authorless item with a title too short to judge is unknown, as is a blank title."""
    assert zotero.judge_text("Quantum dots", "", FILLER).reason == "unknown"
    assert zotero.judge_text("", "", FILLER).reason == "unknown"
    assert not zotero.judge_text("", "", FILLER).accepted
    assert zotero.judge_text("", "", FILLER).foreign


def test_a_non_latin_title_is_judged_verbatim_not_waved_through():
    title = "铜表面的电子结构研究"
    assert zotero.judge_text(title, "", FILLER).reason == "unknown"
    assert zotero.judge_text(title, "", f"{title} {FILLER}").reason == "title_exact"


def test_a_doi_prefix_does_not_match_a_longer_doi():
    text = f"Unrelated paper. doi:10.1021/ja0357902 {FILLER}"
    assert not zotero.judge_text(TITLE, "10.1021/ja035", text).doi_hit
    assert zotero.judge_text(TITLE, "10.1021/ja0357902", text).doi_hit


def test_a_cv_listing_the_paper_near_the_top_is_rejected():
    cv = f"Jane Doe. Curriculum Vitae. Publications: {TITLE}. J. Joo, T. Hyeon. {FILLER}"
    decision = zotero.judge_text(TITLE, "", cv, authors=AUTHORS)
    assert decision.reason == "listing" and not decision.accepted


def test_a_title_past_the_top_needs_the_authors_too():
    padding = "padding " * (zotero.TITLE_NEAR_CHARS // 8 + 1)
    body = f"{padding}{TITLE} {FILLER}"
    assert zotero.judge_text(TITLE, "", body).reason == "foreign"
    assert zotero.judge_text(TITLE, "", f"J. Joo, H. B. Na and T. Hyeon. {body}", authors=AUTHORS).reason == "title+authors"


def test_an_overrides_edit_changes_the_stamp(tmp_path, monkeypatch):
    monkeypatch.setattr(zotero, "overrides_file", lambda: tmp_path / "text_overrides.json")
    assert zotero.overrides_stamp() == ""
    (tmp_path / "text_overrides.json").write_text('{"A": "foreign"}')
    first = zotero.overrides_stamp()
    (tmp_path / "text_overrides.json").write_text('{"A": "mine"}')
    assert first and zotero.overrides_stamp() != first


def test_a_title_too_short_to_judge_needs_an_author_when_authors_are_known():
    assert zotero.judge_text("Quantum dots", "", FILLER, authors=AUTHORS).reason == "foreign"
    assert zotero.judge_text("Quantum dots", "", f"J. Joo, H. B. Na and T. Hyeon. {FILLER}", authors=AUTHORS).reason == "authors"


def test_markup_and_accents_in_the_title_are_ignored():
    title = "<i>n</i>-Type Conducting CdSe Nanocrystal Solids: Électronic transport"
    assert zotero.text_belongs_to_item(title, "", f"n-type conducting CdSe nanocrystal solids: electronic transport. {FILLER}")


def test_title_words_match_whole_words_only():
    # "solid" inside "solids" or "resolid" must not count as the title word.
    assert not zotero.text_belongs_to_item("Metal carbide catalysts surface", "", "metallic carbides catalyst surfaces " * 20)


# --- version 2: only the head of the text counts, authors are a second signal, empty caches are dropped ---

def test_a_document_that_merely_cites_the_title_later_does_not_belong():
    # A CV or another paper's reference list repeats the title, but after its own first page.
    assert zotero.judge_text(TITLE, "", f"Curriculum vitae of someone. {TAIL} 12. {TITLE}, JACS 2003.").reason == "listing"
    assert zotero.judge_text(TITLE, "", f"Notes of someone. {TAIL} 12. {TITLE}, JACS 2003.").reason == "foreign"


def test_a_doi_cited_later_in_the_text_does_not_belong():
    assert zotero.judge_text(TITLE, "10.1021/ja0357902", f"Another paper. {TAIL} [7] doi:10.1021/ja0357902").reason == "foreign"


def test_a_partial_title_with_the_authors_on_the_first_page_belongs():
    # The known false reject: one of three title words, both authors, no DOI in the text.
    decision = zotero.judge_text("Large scale GW calculations", "", f"Calculations of quasiparticle energies. J. Joo and T. Hyeon. {FILLER}",
                                 authors=["Jin Joo", "Taeghwan Hyeon"])
    assert decision.accepted and decision.reason == "title+authors"
    assert decision.title_fraction == round(1 / 3, 3) and decision.author_fraction == 1.0


def test_a_partial_title_without_the_authors_does_not_belong():
    decision = zotero.judge_text("Large scale GW calculations", "", f"Calculations of something else. {FILLER}", authors=AUTHORS)
    assert not decision.accepted and decision.reason == "foreign"


def test_the_authors_alone_do_not_admit_another_paper_by_the_same_people():
    decision = zotero.judge_text(TITLE, "", f"A different paper. J. Joo, H. B. Na and T. Hyeon. {FILLER}", authors=AUTHORS)
    assert not decision.accepted and decision.author_fraction == 1.0


def test_a_near_empty_cache_is_dropped_not_judged_foreign():
    decision = zotero.judge_text(TITLE, "", "Anything at all")
    assert not decision.accepted and decision.reason == "empty" and not decision.foreign


# --- overrides (R3): consulted before the heuristic; a bad file or value admits nothing ---

def test_an_override_wins_over_the_heuristic():
    overrides = {"ATT00001": "mine", "ATT00002": "foreign"}
    assert zotero.judge_text(TITLE, "", "Questionnaire for public trust positions " * 40, attachment_key="ATT00001", overrides=overrides).reason == "override:mine"
    assert zotero.judge_text(TITLE, "", f"{TITLE}. {FILLER}", attachment_key="ATT00002", overrides=overrides).reason == "override:foreign"


def test_an_unknown_override_value_rejects_the_text():
    decision = zotero.judge_text(TITLE, "", f"{TITLE}. {FILLER}", attachment_key="ATT00003", overrides={"ATT00003": "maybe"})
    assert not decision.accepted and decision.reason == "override:invalid" and decision.foreign


def test_overrides_file_is_read_from_the_data_folder(tmp_path, monkeypatch):
    monkeypatch.setenv("VERITAS_DATA", str(tmp_path))
    assert zotero.overrides_file() == tmp_path / "text_overrides.json"
    assert zotero.text_overrides() == {}  # no file: no override
    (tmp_path / "text_overrides.json").write_text(json.dumps({"ATT00001": " Mine ", "ATT00002": 7}))
    assert zotero.text_overrides() == {"ATT00001": "mine", "ATT00002": "7"}
    assert zotero.judge_text(TITLE, "", f"{TITLE}. {FILLER}", attachment_key="ATT00002").reason == "override:invalid"


def test_a_malformed_overrides_file_is_ignored_and_admits_nothing(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("VERITAS_DATA", str(tmp_path))
    (tmp_path / "text_overrides.json").write_text("{not json")
    assert zotero.text_overrides() == {}
    assert "text_overrides.json" in capsys.readouterr().err
    assert zotero.judge_text(TITLE, "", "Questionnaire for public trust positions " * 40, attachment_key="ATT00001").reason == "foreign"
    (tmp_path / "text_overrides.json").write_text(json.dumps(["ATT00001"]))
    assert zotero.text_overrides() == {}


def test_audit_line_carries_only_keys_and_numbers():
    row = {"item": "ITEM0001", "attachment": "ATT00001", "decision": "foreign", "reason": "foreign", "doi_hit": False,
           "title_fraction": 0.25, "author_fraction": 0.0, "chars": 9850}
    line = zotero.audit_line(row)
    assert line == "ITEM0001 ATT00001 foreign foreign doi=0 title=0.25 authors=0.00 chars=9850" and len(line) < 200
