// service/main.ts
import { timingSafeEqual } from "node:crypto";
import http from "node:http";

// service/musemem.ts
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
var MUSEMEM_BIN = process.env.MUSEMEM_BIN || fileURLToPath(new URL("../../musemem/bin/musemem.py", import.meta.url));
var TIMEOUT_MS = 60000;
var MAX_OUTPUT = 16 * 1024 * 1024;
var MAX_PARALLEL = 4;
var MAX_QUEUED = 32;

class MusememError extends Error {
  status;
  busy;
  constructor(message, status, busy = false) {
    super(message);
    this.status = status;
    this.busy = busy;
  }
}
var running = 0;
var waiting = [];
var writeChain = Promise.resolve();
var acquire = async () => {
  if (running < MAX_PARALLEL) {
    running += 1;
    return;
  }
  if (waiting.length >= MAX_QUEUED)
    throw new MusememError("busy: too many requests. Try again.", 429, true);
  await new Promise((resolve) => waiting.push(resolve));
  running += 1;
};
var release = () => {
  running -= 1;
  waiting.shift()?.();
};
var exec = (args, stdin) => new Promise((resolve, reject) => {
  const child = spawn(MUSEMEM_BIN, args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  const out = [];
  const err = [];
  let size = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, TIMEOUT_MS);
  const collect = (sink) => (chunk) => {
    size += chunk.length;
    if (size > MAX_OUTPUT) {
      child.kill("SIGKILL");
      return;
    }
    sink.push(chunk);
  };
  child.stdout.on("data", collect(out));
  child.stderr.on("data", collect(err));
  child.on("error", (error) => {
    clearTimeout(timer);
    reject(new MusememError(error.code === "ENOENT" ? `musemem.py not found at ${MUSEMEM_BIN}` : `Cannot start musemem.py: ${error.message}`, 500));
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (timedOut) {
      reject(new MusememError("musemem.py did not answer in 60 seconds", 504));
      return;
    }
    if (size > MAX_OUTPUT) {
      reject(new MusememError("musemem.py output is too large", 502));
      return;
    }
    resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
  });
  child.stdin.on("error", () => {
    return;
  });
  child.stdin.end(stdin ?? "");
});
var failure = (result) => {
  let message = "";
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed && typeof parsed === "object" && typeof parsed.error === "string")
      message = parsed.error;
  } catch {}
  if (!message) {
    const lines = `${result.stderr}
${result.stdout}`.split(`
`).map((line) => line.trim()).filter(Boolean);
    message = lines.at(-1) ?? `musemem.py stopped with exit code ${result.code}`;
  }
  if (message.startsWith("busy:"))
    return new MusememError(message, 409, true);
  if (/not found|unknown claim|no such/i.test(message))
    return new MusememError(message, 404);
  return new MusememError(message, 422);
};
var run = async (args, options) => {
  const job = async () => {
    await acquire();
    try {
      const result = await exec(args, options.stdin);
      if (result.code !== 0)
        throw failure(result);
      return result.stdout;
    } finally {
      release();
    }
  };
  if (!options.write)
    return job();
  const next = writeChain.then(job, job);
  writeChain = next.catch(() => {
    return;
  });
  return next;
};
var runJson = async (args, options = {}) => {
  const stdout = await run(args, options);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new MusememError("musemem.py did not print JSON", 502);
  }
};
var runText = async (args, options = {}) => (await run(args, options)).trim();

// shared/types.ts
var KINDS = ["fact", "preference", "commitment", "experience", "opinion"];
var STATUSES = ["active", "superseded", "retracted", "all"];
var SORTS = ["salience", "recent", "confidence"];

