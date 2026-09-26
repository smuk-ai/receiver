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

The local config independently approves the destination identity, exact provider
and instructions, at least one source node ID, and optional sender/channel/
server ID allowlists. Both inbound and dequeued messages must match. Changing
instructions on the website alone cannot change what the local agent does.
Legacy installations approve exactly `message.nodeId`. Reusable saved-agent
installations explicitly add `destinationId` to their setup manifest and config;
that ID must equal the manifest/config `nodeId`. Incoming messages must then carry
that same `agent.destinationId`, while `message.nodeId` retains the actual tile
that sent the message. This permits several tiles to share the approved agent
without losing tile provenance. Legacy approvals reject a `destinationId` claim,
even when it happens to equal their tile ID. Missing/wrong profile identities,
changed tasks/providers, and unapproved sources fail closed both on delivery and
when dequeued. Moving an existing local installation between legacy and reusable
identity modes is refused; it cannot silently broaden a prior tile approval.

Unknown payload fields are dropped; no remote JSON field becomes arguments,
environment, a callback, a session ID or an executable. A valid signature
proves delivery origin, not that a Discord author's text is trustworthy.

## Receiver lifecycle

`npm run build` compiles the ESM modules and declarations, then bundles
`src/index.ts` with esbuild into `dist/smuk-receiver.mjs` for Node.js 22.13+.
Versioned releases contain the executable and a package tarball. The SMUK
site serves the executable from its pinned package dependency.
The receiver is licensed under Apache 2.0. The standalone executable embeds
the full LICENSE and NOTICE after its shebang; npm packages include both files.
The browser-safe protocol preserves an Apache attribution comment for bundlers.
There are no receiver npm dependencies, hosted inboxes, API keys, or idle AI
polls. `init` creates a private config and a random per-destination secret.
`serve` binds only 127.0.0.1; the user supplies TLS through their proxy/tunnel.
Only signed POST `/webhook` delivery and POST `/verify` approval challenges are
exposed. Inbox contents and results are available via local `list`, never through
HTTP. Serving alone queues without processing.

### Signed connection verification

`POST /verify` uses the same timestamp/signature headers and exact-byte HMAC as
webhook delivery. Authentication happens before JSON parsing or policy checks.
The request is:

```json
{
  "schemaVersion": 1,
  "type": "smuk.receiver.verify",
  "nonce": "<fresh 64 lowercase hex characters>",
  "nodeId": "actual-tile-or-saved-profile-id",
  "destinationId": "saved-profile-id",
  "provider": "Codex",
  "instructions": "Summarize as JSON.",
  "sourceNodeIds": ["approved-source-tile-id"]
}
```

Omit `destinationId` for a legacy installation. Verification requires the same
identity/provider/exact instruction approval as delivery and between 1 and 100
unique requested source IDs, all locally approved. A saved-agent library check
uses its profile ID as `nodeId`; a tile check can use the actual tile ID. Fields
are bounded and unknown input is discarded. No message is enqueued and no agent
CLI starts. Sender/channel/server message filters still apply to real deliveries;
verification does not prove that arbitrary future messages will pass those filters.

A successful response contains only:

```json
{
  "schemaVersion": 1,
  "type": "smuk.receiver.verified",
  "nonce": "<the request nonce>",
  "approval": "matched",
  "mode": "receiving",
  "receiverVersion": "<installed release version>"
}
```

The response has its own timestamp and HMAC signature over its exact bytes.
The caller must verify that signature, timestamp, response type, and its fresh
nonce before trusting the result. A captured response cannot answer a new
challenge. Reusing a successfully authenticated challenge is rejected with 409
until its complete signature window expires, including requests timestamped in
the future. A bounded 720-entry nonce cache refuses new checks when full rather
than evicting live challenges. `/verify` shares the existing body/socket/time and
60 requests/minute ingress limits with `/webhook`; policy failures return a terse
403 and unavailable mode reads return 503 without private diagnostics.

