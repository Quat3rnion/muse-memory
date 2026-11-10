// Local service for the Memory extension. OpenChamber starts it and sends panel
// requests to it on 127.0.0.1 with a private bearer token. Every route runs musemem.py.
//
// Routes (JSON):
//   GET  /health
//   GET  /stats
//   GET  /claims?status=&kind=&q=&entity=&pinned=&sort=&limit=&offset=
//   GET  /claim?id=c_xxxxxxxx
//   POST /claim/edit   {id, text?, kind?, salience?, confidence?, pinned?, status?}
//   POST /forget       {id (claim id or Mem0 uuid), reason}
//   GET  /legacy?q=
//   POST /legacy/adopt {id (Mem0 uuid), text, kind, salience?}
//   GET  /dreams
//   GET  /dream?date=YYYY-MM-DD|synthesis
//   GET  /pinned-text
//   POST /pinned-text  {text}
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AdoptResult, LegacyList, TextResult } from '../shared/types.ts';
import { MusememError, runJson, runText } from './musemem.ts';
import {
  LIMITS,
  ValidationError,
  claimId,
  dreamArgs,
  editArgs,
  forgetArgs,
  listArgs,
  noteArgs,
  notedId,
  pinnedText,
  text,
  uuid,
} from './validate.ts';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const sendJson = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Discard the rest of the upload so the client still gets the 413 answer.
        tooLarge = true;
        chunks.length = 0;
        reject(new HttpError('Request body too large', 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const readJson = async (req: http.IncomingMessage): Promise<Record<string, unknown>> => {
  const raw = await readBody(req);
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError('Body is not valid JSON', 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError('Body must be a JSON object', 400);
  return parsed as Record<string, unknown>;
};

const expectedAuth = Buffer.from(`Bearer ${token}`);

const authorized = (header: string | undefined): boolean => {
  if (header === undefined) return false;
  const given = Buffer.from(header);
  return given.length === expectedAuth.length && timingSafeEqual(given, expectedAuth);
};

const adopt = async (body: Record<string, unknown>): Promise<AdoptResult> => {
  const id = uuid(body.id);
  const args = noteArgs(body);
  // Make sure the Mem0 entry exists and has no claim before a new claim is written.
  const legacy = await runJson<LegacyList>(['legacy']);
  if (!legacy.items.some((item) => item.id.toLowerCase() === id)) throw new HttpError('This Mem0 entry is not in the legacy list', 404);
  const noted = await runText(args, { write: true });
  const newId = notedId(noted);
  try {
    await runText(['forget', id, '--reason=adopted'], { write: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new HttpError(`Saved as ${newId ?? 'a new claim'}, but the old Mem0 entry was not removed: ${reason}`, 502);
  }
  return { ok: true, claim_id: newId, message: noted };
};

const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
  if (!authorized(req.headers.authorization)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const query = url.searchParams;
  const route = `${req.method ?? 'GET'} ${url.pathname}`;

  switch (route) {
    case 'GET /health':
      sendJson(res, 200, { ok: true });
      return;
    case 'GET /stats':
      sendJson(res, 200, await runJson(['stats']));
      return;
    case 'GET /claims':
      sendJson(res, 200, await runJson(listArgs(query)));
      return;
    case 'GET /claim':
      sendJson(res, 200, await runJson(['show', claimId(query.get('id'))]));
      return;
    case 'POST /claim/edit':
      sendJson(res, 200, await runJson(editArgs(await readJson(req)), { write: true }));
      return;
    case 'POST /forget': {
      const message = await runText(forgetArgs(await readJson(req)), { write: true });
      sendJson(res, 200, { ok: true, message } satisfies TextResult);
      return;
    }
    case 'GET /legacy': {
      const q = query.get('q');
      const args = ['legacy'];
      if (q && q.trim() !== '') args.push(`--q=${text(q, 'q', LIMITS.query)}`);
      sendJson(res, 200, await runJson(args));
      return;
    }
    case 'POST /legacy/adopt':
      sendJson(res, 200, await adopt(await readJson(req)));
      return;
    case 'GET /dreams':
      sendJson(res, 200, await runJson(['dreams']));
      return;
    case 'GET /dream':
      sendJson(res, 200, await runJson(dreamArgs(query.get('date'))));
      return;
    case 'GET /pinned-text':
      sendJson(res, 200, await runJson(['pinned-text']));
      return;
    case 'POST /pinned-text': {
      const value = pinnedText(await readJson(req));
      sendJson(res, 200, await runJson(['pinned-text', '--set'], { write: true, stdin: value }));
      return;
    }
    default:
      sendJson(res, 404, { error: 'not-found' });
  }
};

const server = http.createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof ValidationError) sendJson(res, 400, { error: error.message });
    else if (error instanceof HttpError) sendJson(res, error.status, { error: error.message });
    else if (error instanceof MusememError) sendJson(res, error.status, { error: error.message, ...(error.busy ? { busy: true } : {}) });
    else sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

process.on('uncaughtException', (error) => console.error(`[memory] uncaught: ${error.message}`));
process.on('unhandledRejection', (error) => console.error(`[memory] unhandled: ${String(error)}`));
process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});

server.listen(port, '127.0.0.1');
