# Working on SMUK Receiver

This repository is the source of truth for the receiver, its protocol and signing helpers. The SMUK application consumes a pinned release; never copy private application data or history here.

- Read README.md and docs/architecture.md before changes. Keep those documents and CHANGELOG.md current when behavior changes.
- Preserve receive-only defaults, exact local instruction/source approval, signature verification, process cancellation and fail-closed CLI restrictions. Never fall back to weaker flags when an agent rejects a command.
- All logic changes need real input/output and failure-path tests. Do not weaken assertions or lower coverage/mutation thresholds to pass.
- Run npm run build, npm test, npm run coverage and npm run e2e before committing. Run npm run mutation when changing logic; CI also enforces it.
- Coverage is at least 85% per logic file. CLI/supervisor I/O composition is covered by the real-process integration test. No live provider credentials or paid calls belong in automated tests.
- Get an independent adversarial review before merging non-trivial changes.
- Commit no .env files, credentials, user instructions, receiver configs, SQLite files, logs, inbox/results, local paths or node_modules. Test credentials must be clearly synthetic.
- Release from a tested commit, publish checksums, and update consumers deliberately. Never replace an existing release asset with different bytes.