`receiving` means the running receiver has AI processing disabled. `processing`
means its local processing switch is enabled; `paused` means the local PAUSE file
is present. Those states are observed at check time and can change immediately.
They do **not** prove that a CLI exists, its login works, a provider accepts the
request, or a model has completed a task. The endpoint exposes no configuration,
secrets, jobs, results, or processing controls.

### Quick setup and local approval

`setup <https-origin/#token> --tunnel <absolute-executable-path>` is the quick
setup entry point. The SMUK installer supplies the privately installed tunnel
executable. A one-time 64-character hex token stays in the link fragment and
is sent only as a Bearer authorization header to fixed pairing endpoints on
that HTTPS origin. Redirects are refused; requests time out after ten seconds
and response bodies are capped at 64 KiB. No token or signing secret is printed.

The manifest contains schema version 1, node ID, provider, exact instructions
and source IDs, plus an optional explicitly approved reusable `destinationId`. The receiver validates it, prints those details
with terminal control characters escaped, and requires the local user to type
`approve`. Cancellation or EOF before approval never changes a configuration.
The installation directory is `~/.smuk/receivers/<sha256-of-origin-and-node-id>` with
private permissions. Pairing with a different HTTPS origin creates a separate
installation and never reuses or sends another site's signing key. The approval
summary shows the site origin. A receiver lock covers approval, atomic configuration
replacement and the serving lifetime. Reconnection retains the existing
signing secret, SQLite inbox and sender/channel/server allowlists. Changed
instructions, providers or sources require fresh local approval; dequeued
messages still pass the existing exact-policy check before any agent runs.

The receiver opens an available localhost port and launches the explicitly
provided Cloudflare executable without a shell, with automatic updates off
a separate private HOME, an explicit fresh empty config file, and metrics bound
to an available localhost port. User and system tunnel configurations are not
applied; a private HOME alone would still allow /etc/cloudflared defaults.
It accepts only a generated HTTPS `*.trycloudflare.com` address and waits for
the connection registration event before completing pairing. Tunnel output is
bounded and not echoed. The completion request carries that webhook address
and signing key to SMUK; the user still needs to publish the blueprint.
The tunnel forwards the delivery and signed-verification surface; it cannot access
configuration, controls, inboxes or answers over HTTP.

Quick tunnels are temporary, intended for trying the receiver, and do not
promise uptime. Stopping the terminal stops both receiver and tunnel. A fresh
Connect computer command and Publish reconnect the same tile while retaining
local state. Stable addresses remain available through the manual workflow.

The foreground terminal accepts `process`, `pause`, `results`, and `quit`.
Every setup starts receive-only; only the local `process` command enables AI,
after the existing isolation/platform checks. `pause` stops new starts without
cancelling the current job. `results` shows inert JSON locally. EOF, Ctrl+C,
termination and hangup close the tunnel and receiver, cancel active AI work,
and release the installation lock. If the tunnel exits, receiving stops with
reconnection guidance. The manual `init`, `serve`, `list` and `--process`
interfaces remain available.

SQLite WAL persists queued/running/completed/failed/interrupted records with
private permissions. Pairing with a different HTTPS origin creates a separate
installation and never reuses or sends another site's signing key. The approval
summary shows the site origin. Capacity is 1,000 retained rows, including completed
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

## Testing the setup workflow

`test/setup-e2e.mjs` exercises the actual bundled executable with a local HTTPS
pairing server and a generated test certificate, fake tunnel and agent
executables, real SQLite and signed local deliveries. It covers cancelled
approval, control-character display, private permissions and tunnel HOME,
private HTTP surfaces, signed non-enqueueing checks, receive/process/pause modes,
reusable destination setup and actual tile provenance, retained keys and inboxes, duplicate-instance refusal,
receive-only restarts, changed-policy queue rejection, pairing/tunnel failures,
and signal cleanup. No production HTTP bypass or public tunnel is used.
`src/setup.ts` and `src/terminal.ts` are unit and mutation tested. CLI, session
and tunnel composition are covered by real-process tests rather than mocked
coverage of their I/O.
