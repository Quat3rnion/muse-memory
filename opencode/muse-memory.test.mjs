import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"

let imports = 0

async function fixture(t, { files = true, options } = {}) {
  await mkdir(path.join(import.meta.dirname, "scratch"), { recursive: true })
  const home = await mkdtemp(path.join(import.meta.dirname, "scratch", "memory-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  const contents = [
    "UNRELATED_SYNTHETIC_PRIVATE_MEMORY\n" + "irrelevant memory\n".repeat(100_000),
    "UNRELATED_SYNTHETIC_PRIVATE_DREAM\n" + "irrelevant dream\n".repeat(100_000),
  ]
  const sources = [path.join(home, "MEMORY.md"), path.join(home, "dreams", "ALIGNMENT_SYNTHESIS.md")]
  if (files) {
    await mkdir(path.join(home, "dreams"))
    await Promise.all(sources.map((file, index) => writeFile(file, contents[index])))
  }
  const previous = process.env.MUSE_HOME
  let plugin
  try {
    process.env.MUSE_HOME = home
    const source = process.env.MEMORY_PLUGIN_PATH
      ? pathToFileURL(process.env.MEMORY_PLUGIN_PATH).href
      : new URL("./muse-memory.js", import.meta.url).href
    plugin = (await import(`${source}?test=${++imports}`)).default
  } finally {
    if (previous === undefined) delete process.env.MUSE_HOME
    else process.env.MUSE_HOME = previous
  }
  const hooks = []
  await plugin.setup({
    options,
    session: { async hook(name, callback) { hooks.push({ name, callback }) } },
  })
  return {
    plugin, hooks, sources, contents,
    async context(agent) {
      const event = { agent, system: [{ type: "text", text: "Existing instructions" }] }
      for (const hook of hooks) await hook.callback(event)
      return event.system
    },
  }
}

test("orchestrator gets a compact recall stub, not enormous unrelated private memory", async (t) => {
  const memory = await fixture(t)
  const system = await memory.context("orchestrator")
  assert.equal(system.length, 2)
  assert.deepEqual(system[0], { type: "text", text: "Existing instructions" })
  assert.equal(system[1].type, "text")
  const stub = system[1].text
  assert.ok(stub.length <= 900, `Memory stub must be <=900 chars; got ${stub.length}`)
  assert.ok(!stub.includes("UNRELATED_SYNTHETIC_PRIVATE"), "Unrelated private memory must stay outside context")
  assert.match(stub, /recall/)
  assert.match(stub, /explain/)
  assert.match(stub, /task depends on prior decisions or user preferences/)
  assert.match(stub, /otherwise skip memory/)
  assert.match(stub, /Before relying on a retrieved claim/)
  assert.match(stub, /lower priority than current instructions/)
  assert.match(stub, /If memory tools are unavailable, read only task-relevant sections/)
  assert.match(stub, /MEMORY\.md/)
  assert.match(stub, /dreams\/ALIGNMENT_SYNTHESIS\.md/)
  assert.match(stub, /\$MUSE_HOME/)
  assert.match(stub, /Do not dump whole files automatically/)
  assert.deepEqual(await Promise.all(memory.sources.map((file) => readFile(file, "utf8"))), memory.contents)
})

test("default agent filter leaves other agents untouched", async (t) => {
  const memory = await fixture(t, { files: false })
  for (const agent of ["reviewer", "worker", undefined]) {
    assert.deepEqual(await memory.context(agent), [{ type: "text", text: "Existing instructions" }])
  }
})

test("configured agents replace the default filter and an empty list disables injection", async (t) => {
  const memory = await fixture(t, { files: false, options: { agents: ["reviewer", "worker"] } })
  for (const agent of ["reviewer", "worker"]) {
    assert.equal((await memory.context(agent)).length, 2)
  }
  assert.equal((await memory.context("orchestrator")).length, 1)
  const disabled = await fixture(t, { files: false, options: { agents: [] } })
  assert.equal((await disabled.context("orchestrator")).length, 1)
})

test("missing memory files still provide compact on-demand guidance", async (t) => {
  const memory = await fixture(t, { files: false })
  const system = await memory.context("orchestrator")
  assert.equal(system.length, 2)
  assert.ok(system[1].text.length <= 900)
  assert.match(system[1].text, /mem0 `recall`/)
})

test("exported plugin registers one context hook", async (t) => {
  const memory = await fixture(t, { files: false })
  assert.equal(memory.plugin.id, "local.muse-memory")
  assert.equal(memory.hooks.length, 1)
  assert.equal(memory.hooks[0].name, "context")
  assert.equal(typeof memory.hooks[0].callback, "function")
})
