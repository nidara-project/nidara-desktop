# Security Policy

Nidara is a Wayland desktop environment: it runs as your graphical session and,
when you enable it, exposes an AI agent that can perceive and control the desktop
(computer-use) plus an MCP server. We take security reports seriously and
appreciate coordinated, private disclosure.

## Supported versions

Nidara is pre-1.0 and ships from a rolling `main`. Security fixes land on `main`
and in the most recent `v0.x` release; older versions do not receive backports.
Please update (`nidara-update`) before reporting, to confirm the issue still
reproduces on the latest code.

| Version           | Supported |
| ----------------- | --------- |
| Latest `main`     | ✅        |
| Latest `v0.x` tag | ✅        |
| Older `v0.x` tags | ❌        |

## Reporting a vulnerability

**Please do not open a public issue for security problems.** Use GitHub's
private vulnerability reporting instead:

1. Go to the [**Security**](https://github.com/nidara-project/nidara-desktop/security) tab.
2. Click **Report a vulnerability**.
3. Describe the issue, its impact, and steps to reproduce.

This opens a private channel visible only to the maintainers. If you cannot use
GitHub's reporting, open a public issue **without technical detail** asking a
maintainer to get in touch, and we'll establish a private channel from there.

Where possible, please include:

- Nidara version / commit (`git rev-parse HEAD`, or your `nidara-update` output).
- Your environment (distro, GPU, Hyprland version).
- Steps to reproduce and the impact you believe it has.
- Whether the AI agent surface (computer-use, MCP server) is involved.

## What to expect

Nidara is maintained by a small team on a best-effort basis — we can't promise
enterprise SLAs, but we aim to:

- Acknowledge your report within a few days.
- Keep you updated as we investigate and fix.
- Credit you in the release notes when a fix ships, unless you prefer to stay anonymous.

We ask that you give us reasonable time to release a fix before any public
disclosure. Thank you for helping keep Nidara users safe.

## Scope notes

Nidara's most security-relevant surface is the **AI agent**. Computer-use and the
MCP server are **off by default** and gated behind explicit consent in
Settings → AI. Reports are especially valuable when they concern:

- the agent acting without its corresponding consent gate,
- the installer (`install.sh`) or the update mechanism (`nidara-update`),
- the lockscreen / greeter authentication path.
