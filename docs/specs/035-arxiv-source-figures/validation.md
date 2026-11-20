# Spec 035 validation

| ID | Check | Expected | Actual (2026-11-20) |
|----|-------|----------|---------------------|
| R1 | `test_the_first_included_figure_follows_inputs_graphicspath_and_extensions` | `\input` followed, `\graphicspath` and extensions resolved, comments skipped, main.tex first | pass |
| R1 | `test_a_single_gzipped_tex_and_a_wide_png_are_read` | one gzipped .tex read; a 2400 px PNG becomes 1000 px | pass |
| R2 | `test_an_eps_figure_is_skipped_for_the_next_and_a_pdf_figure_is_drawn` | EPS skipped, the PDF figure after it drawn (blue), not the PNG after that | pass |
| R2 | `test_a_pdf_source_gives_its_first_large_picture` | a 40 px picture skipped, the 900 x 600 one on page 2 cut out | pass |
| R2 | `test_no_drawable_figure_or_too_large_a_source_gives_none` | EPS only, or an over-limit source: no figure, no file written | pass |
| R3 | `test_a_kept_figure_is_answered_as_a_data_address_and_a_lost_one_is_found_again` | data:image/jpeg answer, cached; a deleted file is found again | pass |
| R4 | `test_source_downloads_are_spaced_three_seconds_apart` | second download waits 2 s after 1 s; over SOURCE_LIMIT gives None | pass |
| R5 | `test_the_html_figure_comes_first_and_the_source_only_without_it` | HTML figure used; source asked only without it | pass |
| R5 | `pytest -q tests/` (server) | all pass | 625 passed, 3 skipped |
| live | repo finder, throwaway data folder, papers from Home without a figure: 2605.29821, 2609.09923, 2610.34354, 2611.12018 (no HTML), 2611.25650, 2611.25655 | figures for those whose source has one | 5 of 6: 2605.29821 (PDF source, picture), 2609.09923 and 2610.34354 (PDF sources, pictures after page 20, found once the page limit was 60), 2611.12018 (LaTeX, PDF figure drawn), 2611.25650 (HTML SVG figure, fix 57459b7); 2611.25655 has no figure files in its source (none is right). Two drawn figures looked at: correct first figures |
| app | the released app shows them on Home | figures appear | Not run: needs the release from this commit |
