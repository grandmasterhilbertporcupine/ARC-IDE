# Host UI, status, and lifecycle

### bb.ui — host-rendered UI (no frontend bundle needed)

```ts
bb.ui.registerMentionProvider({
  id: "issue",
  label: "Issues",
  triggers: ["@", "#"], // optional; defaults to ["@"]. Valid: @ # $ ! ~
  search({ trigger, query, projectId, threadId }) {
    // 2s time box, failure = empty list
    return [{ id: "42", title: "ENG-42 Fix flake", subtitle: "Todo" }];
  },
  resolve(itemId) {
    // once per unique item AT SEND TIME
    return { context: "# ENG-42…" }; // attached as agent-only context; throwing BLOCKS the send
  },
});
```

Mention items render under `label` in the menu for each registered trigger.
Items may provide `experimental_recipient: {kind: "agent" | "team", entityId, versionId, scopeKey}` to become persistent addressed-work chips. This metadata is untrusted client input at Send: validate scope and published revision again in `bb.ui.experimental_registerAddressedDispatch(async context => result)`. Its context is `{projectId, threadId, operationId, prompt, recipients}`. Each recipient also carries `pluginId` and `label`. Persist operation idempotency before run effects. Return `{runId, status: "started" | "continued", summary, path?}`; optional `path` must stay beneath `/plugins/<your-plugin-id>/`. Core writes durable operation receipts and suppresses ordinary provider dispatch. Search and mention resolution must remain side-effect free; a coordinator owns the explicit Send only. Multiple coordinator plugins in one send are rejected.
All handlers run server-side. Frontend thread-header actions use
`app.slots.threadHeader`.
There is deliberately no plugin slash-command surface: the composer's `/`
menu lists skills, so a plugin capability that crafts a prompt for the agent
ships as a `skills/` entry instead.

### bb.status

`bb.status.needsConfiguration(message)` — mark the plugin
`needs-configuration` (shown in `bb plugin list` and the UI) instead of
failing. Cleared on the next load.

### bb.onDispose and the reload lifecycle

`bb.onDispose(hook)` registers cleanup; hooks run **LIFO**. On
reload the host first runs the factory against a candidate registration set.
If it throws, the complete previous set stays live. Once the candidate
succeeds, the host disposes the old host artifact first. It then interrupts
pending plugin input, aborts services, and waits up to five seconds for each
service. A hung service marks the plugin as degraded until it stops. The host
then runs dispose hooks in LIFO order. One failed hook does not stop later
cleanup. It gives in-flight HTTP, RPC, and event handlers five seconds to
finish. It then closes database handles and invalidates the old `bb` object.
Disable and shutdown use the same sequence without a replacement. A
captured `bb` from a previous load throws `PluginContextStaleError` on use
— never stash the API object in module-level state that outlives a load.
