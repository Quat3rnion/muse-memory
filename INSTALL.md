# Install

This guide installs all parts on one Linux computer. You can also run the Mem0
stack on a different host. In that case, set `MEM0_URL` to that host in steps 3 to 5.

## Requirements

- Docker with the Compose plugin (for the Mem0 stack)
- [uv](https://docs.astral.sh/uv/) (it runs the Python scripts and installs their dependencies)
- opencode 2
- An OpenAI-compatible model server for chat and embeddings
- Optional: systemd (user units) for the timers, and [Bun](https://bun.sh) for the OpenChamber extension

## 1. Get the code

```sh
git clone https://github.com/<owner>/muse-memory.git ~/.local/share/muse-memory
cd ~/.local/share/muse-memory
```

The systemd units in `musemem/systemd/` use this path. If you use a different path,
change `ExecStart` in the two `.service` files.

## 2. Start the Mem0 stack

```sh
cd stack
cp .env.example .env
chmod 600 .env
```

Edit `.env`:

1. Replace each `replace-with-...` value with a random value. Use `openssl rand -hex 32`.
2. Set `LLM_BASE_URL`, `LLM_MODEL` and `EMBED_MODEL` for your model server. Inside
   the containers, `host.docker.internal` is the Docker host.
3. Set `POSTGRES_EMBEDDING_DIMS` to the output size of `EMBED_MODEL`. You cannot
   change this value after the first start without a new database.
4. If your model does not reason, set `LLM_IS_REASONING_MODEL=false`.

Start the stack:

```sh
docker compose up -d --build
docker compose logs mem0-configure
```

The `mem0-configure` job must print `Mem0 configured: ...` and stop with exit
code 0. It runs again at each `docker compose up`. If it fails, read its log: it
tells you which endpoint or value is wrong.

Check the API:

```sh
curl -s -H "X-API-Key: <ADMIN_API_KEY>" http://127.0.0.1:9120/entities
```

The dashboard is at <http://localhost:3120>. It asks you to make an admin account
on the first visit.

### Optional: reranker

The reranker sorts the search results again with a cross-encoder. It runs on the
CPU and downloads approximately 2 GB at the first start.

```sh
docker compose --profile reranker up -d
```

Then set `RERANKER_URL=http://reranker:7997/rerank` in `.env` and run
`docker compose up -d` again. If the reranker fails, Mem0 returns the results
without reranking.

### Optional: private TLS authority

If your model server uses a certificate from a private authority, put the
authority certificate (`*.crt`) in `stack/certs/` and build again with
`docker compose up -d --build`.

## 3. Store the API key

The MCP server and musemem read the Mem0 key from a file:

```sh
cd ~/.local/share/muse-memory
install -d -m 700 ~/.config/mem0
grep ^ADMIN_API_KEY= stack/.env | cut -d= -f2- > ~/.config/mem0/api_key
chmod 600 ~/.config/mem0/api_key
```

You can also make a per-user key in the dashboard and use it instead of the admin key.

## 4. Configure musemem

musemem needs a chat model for claim extraction and dreams. Put the settings in
`~/.config/muse-memory/env`. musemem, the MCP server and the OpenChamber service
read this file. A variable that is already set in the environment has priority.
`MUSE_ENV_FILE` selects a different file.

```sh
install -d -m 700 ~/.config/muse-memory
cat > ~/.config/muse-memory/env <<'EOF'
MUSE_HOME=/home/<you>
MUSE_LLM_URL=http://127.0.0.1:8731/v1
MUSE_LLM_MODEL=LFM3-1.7B
MUSE_LLM_KEY=
MEM0_URL=http://127.0.0.1:9120
MEM0_USER_ID=<you>
EOF
chmod 600 ~/.config/muse-memory/env
```

| Variable | Default | Purpose |
|---|---|---|
| `MUSE_HOME` | your home folder | Folder for `MEMORY.md`, `memory/` and `dreams/` |
| `MUSE_LLM_URL` | `http://127.0.0.1:8731/v1` | OpenAI-compatible base URL |
| `MUSE_LLM_MODEL` | `LFM3-1.7B` | Chat model. It must return JSON. |
| `MUSE_LLM_KEY` | empty | Bearer token for the model server |
| `MEM0_URL` | `http://127.0.0.1:9120` | Mem0 API |
| `MEM0_API_KEY_FILE` | `~/.config/mem0/api_key` | File with the Mem0 key |
| `MEM0_USER_ID` | `$USER` | Mem0 user scope. Use the same value everywhere. |
| `MUSE_AGENT_ID` | `opencode` | Agent attribution for Mem0 writes |
| `OPENCODE_DB` | `~/.local/share/opencode/opencode.db` | opencode session database |

Test musemem:

```sh
musemem/tests/test_musemem.py      # offline test, prints "ok"
musemem/bin/musemem.py stats       # reads the env file, prints JSON
```

The first `consolidate` run reads the sessions of the last 7 days.

Install the timers (hourly consolidate, dream at 04:30):

```sh
mkdir -p ~/.config/systemd/user
cp musemem/systemd/* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now musemem-consolidate.timer musemem-dream.timer
```

## 5. Add the MCP server to opencode

Add this to `~/.config/opencode/opencode.json`. Use absolute paths. The server
name must be `mem0`, because the plugin instruction refers to `mem0` tools.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "mem0": {
        "type": "local",
        "command": ["/home/<you>/.local/share/muse-memory/mcp/mem0_memory_mcp.py"],
        "environment": {
          "MEM0_AGENT_ID": "opencode"
        }
      }
    }
  }
}
```

The server reads the other settings from `~/.config/muse-memory/env` (step 4).
The `note`, `explain` and `forget` tools start `musemem/bin/musemem.py` from the
same clone. Set `MUSEMEM_BIN` to use a different copy.

Check the connection with `opencode mcp list`. Then ask an agent to call
`memory_stats`.

## 6. Add the opencode plugin

The plugin adds the memory instruction to the `orchestrator` agent only. Use one
of these methods.

Copy the file. This uses the default agent list:

```sh
mkdir -p ~/.config/opencode/plugins
cp opencode/muse-memory.js ~/.config/opencode/plugins/
```

Or load the folder from the configuration and select the agents:

```jsonc
{
  "plugins": [
    {
      "package": "/home/<you>/.local/share/muse-memory/opencode",
      "options": { "agents": ["orchestrator", "build"] }
    }
  ]
}
```

An empty `agents` list turns the instruction off.

## 7. Optional: OpenChamber panel

```sh
cd openchamber
bun install
bun run build
bun test
```

Then add the extension in OpenChamber (Settings, Extensions) and allow its local
service. Or edit `~/.config/openchamber/extensions.json`:

- Add the absolute path of the `openchamber` folder to `paths`.
- Add `"memory": ["service"]` to `capabilityGrants`.
- Add `"memory": {"service": {"exec": ["uv"], "sockets": []}}` to `capabilityScopes`.

The service starts musemem, which reads `~/.config/muse-memory/env` (step 4). See
[openchamber/README.md](openchamber/README.md) for details.

## Update

```sh
cd ~/.local/share/muse-memory
git pull
(cd stack && docker compose up -d --build)
(cd openchamber && bun install && bun run build)
```

## Uninstall

```sh
systemctl --user disable --now musemem-consolidate.timer musemem-dream.timer
(cd stack && docker compose down)       # add -v to delete all memories in Mem0
```

Then remove the `mem0` server and the plugin from the opencode configuration. Your
Markdown files stay in `$MUSE_HOME`.

## Troubleshooting

| Problem | Check |
|---|---|
| `mem0` does not become healthy | `docker compose logs mem0`. `LLM_BASE_URL` and `LLM_MODEL` must be set before the first start. |
| `mem0-configure` waits and then fails | The embedding endpoint is not reachable from the container, or it returns a different number of dimensions than `POSTGRES_EMBEDDING_DIMS`. |
| `remember` says "not stored" | Mem0 found no durable fact in the text. This is normal for transient text. |
| `note`, `explain` or `forget` fail | `uv` is not on the `PATH` of opencode, or `MUSEMEM_BIN` is wrong. |
| Recall returns nothing | `MEM0_USER_ID` is different in the MCP server and in musemem. |
