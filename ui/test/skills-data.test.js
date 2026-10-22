import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterSkills, safeName, fieldsFromFile, formProblem, fileFromFields, usedLine } from '../src/chat/skills-data.js';
import { parseSkill } from '../../agent/src/skills.js';

const list = [
  { name: 'Weekly Digest', description: 'Short digest of new papers', source: 'user', hash: 'a', size: 1, warning: null },
  { name: 'Broken one', description: '', source: 'user', hash: null, size: 1, warning: 'no name' },
  { name: '1-Page Overview', description: 'Fits on one page', source: 'builtin', hash: 'b', size: 1, warning: null },
  { name: 'Research Gap Analysis', description: 'Finds what is missing', source: 'builtin', hash: 'c', size: 1, warning: null },
];

test('tabs split By you and Built-in; All keeps the order given; search reads name and description', () => {
  assert.deepEqual(filterSkills(list, 'all', '').map((s) => s.name), list.map((s) => s.name));
  assert.deepEqual(filterSkills(list, 'mine', '').map((s) => s.name), ['Weekly Digest', 'Broken one']);
  assert.deepEqual(filterSkills(list, 'builtin', '').map((s) => s.name), ['1-Page Overview', 'Research Gap Analysis']);
  assert.deepEqual(filterSkills(list, 'all', '  MISSING ').map((s) => s.name), ['Research Gap Analysis']);
  assert.deepEqual(filterSkills(list, 'mine', 'overview'), []);
});

test('safeName turns a file name into a valid skill name', () => {
  assert.equal(safeName('my notes.md'), 'my notes');
  assert.equal(safeName('../../etc/passwd.md'), 'etc passwd');
  assert.equal(safeName('///'), '');
});

test('an uploaded SKILL.md keeps its fields; a plain .md becomes the instructions under the file name', () => {
  const good = '---\nname: Tiny\ndescription: Be tiny.\n---\n\nKeep it tiny.\n';
  assert.deepEqual(fieldsFromFile(good, 'whatever.md'), { name: 'Tiny', description: 'Be tiny.', instructions: 'Keep it tiny.' });
  const plain = '# Tips\n\nGive three tips.\n';
  assert.deepEqual(fieldsFromFile(plain, 'tips.md'), { name: 'tips', description: 'Tips', instructions: '# Tips\n\nGive three tips.' });
  const noDesc = '---\nname: Odd\n---\nDo it.';
  const f = fieldsFromFile(noDesc, 'odd.md');
  assert.equal(f.instructions, 'Do it.'); assert.equal(f.name, 'odd');
});

test('the form is checked before saving and written as a file the engine reads back', () => {
  const ok = { name: ' Tips ', description: 'For tips.', instructions: 'Give three tips.' };
  assert.equal(formProblem(ok), null);
  assert.match(formProblem({ ...ok, name: '' }), /name/);
  assert.match(formProblem({ ...ok, name: 'a/b' }), /slashes/);
  assert.match(formProblem({ ...ok, description: ' ' }), /one line/);
  assert.match(formProblem({ ...ok, instructions: '' }), /instructions/);
  assert.match(formProblem(ok, ['Tips']), /already have/);
  const parsed = parseSkill(fileFromFields(ok), 'Tips');
  assert.equal(parsed.ok, true); assert.equal(parsed.body, 'Give three tips.');
});

test('the line under a message names the skills used', () => {
  assert.equal(usedLine(['A']), 'Skill: A');
  assert.equal(usedLine(['A', 'B']), 'Skills: A, B');
  assert.equal(usedLine(undefined), '');
});
