# Memory (OpenChamber extension)

This extension shows your agent memories in OpenChamber. You can read, search and curate them.

The extension uses the musemem command-line tool (`../musemem/bin/musemem.py` in this repository, or `$MUSEMEM_BIN`). It does not read the memory files directly.

## What it does

The panel has four tabs:

- **Claims**: Search and filter the musemem claims (status, kind, entity, pinned, sort). Select a claim to see its full text, the verbatim quote, the evidence (session title, folder and message IDs), the daily log citation and the supersession history. You can edit the text, the kind, the salience and the confidence. You can pin or unpin a claim, restore a superseded claim, and forget a claim.
- **Legacy (Mem0)**: Mem0 entries that have no claim (from other Mem0 clients, or from the time before musemem). You can forget an entry, or adopt it as a new claim.
- **Dreams**: The alignment synthesis, the dream files by date, and the companion data (alignment state, repair threads, progression history).
- **Pinned**: An editor for the hand-written Pinned block of `~/MEMORY.md`, and the list of pinned claims.

The header shows the claim counts and the time of the last consolidate and dream runs.

Forget cannot be undone. musemem retracts the claim, deletes it from Mem0, removes the text from the logs and dreams, and does not add it again. The panel asks for a reason before it forgets.

## Parts

| Path | Purpose |
|---|---|
| `package.json` | Package and OpenChamber manifest (panel `memory`, page, host service). |
| `panel/` | The panel. `main.ts` is the source; `main.js` is the built file. |
| `panel/markdown.ts` | A small Markdown reader. It does not make HTML from the source text. |
| `service/` | The local service. `main.ts` is the source; `main.js` is the built file. |
| `service/validate.ts` | Input checks. They build the argument list for musemem.py. |
| `service/musemem.ts` | Starts musemem.py without a shell. It has a 60 second timeout and limits parallel runs. |
| `shared/types.ts` | Data shapes that the CLI prints. |
| `test/unit.test.ts` | Unit tests. |
| `test/harness/` | A web page that acts as the OpenChamber host, for manual tests. |

## Service routes

All routes need the header `Authorization: Bearer <OPENCHAMBER_SERVICE_TOKEN>`. Bodies are JSON and can be 64 KB at most.

| Route | musemem command |
|---|---|
| `GET /health` | none |
| `GET /stats` | `stats` |
| `GET /claims?status=&kind=&q=&entity=&pinned=&sort=&limit=&offset=` | `list` |
| `GET /claim?id=c_xxxxxxxx` | `show` |
| `POST /claim/edit {id, text?, kind?, salience?, confidence?, pinned?, status?}` | `edit` |
| `POST /forget {id, reason}` (claim ID or Mem0 UUID) | `forget` |
| `GET /legacy?q=` | `legacy` |
| `POST /legacy/adopt {id, text, kind, salience?}` | `legacy` (check), `note`, then `forget <uuid> --reason=adopted` |
| `GET /dreams` | `dreams` |
| `GET /dream?date=YYYY-MM-DD\|synthesis` | `dreams --date` |
| `GET /pinned-text` | `pinned-text` |
| `POST /pinned-text {text}` | `pinned-text --set` (text on STDIN) |

Error status codes:

- 400: the input is not valid.
- 401: the token is missing or wrong.
- 404: the claim, date or entry does not exist.
- 409: musemem is busy (another run holds its lock). Try again.
- 429: too many requests are waiting. Try again.
- 422: musemem refused the change. The `error` field has the reason.
- 504: musemem did not answer in 60 seconds.

The service runs one change at a time. It runs at most four reads at the same time.

## Requirements

- `uv` on the PATH of the OpenChamber service. musemem.py is a uv script.
- `../musemem/bin/musemem.py` from this repository, or `MUSEMEM_BIN`.
- The settings in `~/.config/muse-memory/env` (see INSTALL.md). musemem reads this file.
- The Mem0 API key in `~/.config/mem0/api_key`. musemem reads it. The service does not get the environment of OpenChamber, so musemem must find the key in this file.

## Build

1. Install the packages:

   ```sh
   bun install
   ```

2. Build the panel and the service:

   ```sh
   bun run build
   ```

3. Do the type check and the tests:

   ```sh
   bunx tsc --noEmit
   bun test
   ```

Commit the built files `panel/main.js` and `service/main.js` with the sources. OpenChamber loads the built files.

## Install

1. Add the folder to `~/.config/openchamber/extensions.json`:
   - Add the absolute path of this `openchamber` folder to `paths`.
   - Add `"memory": ["service"]` to `capabilityGrants`.
   - Add `"memory": {"service": {"exec": ["uv"], "sockets": []}}` to `capabilityScopes`.

   Or, install the folder from Settings, Extensions, and approve the local service there.

2. OpenChamber reads the file again in approximately 5 seconds. You do not need to restart it.

3. Open the **Memory** panel (brain icon).

If the panel says that the service is not running, open Settings, Extensions, and allow the Memory service.

## Manual test

Do not test changes on your real memory. Use a scratch home and a scratch Mem0 user:

```sh
export MUSE_HOME="$(mktemp -d)" MEM0_USER_ID=musemem-ui-test
../musemem/bin/musemem.py note "The user likes short answers." --kind preference --salience 0.8
HARNESS_PORT=39420 bun test/harness/dev.ts
```

Open the printed URL. The harness shows toasts in its top bar.

To see your real data without changes, use the read-only mode. The harness then refuses all POST requests:

```sh
HARNESS_READONLY=1 MUSE_HOME=$HOME MEM0_USER_ID=$USER HARNESS_PORT=39421 bun test/harness/dev.ts
```


After the test, delete the scratch Mem0 user:

```sh
curl -X DELETE -H "X-API-Key: $(cat ~/.config/mem0/api_key)" "${MEM0_URL:-http://127.0.0.1:9120}/entities/user/musemem-ui-test"
```
