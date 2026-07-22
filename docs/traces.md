# Trace mapping

One real WorkBuddy user message starts one turn. The turn ends at the latest transcript or measured tool event associated with the terminal assistant message or a cancelling `SessionEnd`. Startup context, compaction messages, meta messages, teammate injections, blank turns, and non-terminal turns are not exported.

```text
invoke_agent
|- llm
|- assistant
|- tool:<name>
|  `- skill:<name>
|- llm
`- assistant
```

`llm`, `assistant`, and `tool:*` are direct children of `invoke_agent`. A `skill:*` span is emitted only when a tool directly accesses an existing `SKILL.md`, or the WorkBuddy `Skill` tool resolves an exact installed Skill name.

## Timing

- Turn timing starts at the real user message and covers the latest transcript or measured tool timestamp in the turn.
- Tool timing prefers `PreToolUse` to `PostToolUse`/`PostToolUseFailure`; transcript timestamps are the fallback.
- WorkBuddy does not expose each model API request start through its public Hook payload. LLM duration is therefore the client interval from the triggering user/tool result to the model output and carries `timing.source=inferred`.
- Assistant spans represent local output events and use a minimal non-zero duration.

## Main fields

All spans include `gen_ai.conversation.id`, compatibility `session_id`, `gen_ai.turn.id`, and `turn_id`.

- `invoke_agent`: structured input/final output, model, finish reason, `final_status`, channel, previews, lengths, and `tool_count`.
- `llm`: structured input/output, provider/model when present, per-call usage, output kind, and finish reason.
- `assistant`: structured output and model fields, without token usage.
- `tool:*`: tool name/call ID, arguments, result, status, timing source, and triggering LLM span ID.
- `skill:*`: name, absolute entry path, source, status, and parsed frontmatter metadata.

Main and subagents create independent `invoke_agent` traces. When the Hook payload exposes ancestry, subagent roots include `parent_session_id` and `parent_tool_call_id`. Missing ancestry is omitted rather than guessed.
