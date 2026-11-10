// A small, safe Markdown reader. It builds a tree of plain values and never makes HTML from
// the source text: the panel renders the tree with textContent only.
//
// Supported: front matter, headings, paragraphs, lists (nested by indent), block quotes,
// fenced code, horizontal rules, `code`, **bold**, *italic*, _italic_, [text](https://...),
// and claim references such as [c_0123abcd] or c_0123abcd.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'claim'; id: string };

export interface ListItem {
  c: Inline[];
  children: Block[];
}

export type Block =
  | { t: 'meta'; pairs: Array<[string, string]> }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'list'; ordered: boolean; items: ListItem[] }
  | { t: 'quote'; c: Block[] }
  | { t: 'pre'; v: string }
  | { t: 'hr' };

const INLINE =
  /(`[^`\n]+`)|(\*\*(?=\S)[^\n]*?\S\*\*)|(\[(c_[0-9a-f]{8})\])|(\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\))|(\bc_[0-9a-f]{8}\b)|((?<![\w*])\*(?=\S)[^*\n]*?\S\*(?![\w*]))|((?<!\w)_(?=\S)[^_\n]*?\S_(?!\w))/g;

export const parseInline = (src: string, depth = 0): Inline[] => {
  if (depth > 4) return [{ t: 'text', v: src }];
  const out: Inline[] = [];
  let last = 0;
  const push = (value: string): void => {
    if (!value) return;
    const prev = out.at(-1);
    if (prev && prev.t === 'text') prev.v += value;
    else out.push({ t: 'text', v: value });
  };
  for (const m of src.matchAll(INLINE)) {
    const index = m.index ?? 0;
    push(src.slice(last, index));
    last = index + m[0].length;
    if (m[1]) out.push({ t: 'code', v: m[1].slice(1, -1) });
    else if (m[2]) out.push({ t: 'strong', c: parseInline(m[2].slice(2, -2), depth + 1) });
    else if (m[4]) out.push({ t: 'claim', id: m[4] });
    else if (m[6] && m[7]) out.push({ t: 'link', href: m[7], c: parseInline(m[6], depth + 1) });
    else if (m[8]) out.push({ t: 'claim', id: m[8] });
    else if (m[9]) out.push({ t: 'em', c: parseInline(m[9].slice(1, -1), depth + 1) });
    else if (m[10]) out.push({ t: 'em', c: parseInline(m[10].slice(1, -1), depth + 1) });
  }
  push(src.slice(last));
  return out;
};

const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const indentOf = (line: string): number => (/^\s*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length;

const frontMatter = (lines: string[]): { pairs: Array<[string, string]>; rest: string[] } | null => {
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end < 0 || end > 40) return null;
  const pairs: Array<[string, string]> = [];
  for (const line of lines.slice(1, end)) {
    const m = /^([\w.-]+):\s*(.*)$/.exec(line);
    if (m?.[1]) pairs.push([m[1], (m[2] ?? '').replace(/^['"]|['"]$/g, '')]);
  }
  return { pairs, rest: lines.slice(end + 1) };
};

const parseBlocks = (lines: string[], depth: number): Block[] => {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed === '') {
      i += 1;
      continue;
    }
    if (trimmed.startsWith('```')) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) body.push(lines[i++] ?? '');
      i += 1;
      blocks.push({ t: 'pre', v: body.join('\n') });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(trimmed);
    if (heading?.[1]) {
      blocks.push({ t: 'h', level: heading[1].length, c: parseInline(heading[2] ?? '') });
      i += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ t: 'hr' });
      i += 1;
      continue;
    }
    if (trimmed.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('>')) body.push((lines[i++] ?? '').trim().replace(/^>\s?/, ''));
      blocks.push({ t: 'quote', c: depth < 4 ? parseBlocks(body, depth + 1) : [{ t: 'p', c: parseInline(body.join(' ')) }] });
      continue;
    }
    const first = LIST_ITEM.exec(line);
    if (first) {
      const base = indentOf(line);
      const ordered = /\d/.test(first[2] ?? '');
      const items: ListItem[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? '';
        if (current.trim() === '') {
          // A blank line ends the list unless the next line continues it.
          const next = lines[i + 1] ?? '';
          if (LIST_ITEM.test(next) && indentOf(next) >= base) {
            i += 1;
            continue;
          }
          break;
        }
        const m = LIST_ITEM.exec(current);
        const indent = indentOf(current);
        if (m && indent === base) {
          items.push({ c: parseInline(m[3] ?? ''), children: [] });
          i += 1;
          continue;
        }
        if (indent > base && items.length > 0) {
          // Nested list or a wrapped line of the current item.
          const sub: string[] = [];
          while (i < lines.length && (lines[i] ?? '').trim() !== '' && indentOf(lines[i] ?? '') > base) sub.push(lines[i++] ?? '');
          const item = items[items.length - 1];
          if (item && sub.length > 0) {
            if (LIST_ITEM.test(sub[0] ?? '') && depth < 4) item.children.push(...parseBlocks(sub, depth + 1));
            else item.c.push({ t: 'text', v: ' ' }, ...parseInline(sub.map((s) => s.trim()).join(' ')));
          }
          continue;
        }
        break;
      }
      blocks.push({ t: 'list', ordered, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? '';
      const t = current.trim();
      if (t === '' || t.startsWith('```') || t.startsWith('>') || /^#{1,6}\s/.test(t) || LIST_ITEM.test(current) || /^(-{3,}|\*{3,})$/.test(t)) break;
      para.push(t);
      i += 1;
    }
    if (para.length === 0) {
      // Never loop forever on a line that no rule takes.
      para.push(trimmed);
      i += 1;
    }
    blocks.push({ t: 'p', c: parseInline(para.join(' ')) });
  }
  return blocks;
};

export const parseMarkdown = (src: string): Block[] => {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const fm = frontMatter(lines);
  if (fm) return [{ t: 'meta', pairs: fm.pairs }, ...parseBlocks(fm.rest, 0)];
  return parseBlocks(lines, 0);
};

export interface RenderOptions {
  onClaim: (id: string) => void;
  onLink: (href: string) => void;
}

const renderInline = (parent: Node, nodes: Inline[], options: RenderOptions): void => {
  for (const node of nodes) {
    switch (node.t) {
      case 'text':
        parent.appendChild(document.createTextNode(node.v));
        break;
      case 'code': {
        const code = document.createElement('code');
        code.textContent = node.v;
        parent.appendChild(code);
        break;
      }
      case 'strong':
      case 'em': {
        const wrap = document.createElement(node.t);
        renderInline(wrap, node.c, options);
        parent.appendChild(wrap);
        break;
      }
      case 'link': {
        const a = document.createElement('a');
        a.href = node.href;
        a.rel = 'noreferrer noopener';
        a.title = node.href;
        renderInline(a, node.c, options);
        a.addEventListener('click', (event) => {
          event.preventDefault();
          options.onLink(node.href);
        });
        parent.appendChild(a);
        break;
      }
      case 'claim': {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'claim-ref';
        b.textContent = node.id;
        b.title = `Open claim ${node.id}`;
        b.addEventListener('click', () => options.onClaim(node.id));
        parent.appendChild(b);
        break;
      }
    }
  }
};

const renderBlocks = (parent: Node, blocks: Block[], options: RenderOptions): void => {
  for (const block of blocks) {
    switch (block.t) {
      case 'meta': {
        if (block.pairs.length === 0) break;
        const dl = document.createElement('dl');
        dl.className = 'md-meta';
        for (const [k, v] of block.pairs) {
          const dt = document.createElement('dt');
          dt.textContent = k.replace(/_/g, ' ');
          const dd = document.createElement('dd');
          dd.textContent = v;
          dl.append(dt, dd);
        }
        parent.appendChild(dl);
        break;
      }
      case 'h': {
        const h = document.createElement(`h${Math.min(6, block.level + 1)}` as 'h2');
        renderInline(h, block.c, options);
        parent.appendChild(h);
        break;
      }
      case 'p': {
        const p = document.createElement('p');
        renderInline(p, block.c, options);
        parent.appendChild(p);
        break;
      }
      case 'list': {
        const list = document.createElement(block.ordered ? 'ol' : 'ul');
        for (const item of block.items) {
          const li = document.createElement('li');
          renderInline(li, item.c, options);
          renderBlocks(li, item.children, options);
          list.appendChild(li);
        }
        parent.appendChild(list);
        break;
      }
      case 'quote': {
        const q = document.createElement('blockquote');
        renderBlocks(q, block.c, options);
        parent.appendChild(q);
        break;
      }
      case 'pre': {
        const pre = document.createElement('pre');
        pre.textContent = block.v;
        parent.appendChild(pre);
        break;
      }
      case 'hr':
        parent.appendChild(document.createElement('hr'));
        break;
    }
  }
};

/** Renders one line of inline Markdown (code, emphasis, links, claim references). */
export const renderInlineText = (src: string, options: RenderOptions): DocumentFragment => {
  const fragment = document.createDocumentFragment();
  renderInline(fragment, parseInline(src), options);
  return fragment;
};

/** Renders Markdown into a new element with class "md". */
export const renderMarkdown = (src: string, options: RenderOptions): HTMLElement => {
  const root = document.createElement('div');
  root.className = 'md';
  renderBlocks(root, parseMarkdown(src), options);
  return root;
};