// service/validate.ts
class ValidationError extends Error {
}
var CLAIM_ID = /^c_[0-9a-f]{8}$/;
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var DATE = /^\d{4}-\d{2}-\d{2}$/;
var CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
var LIMITS = {
  text: 2000,
  reason: 500,
  query: 200,
  entity: 120,
  pinned: 4000,
  pageSize: 200
};
var oneOf = (value, allowed, name) => {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new ValidationError(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value;
};
var claimId = (value) => {
  if (typeof value !== "string" || !CLAIM_ID.test(value))
    throw new ValidationError("id must look like c_0123abcd");
  return value;
};
var uuid = (value) => {
  if (typeof value !== "string" || !UUID.test(value))
    throw new ValidationError("id must be a Mem0 uuid");
  return value.toLowerCase();
};
var text = (value, name, max, options = {}) => {
  if (typeof value !== "string")
    throw new ValidationError(`${name} must be a string`);
  const trimmed = value.trim();
  if (!options.allowEmpty && trimmed === "")
    throw new ValidationError(`${name} is empty`);
  if ([...trimmed].length > max)
    throw new ValidationError(`${name} is longer than ${max} characters`);
  if (CONTROL.test(trimmed))
    throw new ValidationError(`${name} has control characters`);
  if (!options.multiline && /[\r\n]/.test(trimmed))
    throw new ValidationError(`${name} must be one line`);
  return trimmed;
};
var unit = (value, name) => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1)
    throw new ValidationError(`${name} must be a number from 0 to 1`);
  return Math.round(n * 1000) / 1000;
};
var int = (value, name, min, max, fallback) => {
  if (value === null || value === "")
    return fallback;
  if (!/^\d+$/.test(value))
    throw new ValidationError(`${name} must be a whole number`);
  const n = Number(value);
  if (n < min || n > max)
    throw new ValidationError(`${name} must be from ${min} to ${max}`);
  return n;
};
var listArgs = (query) => {
  const args = ["list"];
  const status = query.get("status");
  if (status)
    args.push(`--status=${oneOf(status, STATUSES, "status")}`);
  const kind = query.get("kind");
  if (kind)
    args.push(`--kind=${oneOf(kind, KINDS, "kind")}`);
  const q = query.get("q");
  if (q && q.trim() !== "")
    args.push(`--q=${text(q, "q", LIMITS.query)}`);
  const entity = query.get("entity");
  if (entity && entity.trim() !== "")
    args.push(`--entity=${text(entity, "entity", LIMITS.entity)}`);
  const pinned = query.get("pinned");
  if (pinned === "1" || pinned === "true")
    args.push("--pinned");
  else if (pinned !== null && pinned !== "" && pinned !== "0" && pinned !== "false")
    throw new ValidationError("pinned must be true or false");
  const sort = query.get("sort");
  if (sort)
    args.push(`--sort=${oneOf(sort, SORTS, "sort")}`);
  args.push(`--limit=${int(query.get("limit"), "limit", 1, LIMITS.pageSize, 50)}`);
  args.push(`--offset=${int(query.get("offset"), "offset", 0, 1e6, 0)}`);
  return args;
};
var editArgs = (body) => {
  const args = ["edit", claimId(body.id)];
  const before = args.length;
  if (body.text !== undefined)
    args.push(`--text=${text(body.text, "text", LIMITS.text)}`);
  if (body.kind !== undefined)
    args.push(`--kind=${oneOf(body.kind, KINDS, "kind")}`);
  if (body.salience !== undefined)
    args.push(`--salience=${unit(body.salience, "salience")}`);
  if (body.confidence !== undefined)
    args.push(`--confidence=${unit(body.confidence, "confidence")}`);
  if (body.pinned !== undefined) {
    if (typeof body.pinned !== "boolean")
      throw new ValidationError("pinned must be true or false");
    args.push(`--pin=${body.pinned ? "on" : "off"}`);
  }
  if (body.status !== undefined)
    args.push(`--status=${oneOf(body.status, ["active", "superseded"], "status")}`);
  if (args.length === before)
    throw new ValidationError("Nothing to change");
  return args;
};
var forgetArgs = (body) => {
  const raw = body.id;
  const id = typeof raw === "string" && CLAIM_ID.test(raw) ? raw : uuid(raw);
  return ["forget", id, `--reason=${text(body.reason, "reason", LIMITS.reason)}`];
};
var noteArgs = (body) => {
  const kind = oneOf(body.kind, KINDS, "kind");
  const salience = body.salience === undefined ? 0.8 : unit(body.salience, "salience");
  return ["note", `--kind=${kind}`, `--salience=${salience}`, "--", text(body.text, "text", LIMITS.text)];
};
var dreamArgs = (date) => {
  if (date !== "synthesis" && (date === null || !DATE.test(date)))
    throw new ValidationError("date must be YYYY-MM-DD or synthesis");
  return ["dreams", `--date=${date}`];
};
var pinnedText = (body) => {
  if (typeof body.text !== "string")
    throw new ValidationError("text must be a string");
  const value = body.text.replace(/\r\n?/g, `
`);
  if ([...value].length > LIMITS.pinned)
    throw new ValidationError(`text is longer than ${LIMITS.pinned} characters`);
  if (CONTROL.test(value))
    throw new ValidationError("text has control characters");
  return value;
};
var notedId = (line) => /\bnoted (c_[0-9a-f]{8})\b/.exec(line)?.[1] ?? null;

