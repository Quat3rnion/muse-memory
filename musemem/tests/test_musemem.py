#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["httpx>=0.27", "pyyaml>=6"]
# ///
"""Offline regression checks for musemem (no LLM, no Mem0). Run: tests/test_musemem.py"""
import importlib.util
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRATCH = pathlib.Path(os.environ.get("MUSEMEM_TEST_DIR") or tempfile.mkdtemp(prefix="musemem-tests-"))
shutil.rmtree(SCRATCH, ignore_errors=True)
SCRATCH.mkdir(parents=True)
os.environ.update(MUSE_ENV_FILE=str(SCRATCH / "no-env"), MUSE_HOME=str(SCRATCH), MEM0_URL="http://127.0.0.1:9", TMPDIR=str(SCRATCH))

spec = importlib.util.spec_from_file_location("musemem", ROOT / "bin" / "musemem.py")
mm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mm)

batch = [{"id": "msg_1", "session_id": "ses_1", "time": 0, "text": "We do want purely HTTP, no browser at all.", "context": ""}]
ok, _ = mm.verify({"text": "The user wants pure HTTP.", "kind": "preference", "quote": "purely HTTP, no browser", "message_ids": ["msg_1"]}, batch)
assert ok, "verbatim quote must pass"
ok, why = mm.verify({"text": "The user wants pure HTTP.", "kind": "preference", "quote": "only HTTP requests please", "message_ids": ["msg_1"]}, batch)
assert not ok and "verbatim" in why, "paraphrased quote must fail"
ok, why = mm.verify({"text": "The user token is ghp_" + "a" * 30, "kind": "fact", "quote": "purely HTTP, no browser", "message_ids": ["msg_1"]}, batch)
assert not ok and "secret" in why, "secrets must fail"

cli = [str(ROOT / "bin" / "musemem.py")]
env = dict(os.environ)
run = lambda *a: subprocess.run(cli + list(a), capture_output=True, text=True, env=env)
out = run("note", "Regression: the user likes teal themes.", "--kind", "preference", "--salience", "0.9").stdout
cid = out.split()[1]
assert "teal" in (SCRATCH / "MEMORY.md").read_text()
assert run("forget", cid, "--reason", "test").returncode == 0
assert "teal" not in (SCRATCH / "MEMORY.md").read_text()
assert not any("teal" in p.read_text() for p in (SCRATCH / "memory").glob("*.md"))
assert "forgotten" in run("note", "Regression: the user likes teal themes.").stdout, "tombstone must block re-adding"
assert "[retracted]" in run("explain", cid).stdout
print("ok")
