// Runs musemem.py as a child process. No shell: the arguments go to spawn() as an array.
// Reads run in parallel up to a limit. Writes run one at a time.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Default: the musemem.py of this repository (service/ -> openchamber/ -> repo root).
export const MUSEMEM_BIN = process.env.MUSEMEM_BIN || fileURLToPath(new URL('../../musemem/bin/musemem.py', import.meta.url));

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_PARALLEL = 4;
const MAX_QUEUED = 32;

/** An error with the HTTP status that the service sends for it. */
export class MusememError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly busy = false,
  ) {
    super(message);
  }
}

interface Output {
  code: number | null;
  stdout: string;
  stderr: string;
}

let running = 0;
const waiting: Array<() => void> = [];
let writeChain: Promise<unknown> = Promise.resolve();

const acquire = async (): Promise<void> => {
  if (running < MAX_PARALLEL) {
    running += 1;
    return;
  }
  if (waiting.length >= MAX_QUEUED) throw new MusememError('busy: too many requests. Try again.', 429, true);
  await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
};

const release = (): void => {
  running -= 1;
  waiting.shift()?.();
};

const exec = (args: string[], stdin?: string): Promise<Output> =>
  new Promise((resolve, reject) => {
    const child = spawn(MUSEMEM_BIN, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);
    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        child.kill('SIGKILL');
        return;
      }
      sink.push(chunk);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new MusememError(error.code === 'ENOENT' ? `musemem.py not found at ${MUSEMEM_BIN}` : `Cannot start musemem.py: ${error.message}`, 500));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new MusememError('musemem.py did not answer in 60 seconds', 504));
        return;
      }
      if (size > MAX_OUTPUT) {
        reject(new MusememError('musemem.py output is too large', 502));
        return;
      }
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin ?? '');
  });

const failure = (result: Output): MusememError => {
  let message = '';
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') message = (parsed as { error: string }).error;
  } catch {
    // Not JSON.
  }
  if (!message) {
    const lines = `${result.stderr}\n${result.stdout}`.split('\n').map((line) => line.trim()).filter(Boolean);
    message = lines.at(-1) ?? `musemem.py stopped with exit code ${result.code}`;
  }
  if (message.startsWith('busy:')) return new MusememError(message, 409, true);
  if (/not found|unknown claim|no such/i.test(message)) return new MusememError(message, 404);
  return new MusememError(message, 422);
};

const run = async (args: string[], options: { write?: boolean; stdin?: string }): Promise<string> => {
  const job = async (): Promise<string> => {
    await acquire();
    try {
      const result = await exec(args, options.stdin);
      if (result.code !== 0) throw failure(result);
      return result.stdout;
    } finally {
      release();
    }
  };
  if (!options.write) return job();
  const next = writeChain.then(job, job);
  writeChain = next.catch(() => undefined);
  return next;
};

/** Runs a command that prints one JSON object. */
export const runJson = async <T>(args: string[], options: { write?: boolean; stdin?: string } = {}): Promise<T> => {
  const stdout = await run(args, options);
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new MusememError('musemem.py did not print JSON', 502);
  }
};

/** Runs a command that prints a plain text line (note, forget). */
export const runText = async (args: string[], options: { write?: boolean } = {}): Promise<string> =>
  (await run(args, options)).trim();