// service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  status;
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
var sendJson = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};
var readBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  let tooLarge = false;
  const chunks = [];
  req.on("data", (chunk) => {
    if (tooLarge)
      return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      reject(new HttpError("Request body too large", 413));
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});
var readJson = async (req) => {
  const raw = await readBody(req);
  if (raw.trim() === "")
    return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError("Body is not valid JSON", 400);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new HttpError("Body must be a JSON object", 400);
  return parsed;
};
var expectedAuth = Buffer.from(`Bearer ${token}`);
var authorized = (header) => {
  if (header === undefined)
    return false;
  const given = Buffer.from(header);
  return given.length === expectedAuth.length && timingSafeEqual(given, expectedAuth);
};
var adopt = async (body) => {
  const id = uuid(body.id);
  const args = noteArgs(body);
  const legacy = await runJson(["legacy"]);
  if (!legacy.items.some((item) => item.id.toLowerCase() === id))
    throw new HttpError("This Mem0 entry is not in the legacy list", 404);
  const noted = await runText(args, { write: true });
  const newId = notedId(noted);
  try {
    await runText(["forget", id, "--reason=adopted"], { write: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new HttpError(`Saved as ${newId ?? "a new claim"}, but the old Mem0 entry was not removed: ${reason}`, 502);
  }
  return { ok: true, claim_id: newId, message: noted };
};
var handle = async (req, res) => {
  if (!authorized(req.headers.authorization)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const query = url.searchParams;
  const route = `${req.method ?? "GET"} ${url.pathname}`;
  switch (route) {
    case "GET /health":
      sendJson(res, 200, { ok: true });
      return;
    case "GET /stats":
      sendJson(res, 200, await runJson(["stats"]));
      return;
    case "GET /claims":
      sendJson(res, 200, await runJson(listArgs(query)));
      return;
    case "GET /claim":
      sendJson(res, 200, await runJson(["show", claimId(query.get("id"))]));
      return;
    case "POST /claim/edit":
      sendJson(res, 200, await runJson(editArgs(await readJson(req)), { write: true }));
      return;
    case "POST /forget": {
      const message = await runText(forgetArgs(await readJson(req)), { write: true });
      sendJson(res, 200, { ok: true, message });
      return;
    }
    case "GET /legacy": {
      const q = query.get("q");
      const args = ["legacy"];
      if (q && q.trim() !== "")
        args.push(`--q=${text(q, "q", LIMITS.query)}`);
      sendJson(res, 200, await runJson(args));
      return;
    }
    case "POST /legacy/adopt":
      sendJson(res, 200, await adopt(await readJson(req)));
      return;
    case "GET /dreams":
      sendJson(res, 200, await runJson(["dreams"]));
      return;
    case "GET /dream":
      sendJson(res, 200, await runJson(dreamArgs(query.get("date"))));
      return;
    case "GET /pinned-text":
      sendJson(res, 200, await runJson(["pinned-text"]));
      return;
    case "POST /pinned-text": {
      const value = pinnedText(await readJson(req));
      sendJson(res, 200, await runJson(["pinned-text", "--set"], { write: true, stdin: value }));
      return;
    }
    default:
      sendJson(res, 404, { error: "not-found" });
  }
};
var server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof ValidationError)
      sendJson(res, 400, { error: error.message });
    else if (error instanceof HttpError)
      sendJson(res, error.status, { error: error.message });
    else if (error instanceof MusememError)
      sendJson(res, error.status, { error: error.message, ...error.busy ? { busy: true } : {} });
    else
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});
process.on("uncaughtException", (error) => console.error(`[memory] uncaught: ${error.message}`));
process.on("unhandledRejection", (error) => console.error(`[memory] unhandled: ${String(error)}`));
process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});
server.listen(port, "127.0.0.1");
