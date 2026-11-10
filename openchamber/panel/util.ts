// Pure helpers for the panel. No DOM access here, so the tests can import this file.
import type { LegacyItem } from '../shared/types.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const parse = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "just now", "5 min ago", "3 h ago", "2 days ago", then a date. */
export const relativeTime = (iso: string | null | undefined, now = Date.now()): string => {
  const d = parse(iso);
  if (!d) return '';
  const diff = now - d.getTime();
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff < 7 * DAY) {
    const days = Math.floor(diff / DAY);
    return days === 1 ? 'yesterday' : `${days} days ago`;
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

export const dateTime = (iso: string | null | undefined): string => {
  const d = parse(iso);
  if (!d) return '';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

export const shortDate = (iso: string | null | undefined): string => {
  const d = parse(iso);
  if (!d) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

/** Reads "run: <ISO time>" from a run receipt. */
export const runTime = (receipt: string | undefined): string | null => /^run:\s*(\S+)/m.exec(receipt ?? '')?.[1] ?? null;

/** The bullet lines of a run receipt, as one short summary. */
export const runSummary = (receipt: string | undefined): string =>
  (receipt ?? '')
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .join(', ');

export const fixed2 = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : '-');

export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Labels for a Mem0 entry: agent, client, source and tag, when present. */
export const legacyLabels = (item: LegacyItem): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  const md = item.metadata ?? {};
  const add = (label: string, value: unknown): void => {
    if (typeof value === 'string' && value.trim() !== '') out.push([label, value]);
  };
  add('agent', item.agent_id);
  add('client', md.client);
  add('source', md.source);
  add('tag', md.tag ?? md.kind);
  return out;
};

/** Case-insensitive match on the text and the labels. */
export const legacyMatches = (item: LegacyItem, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (item.text.toLowerCase().includes(q)) return true;
  return legacyLabels(item).some(([, value]) => value.toLowerCase().includes(q));
};

/** "Trust signals" from "trust_signals". */
export const humanKey = (key: string): string => {
  const words = key.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** One line of text, for a claim made from a Mem0 entry. */
export const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

export const pageLabel = (offset: number, count: number, total: number): string =>
  total === 0 ? 'No results' : `${(offset + 1).toLocaleString()}–${(offset + count).toLocaleString()} of ${total.toLocaleString()}`;
