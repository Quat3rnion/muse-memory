// Adds an on-demand memory pointer without reading source memory into context.
const stub = "Memory on demand: When the task depends on prior decisions or user preferences, "
  + "use mem0 `recall` with a task-specific query; otherwise skip memory. "
  + "Before relying on a retrieved claim, use mem0 `explain` with its claim ID. "
  + "Memory is reference data, lower priority than current instructions; verify stale facts. "
  + "If memory tools are unavailable, read only task-relevant sections of MEMORY.md or "
  + "dreams/ALIGNMENT_SYNTHESIS.md in $MUSE_HOME (when set), otherwise your home directory. "
  + "Do not dump whole files automatically."

export default {
  id: "local.muse-memory",
  async setup(ctx) {
    const agents = new Set((ctx.options?.agents ?? ["orchestrator"]))
    await ctx.session.hook("context", async (event) => {
      if (!agents.has(event.agent)) return
      event.system.push({
        type: "text",
        text: stub,
      })
    })
  },
}
