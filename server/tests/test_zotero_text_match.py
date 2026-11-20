"""zotero.py: an attachment's cached text that is plainly another document is not treated as the item's."""
from __future__ import annotations

import zotero

TITLE = "Generalized and Facile Synthesis of Semiconducting Metal Sulfide Nanocrystals"


def test_text_with_the_title_belongs():
    assert zotero.text_belongs_to_item(TITLE, "", f"J. Am. Chem. Soc. {TITLE}. We report a synthesis.")


def test_text_of_another_document_does_not_belong():
    assert not zotero.text_belongs_to_item(TITLE, "", "Examples of language model applications in chemistry. " * 50)


def test_private_form_does_not_belong():
    assert not zotero.text_belongs_to_item("Colloidal quantum dot electronics", "", "Questionnaire for public trust positions " * 40)


def test_a_doi_in_the_text_is_enough_even_if_the_title_is_reworded():
    assert zotero.text_belongs_to_item(TITLE, "10.1021/ja0357902", "Rewritten heading. doi:10.1021/ja0357902 body text")


def test_a_different_doi_does_not_rescue_another_document():
    assert not zotero.text_belongs_to_item(TITLE, "10.1021/ja0357902", "Unrelated. doi:10.1000/other body text " * 20)


def test_a_title_too_short_to_judge_is_kept():
    assert zotero.text_belongs_to_item("Quantum dots", "", "Anything at all")


def test_markup_and_accents_in_the_title_are_ignored():
    title = "<i>n</i>-Type Conducting CdSe Nanocrystal Solids: Électronic transport"
    assert zotero.text_belongs_to_item(title, "", "n-type conducting CdSe nanocrystal solids: electronic transport")


def test_title_words_match_whole_words_only():
    # "solid" inside "solids" or "resolid" must not count as the title word.
    assert not zotero.text_belongs_to_item("Metal carbide catalysts surface", "", "metallic carbides catalyst surfaces " * 20)
