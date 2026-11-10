#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "httpx>=0.27",
#   "pyyaml>=6",
# ]
# ///
"""
musemem: file-backed memory pipeline for opencode, modelled on the Muse layout.

Layers
  1 live files     ~/MEMORY.md (curated, has a hand-edited section)
                   ~/memory/YYYY-MM-DD.md (daily claim log, one line per claim)
  2 consolidation  `musemem consolidate` (hourly): reads new user messages from
                   the opencode session DB, extracts claims with an LLM, checks
                   that each quote occurs verbatim in a cited message, merges
                   duplicates, marks superseded claims, promotes durable claims.
  3 derived bank   ~/memory/bank/{world,experience,opinions,reflections}.md and
                   ~/memory/people/, ~/memory/groups/; each line cites file:line.
  4 index          claim ledger ~/memory/.index/claims.db (evidence, status,
                   supersedes_claim_id) + Mem0 (pgvector) for semantic recall.
  5 dreams         `musemem dream` (nightly): ~/dreams/YYYY-MM-DD.md prose plus
                   ALIGNMENT_SYNTHESIS.md and YAML companion files.
  6 recall         `musemem search`, `musemem explain <claim_id>`.
  F forget         `musemem forget <claim_id>...`: stage, retract claim and
                   derivatives, tombstone, rebuild derived files.

Environment
  MUSE_HOME        root for MEMORY.md, memory/, dreams/ (default: ~)
  MUSE_LLM_URL     OpenAI-compatible base URL (default http://127.0.0.1:8731/v1)
  MUSE_LLM_MODEL   chat model name (default LFM3-1.7B)
  MUSE_LLM_KEY     optional bearer token
  OPENCODE_DB      default ~/.local/share/opencode/opencode.db
  MEM0_URL, MEM0_API_KEY_FILE, MEM0_USER_ID   as for the mem0 MCP server
  MUSE_AGENT_ID    agent attribution for Mem0 writes (default opencode)
  MUSE_ENV_FILE    optional KEY=VALUE file (default ~/.config/muse-memory/env);
                   set variables take precedence
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
import pathlib
import re
import secrets
import sqlite3
import sys
import time
from typing import Any, Iterable

import httpx
import yaml


def _load_env_file() -> None:
    """Read KEY=VALUE lines from $MUSE_ENV_FILE (default ~/.config/muse-memory/env).
    Variables that are already set in the environment take precedence."""
    path = pathlib.Path(os.path.expanduser(os.environ.get("MUSE_ENV_FILE", "~/.config/muse-memory/env")))
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip().removeprefix("export ").strip(), value.strip().strip("'\"")
        if key and value and not os.environ.get(key):
            os.environ[key] = value


_load_env_file()

HOME = pathlib.Path(os.path.expanduser(os.environ.get("MUSE_HOME", "~")))
MEMORY_MD = HOME / "MEMORY.md"
MEM_DIR = HOME / "memory"
BANK = MEM_DIR / "bank"
PEOPLE = MEM_DIR / "people"
GROUPS = MEM_DIR / "groups"
INDEX_DIR = MEM_DIR / ".index"
LEDGER = INDEX_DIR / "claims.db"
FORGET_DIR = MEM_DIR / "forget"
RUNS = MEM_DIR / "runs"
DREAMS = HOME / "dreams"
SYNTHESIS = DREAMS / "ALIGNMENT_SYNTHESIS.md"

OPENCODE_DB = pathlib.Path(os.path.expanduser(os.environ.get("OPENCODE_DB", "~/.local/share/opencode/opencode.db")))
LLM_URL = os.environ.get("MUSE_LLM_URL", "http://127.0.0.1:8731/v1").rstrip("/")
LLM_MODEL = os.environ.get("MUSE_LLM_MODEL", "LFM3-1.7B")
LLM_KEY = os.environ.get("MUSE_LLM_KEY", "")
MEM0_URL = os.environ.get("MEM0_URL", "http://127.0.0.1:9120").rstrip("/")
MEM0_USER = os.environ.get("MEM0_USER_ID") or os.environ.get("USER") or "default"
AGENT_ID = os.environ.get("MUSE_AGENT_ID", "opencode")

KINDS = ("fact", "preference", "commitment", "experience", "opinion")
BANK_OF = {"fact": "world", "experience": "experience", "commitment": "experience",
           "preference": "opinions", "opinion": "opinions"}
PROMOTE_KINDS = {"fact", "preference", "commitment", "opinion"}
PROMOTE_SALIENCE = 0.6
PROMOTE_CONFIDENCE = 0.6
MEMORY_MD_MAX_LINES = 45
ENTITY_MIN_CLAIMS = 2
BATCH_CHARS = 14000
DEFAULT_BACKFILL_DAYS = 7
SECRET_RE = re.compile(
    r"(gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}"
    r"|-----BEGIN [A-Z ]*PRIVATE KEY|xox[abp]-[A-Za-z0-9-]{10,}|(?i:password|passwd|api[_-]?key|secret)\s*[:=]\s*\S{6,})"
)
MANUAL_START = "<!-- manual:start -->"
MANUAL_END = "<!-- manual:end -->"


# --------------------------------------------------------------------------- utils

def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def local_date(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000).astimezone().strftime("%Y-%m-%d")


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip().lower()


def h(text: str) -> str:
    return hashlib.sha256(norm(text).encode()).hexdigest()[:32]


def log(msg: str) -> None:
    print(f"[musemem {dt.datetime.now():%H:%M:%S}] {msg}", file=sys.stderr, flush=True)


def ensure_dirs() -> None:
    for d in (MEM_DIR, BANK, PEOPLE, GROUPS, INDEX_DIR, FORGET_DIR, RUNS, DREAMS):
        d.mkdir(parents=True, exist_ok=True, mode=0o700)


def atomic_write(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}")
    tmp.write_text(text)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


@contextlib.contextmanager
def job_lock(on_busy=None):
    ensure_dirs()
    with open(INDEX_DIR / "job.lock", "w") as fh:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            if on_busy:
                on_busy()
            log("another musemem job holds the lock; exiting")
            sys.exit(0)
        yield


def receipt(job: str, lines: list[str]) -> None:
    body = f"# {job}\n\nrun: {now_iso()}\n\n" + "\n".join(f"- {line}" for line in lines) + "\n"
    atomic_write(RUNS / job / "CURRENT.md", body)


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60] or "unnamed"


# --------------------------------------------------------------------------- ledger

SCHEMA = """
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  kind TEXT NOT NULL,
  salience REAL NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',          -- active | superseded | retracted
  supersedes_claim_id TEXT,
  superseded_by TEXT,
  quote TEXT,
  session_id TEXT,
  message_ids TEXT NOT NULL DEFAULT '[]',          -- JSON list
  entities TEXT NOT NULL DEFAULT '[]',             -- JSON list of {name,type}
  origin TEXT NOT NULL DEFAULT 'consolidate',      -- consolidate | live | legacy
  observed_at TEXT,
  created_at TEXT NOT NULL,
  daily_file TEXT,
  mem0_id TEXT,
  text_hash TEXT,
  quote_hash TEXT
);
CREATE INDEX IF NOT EXISTS claims_status ON claims(status);
CREATE TABLE IF NOT EXISTS evidence (
  claim_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  session_id TEXT,
  quote TEXT,
  added_at TEXT NOT NULL,
  PRIMARY KEY (claim_id, message_id)
);
CREATE TABLE IF NOT EXISTS tombstones (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                              -- text | quote | message
  claim_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
"""


def ledger() -> sqlite3.Connection:
    ensure_dirs()
    con = sqlite3.connect(LEDGER)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    cols = {r[1] for r in con.execute("PRAGMA table_info(claims)")}
    for col, ddl in (("pinned", "INTEGER NOT NULL DEFAULT 0"), ("edited_at", "TEXT")):
        if col not in cols:
            con.execute(f"ALTER TABLE claims ADD COLUMN {col} {ddl}")
    return con


def meta_get(con, k, default=None):
    row = con.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    return row["v"] if row else default


def meta_set(con, k, v):
    con.execute("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, str(v)))


def new_claim_id(con) -> str:
    while True:
        cid = "c_" + secrets.token_hex(4)
        if not con.execute("SELECT 1 FROM claims WHERE id=?", (cid,)).fetchone():
            return cid


def tombstoned(con, *hashes: str) -> bool:
    hs = [x for x in hashes if x]
    if not hs:
        return False
    q = f"SELECT 1 FROM tombstones WHERE hash IN ({','.join('?' * len(hs))})"
    return con.execute(q, hs).fetchone() is not None


def active_claims(con) -> list[sqlite3.Row]:
    return con.execute("SELECT * FROM claims WHERE status='active' ORDER BY salience DESC, created_at DESC").fetchall()


# --------------------------------------------------------------------------- llm

def llm_json(system: str, user: str, max_tokens: int = 6000, timeout: float = 600.0) -> dict:
    headers = {"content-type": "application/json"}
    if LLM_KEY:
        headers["authorization"] = f"Bearer {LLM_KEY}"
    payload = {
        "model": LLM_MODEL,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "max_tokens": max_tokens,
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
    }
    last: Exception | None = None
    for attempt in range(3):
        try:
            r = httpx.post(f"{LLM_URL}/chat/completions", json=payload, headers=headers, timeout=timeout)
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"] or ""
            content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip())
            return json.loads(content)
        except Exception as error:  # noqa: BLE001
            last = error
            log(f"llm attempt {attempt + 1} failed: {type(error).__name__}: {str(error)[:200]}")
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"LLM failed after retries: {last}")


# --------------------------------------------------------------------------- mem0

def _mem0_headers() -> dict:
    path = pathlib.Path(os.path.expanduser(os.environ.get("MEM0_API_KEY_FILE", "~/.config/mem0/api_key")))
    key = ""
    with contextlib.suppress(OSError):
        key = path.read_text().strip()
    key = key or os.environ.get("MEM0_API_KEY", "").strip()
    if not key:
        raise RuntimeError("no Mem0 API key")
    return {"X-API-Key": key, "content-type": "application/json"}


def mem0(method: str, path: str, timeout: float = 60.0, **kw) -> Any:
    r = httpx.request(method, MEM0_URL + path, headers=_mem0_headers(), timeout=timeout, **kw)
    if r.status_code == 404 and method == "DELETE":
        return {}
    if r.status_code >= 400:
        raise RuntimeError(f"Mem0 {method} {path} -> {r.status_code}: {r.text[:300]}")
    return r.json() if r.content else {}


def mem0_add_claim(row: sqlite3.Row) -> str | None:
    mids = json.loads(row["message_ids"])
    payload = {
        "messages": [{"role": "user", "content": row["text"]}],
        "user_id": MEM0_USER,
        "agent_id": AGENT_ID,
        "infer": False,
        "metadata": {
            "claim_id": row["id"], "kind": row["kind"], "tag": row["kind"],
            "salience": row["salience"], "confidence": row["confidence"],
            "source": f"session:{row['session_id']}#{mids[0] if mids else '?'}" if row["session_id"] else row["origin"],
            "quote": (row["quote"] or "")[:300], "client": "musemem",
        },
    }
    res = mem0("POST", "/memories", json=payload, timeout=120)
    for ev in (res.get("results") or []) if isinstance(res, dict) else []:
        if ev.get("id"):
            return ev["id"]
    return None


def mem0_search(query: str, top_k: int = 5, threshold: float = 0.5) -> list[dict]:
    body = {"query": query, "filters": {"user_id": MEM0_USER}, "top_k": top_k, "threshold": threshold}
    return mem0("POST", "/search", json=body).get("results") or []


# --------------------------------------------------------------------------- session source

def _text_of(mtype: str, data: dict) -> str:
    if mtype == "user":
        parts = [data.get("text") or ""]
    else:
        parts = [c.get("text", "") for c in data.get("content") or [] if isinstance(c, dict) and c.get("type") == "text"]
    return "\n".join(p for p in parts if p).strip()


def is_human(data: dict, text: str) -> bool:
    md = data.get("metadata") or {}
    if md.get("agentComms") or md.get("synthetic"):
        return False
    return bool(text) and not text.startswith(("[IRC", "<system-reminder>"))


def load_messages(since_ms: int, until_ms: int | None = None) -> list[dict]:
    """Human user messages from root sessions, each with the previous assistant text as context."""
    con = sqlite3.connect(f"file:{OPENCODE_DB}?mode=ro", uri=True, timeout=30)
    con.row_factory = sqlite3.Row
    q = """SELECT m.id, m.session_id, m.type, m.seq, m.time_created, m.data, s.title, s.directory
           FROM session_message m JOIN session_v2 s ON s.id = m.session_id
           WHERE s.parent_id IS NULL AND m.type IN ('user','assistant') AND m.time_created > ?"""
    args: list[Any] = [since_ms]
    if until_ms:
        q += " AND m.time_created <= ?"
        args.append(until_ms)
    q += " ORDER BY m.session_id, m.seq"
    out, last_assistant = [], {}
    for r in con.execute(q, args):
        try:
            data = json.loads(r["data"])
        except json.JSONDecodeError:
            continue
        text = _text_of(r["type"], data)
        if r["type"] == "assistant":
            if text:
                last_assistant[r["session_id"]] = text
            continue
        if not is_human(data, text):
            continue
        out.append({
            "id": r["id"], "session_id": r["session_id"], "time": r["time_created"],
            "title": r["title"] or "", "directory": r["directory"] or "", "text": text[:6000],
            "context": last_assistant.get(r["session_id"], "")[-500:],
        })
    con.close()
    return out


def batches(messages: list[dict]) -> Iterable[list[dict]]:
    by_session: dict[str, list[dict]] = {}
    for m in messages:
        by_session.setdefault(m["session_id"], []).append(m)
    for msgs in by_session.values():
        cur, size = [], 0
        for m in msgs:
            n = len(m["text"]) + len(m["context"]) + 100
            if cur and size + n > BATCH_CHARS:
                yield cur
                cur, size = [], 0
            cur.append(m)
            size += n
        if cur:
            yield cur


# --------------------------------------------------------------------------- consolidation

EXTRACT_SYSTEM = """You extract durable memory claims about one user ("the user") from their chat messages to coding agents.
Return JSON: {"claims": [{"text": str, "kind": one of fact|preference|commitment|experience|opinion,
 "salience": 0..1, "confidence": 0..1, "quote": str, "message_ids": [str], "entities": [{"name": str, "type": "person"|"group"|"project"}]}]}
entities: only people, teams/organisations (group) and the user's own named projects (project) that the claim is about.
Not tools, models, hosts, URLs, file paths or vendors. Use the canonical short name (e.g. "acme", not "acme-corp.example.com").

Rules:
- text: one self-contained statement in third person ("The user prefers ...", "The homelab runs ..."). Include enough context to stand alone months later.
- kind: fact = stable truth about the user's environment, systems, projects or world; preference = how the user wants work done;
  commitment = an ongoing promise, rule or plan that should still hold later; experience = a notable event, decision or outcome; opinion = the user's judgement of something.
- quote: copy an exact, contiguous substring (8-200 chars) from ONE cited user message that supports the claim. Never paraphrase the quote.
- message_ids: ids of the user messages that support the claim (first one must contain the quote).
- salience: how useful this is for future, unrelated sessions. Transient task detail, one-off commands, file-level edits, test results, debugging steps: do NOT extract.
- Never extract credentials, tokens, passwords, or private data about third parties beyond names and roles.
- The assistant context is only for resolving short replies like "yes"; claims must be supported by the user's own words.
- Prefer few, high-value claims. Return {"claims": []} when nothing durable is present."""

JUDGE_SYSTEM = """You compare NEW memory claims against EXISTING ones. For each new claim decide:
- "duplicate": an existing claim already states the same thing (target = that id)
- "supersedes": the new claim makes the existing claim FALSE or OUTDATED (a changed value, a reversed decision, a corrected fact)
  about the exact same attribute (target = that id). Sharing a topic, project or subject is NOT enough: if both
  claims can be true at the same time, the relation is "distinct". When in doubt, choose "distinct".
- "distinct": otherwise (target = null)
Examples: "deploys with commit, PR, deploy" vs "deploys with commit, push, merge, deploy" -> supersedes.
"has production access; nodes are ny1, la1" vs "has a test account on port 18004" -> distinct.
"home directory is /home/alice" vs "username is alice (home /home/alice, SSH key id_alice)" -> duplicate (new adds detail; keep old).
Return JSON: {"decisions": [{"new": <index>, "relation": "duplicate"|"supersedes"|"distinct", "target": <id or null>}]}"""


def verify(claim: dict, batch: list[dict]) -> tuple[bool, str]:
    by_id = {m["id"]: m for m in batch}
    mids = [m for m in claim.get("message_ids") or [] if m in by_id]
    quote = (claim.get("quote") or "").strip()
    text = (claim.get("text") or "").strip()
    if claim.get("kind") not in KINDS:
        return False, "bad kind"
    if len(text) < 12 or len(quote) < 8:
        return False, "too short"
    if not mids:
        return False, "no valid message ids"
    if SECRET_RE.search(text) or SECRET_RE.search(quote):
        return False, "secret-like content"
    nq = norm(quote)
    if not any(nq in norm(by_id[m]["text"]) for m in mids):
        return False, "quote not found verbatim"
    claim["message_ids"] = mids
    return True, ""


def _tokens(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]{3,}", s.lower())}


def candidates_for(text: str, pool: list[sqlite3.Row], k: int = 5) -> list[sqlite3.Row]:
    t = _tokens(text)
    scored = []
    for row in pool:
        o = _tokens(row["text"])
        if t and o:
            j = len(t & o) / len(t | o)
            if j >= 0.15:
                scored.append((j, row))
    scored.sort(key=lambda x: -x[0])
    return [r for _, r in scored[:k]]


def judge(new: list[dict], pool: list[sqlite3.Row]) -> dict[int, tuple[str, str | None]]:
    items, cand_ids = [], set()
    for i, c in enumerate(new):
        cands = candidates_for(c["text"], pool)
        if cands:
            items.append({"new": i, "text": c["text"], "existing": [{"id": r["id"], "text": r["text"]} for r in cands]})
            cand_ids |= {r["id"] for r in cands}
    if not items:
        return {}
    res = llm_json(JUDGE_SYSTEM, json.dumps({"items": items}, ensure_ascii=False), max_tokens=3000)
    out = {}
    for d in res.get("decisions") or []:
        try:
            i = int(d.get("new"))
        except (TypeError, ValueError):
            continue
        rel, tgt = d.get("relation"), d.get("target")
        if rel in ("duplicate", "supersedes") and tgt in cand_ids:
            out[i] = (rel, tgt)
    return out


def append_daily(row: sqlite3.Row, date: str) -> str:
    path = MEM_DIR / f"{date}.md"
    if not path.exists():
        atomic_write(path, f"# Memory log {date}\n\nOne line per claim. Format: [claim] (kind, salience) text -- \"quote\" <session/message>\n\n")
    mids = json.loads(row["message_ids"])
    src = f"{row['session_id']}/{mids[0]}" if row["session_id"] and mids else row["origin"]
    quote = (row["quote"] or "").replace("\n", " ")[:200]
    line = f"- [{row['id']}] ({row['kind']}, {row['salience']:.1f}) {row['text']} -- \"{quote}\" <{src}>\n"
    with open(path, "a") as fh:
        fh.write(line)
    return path.name


def insert_claim(con, c: dict, origin: str, session_id: str | None, observed_ms: int | None,
                 supersedes: str | None = None) -> sqlite3.Row:
    cid = new_claim_id(con)
    con.execute(
        """INSERT INTO claims(id,text,kind,salience,confidence,status,supersedes_claim_id,quote,session_id,message_ids,
           entities,origin,observed_at,created_at,text_hash,quote_hash) VALUES(?,?,?,?,?,'active',?,?,?,?,?,?,?,?,?,?)""",
        (cid, c["text"].strip(), c["kind"], float(c.get("salience", 0.5)), float(c.get("confidence", 0.7)), supersedes,
         c.get("quote"), session_id, json.dumps(c.get("message_ids") or []), json.dumps(c.get("entities") or []), origin,
         dt.datetime.fromtimestamp(observed_ms / 1000).astimezone().isoformat(timespec="seconds") if observed_ms else now_iso(),
         now_iso(), h(c["text"]), h(c.get("quote") or "")),
    )
    for mid in c.get("message_ids") or []:
        con.execute("INSERT OR IGNORE INTO evidence VALUES(?,?,?,?,?)", (cid, mid, session_id, c.get("quote"), now_iso()))
    return con.execute("SELECT * FROM claims WHERE id=?", (cid,)).fetchone()


def promote(con, row: sqlite3.Row) -> None:
    if row["kind"] not in PROMOTE_KINDS or row["salience"] < PROMOTE_SALIENCE or row["confidence"] < PROMOTE_CONFIDENCE:
        return
    try:
        mid = mem0_add_claim(row)
        if mid:
            con.execute("UPDATE claims SET mem0_id=? WHERE id=?", (mid, row["id"]))
    except Exception as error:  # noqa: BLE001
        log(f"mem0 promote {row['id']} failed: {error}")


def retire_mem0(con, claim_id: str) -> None:
    row = con.execute("SELECT mem0_id FROM claims WHERE id=?", (claim_id,)).fetchone()
    if row and row["mem0_id"]:
        try:
            mem0("DELETE", f"/memories/{row['mem0_id']}")
            con.execute("UPDATE claims SET mem0_id=NULL WHERE id=?", (claim_id,))
        except Exception as error:  # noqa: BLE001
            log(f"mem0 delete for {claim_id} failed: {error}")


def ingest(con, raw_claims: list[dict], batch: list[dict], origin: str, stats: dict) -> None:
    by_id = {m["id"]: m for m in batch}
    good = []
    for c in raw_claims:
        ok, why = verify(c, batch)
        if not ok:
            stats["rejected"] += 1
            log(f"rejected claim ({why}): {str(c.get('text'))[:100]}")
            continue
        if tombstoned(con, h(c["text"]), h(c["quote"]), *[h(m) for m in c["message_ids"]]):
            stats["tombstoned"] += 1
            continue
        if con.execute("SELECT 1 FROM claims WHERE quote_hash=? AND message_ids LIKE ?",
                       (h(c["quote"]), f'%"{c["message_ids"][0]}"%')).fetchone():
            stats["seen"] += 1
            continue
        good.append(c)
    if not good:
        return
    decisions = judge(good, active_claims(con))
    for i, c in enumerate(good):
        first = by_id[c["message_ids"][0]]
        rel, target = decisions.get(i, ("distinct", None))
        if rel == "duplicate":
            for mid in c["message_ids"]:
                con.execute("INSERT OR IGNORE INTO evidence VALUES(?,?,?,?,?)", (target, mid, first["session_id"], c["quote"], now_iso()))
            con.execute("UPDATE claims SET confidence=MIN(1.0, confidence+0.1), salience=MAX(salience, ?) WHERE id=?",
                        (float(c.get("salience", 0)), target))
            stats["merged"] += 1
            continue
        row = insert_claim(con, c, origin, first["session_id"], first["time"], supersedes=target if rel == "supersedes" else None)
        if rel == "supersedes":
            con.execute("UPDATE claims SET status='superseded', superseded_by=? WHERE id=?", (row["id"], target))
            retire_mem0(con, target)
            stats["superseded"] += 1
        daily = append_daily(row, local_date(first["time"]))
        con.execute("UPDATE claims SET daily_file=? WHERE id=?", (daily, row["id"]))
        promote(con, con.execute("SELECT * FROM claims WHERE id=?", (row["id"],)).fetchone())
        stats["added"] += 1
    con.commit()


def cmd_consolidate(args) -> int:
    with job_lock():
        con = ledger()
        default_since = int((time.time() - DEFAULT_BACKFILL_DAYS * 86400) * 1000)
        since = int(args.since_ms) if args.since_ms else int(meta_get(con, "cursor_ms", default_since))
        msgs = load_messages(since)
        if not msgs:
            apply_forget(con)
            log("no new signal")
            receipt("consolidate", ["no new human messages"])
            return 0
        stats = {k: 0 for k in ("batches", "failed", "added", "merged", "superseded", "rejected", "tombstoned", "seen")}
        failed_min = None
        for batch in batches(msgs):
            stats["batches"] += 1
            head = batch[0]
            prompt = json.dumps({
                "session": {"title": head["title"], "directory": head["directory"]},
                "messages": [{"id": m["id"], "assistant_context": m["context"], "user": m["text"]} for m in batch],
            }, ensure_ascii=False)
            try:
                res = llm_json(EXTRACT_SYSTEM, prompt, max_tokens=12000)
                ingest(con, res.get("claims") or [], batch, "consolidate", stats)
            except Exception as error:  # noqa: BLE001
                stats["failed"] += 1
                log(f"batch {head['session_id']} failed: {error}")
                failed_min = min(failed_min or head["time"], head["time"])
        cursor = (failed_min - 1) if failed_min else max(m["time"] for m in msgs)
        meta_set(con, "cursor_ms", cursor)
        con.commit()
        apply_forget(con)
        rebuild(con)
        summary = ", ".join(f"{k}={v}" for k, v in stats.items())
        log(summary)
        receipt("consolidate", [f"messages={len(msgs)}", summary, f"cursor={cursor}"])
        return 1 if stats["failed"] and not stats["added"] else 0


# --------------------------------------------------------------------------- live notes

def cmd_note(args) -> int:
    con = ledger()
    text = args.text.strip()
    if SECRET_RE.search(text):
        print("refused: text looks like it contains a secret")
        return 2
    if tombstoned(con, h(text)):
        print("refused: this text was forgotten on request")
        return 2
    c = {"text": text, "kind": args.kind, "salience": args.salience, "confidence": 0.9,
         "quote": args.quote or text, "message_ids": [], "entities": []}
    row = insert_claim(con, c, "live", args.session or None, None)
    daily = append_daily(row, dt.date.today().isoformat())
    con.execute("UPDATE claims SET daily_file=? WHERE id=?", (daily, row["id"]))
    con.commit()
    promote(con, con.execute("SELECT * FROM claims WHERE id=?", (row["id"],)).fetchone())
    con.commit()
    rebuild(con)
    print(f"noted {row['id']} ({args.kind}) in memory/{daily}")
    return 0


# --------------------------------------------------------------------------- derived files

def _daily_index() -> dict[str, tuple[str, int]]:
    out = {}
    for f in sorted(MEM_DIR.glob("????-??-??.md")):
        for n, line in enumerate(f.read_text().splitlines(), 1):
            m = re.match(r"- \[(c_[0-9a-f]{8})\]", line)
            if m:
                out[m.group(1)] = (f.name, n)
    return out


def _cite(cid: str, idx: dict) -> str:
    f, n = idx.get(cid, ("?", 0))
    return f"[{cid}] (memory/{f}:{n})"


def rebuild(con) -> None:
    rows = active_claims(con)
    idx = _daily_index()
    # bank
    for bank in ("world", "experience", "opinions"):
        sel = [r for r in rows if BANK_OF[r["kind"]] == bank]
        body = f"# {bank.title()}\n\nGenerated by musemem. Do not edit; edit ~/MEMORY.md or use `musemem note`.\n\n"
        body += "".join(f"- {r['text']} {_cite(r['id'], idx)}\n" for r in sel) or "_none yet_\n"
        atomic_write(BANK / f"{bank}.md", body)
    if not (BANK / "reflections.md").exists():
        atomic_write(BANK / "reflections.md", "# Reflections\n\nWritten by the nightly dream job.\n\n")
    # people / groups
    pages: dict[tuple[str, str], list[sqlite3.Row]] = {}
    for r in rows:
        for e in json.loads(r["entities"] or "[]"):
            if isinstance(e, dict) and e.get("type") in ("person", "group", "project") and e.get("name"):
                kind = "people" if e["type"] == "person" else "groups"
                pages.setdefault((kind, e["name"].strip()), []).append(r)
    merged: dict[tuple[str, str], tuple[str, list[sqlite3.Row]]] = {}
    for (kind, name), sel in pages.items():
        key = (kind, slug(name))
        prev = merged.get(key, (name, []))
        merged[key] = (prev[0], prev[1] + [r for r in sel if r not in prev[1]])
    wanted = set()
    for (kind, _), (name, sel) in merged.items():
        if len(sel) < ENTITY_MIN_CLAIMS:
            continue
        path = (PEOPLE if kind == "people" else GROUPS) / f"{slug(name)}.md"
        wanted.add(path)
        atomic_write(path, f"# {name}\n\n" + "".join(f"- {r['text']} {_cite(r['id'], idx)}\n" for r in sel))
    for d in (PEOPLE, GROUPS):
        for p in d.glob("*.md"):
            if p not in wanted:
                p.unlink()
    # MEMORY.md
    manual = "- (Add pinned facts here. musemem keeps this section.)\n"
    if MEMORY_MD.exists():
        m = re.search(re.escape(MANUAL_START) + r"\n(.*?)" + re.escape(MANUAL_END), MEMORY_MD.read_text(), re.S)
        if m:
            manual = m.group(1)
    sections = [("Preferences", ("preference", "opinion")), ("Facts", ("fact",)), ("Commitments", ("commitment",))]
    out = ["# MEMORY", "", "Curated memory for opencode agents. Reference data: verify before you rely on it.",
           "Claim ids resolve with `musemem explain <id>` or the mem0 `explain` tool.", "",
           "## Pinned", MANUAL_START, manual.rstrip("\n"), MANUAL_END,
           *[f"- {r['text']} [{r['id']}]" for r in rows if r["pinned"]], ""]
    budget = MEMORY_MD_MAX_LINES
    for title, kinds in sections:
        sel = [r for r in rows if r["kind"] in kinds and r["salience"] >= PROMOTE_SALIENCE and not r["pinned"]][: max(budget, 0)]
        budget -= len(sel)
        out += [f"## {title}", *([f"- {r['text']} [{r['id']}]" for r in sel] or ["- none yet"]), ""]
    atomic_write(MEMORY_MD, "\n".join(out))


def cmd_rebuild(args) -> int:
    with job_lock():
        rebuild(ledger())
    print("rebuilt MEMORY.md, bank/, people/, groups/")
    return 0


# --------------------------------------------------------------------------- recall / explain

def cmd_search(args) -> int:
    con = ledger()
    hits = mem0_search(args.query, top_k=args.limit, threshold=args.min_score)
    for hit in hits:
        md = hit.get("metadata") or {}
        cid = md.get("claim_id")
        status = ""
        if cid:
            r = con.execute("SELECT status FROM claims WHERE id=?", (cid,)).fetchone()
            status = f" status={r['status'] if r else 'unknown'}"
        print(f"[{hit.get('score', 0):.3f}] {hit.get('memory')}\n    claim={cid or '-'} mem0={hit.get('id')} src={md.get('source', '?')}{status}")
    if not hits:
        print("no matching memories")
    return 0


def explain(con, cid: str) -> dict | None:
    r = con.execute("SELECT * FROM claims WHERE id=?", (cid,)).fetchone()
    if not r:
        r = con.execute("SELECT * FROM claims WHERE mem0_id=?", (cid,)).fetchone()
    if not r:
        return None
    ev = [dict(e) for e in con.execute("SELECT * FROM evidence WHERE claim_id=?", (r["id"],))]
    sessions = {}
    if OPENCODE_DB.exists() and ev:
        oc = sqlite3.connect(f"file:{OPENCODE_DB}?mode=ro", uri=True)
        for e in ev:
            sid = e["session_id"]
            if sid and sid not in sessions:
                s = oc.execute("SELECT title, directory FROM session_v2 WHERE id=?", (sid,)).fetchone()
                sessions[sid] = {"title": s[0], "directory": s[1]} if s else None
        oc.close()
    idx = _daily_index()
    chain, cur = [], r["supersedes_claim_id"]
    while cur and len(chain) < 10:
        p = con.execute("SELECT id, text, status FROM claims WHERE id=?", (cur,)).fetchone()
        if not p:
            break
        chain.append(dict(p))
        cur = con.execute("SELECT supersedes_claim_id FROM claims WHERE id=?", (cur,)).fetchone()[0]
    d = dict(r)
    d["message_ids"] = json.loads(d["message_ids"])
    d["entities"] = json.loads(d["entities"])
    d.pop("text_hash"); d.pop("quote_hash")
    d["daily_citation"] = f"memory/{idx[r['id']][0]}:{idx[r['id']][1]}" if r["id"] in idx else None
    d["evidence"] = ev
    d["sessions"] = sessions
    d["supersedes_chain"] = chain
    return d


def cmd_explain(args) -> int:
    d = explain(ledger(), args.claim_id)
    if not d:
        print(f"unknown claim {args.claim_id}")
        return 1
    if args.json:
        print(json.dumps(d, indent=2, ensure_ascii=False))
        return 0
    print(f"{d['id']} [{d['status']}] ({d['kind']}, salience {d['salience']:.2f}, confidence {d['confidence']:.2f}, origin {d['origin']})")
    print(f"  {d['text']}")
    print(f"  quote: \"{d['quote']}\"")
    print(f"  cited: {d['daily_citation']}  mem0: {d['mem0_id']}  observed: {d['observed_at']}")
    for e in d["evidence"]:
        s = d["sessions"].get(e["session_id"]) or {}
        print(f"  evidence: {e['session_id']}/{e['message_id']} \"{s.get('title', '')}\" {s.get('directory', '')}")
    if d["superseded_by"]:
        print(f"  superseded by: {d['superseded_by']}")
    for p in d["supersedes_chain"]:
        print(f"  supersedes: {p['id']} [{p['status']}] {p['text']}")
    return 0


# --------------------------------------------------------------------------- forget

def _redact_file(path: pathlib.Path, needles: list[str], ids: set[str], drop_lines: bool) -> int:
    if not path.exists():
        return 0
    lines, changed = path.read_text().splitlines(keepends=True), 0
    out = []
    for line in lines:
        hit = any(f"[{i}]" in line for i in ids) or any(n and n in line.lower() for n in needles)
        if hit:
            changed += 1
            if not drop_lines:
                out.append("[redacted on request]\n")
            continue
        out.append(line)
    if changed:
        atomic_write(path, "".join(out))
    return changed


PENDING = FORGET_DIR / "pending.json"


def stage_forget(claim_ids: list[str], reason: str, chain: bool) -> None:
    ensure_dirs()
    staged = json.loads(PENDING.read_text()) if PENDING.exists() else []
    staged += [{"claim_id": c, "reason": reason, "chain": chain, "staged_at": now_iso()} for c in claim_ids]
    atomic_write(PENDING, json.dumps(staged, indent=2))


def cmd_forget(args) -> int:
    stage_forget(args.claim_ids, args.reason, args.chain)

    def busy():
        print(f"staged {', '.join(args.claim_ids)} in memory/forget/pending.json; a running musemem job applies it before it exits")

    with job_lock(on_busy=busy):
        return apply_forget(ledger())


def apply_forget(con) -> int:
    if not PENDING.exists():
        return 0
    staged = json.loads(PENDING.read_text())
    reasons = sorted({i.get("reason") or "-" for i in staged})
    ids: set[str] = set()
    for item in staged:
        r = con.execute("SELECT * FROM claims WHERE id=? OR mem0_id=?", (item["claim_id"], item["claim_id"])).fetchone()
        if not r:
            # Legacy Mem0 memory without a claim: tombstone its text, then delete it.
            with contextlib.suppress(Exception):
                legacy = mem0("GET", f"/memories/{item['claim_id']}")
                if legacy.get("memory"):
                    con.execute("INSERT OR IGNORE INTO tombstones VALUES(?,?,?,?)",
                                (h(legacy["memory"]), "text", item["claim_id"], now_iso()))
                mem0("DELETE", f"/memories/{item['claim_id']}")
                log(f"deleted legacy Mem0 memory {item['claim_id']}")
            continue
        ids.add(r["id"])
        # derivatives: claims in the same supersession chain
        for rel in con.execute("SELECT id FROM claims WHERE supersedes_claim_id=? OR superseded_by=? OR id=?",
                               (r["id"], r["id"], r["supersedes_claim_id"] or "")):
            if item.get("chain"):
                ids.add(rel["id"])
    needles = []
    for cid in ids:
        r = con.execute("SELECT * FROM claims WHERE id=?", (cid,)).fetchone()
        for t in (r["text"], r["quote"]):
            if t and len(t) >= 20:
                needles.append(norm(t)[:120])
        for t in (r["text"], r["quote"]):
            if t:
                con.execute("INSERT OR IGNORE INTO tombstones VALUES(?,?,?,?)", (h(t), "text", cid, now_iso()))
        for mid in json.loads(r["message_ids"]):
            con.execute("INSERT OR IGNORE INTO tombstones VALUES(?,?,?,?)", (h(mid), "message", cid, now_iso()))
        retire_mem0(con, cid)
        con.execute("UPDATE claims SET status='retracted', text='[forgotten]', quote=NULL, entities='[]' WHERE id=?", (cid,))
        con.execute("UPDATE evidence SET quote=NULL WHERE claim_id=?", (cid,))
    con.commit()
    touched = 0
    for f in MEM_DIR.glob("????-??-??.md"):
        touched += _redact_file(f, needles, ids, drop_lines=True)
    for f in list(DREAMS.glob("*.md")) + list(DREAMS.glob("*.yaml")) + [BANK / "reflections.md", MEMORY_MD]:
        touched += _redact_file(f, needles, ids, drop_lines=f.suffix == ".yaml" or f == MEMORY_MD)
    meta_set(con, "synthesis_dirty", "1")
    con.commit()
    rebuild(con)
    PENDING.unlink(missing_ok=True)
    receipt("forget", [f"retracted={sorted(ids)}", f"lines_redacted={touched}", f"reason={', '.join(reasons)}"])
    print(f"retracted {len(ids)} claim(s): {', '.join(sorted(ids))}; redacted {touched} line(s); synthesis marked for rewrite")
    return 0


# --------------------------------------------------------------------------- dreams

DREAM_SYSTEM = """You are the nightly reflection process for a team of coding agents that work for one user.
You get recent user messages, the active memory claims, the previous alignment synthesis and state.
Return JSON with keys:
 "dream": prose (300-700 words) reviewing the recent interactions: what the user tried to do, where agents helped or caused friction, what to do differently.
 "synthesis": markdown under 2200 characters with exactly these sections: "## Preferences", "## Boundaries", "## Current friction", "## How to respond".
   Short imperative bullets. Cite supporting claim ids in brackets like [c_1234abcd] where possible. This is standing guidance injected into future sessions.
 "state": object {"mood_of_collaboration": str, "trust_signals": [str], "risk_signals": [str], "focus_projects": [str]}
 "repair_threads": list of {"id": short-kebab-id, "title": str, "status": "open"|"resolved", "evidence": str, "next_step": str} (carry forward open threads from the previous state unless resolved)
 "progression": {"summary": one sentence on how the collaboration changed today}
 "reflections": list of {"text": str, "claim_ids": [str]} (at most 5 durable insights)
Do not invent facts. Never include secrets. If there were no messages, keep the previous synthesis and say so."""


def cmd_dream(args) -> int:
    with job_lock():
        con = ledger()
        hours = args.hours
        since = int((time.time() - hours * 3600) * 1000)
        retracted_msgs = {m for (j,) in con.execute("SELECT message_ids FROM claims WHERE status='retracted'") for m in json.loads(j)}
        msgs = [m for m in load_messages(since) if m["id"] not in retracted_msgs and not tombstoned(con, h(m["id"]))]
        dirty = meta_get(con, "synthesis_dirty") == "1"
        if not msgs and not dirty and not args.force:
            log("no new signal for dreaming")
            receipt("dream", ["no messages in window"])
            return 0
        corpus, size = [], 0
        for m in msgs:
            piece = f"[{m['id']} | {m['title'][:60]}] {m['text'][:1500]}"
            if size + len(piece) > 40000:
                break
            corpus.append(piece)
            size += len(piece)
        claims = [{"id": r["id"], "kind": r["kind"], "text": r["text"]} for r in active_claims(con)[:120]]
        state_file = DREAMS / "ALIGNMENT_STATE.yaml"
        repair_file = DREAMS / "REPAIR_THREADS.yaml"
        prev = {
            "synthesis": SYNTHESIS.read_text() if SYNTHESIS.exists() else "",
            "state": yaml.safe_load(state_file.read_text()) if state_file.exists() else {},
            "repair_threads": yaml.safe_load(repair_file.read_text()) if repair_file.exists() else [],
        }
        res = llm_json(DREAM_SYSTEM, json.dumps({"recent_messages": corpus, "claims": claims, "previous": prev}, ensure_ascii=False),
                       max_tokens=12000, timeout=900)
        today = dt.date.today().isoformat()
        synthesis = str(res.get("synthesis") or prev["synthesis"]).strip()
        if SECRET_RE.search(synthesis):
            raise RuntimeError("synthesis contained secret-like content; not written")
        dream = str(res.get("dream") or "").strip()
        atomic_write(DREAMS / f"{today}.md",
                     f"---\ndate: {today}\nmessages: {len(msgs)}\nprompt_hoisted: false\n---\n\n# Dream {today}\n\n{dream}\n")
        atomic_write(SYNTHESIS, f"# Alignment synthesis\n\nUpdated {now_iso()} by musemem dream. Standing guidance; verify facts via claim ids.\n\n{synthesis}\n")
        atomic_write(state_file, yaml.safe_dump({"updated": now_iso(), **(res.get("state") or {})}, sort_keys=False, allow_unicode=True))
        atomic_write(repair_file, yaml.safe_dump(res.get("repair_threads") or [], sort_keys=False, allow_unicode=True))
        hist_file = DREAMS / "PROGRESSION_HISTORY.yaml"
        hist = (yaml.safe_load(hist_file.read_text()) if hist_file.exists() else None) or []
        hist = [e for e in hist if e.get("date") != today] + [{"date": today, **(res.get("progression") or {})}]
        atomic_write(hist_file, yaml.safe_dump(hist[-365:], sort_keys=False, allow_unicode=True))
        refl = [r for r in res.get("reflections") or [] if isinstance(r, dict) and r.get("text") and not SECRET_RE.search(r["text"])]
        if refl:
            with open(BANK / "reflections.md", "a") as fh:
                fh.write(f"\n## {today}\n\n" + "".join(
                    f"- {r['text']} " + " ".join(f"[{c}]" for c in r.get("claim_ids") or []) + f" (dreams/{today}.md)\n" for r in refl))
        meta_set(con, "synthesis_dirty", "0")
        con.commit()
        apply_forget(con)
        receipt("dream", [f"messages={len(msgs)}", f"claims={len(claims)}", f"reflections={len(refl)}",
                          f"repair_threads={len(res.get('repair_threads') or [])}"])
        log(f"dream written: dreams/{today}.md")
        return 0


# --------------------------------------------------------------------------- legacy Mem0 cleanup

DEDUPE_SYSTEM = """You get numbered stored memories ("n: [date] text"). Find groups that state the same fact, or where a
newer memory replaces an older one. Return compact JSON {"groups": [{"keep": n, "drop": [n, ...]}]} using the numbers.
Keep the most complete and most recent wording. Only group true duplicates or clear replacements; leave everything else out."""


def cmd_dedupe(args) -> int:
    rows = mem0("GET", "/memories", params={"user_id": MEM0_USER, "top_k": 1000})
    items = rows.get("results", rows) if isinstance(rows, dict) else rows
    mems = [{"id": m["id"], "text": m.get("memory", ""), "created_at": m.get("created_at"),
             "client": (m.get("metadata") or {}).get("client"), "source": (m.get("metadata") or {}).get("source")} for m in items
            if not (m.get("metadata") or {}).get("claim_id")]  # musemem-owned entries are deduped by the ledger
    log(f"{len(mems)} memories in Mem0 for {MEM0_USER}")
    listing = "\n".join(f"{i}: [{(m['created_at'] or '')[:10]}] {m['text']}" for i, m in enumerate(mems))
    res = llm_json(DEDUPE_SYSTEM, listing, max_tokens=24000, timeout=1200)
    by_id = {m["id"]: m for m in mems}

    def ref(n):
        try:
            return mems[int(n)]["id"]
        except (TypeError, ValueError, IndexError):
            return None

    plan, used = [], set()
    for g in res.get("groups") or []:
        keep = ref(g.get("keep"))
        drop = [d for d in (ref(n) for n in g.get("drop") or []) if d and d != keep and d not in used]
        if keep and drop:
            used.update(drop)
            plan.append((keep, drop, ""))
    report = INDEX_DIR / "dedupe-plan.json"
    atomic_write(report, json.dumps([{"keep": k, "keep_text": by_id[k]["text"], "drop": [{"id": d, "text": by_id[d]["text"]} for d in ds],
                                      "reason": r} for k, ds, r in plan], indent=2, ensure_ascii=False))
    for k, ds, r in plan:
        print(f"KEEP {k}: {by_id[k]['text'][:110]}")
        for d in ds:
            print(f"  DROP {d}: {by_id[d]['text'][:110]}")
    missing = [m for m in mems if not m["source"] or m["source"] == "?"]
    print(f"\n{len(plan)} duplicate group(s), {sum(len(d) for _, d, _ in plan)} to drop; {len(missing)} without source. Plan: {report}")
    if not args.apply:
        print("dry run; re-run with --apply to delete the DROP entries and tag missing sources as 'legacy'")
        return 0
    for _, ds, _ in plan:
        for d in ds:
            mem0("DELETE", f"/memories/{d}")
    for m in missing:
        full = next(x for x in items if x["id"] == m["id"])
        md = {**(full.get("metadata") or {}), "source": "legacy"}
        with contextlib.suppress(Exception):
            mem0("PUT", f"/memories/{m['id']}", json={"metadata": md})
    print("applied")
    return 0


# --------------------------------------------------------------------------- curation (JSON API for UIs)

def _row_json(r: sqlite3.Row, idx: dict | None = None) -> dict:
    d = dict(r)
    d["message_ids"] = json.loads(d["message_ids"] or "[]")
    d["entities"] = json.loads(d["entities"] or "[]")
    d["pinned"] = bool(d.get("pinned"))
    d.pop("text_hash", None); d.pop("quote_hash", None)
    if idx is not None:
        d["daily_citation"] = f"memory/{idx[r['id']][0]}:{idx[r['id']][1]}" if r["id"] in idx else None
    return d


def emit(obj) -> int:
    print(json.dumps(obj, ensure_ascii=False))
    return 0


def cmd_list(args) -> int:
    con = ledger()
    where, params = [], []
    if args.status != "all":
        where.append("status=?"); params.append(args.status)
    if args.kind:
        where.append("kind=?"); params.append(args.kind)
    if args.pinned:
        where.append("pinned=1")
    if args.q:
        where.append("(text LIKE ? OR quote LIKE ? OR id=?)"); params += [f"%{args.q}%", f"%{args.q}%", args.q]
    if args.entity:
        where.append("entities LIKE ?"); params.append(f'%"name": "{args.entity}"%')
    order = {"salience": "pinned DESC, salience DESC, created_at DESC", "recent": "created_at DESC",
             "confidence": "confidence DESC, created_at DESC"}[args.sort]
    sql = "FROM claims" + (" WHERE " + " AND ".join(where) if where else "")
    total = con.execute(f"SELECT COUNT(*) {sql}", params).fetchone()[0]
    rows = con.execute(f"SELECT * {sql} ORDER BY {order} LIMIT ? OFFSET ?", params + [args.limit, args.offset]).fetchall()
    idx = _daily_index()
    return emit({"total": total, "offset": args.offset, "items": [_row_json(r, idx) for r in rows]})


def cmd_stats(args) -> int:
    con = ledger()
    by = lambda col: {r[0]: r[1] for r in con.execute(f"SELECT {col}, COUNT(*) FROM claims GROUP BY {col}")}
    ents: dict[str, int] = {}
    names: dict[str, str] = {}
    for (j,) in con.execute("SELECT entities FROM claims WHERE status='active'"):
        for e in json.loads(j or "[]"):
            if isinstance(e, dict) and e.get("name"):
                key = e["name"].strip().lower()
                names.setdefault(key, e["name"].strip())
                ents[key] = ents.get(key, 0) + 1
    ents = {names[k]: v for k, v in ents.items()}
    runs = {}
    for job in ("consolidate", "dream", "forget"):
        f = RUNS / job / "CURRENT.md"
        if f.exists():
            runs[job] = f.read_text()
    return emit({"status": by("status"), "kind": by("kind"), "origin": by("origin"),
                 "pinned": con.execute("SELECT COUNT(*) FROM claims WHERE pinned=1 AND status='active'").fetchone()[0],
                 "entities": dict(sorted(ents.items(), key=lambda x: -x[1])[:60]),
                 "cursor_ms": meta_get(con, "cursor_ms"), "pending_forget": PENDING.exists(), "runs": runs})


def cmd_show(args) -> int:
    d = explain(ledger(), args.claim_id)
    if not d:
        print(json.dumps({"error": f"unknown claim {args.claim_id}"}))
        return 1
    d["pinned"] = bool(d.get("pinned"))
    return emit(d)


def cmd_edit(args) -> int:
    with job_lock(on_busy=lambda: print(json.dumps({"error": "busy: a musemem job is running; retry shortly"}))):
        con = ledger()
        r = con.execute("SELECT * FROM claims WHERE id=?", (args.claim_id,)).fetchone()
        if not r or r["status"] == "retracted":
            print(json.dumps({"error": f"unknown or retracted claim {args.claim_id}"}))
            return 1
        sets, vals = [], []
        text = r["text"]
        if args.text is not None:
            text = args.text.strip()
            if len(text) < 12 or SECRET_RE.search(text):
                print(json.dumps({"error": "text too short or looks like a secret"}))
                return 1
            sets += ["text=?", "text_hash=?"]; vals += [text, h(text)]
        if args.kind:
            sets.append("kind=?"); vals.append(args.kind)
        if args.salience is not None:
            sets.append("salience=?"); vals.append(max(0.0, min(1.0, args.salience)))
        if args.confidence is not None:
            sets.append("confidence=?"); vals.append(max(0.0, min(1.0, args.confidence)))
        if args.pin is not None:
            sets.append("pinned=?"); vals.append(1 if args.pin == "on" else 0)
        if args.status:
            if args.status == "active" and r["superseded_by"]:
                sets.append("superseded_by=NULL")
            sets.append("status=?"); vals.append(args.status)
        if not sets:
            print(json.dumps({"error": "nothing to change"}))
            return 1
        sets.append("edited_at=?"); vals.append(now_iso())
        con.execute(f"UPDATE claims SET {', '.join(sets)} WHERE id=?", vals + [r["id"]])
        con.commit()
        row = con.execute("SELECT * FROM claims WHERE id=?", (r["id"],)).fetchone()
        # keep Mem0 in step: drop and re-add when the claim is active and promotable, else drop
        retire_mem0(con, row["id"])
        if row["status"] == "active":
            promote(con, row)
        con.commit()
        rebuild(con)
        return emit(_row_json(con.execute("SELECT * FROM claims WHERE id=?", (r["id"],)).fetchone(), _daily_index()))


def cmd_legacy(args) -> int:
    """Mem0 memories for this user that no musemem claim owns (other clients and pre-musemem entries)."""
    rows = mem0("GET", "/memories", params={"user_id": MEM0_USER, "top_k": 1000})
    items = rows.get("results", rows) if isinstance(rows, dict) else rows
    out = []
    for m in items:
        md = m.get("metadata") or {}
        if md.get("claim_id"):
            continue
        out.append({"id": m["id"], "text": m.get("memory", ""), "created_at": m.get("created_at"),
                    "updated_at": m.get("updated_at"), "agent_id": m.get("agent_id"), "metadata": md})
    if args.q:
        out = [m for m in out if args.q.lower() in m["text"].lower()]
    out.sort(key=lambda m: m.get("created_at") or "", reverse=True)
    return emit({"total": len(out), "items": out})


def cmd_dreams(args) -> int:
    if args.date:
        f = DREAMS / f"{args.date}.md" if args.date != "synthesis" else SYNTHESIS
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}|synthesis", args.date) or not f.exists():
            print(json.dumps({"error": "not found"}))
            return 1
        return emit({"date": args.date, "markdown": f.read_text()})
    companions = {}
    for name in ("ALIGNMENT_STATE", "REPAIR_THREADS", "PROGRESSION_HISTORY"):
        f = DREAMS / f"{name}.yaml"
        companions[name] = yaml.safe_load(f.read_text()) if f.exists() else None
    return emit({"dates": sorted((p.stem for p in DREAMS.glob("????-??-??.md")), reverse=True),
                 "synthesis": SYNTHESIS.read_text() if SYNTHESIS.exists() else "",
                 "companions": json.loads(json.dumps(companions, default=str))})


def cmd_pinned_text(args) -> int:
    """Read or replace the hand-edited Pinned block of MEMORY.md (stdin for --set)."""
    with job_lock(on_busy=lambda: print(json.dumps({"error": "busy: a musemem job is running; retry shortly"}))):
        con = ledger()
        if args.set:
            text = sys.stdin.read()
            if SECRET_RE.search(text) or MANUAL_START in text or MANUAL_END in text or len(text) > 4000:
                print(json.dumps({"error": "rejected: secret-like, contains markers, or over 4000 chars"}))
                return 1
            body = MEMORY_MD.read_text() if MEMORY_MD.exists() else ""
            pat = re.compile(re.escape(MANUAL_START) + r"\n.*?" + re.escape(MANUAL_END), re.S)
            block = f"{MANUAL_START}\n{text.rstrip()}\n{MANUAL_END}"
            atomic_write(MEMORY_MD, pat.sub(lambda _: block, body) if pat.search(body) else body)
            rebuild(con)
        m = re.search(re.escape(MANUAL_START) + r"\n(.*?)" + re.escape(MANUAL_END), MEMORY_MD.read_text(), re.S) if MEMORY_MD.exists() else None
        return emit({"pinned_text": m.group(1).rstrip("\n") if m else ""})


# --------------------------------------------------------------------------- inject

def cmd_inject(args) -> int:
    parts = []
    if MEMORY_MD.exists():
        parts.append(MEMORY_MD.read_text()[: args.memory_chars])
    if SYNTHESIS.exists():
        parts.append(SYNTHESIS.read_text()[: args.synthesis_chars])
    print("\n\n".join(parts))
    return 0


def main() -> int:
    p = argparse.ArgumentParser(prog="musemem", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("consolidate", help="extract and verify claims from new session messages")
    s.add_argument("--since-ms", help="override cursor (epoch ms)")
    s.set_defaults(fn=cmd_consolidate)
    s = sub.add_parser("dream", help="nightly reflection and alignment synthesis")
    s.add_argument("--hours", type=float, default=26)
    s.add_argument("--force", action="store_true")
    s.set_defaults(fn=cmd_dream)
    s = sub.add_parser("note", help="live write: record a claim now")
    s.add_argument("text")
    s.add_argument("--kind", choices=KINDS, default="fact")
    s.add_argument("--salience", type=float, default=0.8)
    s.add_argument("--quote")
    s.add_argument("--session")
    s.set_defaults(fn=cmd_note)
    s = sub.add_parser("search", help="semantic recall via Mem0, annotated with claim status")
    s.add_argument("query")
    s.add_argument("--limit", type=int, default=8)
    s.add_argument("--min-score", type=float, default=0.3)
    s.set_defaults(fn=cmd_search)
    s = sub.add_parser("explain", help="evidence and citations for a claim id (or Mem0 id)")
    s.add_argument("claim_id")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd_explain)
    s = sub.add_parser("forget", help="retract claims and everything derived from them")
    s.add_argument("claim_ids", nargs="+")
    s.add_argument("--reason", default="")
    s.add_argument("--chain", action="store_true", help="also retract claims in the same supersession chain")
    s.set_defaults(fn=cmd_forget)
    s = sub.add_parser("list", help="JSON: claims with filters")
    s.add_argument("--status", choices=("active", "superseded", "retracted", "all"), default="active")
    s.add_argument("--kind", choices=KINDS)
    s.add_argument("--q")
    s.add_argument("--entity")
    s.add_argument("--pinned", action="store_true")
    s.add_argument("--sort", choices=("salience", "recent", "confidence"), default="salience")
    s.add_argument("--limit", type=int, default=50)
    s.add_argument("--offset", type=int, default=0)
    s.set_defaults(fn=cmd_list)
    s = sub.add_parser("stats", help="JSON: counts, entities, last run receipts")
    s.set_defaults(fn=cmd_stats)
    s = sub.add_parser("show", help="JSON: one claim with evidence")
    s.add_argument("claim_id")
    s.set_defaults(fn=cmd_show)
    s = sub.add_parser("edit", help="JSON: curate a claim (text, kind, salience, confidence, pin, status)")
    s.add_argument("claim_id")
    s.add_argument("--text")
    s.add_argument("--kind", choices=KINDS)
    s.add_argument("--salience", type=float)
    s.add_argument("--confidence", type=float)
    s.add_argument("--pin", choices=("on", "off"))
    s.add_argument("--status", choices=("active", "superseded"))
    s.set_defaults(fn=cmd_edit)
    s = sub.add_parser("legacy", help="JSON: Mem0 memories not owned by a claim")
    s.add_argument("--q")
    s.set_defaults(fn=cmd_legacy)
    s = sub.add_parser("dreams", help="JSON: dream dates, synthesis, companions; --date for one file")
    s.add_argument("--date")
    s.set_defaults(fn=cmd_dreams)
    s = sub.add_parser("pinned-text", help="JSON: get or (--set, stdin) replace the hand-edited Pinned block")
    s.add_argument("--set", action="store_true")
    s.set_defaults(fn=cmd_pinned_text)
    s = sub.add_parser("rebuild", help="regenerate MEMORY.md, bank, people and groups from the ledger")
    s.set_defaults(fn=cmd_rebuild)
    s = sub.add_parser("dedupe-mem0", help="find duplicate legacy Mem0 memories (dry run unless --apply)")
    s.add_argument("--apply", action="store_true")
    s.set_defaults(fn=cmd_dedupe)
    s = sub.add_parser("inject", help="print the capped standing-memory block")
    s.add_argument("--memory-chars", type=int, default=5000)
    s.add_argument("--synthesis-chars", type=int, default=2600)
    s.set_defaults(fn=cmd_inject)
    args = p.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
