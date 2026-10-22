"""Recall check: paraphrased questions whose answer note is known. Prints hit@1 / hit@5 for several vector gates.

The paraphrases deliberately avoid the note titles' words, so they need the meaning side of the search.
"""
import sys

import kb

CASES = [
    ("keyboard shortcut to jump to a typed folder location in the Mac file browser",
     "Clippings/command to enter the path and go there in finder window.md"),
    ("speeding up mixture-of-experts inference with a custom GPU kernel on Apple silicon",
     "Clippings/One Metal kernel made Apple Core AI’s MoE decode 2–3.6× faster — same quality.md"),
    ("why young people rent and subscribe instead of buying things", "youtube/Why Gen Z Might Never Own Anything.md"),
    ("semaglutide weight-loss drug downsides", "youtube/I Investigated Ozempic The Good, the Bad, and the Lies....md"),
    ("how banks create money by lending out deposits", "youtube/The Money Multiplier Machine, Explained.md"),
    ("tap a tag on my phone to lock distracting apps for attention deficit", "ai_notes/perplexity/General/NFC Physical Friction for ADHD and Focus.md"),
    ("how much to charge clients for photoshoots", "ai_notes/perplexity/General/Photography Package Pricing Tiers.md"),
    ("do quasiparticle band gaps depend on the starting DFT functional",
     "ai_notes/perplexity/General/GW@LDA and GW@PBE Band Gaps.md"),
    ("an assistant that reads preprint servers, plans a workflow and runs and plots simulations for me",
     ("Notion/Notes & braindump/2025-08-25 - hackathon ideas for agent.md",
      "ai_notes/notion-inbox/2025-08-25 - hackathon ideas for agent [25a727f5].md")),
    ("what is an embedding store and how does similarity lookup work",
     "Clippings/## What is a Vector Database? — Full Step-by-Step Tutorial.md"),
    ("MACE polarisable foundation model",
     "ai_notes/notion-inbox/MACE-POLAR-1 A Polarisable Electrostatic Foundation Model for Molecular Chemistry [78fcf0db].md"),
]


def main() -> None:
    searcher = kb.Searcher()
    gates = [float(g) for g in sys.argv[1:]] or [0.0, 0.55, 0.6, 0.62, 0.65, 0.7]
    for gate in gates:
        kb.VECTOR_GATE = gate
        hit1 = hit5 = 0
        misses = []
        for query, expected in CASES:
            expected = {expected} if isinstance(expected, str) else set(expected)  # copies of one note
            paths = [r["path"] for r in searcher.search(query, limit=5)]
            hit1 += bool(paths) and paths[0] in expected
            hit5 += bool(expected & set(paths))
            if not expected & set(paths):
                misses.append(query)
        print(f"gate {gate:.2f}: hit@1 {hit1}/{len(CASES)}  hit@5 {hit5}/{len(CASES)}")
        for query in misses:
            print(f"    miss: {query}")


if __name__ == "__main__":
    main()
