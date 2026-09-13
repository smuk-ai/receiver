# Security

Report a suspected vulnerability through [GitHub private security reporting](https://github.com/smuk-ai/receiver/security/advisories/new). Include the receiver version, supported platform, a minimal reproduction and expected impact. Use synthetic messages and secrets; never include your real config, signing secret, agent credentials or inbox.

Only the latest release is maintained. There is no promised response time. Review [the architecture and limitations](docs/architecture.md) before exposing a receiver or enabling AI processing. Use a dedicated computer account or VM and keep your receiver, Node.js and provider CLI current.

Signed messages can still contain hostile text. Local approval and restricted tools reduce exposure; they do not guarantee safe or correct model output.
