#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "mcp>=1.2.0,<2",
#   "httpx>=0.27",
# ]
# ///
"""
Memory MCP server for opencode, backed by a Mem0 REST server.

Embedding, fact extraction and storage happen on the Mem0 server. This process
only speaks HTTP; it holds no model and no database.

Tools exposed:
  recall(query, limit, tag, min_score) -> semantic search over stored memories
  remember(text, tag, source)          -> store a durable memory
  forget(memory_id)                    -> retract a claim (c_...) or delete a Mem0 id
  explain(claim_id)                    -> evidence, quote, citations, supersession chain
  note(text, kind)                     -> live write into $MUSE_HOME/memory and the claim ledger
  memory_stats()                       -> service and entity health/counts

Claims, files and the forget workflow live in musemem (MUSEMEM_BIN, default
../musemem/bin/musemem.py relative to this file).

Configuration (environment):
  MEM0_URL           default http://127.0.0.1:9120
  MEM0_API_KEY_FILE  default ~/.config/mem0/api_key (mode 0600)
  MEM0_API_KEY       fallback if no key file is readable
  MEM0_USER_ID       default $USER
  MEM0_AGENT_ID      optional; when set, writes are attributed to that agent
  MUSE_ENV_FILE      optional KEY=VALUE file (default ~/.config/muse-memory/env);
                     set variables take precedence
"""
from __future__ import annotations

import logging
import os
import pathlib
import subprocess
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

# MCP over stdio keeps stdout for protocol frames; httpx logs a line per request
# on stderr, which is pure noise for the client. Keep only real warnings.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

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

MEM0_URL = os.environ.get("MEM0_URL", "http://127.0.0.1:9120").rstrip("/")
USER_ID = os.environ.get("MEM0_USER_ID") or os.environ.get("USER") or "default"
AGENT_ID = os.environ.get("MEM0_AGENT_ID", "").strip()
NO_MATCHES = "no matching memories"
MUSEMEM = os.path.expanduser(os.environ.get(
    "MUSEMEM_BIN",
    str(pathlib.Path(__file__).resolve().parent.parent / "musemem" / "bin" / "musemem.py"),
))


