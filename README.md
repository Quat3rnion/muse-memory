# muse-memory

Long-term memory for [opencode](https://opencode.ai) agents. It stores what you tell
your agents in a self-hosted [Mem0](https://github.com/mem0ai/mem0) server and in
plain Markdown files that you can read and edit.

Each memory is a **claim**. A claim has a verbatim quote from one of your messages,
the session and message IDs of that quote, a kind, a salience and a status. An agent
can ask why it remembers something (`explain`), and you can retract a claim
everywhere with one command (`forget`).

## Parts

| Folder | Part | What it does |
|---|---|---|
| `stack/` | Mem0 Docker stack | Mem0 REST server, Postgres with pgvector, the Mem0 dashboard, a configure job and an optional reranker. The models run on any OpenAI-compatible server. |
| `mcp/` | MCP server | Gives opencode the tools `recall`, `remember`, `note`, `explain`, `forget` and `memory_stats`. |
| `opencode/` | opencode plugin | Adds a short instruction to the system prompt of selected agents. The instruction tells the agent to use `recall` only when the task needs it. The plugin does not load memory into the context. |
| `musemem/` | musemem pipeline | A command-line tool and two systemd timers. It extracts claims from your opencode sessions, writes the Markdown files and keeps Mem0 in sync. |
| `openchamber/` | OpenChamber extension | A **Memory** panel for [OpenChamber](https://github.com/openchamber/openchamber). You can search, edit, pin and forget claims, and read the dreams. |

You can use the parts separately. The minimum is `stack/` and `mcp/`. Without
`musemem/`, the tools `note`, `explain` and `forget` do not work.

## How it works

```text
opencode session ──► opencode.db
                         │  hourly: musemem consolidate
                         ▼
          LLM extracts claims ──► quote check ──► dedupe / supersede
                         │
         ┌───────────────┼──────────────────────────────┐
         ▼               ▼                              ▼
  claim ledger     Markdown files                Mem0 (pgvector)
  claims.db        MEMORY.md, memory/*.md,       semantic recall
                   bank/, people/, groups/
                         │  nightly: musemem dream
                         ▼
                 dreams/YYYY-MM-DD.md, ALIGNMENT_SYNTHESIS.md

agent ──► MCP tools: recall (Mem0) · note · explain · forget (musemem)
```

1. **Consolidate** (hourly). musemem reads new user messages from the opencode
   database. An LLM proposes claims. musemem keeps a claim only if its quote occurs
   word for word in a cited message and the claim contains no secret. It then merges
   duplicates and marks old claims as superseded.
2. **Promote**. Claims with a salience and confidence of 0.6 or more go to Mem0 and
   to `MEMORY.md`.
3. **Dream** (nightly). An LLM writes a short review of recent sessions and updates
   `dreams/ALIGNMENT_SYNTHESIS.md`.
4. **Recall**. The agent calls `recall` when a task depends on earlier decisions or
   preferences. Mem0 does the vector search and, optionally, reranks the results.
5. **Forget**. `forget` retracts the claim and everything made from it: the Mem0
   entry, the lines in `MEMORY.md`, the daily logs, the bank files and the dreams. A
   tombstone stops consolidation from adding the claim again.

All files are below `$MUSE_HOME` (default: your home folder). The `MEMORY.md` file
has a hand-edited **Pinned** block that musemem does not change.

## Models

All model calls use the OpenAI API format. The reference setup uses small local
models on an NPU:

| Role | Used by | Reference model |
|---|---|---|
| Fact extraction | Mem0 | `LFM3-1.7B` (reasoning off) |
| Embeddings | Mem0 | `qwen3-embedding-0.6b`, 1024 dimensions |
| Reranker (optional) | Mem0 | `BAAI/bge-reranker-v2-m3` on Infinity |
| Claim extraction, dreams | musemem | Any chat model that returns JSON. `MUSE_LLM_MODEL` sets it. |

You can use Ollama, llama.cpp, vLLM, OpenAI or another compatible server. See
`stack/.env.example`.

## Install

See [INSTALL.md](INSTALL.md).

## Tests

```sh
musemem/tests/test_musemem.py                       # musemem, offline
node --test opencode/muse-memory.test.mjs           # opencode plugin
(cd openchamber && bun install && bun test)         # OpenChamber extension
(cd stack && python -m unittest test_infinity_reranker)  # needs mem0ai installed; the image build also runs it
```

## Privacy

- musemem rejects claims that look like tokens, keys or passwords. Mem0 gets an
  instruction to store no secrets. Do not depend on these filters alone.
- The stack binds its ports to `127.0.0.1` by default. Change `BIND_ADDRESS` only
  on a network that you trust, and keep `AUTH_DISABLED=false`.
- Your memory files contain personal data. Do not commit `$MUSE_HOME` to a public
  repository.

## License

MIT. See [LICENSE](LICENSE). The Docker images build Mem0 from its upstream source,
which has the Apache 2.0 license.
