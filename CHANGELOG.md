# Changelog

## 0.2.0

- Add quick setup from a SMUK tile connection command: review exact local instructions and source approvals once, then receive in one foreground terminal.
- Connect a managed temporary tunnel with private configuration, bounded startup and process cleanup; transfer the generated signing key directly through authenticated HTTPS pairing.
- Add local `process`, `pause`, `results` and `quit` commands. Processing remains off on every setup; existing agent restrictions are unchanged.
- Keep signing keys, inboxes and local allowlists when reconnecting the same tile; require fresh local approval for configuration changes and recheck queued work against that approval.
- Preserve manual init/serve/list setup for stable tunnels and proxies. Improve actionable startup and connection errors without exposing credentials.

## 0.1.1 — 2026-09-13

- Adopt Apache License 2.0 for the receiver, with a copyright notice.
- Include the full license and attribution in the standalone executable, npm package and release assets; preserve attribution in the browser-safe protocol module.
- Verify licensing in the actual release package. Receiver behavior and wire protocol are unchanged.

## 0.1.0 — 2026-09-13

- First standalone public release of the SMUK Receiver.
- Signed webhook intake, local task/source approval, SQLite inbox, receive-only mode and optional restricted agent processing.
- Existing receiver behavior and tests extracted into a package with no runtime npm dependencies, a standalone executable and shared protocol/signature exports.
