# Changelog

## 0.1.1 — 2026-09-13

- Adopt Apache License 2.0 for the receiver, with a copyright notice.
- Include the full license and attribution in the standalone executable, npm package and release assets; preserve attribution in the browser-safe protocol module.
- Verify licensing in the actual release package. Receiver behavior and wire protocol are unchanged.

## 0.1.0 — 2026-09-13

- First standalone public release of the SMUK Receiver.
- Signed webhook intake, local task/source approval, SQLite inbox, receive-only mode and optional restricted agent processing.
- Existing receiver behavior and tests extracted into a package with no runtime npm dependencies, a standalone executable and shared protocol/signature exports.
