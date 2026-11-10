import { describe, expect, test } from 'bun:test';
import { parseInline, parseMarkdown } from '../panel/markdown.ts';
import { legacyLabels, pageLabel, runTime } from '../panel/util.ts';
import {
  ValidationError,
  dreamArgs,
  editArgs,
  forgetArgs,
  listArgs,
  noteArgs,
  notedId,
  pinnedText,
} from '../service/validate.ts';

describe('service input checks', () => {
  test('list builds flag=value arguments', () => {
    const q = new URLSearchParams({ status: 'all', kind: 'fact', q: '-dash', entity: 'Ares', pinned: 'true', sort: 'recent', limit: '20', offset: '40' });
    expect(listArgs(q)).toEqual(['list', '--status=all', '--kind=fact', '--q=-dash', '--entity=Ares', '--pinned', '--sort=recent', '--limit=20', '--offset=40']);
  });

  test('list rejects bad enums and numbers', () => {
    expect(() => listArgs(new URLSearchParams({ status: 'deleted' }))).toThrow(ValidationError);
    expect(() => listArgs(new URLSearchParams({ limit: '0' }))).toThrow(ValidationError);
    expect(() => listArgs(new URLSearchParams({ offset: '-1' }))).toThrow(ValidationError);
  });

  test('edit needs a valid id and at least one change', () => {
    expect(() => editArgs({ id: 'c_123' })).toThrow(ValidationError);
    expect(() => editArgs({ id: 'c_0123abcd' })).toThrow('Nothing to change');
    expect(editArgs({ id: 'c_0123abcd', salience: 0.5, pinned: true, status: 'active' })).toEqual([
      'edit',
      'c_0123abcd',
      '--salience=0.5',
      '--pin=on',
      '--status=active',
    ]);
    expect(() => editArgs({ id: 'c_0123abcd', confidence: 1.2 })).toThrow(ValidationError);
    expect(() => editArgs({ id: 'c_0123abcd', status: 'retracted' })).toThrow(ValidationError);
    expect(() => editArgs({ id: 'c_0123abcd', text: 'two\nlines' })).toThrow(ValidationError);
  });

  test('forget takes a claim id or a uuid, and a reason', () => {
    expect(forgetArgs({ id: 'c_0123abcd', reason: ' wrong ' })).toEqual(['forget', 'c_0123abcd', '--reason=wrong']);
    expect(forgetArgs({ id: 'F80FFFDB-BFB4-4956-ADD9-1800C838B689', reason: 'old' })[1]).toBe('f80fffdb-bfb4-4956-add9-1800c838b689');
    expect(() => forgetArgs({ id: '--all', reason: 'x' })).toThrow(ValidationError);
    expect(() => forgetArgs({ id: 'c_0123abcd', reason: '' })).toThrow(ValidationError);
  });

  test('note puts the text after "--"', () => {
    expect(noteArgs({ text: '-starts with a dash', kind: 'fact' })).toEqual(['note', '--kind=fact', '--salience=0.8', '--', '-starts with a dash']);
    expect(notedId('noted c_90797872 (fact) in memory/2026-10-31.md')).toBe('c_90797872');
  });

  test('dream date and pinned text', () => {
    expect(dreamArgs('2026-10-31')).toEqual(['dreams', '--date=2026-10-31']);
    expect(() => dreamArgs('../etc')).toThrow(ValidationError);
    expect(pinnedText({ text: 'a\r\nb' })).toBe('a\nb');
    expect(() => pinnedText({ text: 'x'.repeat(4001) })).toThrow(ValidationError);
    expect(() => pinnedText({ text: 'bad\u0000' })).toThrow(ValidationError);
  });
});

describe('markdown reader', () => {
  test('claim references, code and links', () => {
    expect(parseInline('see [c_0123abcd] and c_89abcdef, not c_18e00d657001x')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'claim', id: 'c_0123abcd' },
      { t: 'text', v: ' and ' },
      { t: 'claim', id: 'c_89abcdef' },
      { t: 'text', v: ', not c_18e00d657001x' },
    ]);
    expect(parseInline('`a` [x](https://e.com)')).toEqual([
      { t: 'code', v: 'a' },
      { t: 'text', v: ' ' },
      { t: 'link', href: 'https://e.com', c: [{ t: 'text', v: 'x' }] },
    ]);
    // A javascript: link stays plain text.
    expect(parseInline('[x](javascript:alert(1))').every((n) => n.t === 'text')).toBe(true);
    // snake_case is not italic.
    expect(parseInline('next_step and repair_threads')).toEqual([{ t: 'text', v: 'next_step and repair_threads' }]);
  });

  test('blocks: front matter, headings, nested lists', () => {
    const blocks = parseMarkdown('---\ndate: 2026-10-31\n---\n# Title\n\n- a\n  - b\n- c\n\ntext <b>raw</b>');
    expect(blocks.map((b) => b.t)).toEqual(['meta', 'h', 'list', 'p']);
    const list = blocks[2];
    if (list?.t !== 'list') throw new Error('no list');
    expect(list.items).toHaveLength(2);
    expect(list.items[0]?.children[0]?.t).toBe('list');
    const p = blocks[3];
    expect(p?.t === 'p' && p.c[0]?.t === 'text' && p.c[0].v).toBe('text <b>raw</b>');
  });
});

describe('panel helpers', () => {
  test('run time and labels', () => {
    expect(runTime('# dream\n\nrun: 2026-10-31T09:28:21-04:00\n')).toBe('2026-10-31T09:28:21-04:00');
    expect(runTime(undefined)).toBeNull();
    expect(pageLabel(50, 50, 197)).toBe('51–100 of 197');
    expect(legacyLabels({ id: 'x', text: 't', created_at: null, updated_at: null, agent_id: null, metadata: { client: 'hermes', tag: 'preference' } })).toEqual([
      ['client', 'hermes'],
      ['tag', 'preference'],
    ]);
  });
});