def _musemem(*args: str, timeout: float = 300.0) -> str:
    try:
        done = subprocess.run([MUSEMEM, *args], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        return f"error: musemem {args[0]} failed: {error}"
    out = (done.stdout or "").strip()
    if done.returncode != 0:
        tail = (done.stderr or "").strip().splitlines()[-3:]
        return f"error (exit {done.returncode}): {out or ' | '.join(tail)}"
    return out

mcp = FastMCP("mem0-memory")
# Reads are a vector lookup (~0.5s warm). Writes run LLM fact extraction on the
# Mem0 host, which is measured in tens of seconds, so the write path passes its
# own longer timeout below.
READ_TIMEOUT = 45.0
WRITE_TIMEOUT = 240.0
_client = httpx.Client(base_url=MEM0_URL, timeout=READ_TIMEOUT)


def _api_key() -> str:
    path = os.environ.get("MEM0_API_KEY_FILE", "~/.config/mem0/api_key")
    key_file = pathlib.Path(os.path.expanduser(path))
    try:
        key = key_file.read_text().strip()
    except OSError:
        key = ""
    if not key:
        key = os.environ.get("MEM0_API_KEY", "").strip()
    if not key:
        raise RuntimeError(
            f"no Mem0 API key: {key_file} is unreadable and MEM0_API_KEY is unset"
        )
    return key


def _headers() -> dict[str, str]:
    return {"X-API-Key": _api_key(), "Content-Type": "application/json"}


def _request(method: str, path: str, **kwargs: Any) -> Any:
    try:
        response = _client.request(method, path, headers=_headers(), **kwargs)
    except httpx.TimeoutException as error:
        limit = kwargs.get("timeout", READ_TIMEOUT)
        raise RuntimeError(
            f"Mem0 {method} {path} exceeded its {limit:g}s budget ({type(error).__name__}); "
            "the Mem0 host may be busy with fact extraction"
        ) from error
    except httpx.HTTPError as error:
        raise RuntimeError(f"Mem0 {method} {path} failed: {type(error).__name__}: {error}") from error
    if response.status_code >= 400:
        detail = response.text.strip()[:300]
        raise RuntimeError(f"Mem0 {method} {path} returned {response.status_code}: {detail}")
    if not response.content:
        return {}
    return response.json()


def _entity_filter() -> dict[str, Any]:
    # Memories are scoped to the user; agent_id is only an attribution on writes.
    return {"user_id": USER_ID}


@mcp.tool()
def recall(query: str, limit: int = 5, tag: str = "", min_score: float = 0.3) -> str:
    """Semantic search over stored memories. Use before asking the user to repeat context.

    Args:
        query: Natural-language description of what you're trying to remember.
        limit: Max results (default 5).
        tag: Optional metadata tag filter, applied to results locally.
        min_score: Similarity floor (0-1). Lower = more recall, more noise.
    """
    payload = {
        "query": query,
        "filters": _entity_filter(),
        "top_k": max(1, min(limit, 50)),
        "threshold": max(0.0, min(min_score, 1.0)),
    }
    results = _request("POST", "/search", json=payload).get("results") or []
    if tag:
        results = [r for r in results if str((r.get("metadata") or {}).get("tag", "")) == tag]
    if not results:
        return NO_MATCHES
    lines = []
    for hit in results:
        metadata = hit.get("metadata") or {}
        label = metadata.get("tag") or metadata.get("channel") or metadata.get("client") or "?"
        score = hit.get("score")
        score_text = f"{score:.3f}" if isinstance(score, (int, float)) else "?"
        claim = metadata.get("claim_id")
        lines.append(
            f"[{score_text}] ({label}) {hit.get('memory', '')}"
            f"\n    id={hit.get('id', '?')}{' claim=' + claim if claim else ''} src={metadata.get('source', '?')}"
            f" at={hit.get('created_at', '?')}"
        )
    return "\n".join(lines)


@mcp.tool()
def remember(text: str, tag: str = "general", source: str = "chat") -> str:
    """Store a durable memory for later recall.

    Mem0 extracts and deduplicates facts server-side, so the stored memory can
    be a rewritten form of `text`, and re-sending a fact you already stored may
    add nothing rather than create a duplicate.

    Args:
        text: The fact/preference/context to remember. One idea per call works best.
        tag: Category label for filtered recall (e.g. 'preference', 'project', 'env').
        source: Where this came from (e.g. 'chat', 'file:/path', 'session:<id>').
    """
    text = text.strip()
    if not text:
        return "error: empty text"
    payload: dict[str, Any] = {
        "messages": [{"role": "user", "content": text}],
        "user_id": USER_ID,
        "metadata": {"tag": tag, "source": source, "client": "opencode"},
    }
    if AGENT_ID:
        payload["agent_id"] = AGENT_ID
    result = _request("POST", "/memories", json=payload, timeout=WRITE_TIMEOUT)
    events = result.get("results") if isinstance(result, dict) else None
    if isinstance(events, list):
        for event in events:
            if event.get("event") in {"ADD", "UPDATE"} and event.get("id"):
                return f"stored {event['id']} (tag={tag}, event={event['event']})"
        # Mem0 extracts facts server-side and stores nothing when the text holds
        # no durable fact, so an empty result is a deliberate outcome, not a
        # failure — report it as such instead of implying the text was saved.
        return (
            f"not stored (tag={tag}): Mem0 extracted no durable fact. The memory "
            "store deliberately rejects transient state, one-off commands, tests, "
            "and operational observations."
        )
    return f"submitted to Mem0 as user={USER_ID} (tag={tag}); no extraction event reported"


@mcp.tool()
def forget(memory_id: str, reason: str = "") -> str:
    """Forget a memory. Pass a claim id (c_xxxxxxxx) or a Mem0 id from recall.

    Claims are retracted everywhere: Mem0, ~/MEMORY.md, daily logs, bank files,
    dreams and synthesis, and a tombstone stops consolidation from re-adding them.
    Only call this when the user asks to forget something.
    """
    return _musemem("forget", memory_id, "--reason", reason or "requested via mcp")


@mcp.tool()
def explain(claim_id: str) -> str:
    """Show the evidence behind a claim: verbatim quote, source session and message ids,
    daily-log citation, confidence, status and supersession chain. Accepts c_... or a Mem0 id."""
    return _musemem("explain", claim_id, timeout=60)


@mcp.tool()
def note(text: str, kind: str = "fact", salience: float = 0.8) -> str:
    """Record a durable claim immediately (live write). Use for facts, preferences or
    commitments the user states that future sessions need. One idea per call; never secrets.

    Args:
        text: Self-contained third-person statement, e.g. "The user prefers ...".
        kind: fact | preference | commitment | experience | opinion.
        salience: 0-1 usefulness for unrelated future sessions; >=0.6 is promoted to Mem0 and MEMORY.md.
    """
    return _musemem("note", text, "--kind", kind, "--salience", str(salience))


@mcp.tool()
def memory_stats() -> str:
    """Report Mem0 service health and this user's stored memory count."""
    headers = _headers()
    try:
        entities = _client.get("/entities", headers=headers).json()
    except Exception as error:  # noqa: BLE001
        return f"mem0={MEM0_URL} status=DOWN ({error}) user={USER_ID}"
    mine = [e for e in entities if isinstance(e, dict) and e.get("id") == USER_ID]
    total = sum(int(e.get("total_memories") or 0) for e in mine)
    kinds = ", ".join(f"{e.get('type')}={e.get('total_memories')}" for e in mine) or "no entity yet"
    return (
        f"mem0={MEM0_URL} status=up user={USER_ID} "
        f"memories={total} entities=[{kinds}] agent_attribution={AGENT_ID or 'none'}"
    )


if __name__ == "__main__":
    mcp.run(transport="stdio")
