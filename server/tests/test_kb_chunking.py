"""kb.py clean / pack / chunk_note: markup is removed without eating scientific text, and long paragraphs are split
into sentences that are joined back as prose, not as separate paragraphs."""
from __future__ import annotations

import pytest

import kb


@pytest.mark.parametrize("text", [
    "gap is < 2 eV for PBE and > 3 eV for HSE",
    "the expectation value <psi|H|psi> is real",
    "the bra-ket <phi_i|V|phi_j> couples them",
    "grown along the <110> direction",
    "the rule a<b>c holds",
    "for x<y and y>z",
    "with T<300 K and P>1 bar",
    "a <-> b and c -> d",
    "the expectation values <x> and <p> vanish",
])
def test_clean_keeps_scientific_text_between_angle_brackets(text):
    assert kb.clean(text) == text


def test_clean_removes_inline_tags_without_splitting_words():
    assert kb.clean("<i>GW</i> 100: <i>G</i><sub>0</sub><i>W</i><sub>0</sub> for molecules") == "GW 100: G0W0 for molecules"


def test_clean_removes_block_tags_and_tags_with_attributes():
    text = '<p>First para.</p><p>Second <span class="x">para</span>.<br/>Line<br />End</p>'
    assert kb.clean(text) == "First para. Second para. Line End"


def test_clean_removes_html_that_notes_embed():
    text = '<details><summary>Setup</summary>Run the <mark>relaxation</mark> first.</details><iframe src="x"></iframe>'
    assert kb.clean(text) == "Setup Run the relaxation first."


def test_clean_removes_namespaced_xml_tags():
    assert kb.clean("<jats:p>Band gaps of <jats:italic>ab initio</jats:italic> models.</jats:p>") \
        == "Band gaps of ab initio models."


def test_clean_keeps_tag_like_text_next_to_real_tags():
    assert kb.clean("<b>Result:</b> gap < 2 eV, <psi|H|psi> = E") == "Result: gap < 2 eV, <psi|H|psi> = E"


def _sentences(n: int) -> str:
    return " ".join(f"Sentence {i} cites Phys. Rev. B and reports a value." for i in range(n))


def test_pack_rejoins_sentences_of_one_paragraph_with_a_space():
    para = _sentences(60)  # far above CHUNK_CHARS: split at sentences
    pieces = kb.pack(para)
    assert len(pieces) > 1
    assert all("\n\n" not in p for p in pieces)
    assert "Phys. Rev. B" in pieces[0]
    assert " ".join(pieces) == para


def test_pack_keeps_paragraph_breaks_between_paragraphs():
    short = "A short paragraph about excitons."
    text = short + "\n\n" + _sentences(60) + "\n\n" + short
    pieces = kb.pack(text)
    assert pieces[0].startswith(short + "\n\nSentence 0 cites")
    assert pieces[-1].endswith("value.\n\n" + short)


def test_pack_keeps_line_breaks_inside_a_long_paragraph():
    lines = "\n".join(f"- item {i} with a short description of a measured band offset" for i in range(40))
    pieces = kb.pack(lines)
    assert len(pieces) > 1
    assert all("\n\n" not in p for p in pieces)
    assert "\n".join(pieces) == lines


def test_pack_keeps_text_order_when_one_unit_is_cut():
    text = "Intro sentence. " + "x" * (kb.CHUNK_CHARS * 2) + " Closing sentence."
    pieces = kb.pack(text)
    joined = "".join(pieces)
    assert joined.index("Intro") < joined.index("x") < joined.index("Closing")


def test_short_section_is_one_piece():
    assert kb.pack("one\n\ntwo") == ["one\n\ntwo"]


def test_chunk_note_text_reads_as_prose():
    body = "# Results\n\n" + _sentences(60) + "\n\n## Notes\n\nGap is < 2 eV."
    chunks = kb.chunk_note(body)
    results = [c for c in chunks if c.heading == "Results"]
    assert len(results) > 1 and all("\n\n" not in c.text for c in results)
    assert chunks[-1].heading == "Results > Notes" and chunks[-1].text == "Gap is < 2 eV."
