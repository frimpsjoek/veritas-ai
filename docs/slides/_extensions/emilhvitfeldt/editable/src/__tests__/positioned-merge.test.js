import { describe, it, expect, vi } from 'vitest';

vi.mock('../editable-element.js', () => ({ editableRegistry: { has: () => false, get: () => null } }));
vi.mock('../serialization.js', () => ({ splitIntoSlideChunks: vi.fn() }));
vi.mock('../utils.js', () => ({
  getQmdHeadingIndex: vi.fn(),
  escapeRegex: (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
}));

import { mergeAbsoluteAttrs } from '../modify-mode-positioned.js';

// Re-saving a positioned block must only change its position: other classes (cover layout classes such as
// .cover-title), ids and attributes stay. Regression: saving a cover slide twice dropped .cover-title/.cover-motif.
describe('mergeAbsoluteAttrs', () => {
  const fresh = '{.absolute left=10px top=20px width=30px height=40px}';

  it('keeps extra classes', () => {
    expect(mergeAbsoluteAttrs('{.absolute .cover-title left=1px top=2px width=3px height=4px}', fresh))
      .toBe('{.absolute .cover-title left=10px top=20px width=30px height=40px}');
  });

  it('keeps classes written before .absolute and the order of the rest', () => {
    expect(mergeAbsoluteAttrs('{.cover-id .absolute left=0px top=0px width=760px height=177px}', fresh))
      .toBe('{.absolute .cover-id left=10px top=20px width=30px height=40px}');
  });

  it('keeps ids and other key=value attributes, quoted values included', () => {
    expect(mergeAbsoluteAttrs('{#fig-a .absolute left=1px top=2px width=3px height=4px fig-alt="two words" data-x=1}', fresh))
      .toBe('{.absolute #fig-a left=10px top=20px width=30px height=40px fig-alt="two words" data-x=1}');
  });

  it('replaces transform/clip-path in style but keeps other style rules', () => {
    const next = '{.absolute left=10px top=20px width=30px height=40px style="transform: rotate(10deg);"}';
    expect(mergeAbsoluteAttrs('{.absolute left=1px top=2px width=3px height=4px style="color: red; transform: rotate(5deg);"}', next))
      .toBe('{.absolute left=10px top=20px width=30px height=40px style="color: red; transform: rotate(10deg);"}');
  });

  it('drops a stale transform when the new block has none', () => {
    expect(mergeAbsoluteAttrs('{.absolute left=1px top=2px width=3px height=4px style="transform: rotate(5deg);"}', fresh))
      .toBe(fresh);
  });

  it('returns the new block unchanged when there is nothing extra', () => {
    expect(mergeAbsoluteAttrs('{.absolute left=1px top=2px width=3px height=4px}', fresh)).toBe(fresh);
  });
});
