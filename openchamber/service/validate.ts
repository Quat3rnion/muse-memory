// Input checks for the service. Each builder returns the argument array for musemem.py.
// Values go in "--flag=value" form, so a value that starts with "-" is never read as a flag.
import { KINDS, SORTS, STATUSES } from '../shared/types.ts';

export class ValidationError extends Error {}

export const CLAIM_ID = /^c_[0-9a-f]{8}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Control characters other than tab and newline.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export const LIMITS = {
  text: 2000,
  reason: 500,
  query: 200,
  entity: 120,
  pinned: 4000,
  pageSize: 200,
} as const;

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], name: string): T => {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
};

export const claimId = (value: unknown): string => {
  if (typeof value !== 'string' || !CLAIM_ID.test(value)) throw new ValidationError('id must look like c_0123abcd');
  return value;
};

export const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ValidationError('id must be a Mem0 uuid');
  return value.toLowerCase();
};

export const text = (value: unknown, name: string, max: number, options: { multiline?: boolean; allowEmpty?: boolean } = {}): string => {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be a string`);
  const trimmed = value.trim();
  if (!options.allowEmpty && trimmed === '') throw new ValidationError(`${name} is empty`);
  if ([...trimmed].length > max) throw new ValidationError(`${name} is longer than ${max} characters`);
  if (CONTROL.test(trimmed)) throw new ValidationError(`${name} has control characters`);
  if (!options.multiline && /[\r\n]/.test(trimmed)) throw new ValidationError(`${name} must be one line`);
  return trimmed;
};

export const unit = (value: unknown, name: string): number => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) throw new ValidationError(`${name} must be a number from 0 to 1`);
  return Math.round(n * 1000) / 1000;
};

const int = (value: string | null, name: string, min: number, max: number, fallback: number): number => {
  if (value === null || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new ValidationError(`${name} must be a whole number`);
  const n = Number(value);
  if (n < min || n > max) throw new ValidationError(`${name} must be from ${min} to ${max}`);
  return n;
};

/** GET /claims query -> `list` arguments. */
export const listArgs = (query: URLSearchParams): string[] => {
  const args = ['list'];
  const status = query.get('status');
  if (status) args.push(`--status=${oneOf(status, STATUSES, 'status')}`);
  const kind = query.get('kind');
  if (kind) args.push(`--kind=${oneOf(kind, KINDS, 'kind')}`);
  const q = query.get('q');
  if (q && q.trim() !== '') args.push(`--q=${text(q, 'q', LIMITS.query)}`);
  const entity = query.get('entity');
  if (entity && entity.trim() !== '') args.push(`--entity=${text(entity, 'entity', LIMITS.entity)}`);
  const pinned = query.get('pinned');
  if (pinned === '1' || pinned === 'true') args.push('--pinned');
  else if (pinned !== null && pinned !== '' && pinned !== '0' && pinned !== 'false') throw new ValidationError('pinned must be true or false');
  const sort = query.get('sort');
  if (sort) args.push(`--sort=${oneOf(sort, SORTS, 'sort')}`);
  args.push(`--limit=${int(query.get('limit'), 'limit', 1, LIMITS.pageSize, 50)}`);
  args.push(`--offset=${int(query.get('offset'), 'offset', 0, 1_000_000, 0)}`);
  return args;
};

/** POST /claim/edit body -> `edit` arguments. At least one change is required. */
export const editArgs = (body: Record<string, unknown>): string[] => {
  const args = ['edit', claimId(body.id)];
  const before = args.length;
  if (body.text !== undefined) args.push(`--text=${text(body.text, 'text', LIMITS.text)}`);
  if (body.kind !== undefined) args.push(`--kind=${oneOf(body.kind, KINDS, 'kind')}`);
  if (body.salience !== undefined) args.push(`--salience=${unit(body.salience, 'salience')}`);
  if (body.confidence !== undefined) args.push(`--confidence=${unit(body.confidence, 'confidence')}`);
  if (body.pinned !== undefined) {
    if (typeof body.pinned !== 'boolean') throw new ValidationError('pinned must be true or false');
    args.push(`--pin=${body.pinned ? 'on' : 'off'}`);
  }
  if (body.status !== undefined) args.push(`--status=${oneOf(body.status, ['active', 'superseded'] as const, 'status')}`);
  if (args.length === before) throw new ValidationError('Nothing to change');
  return args;
};

/** POST /forget body -> `forget` arguments. The id is a claim id or a Mem0 uuid. */
export const forgetArgs = (body: Record<string, unknown>): string[] => {
  const raw = body.id;
  const id = typeof raw === 'string' && CLAIM_ID.test(raw) ? raw : uuid(raw);
  return ['forget', id, `--reason=${text(body.reason, 'reason', LIMITS.reason)}`];
};

/** `note` arguments. The text goes after "--" so it is always positional. */
export const noteArgs = (body: Record<string, unknown>): string[] => {
  const kind = oneOf(body.kind, KINDS, 'kind');
  const salience = body.salience === undefined ? 0.8 : unit(body.salience, 'salience');
  return ['note', `--kind=${kind}`, `--salience=${salience}`, '--', text(body.text, 'text', LIMITS.text)];
};

/** GET /dream?date= -> `dreams --date` arguments. */
export const dreamArgs = (date: string | null): string[] => {
  if (date !== 'synthesis' && (date === null || !DATE.test(date))) throw new ValidationError('date must be YYYY-MM-DD or synthesis');
  return ['dreams', `--date=${date}`];
};

/** POST /pinned-text body -> the text for STDIN. Empty text is allowed. */
export const pinnedText = (body: Record<string, unknown>): string => {
  if (typeof body.text !== 'string') throw new ValidationError('text must be a string');
  const value = body.text.replace(/\r\n?/g, '\n');
  if ([...value].length > LIMITS.pinned) throw new ValidationError(`text is longer than ${LIMITS.pinned} characters`);
  if (CONTROL.test(value)) throw new ValidationError('text has control characters');
  return value;
};

/** Reads the new claim id from the `note` output line "noted c_0123abcd (...)". */
export const notedId = (line: string): string | null => /\bnoted (c_[0-9a-f]{8})\b/.exec(line)?.[1] ?? null;
