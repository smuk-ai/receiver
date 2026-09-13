# User-owned agent receiver

The `agent-out` destination routes a signed message to an HTTPS URL chosen by
the user. It does not run a model in SMUK, hold an AI login/API key, inject into
a browser conversation, or bring the result back into the blueprint. The
user runs the downloadable receiver on their own machine/server and signs
into their chosen official CLI there. Follow the [visual setup guide](https://smuk.ai/agent-receiver.html).

## Contract and authorization

`src/protocol.ts` defines the wire contract used by SMUK and the receiver:

```json
{
  "schemaVersion": 1,
  "eventId": "<64 lowercase hex characters>",
  "agent": { "provider": "Codex", "instructions": "Summarize as JSON." },
  "message": {
    "nodeId": "destination-id", "sourceNodeId": "discord-tile-id",
    "text": "Message content", "sender": "display name", "senderId": "123",
    "platform": "discord", "receivedAt": "2026-09-12T12:00:00.000Z",
    "channelId": "456", "channelName": "general",
    "serverId": "789", "serverName": "Example server"
  }
}
```

Unknown sender/channel/server metadata is null. Instructions are literal;
message-template placeholders are not expanded into them. They are ordinary
blueprint configuration, not secret storage: do not put credentials in them.
The signing secret uses the existing split/sealed node-secret path. No secret
is in the JSON, sample, localStorage or export.

The engine checks an HTTPS endpoint without credentials/fragment, applies the
existing outbound address/DNS guard, refuses redirects, and signs the exact
UTF-8 body. `x-smuk-timestamp` is integer Unix seconds;
`x-smuk-signature` is `v1=` plus HMAC-SHA256 over `timestamp + '.' + body`,
using the decoded 32-byte hex secret. The receiver compares in constant time
and accepts only timestamps within five minutes. Every retry gets a fresh
timestamp/signature; its body/event ID stays stable. The event ID hashes the
run ID and complete pre-ID payload, preserving dedup across checkpoint retry
while keeping distinct runs/configurations separate. Ordinary network,
429/5xx retries and 30-second delivery timeout apply. Acceptance is logged
separately from processing completion; SMUK never sees that completion.

The local config independently approves the destination ID, exact provider
and instructions, at least one source node ID, and optional sender/channel/
server ID allowlists. Both inbound and dequeued messages must match. Changing
instructions on the website alone cannot change what the local agent does.
Unknown payload fields are dropped; no remote JSON field becomes arguments,
environment, a callback, a session ID or an executable. A valid signature
proves delivery origin, not that a Discord author's text is trustworthy.

## Receiver lifecycle

`npm run build` compiles the ESM modules and declarations, then bundles
`src/index.ts` with esbuild into `dist/smuk-receiver.mjs` for Node.js 22.13+.
Versioned releases contain the executable and a package tarball. The SMUK
site serves the executable from its pinned package dependency.
There are no receiver npm dependencies, hosted inboxes, API keys, or idle AI
polls. `init` creates a private config and a random per-destination secret.
`serve` binds only 127.0.0.1; the user supplies TLS through their proxy/tunnel.
Only POST `/webhook` is exposed; statuses/results are available via local
`list`, never through HTTP. Serving alone queues without processing.

SQLite WAL persists queued/running/completed/failed/interrupted records with
private permissions. Capacity is 1,000 retained rows, including completed
ones, and retention is seven days while serving. The dedup window lasts only
as long as the retained record. At most 60 ingress requests/minute, 32 sockets,
128 KiB request bodies and 10-second request/header timeouts are accepted.
These local limits do not replace the user's proxy-level flood protection.

`--process` opts into serial work, at most one start per six seconds. Each
job gets a new temporary work directory and CLI session. PAUSE in the data
directory stops new starts; stopping the receiver cancels active work. A
separate IPC watchdog owns the two-minute child-process timeout and cancels
the CLI process group even when the receiver dies abruptly. Output plus
stderr is capped at 128 KiB. The watchdog also removes the work directory.
SIGKILL of the watchdog itself, or a hostile local executable deliberately
escaping its process group, still needs OS-level containment.

Failed jobs are not automatically retried. A startup lock refuses duplicate
instances; after a crash the operator verifies the old processes are gone
before removing it. Restart marks any remaining running row interrupted.
Exactly-once model execution is not promised: a provider may have completed
before a crash prevented saving its answer. `list` never changes live job
state. Results must be JSON objects and remain inert data in local SQLite.

## CLI restrictions and gotchas

Use a dedicated OS account/VM with only the selected CLI sign-in and receiver
data. The receiver preserves that account's HOME so the CLI can use its own
login, but strips other inherited environment variables. No API-key fallback
is configured. macOS/Linux can process; Windows can receive/list only.

- **Codex:** stdin prompt, ephemeral session, ignore user config/rules,
  read-only sandbox, never approve; shell, unified exec, web search, apps,
  plugins, computer use, image tools, memories, subagents and MCP disabled.
- **Claude Code:** print mode with safe mode, restricted mode, empty tools,
  wildcard disallowed tools, strict empty MCP config, no setting sources or
  session persistence. `--bare` is deliberately absent: it skips OAuth.
- **Gemini CLI:** stdin plus fixed prompt, no extensions; system settings
  override tools to empty and disable hooks, skills, agents, MCP, discovery
  and external tool dispatch. **Escape every @ as JSON `\u0040`** in both
  instructions and message data: headless Gemini expands @file references
  before the model, bypassing the model's tool allowlist. JSON decoding keeps
  the original content intact.
- **Grok Build:** fixed prompt file (Grok ignores stdin), empty built-in tools,
  MCP denied, no subagents/memory/web search, one turn. Processing is **Linux
  only**, with fail-closed checks for documented inherited hook/config/MCP/
  plugin/skill paths in HOME and `/etc/grok`. macOS MDM can inject additional
  hooks outside those paths, so macOS processing is refused. Do not remove
  these guards to accommodate a customized account.

All CLIs run with shell:false and fixed arguments; message content stays in
stdin/a private file. Unsupported CLI flags fail the job, with no retry using
weaker flags. Provider CLI startup itself is trusted code; tool restrictions
are defense in depth, not a substitute for OS isolation. Prompt injection
may still corrupt a summary. Neither instructions nor JSON output validation
guarantees semantic correctness. These adapters never authorize actions from
the answer. Live provider/model calls are not part of automated tests.

References checked 2026-09-12: [Codex noninteractive](https://learn.chatgpt.com/docs/non-interactive-mode),
[Claude CLI](https://code.claude.com/docs/en/cli-reference),
[Gemini configuration](https://geminicli.com/docs/reference/configuration/),
[Grok CLI](https://docs.x.ai/build/cli/reference),
[Grok configuration sources](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/26-config-reference.md).
CLI releases and subscription eligibility can change independently of SMUK.
