"""One-shot Mem0 configuration. Runs as the mem0-configure service after mem0 is healthy.

It waits for Mem0 and the embedding endpoint, then POSTs /configure with the
models from .env, and reads the configuration back to verify it.
All model endpoints must speak the OpenAI API (/v1/chat/completions, /v1/embeddings).
"""
import json
import os
import time
import urllib.error
import urllib.request

env = os.environ.get
MEM0_URL = "http://mem0:8000"
LLM_BASE_URL = env("LLM_BASE_URL", "").rstrip("/")
LLM_MODEL = env("LLM_MODEL", "")
LLM_API_KEY = env("LLM_API_KEY") or "no-key"
LLM_IS_REASONING = env("LLM_IS_REASONING_MODEL", "false").lower() in {"1", "true", "yes", "on"}
LLM_REASONING_EFFORT = env("LLM_REASONING_EFFORT", "")
EMBED_BASE_URL = (env("EMBED_BASE_URL") or LLM_BASE_URL).rstrip("/")
EMBED_MODEL = env("EMBED_MODEL", "")
EMBED_API_KEY = env("EMBED_API_KEY") or LLM_API_KEY
EMBED_DIMS = int(env("POSTGRES_EMBEDDING_DIMS", "1024"))
EMBED_SEND_DIMS = env("EMBED_SEND_DIMENSIONS", "true").lower() in {"1", "true", "yes", "on"}
RERANKER_URL = env("RERANKER_URL", "")
RERANKER_MODEL = env("RERANKER_MODEL", "BAAI/bge-reranker-v2-m3")

INSTRUCTIONS = (
    "Store only durable, user-specific knowledge that is likely to remain useful for weeks or months: "
    "explicit preferences, household context, recurring routines, stable service ownership or architecture "
    "choices, and long-lived project decisions. Do not store transient operational observations such as "
    "alerts, health checks, metrics, temperatures, utilization, current service state, search results, "
    "assistant responses, tool output, one-off commands, tests, or troubleshooting details. Never store "
    "credentials, secrets, tokens, private keys, session material, or sensitive values. Do not turn an "
    "assistant inference into a user fact. When a message contains no safe durable fact, extract no memory."
)

for name, value in {"LLM_BASE_URL": LLM_BASE_URL, "LLM_MODEL": LLM_MODEL, "EMBED_MODEL": EMBED_MODEL}.items():
    if not value:
        raise SystemExit(f"{name} is not set in .env")

mem0_headers = {"Content-Type": "application/json", "X-API-Key": os.environ["ADMIN_API_KEY"]}


def request(url, *, body=None, headers=None, timeout=10):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers or {}, method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read() or b"{}")


embed_body = {"input": "memory readiness", "model": EMBED_MODEL, "encoding_format": "float"}
if EMBED_SEND_DIMS:
    embed_body["dimensions"] = EMBED_DIMS
deadline = time.monotonic() + 300
while True:
    try:
        request(f"{MEM0_URL}/auth/setup-status", timeout=5)
        embedding = request(
            f"{EMBED_BASE_URL}/embeddings",
            body=embed_body,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {EMBED_API_KEY}"},
            timeout=30,
        )
        size = len(embedding["data"][0]["embedding"])
        if size != EMBED_DIMS:
            raise SystemExit(f"{EMBED_MODEL} returned {size} dimensions; POSTGRES_EMBEDDING_DIMS is {EMBED_DIMS}")
        break
    except (KeyError, OSError, urllib.error.HTTPError) as error:
        if time.monotonic() >= deadline:
            raise
        print(f"waiting for mem0 and {EMBED_BASE_URL}: {error}", flush=True)
        time.sleep(3)

# Mem0 merges /configure updates into the saved settings, so send every
# optional key explicitly; an omitted key would keep its old value.
llm_config = {
    "model": LLM_MODEL,
    "api_key": LLM_API_KEY,
    "openai_base_url": LLM_BASE_URL,
    # Mem0 sends reasoning_effort only for a "reasoning model". This mode also
    # stops Mem0 from sending temperature/top_p/max_tokens.
    "is_reasoning_model": LLM_IS_REASONING,
    "reasoning_effort": (LLM_REASONING_EFFORT or None) if LLM_IS_REASONING else None,
}
embedder_config = {
    "model": EMBED_MODEL,
    "api_key": EMBED_API_KEY,
    "openai_base_url": EMBED_BASE_URL,
    "embedding_dims": EMBED_DIMS if EMBED_SEND_DIMS else None,
}

config = {
    "custom_instructions": INSTRUCTIONS,
    "vector_store": {"provider": "pgvector", "config": {"embedding_model_dims": EMBED_DIMS}},
    "llm": {"provider": "openai", "config": llm_config},
    "embedder": {"provider": "openai", "config": embedder_config},
}
config["reranker"] = (
    {"provider": "infinity", "config": {"model": RERANKER_MODEL, "url": RERANKER_URL, "timeout": 30}}
    if RERANKER_URL
    else None
)

request(f"{MEM0_URL}/configure", body=config, headers=mem0_headers, timeout=60)

configured = request(f"{MEM0_URL}/configure", headers=mem0_headers)
assert configured["vector_store"]["config"]["embedding_model_dims"] == EMBED_DIMS
assert configured["custom_instructions"] == INSTRUCTIONS
assert configured["llm"]["config"]["model"] == LLM_MODEL
assert configured["llm"]["config"]["openai_base_url"] == LLM_BASE_URL
assert configured["embedder"]["config"]["model"] == EMBED_MODEL
assert configured["embedder"]["config"]["openai_base_url"] == EMBED_BASE_URL
assert configured["llm"]["config"].get("is_reasoning_model") is LLM_IS_REASONING
if RERANKER_URL:
    assert configured["reranker"]["provider"] == "infinity"
    assert configured["reranker"]["config"]["url"] == RERANKER_URL
else:
    assert not configured.get("reranker")
print(f"Mem0 configured: llm={LLM_MODEL} embedder={EMBED_MODEL} dims={EMBED_DIMS} reranker={RERANKER_URL or 'none'}")
