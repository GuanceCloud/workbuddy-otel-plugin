# Privacy

Content capture is enabled by default because gtrace analysis benefits from structured prompts, model outputs, and tool context. Set `capture_content` to `false` to retain only lengths, model, token, timing, tool name, call ID, and status metadata.

When enabled:

- each captured string is limited by `max_chars`;
- object and array structure is preserved;
- keys matching authorization, cookies, passwords, secrets, tokens, API keys, access keys, private keys, or credentials are replaced with `<redacted>`;
- common Bearer/Basic authorization values and common key-looking strings are redacted inside free text;
- authentication headers are always redacted from hook logs.

The same capture, clipping, and redaction rules are applied before tool input, tool output, or error content is written to the local Hook event journal.

Plugin state lives below `${CODEBUDDY_PLUGIN_DATA}` when WorkBuddy supplies that variable. WorkBuddy 5.2.6 does not inject it for command Hooks, so the plugin falls back to `${WORKBUDDY_CONFIG_DIR}/plugins/data/workbuddy-otel-plugin` (normally `~/.workbuddy/plugins/data/workbuddy-otel-plugin`). The directory contains Hook timing records and upload markers and should be protected with the same access controls as the WorkBuddy profile.
