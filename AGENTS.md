# AGENTS.md

Always respond in Chinese-simplified.

This repository exports WorkBuddy native JSONL sessions as gtrace-compatible OTLP/HTTP protobuf traces and metrics. Keep the runtime dependency-free, preserve the WorkBuddy native plugin layout, and run `npm test` plus `npm ls --all` after changes.

Never add real prompts, tokens, credentials, or user transcripts to fixtures or documentation. Trace roots are `invoke_agent`; direct children are `llm`, `assistant`, and `tool:*`; only high-confidence `skill:*` spans are children of their matching tool span.
