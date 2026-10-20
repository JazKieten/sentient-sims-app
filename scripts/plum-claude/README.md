# Plum's brain through Claude Code (dev only)

Plum's thinking can come from a Claude Code session you run on your own Claude plan,
instead of API calls on an Anthropic key. Everything else stays the same: the tab, the
tools, the guard rails, the director, the triggers and the whispers. Settings >
"Plum's brain" switches back to the API instantly, and nothing is lost.

This only exists in the dev tier (the app run from source); player builds strip it.
Use it for **attended sessions only**. Overnight and unattended directing stay on the API.

The app never touches a credential. It only exchanges messages with a `claude` process that
you start and sign in to.

## Set up (once)

1. Install the Claude Code CLI with the native installer and sign in with your Claude
   account (`claude`, then `/login`). The launcher also finds the binary bundled with the
   VS Code extension, or you can pass `--claude <path>`.
2. Start the companion app from source (`npm run start`). On start it writes a token to
   `<its data folder>/plum-claude/token`. For the app run from source on Windows, that folder
   is `%APPDATA%\Electron`.
3. In Settings, set **Plum's brain** to **Claude Code (dev)**.

## Every session

```
npm run plum:claude                       # Opus, effort medium
npm run plum:claude -- --model sonnet     # stretches the plan further
npm run plum:claude -- --continue         # pick the last session back up
```

The first time, accept the prompts: trust the folder, and load the development channel.

**Don't leave a menu open in it.** While `/usage`, `/mcp` or any other panel is open, or
text sits typed in its prompt, Claude Code queues Plum's turns instead of running them. After
20 s the tab says "Claude Code hasn't picked up the turn". Press Esc and the turn runs.

**Keep this terminal off the stream capture.** It shows Plum's raw messages, the `<live>`
block and the notes.

Check `/usage` before going live and once mid-stream. Max plan limits are not published:
there is a rolling window plus a weekly cap, and Opus uses them faster.

## What the launcher sets up

- `--strict-mcp-config --mcp-config plum-mcp.json` loads the `plum` channel (`server.mjs`) and
  no other MCP server. `disableClaudeAiConnectors` and `ENABLE_CLAUDEAI_MCP_SERVERS=false`
  keep your claude.ai connectors (Gmail, Drive...) out.
- `--tools ""` removes the built-in tools: no files, no shell, no web.
- `--allowedTools mcp__plum__*` lets the Plum tools run without a prompt. The app still
  applies every guard: the writes switch, ask-answer-act for destructive tools, and the
  director's one beat per tick.
- `--setting-sources project` runs in an empty folder of its own (`<data>/plum-claude/session`),
  so none of your user settings, hooks or plugins load.
- `--append-system-prompt-file persona.md` adds Plum's system prompt plus the wiring rules
  (served by the app at `GET /plum/cc/persona`).
- Hooks (`hook.mjs`) post SessionStart, UserPromptSubmit, Stop, StopFailure, PreCompact and
  PostCompact to the app, which uses them to bind each turn and end it.
- `ANTHROPIC_API_KEY` is removed from the environment, so the session runs on your plan.
- `MCP_PROTOCOL_NEGOTIATION=legacy` works around Claude Code not registering a channel that
  negotiates MCP revision 2026-07-28.

## How a turn runs

1. The app sends the turn over SSE. `server.mjs` turns it into a channel event:
   `[plum turn <id> kind=chat|director|wake]`, then the `<live>` block, then the seed (first
   turn of a conversation only), then the message.
2. The UserPromptSubmit hook carries that marker. Its `prompt_id` binds the turn.
3. Plum's tool calls go to `/plum/cc/tool` and become the tab's tool rows.
   `mcp__plum__reply {turn, text}` is the only thing the player sees.
4. A Stop with the same `prompt_id` ends the turn. A Stop for any other prompt is ignored.
5. If nothing acks the turn in 20 s, the tab says Claude Code hasn't picked it up, usually
   because a menu is open in its terminal; the turn still runs once it's closed. After 3 minutes
   it is given up (and the tab suggests a restart, in case the channel is missing). After 5 minutes
   with no activity the turn is given up: its writes are refused and its late Stop absorbed.
6. A StopFailure for a rate limit or billing error shows "Claude plan limit reached; switch
   Plum's brain to API in Settings" and holds the brain for 10 minutes.

You can type in the terminal too, but those lines are not mirrored into the tab, and their
tool calls never run a destructive tool.

"New conversation" in the tab starts a new rows thread. Run `/clear` in the terminal too.

Switching Plum's brain (to API and back) is safe mid-session: the next Claude Code turn
carries the seed again, so it knows what the API brain said in between. The same happens
when the app restarts under a running session; the channel reconnects by itself.

## Step 0 probe (2026-10-19)

`probe/` holds the stub that settled the open questions: `probe-launch.mjs`, plus
`--print "<prompt>"` for a non-interactive run.

Found with `-p` on Claude Code 2.1.301:

- The `--strict-mcp-config --mcp-config` + `--setting-sources project` + `--settings` layout
  loads the server.
- With `--tools ""` + `alwaysLoad`, the request carried only the two `mcp__plum__*` tools (plus
  an inert deferred placeholder and the server-side advisor): no built-ins, no connectors.
  `--allowedTools mcp__plum__*` ran a tool with no prompt.
- `--append-system-prompt-file` works.
- `prompt_id` rides UserPromptSubmit, PreToolUse and Stop.
- The session context still carries the account's email address; Plum has no reason to say it.

Found interactively (same layout, Max account):

- `/status` says "Channels: Listening for messages from server:plum", "Login method: Claude
  Max account" and "Setting sources: Command line arguments".
- `/mcp` lists exactly one server: `plum`, with 2 tools.
- A channel event fires UserPromptSubmit. Its `prompt` is the wrapped event,
  `<channel source="plum" turn="p1" kind="chat">\n[plum turn p1 kind=chat]\n...</channel>`, and
  its `prompt_id` is the same on the PreToolUse hooks and the Stop that follow. So turns bind
  by marker plus `prompt_id`. The fallback (first tool call or reply acks a turn) stays in the
  code but is not needed.
- The tools ran with no permission prompt.
