---
title: Antigravity
sidebar_position: 13.5
---

Timon can run agents on **Google Antigravity**, through its command-line tool `agy`. It drives `agy acp` over the Agent Client Protocol; `agy` keeps its own Google sign-in, and Timon never sees or stores it.

## What you need

A **personal Google account** signed in to `agy`: the free plan works, and a Google AI Pro or Ultra plan raises its limits. Timon runs Antigravity on that sign-in only. A Gemini API key, Gemini Enterprise Agent Platform credentials and a Gemini Enterprise sign-in are not supported: the first two are billed by the token, and Timon runs AI tools on their subscriptions.

## Set it up

1. Install `agy` with Google's installer, or click **Install** on the **Antigravity** card in **Settings → AI models → Providers**, which runs the same command:

   ```bash
   # macOS and Linux
   curl -fsSL https://antigravity.google/cli/install.sh | bash
   ```

   ```powershell
   # Windows (PowerShell)
   irm https://antigravity.google/cli/install.ps1 | iex
   ```

2. Sign in, in a terminal, under the OS account that runs Timon:

   ```bash
   agy acp --login
   ```

   It prints a Google sign-in link: open it, choose your personal account, then paste the code the page gives you back into the terminal. Running `agy` once and following its first-run screens signs you in too.

3. Restart Timon. **Antigravity (Google)** then appears among the LLM backends.

Timon looks for `agy` on the service's PATH, in `~/.local/bin` on Linux and macOS, and in `%LOCALAPPDATA%\agy\bin` on Windows, which is where Google's installers put it.

If Antigravity does not appear, run `timon doctor`: it tells you whether the `agy` command was found. A command installed somewhere else may be missing from the service's PATH; set `host.binaries.agy` to its absolute path in that case. If a mission stops with "sign in first", run `agy acp --login` in a terminal on the machine that runs Timon, then retry.

Antigravity is also listed in the [ACP registry](../plugins/providers.md#agents-from-the-acp-registry), as **Google Antigravity**. That one is a separate download with a sign-in of its own; the backend on this page uses the `agy` you installed and its sign-in.

## Models

Timon does not pick a model for Antigravity: the default is `agy`'s own. The model picker lists what your plan offers (Gemini Flash at three thinking levels, and Claude and GPT-OSS models on the tested account). The list is asked from `agy` and refreshed at most every 12 hours; asking starts `agy` briefly, which leaves one empty conversation in its own history. A Gemini model also offers a **Thinking level**.

## Quota

The LLM quotas widget and the strip under the chat composer show Antigravity's quota: one gauge per model group of your plan (for example **Gemini Models** and **Claude and GPT models**), each with the share of its weekly limit already used and when it resets. The models of a group share one weekly limit.

To read it, Timon starts `agy` for about a second, asks it for the figures, then stops it. `agy` fetches them with its own sign-in: Timon reads no token and contacts no Google server itself. Reading the quota uses none of it and leaves no conversation in `agy`'s history. A reading is reused for 5 minutes; the widget's ↻ button asks again.

- **Not signed in**: `agy` has no sign-in Timon can use. Run `agy acp --login` under the OS account that runs Timon. `agy` keeps its sign-in in the system keychain, which Timon cannot reach when it runs outside your desktop session (started over SSH, as a Windows service or as a macOS launch daemon): the gauge then says Antigravity is not signed in, even though `agy` works in your terminal.
- **Unknown**: `agy` did not answer in time, or answered in a way Timon does not recognise. Timon shows no figure rather than a zero. An `agy` too old to report its quota asks you to update it.
- **Server left running**: `agy` exited and left its local server running, and Timon could not stop it. That server answers any program on your machine without a password, so Timon stops reading the quota on its own: end the remaining `agy` process (Task Manager, Activity Monitor or `kill`), then press ↻.

## What agents can do

Antigravity **asks before it edits a file, runs a command or uses an MCP tool**. The request appears as an **Allow / Deny** card: **Allow** lets that one action through, **Deny** refuses it and Antigravity carries on without it. On an autonomous mission with nobody to answer, a card left open ends in a refusal after the usual delay. Rules you set in `agy` itself (commands it may always run) still apply, and what they allow does not reach a card.

Replies stream into the chat and tool calls appear with their results. **Stop** in a chat ends the current turn and keeps the conversation. After a restart, the mission reopens its Antigravity conversation without replaying the old messages. Timon's own tools (Kanban, questions, missions, memory) and the stdio MCP servers configured for the agent reach Antigravity.

## Limitations

- **The permission mode does not switch Antigravity's modes.** Whatever the agent's permission mode, `agy` runs in its default mode, which asks; Timon's cards and classifier decide each request.
- **HTTP MCP servers are not passed on.** MCP servers you added over HTTP do not reach Antigravity agents.
- **The quota gauge relies on an internal interface of `agy`.** It was checked with `agy` 1.5.9; a later version may change it, and the gauge then shows the quota as unknown until Timon follows.
- **Checked on Linux only.** Google's installers cover macOS and Windows, but Timon was not tried there yet. Report what you see.
