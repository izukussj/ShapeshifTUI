# ShapeshifTUI

> Chat-driven terminal UI where the AI ships React/Ink components that run live in a sandbox.

You describe what you want. The AI writes a JSX component. It renders in your terminal. You interact with it. Your actions flow back to the AI. Repeat.

```
┌─ chat ───────────────┐┌─ runtime ──────────────────────┐
│ you  make a todo list││ Todo List (2 remaining)        │
│                      ││                                │
│ ai   Here you go:    ││  [ ] buy milk                  │
│                      ││  [ ] finish the readme         │
│ >                    ││  [x] commit the v2 rewrite     │
│                      ││                                │
│                      ││  > _________ [Add]             │
└──────────────────────┘└────────────────────────────────┘
  Ctrl+A chat   Ctrl+E runtime   Ctrl+C quit
```

## How it works

1. You type a message in the left pane.
2. The backend (Codex CLI by default, plain OpenAI as a fallback) responds with a JSX component inside a `shapeshiftui` fenced code block.
3. `src/sandbox.ts` extracts the block, esbuild transpiles it, and it runs in a Node `vm` context with Ink, React, hooks, and custom widgets injected as globals.
4. The component renders in the right pane.
5. `submitEvent` fires send events back to the AI (loud). `sendEvent` records them locally and sends them as context with your next message (silent).

## Requirements

- Node.js ≥ 20
- Either an authenticated [Codex CLI](https://developers.openai.com/codex) install (recommended) or an OpenAI API key

## Quick start

One command — the TUI spawns the bridge for you.

```bash
# 1. Install & authenticate Codex once
brew install codex && codex login   # or: npm i -g @openai/codex && codex login

# 2. Launch
npx shapeshiftui                    # or: npm i -g shapeshiftui && shapeshiftui
```

First run detects `codex` on `PATH` and auto-spawns `server/codex-bridge.js` on `:8080`. No Codex? Set `OPENAI_API_KEY` (in your env or `.env.local`) and the CLI falls back to the plain OpenAI bridge. To point at a bridge you're running yourself, pass the WebSocket URL — e.g. `shapeshiftui ws://localhost:9000` (auto-spawn is skipped when a URL is given, or with `--no-serve`).

Then type something like `make a counter` or `show me my processes` and watch it render.

### Sandbox tiers

Codex runs in `read-only` mode by default — it can run commands but can't write files. Opt into more:

```bash
shapeshiftui --write                       # edits inside --cwd (workspace-write)
shapeshiftui --sandbox danger-full-access  # no sandboxing (use sparingly)
shapeshiftui --sandbox read-only           # explicit, matches default
```

`--write` is shorthand for `--sandbox workspace-write`. The flag only applies when ShapeshifTUI spawns the bridge itself — when connecting to an external bridge, that bridge's `CODEX_SANDBOX` at startup wins.

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run build` | Bundle the TUI to `dist/` via tsup |
| `npm run dev` | Build in watch mode |
| `npm start` | Launch the TUI (auto-spawns the Codex bridge when none is reachable) |
| `npm run codex-bridge` | Start the Codex CLI bridge manually (see [Codex backend](#codex-backend) below) |
| `npm run bridge` | Start the OpenAI bridge manually on `ws://localhost:8080` |
| `npm run typecheck` | TypeScript check without emit |
| `npm test` | Run the vitest suite |

## Environment variables

Backend-specific. Put them in `.env.local` or prefix the command.

**OpenAI bridge (`server/bridge.js`):**

| Variable | Default | Notes |
|----------|---------|-------|
| `OPENAI_API_KEY` | — | Required |
| `MODEL` | `gpt-5.4` | Any chat-completions model |
| `PORT` | `8080` | WebSocket port |

**Codex bridge (`server/codex-bridge.js`):** see [Codex backend](#codex-backend).

**Client (`src/cli.tsx`):**

| Variable | Default | Notes |
|----------|---------|-------|
| `SHAPESHIFTUI_MOUSE` | on | Mouse tracking is on by default. Set to `0` to disable at launch (also toggleable at runtime with `Ctrl+P`). Hold Option (macOS) or Shift (most terminals) to select text while mouse is on. |

## Architecture

```
 ┌──────────┐    WebSocket    ┌────────────────┐   stdio / HTTPS
 │ TUI Client│ ◄────────────► │ bridge          │ ◄──────────────►  Codex CLI
 │ (Ink/React)│                │ (system prompt │                   or OpenAI
 └──────────┘                 │  + session)    │
                              └────────────────┘
```

Source layout:

```
src/
  cli.tsx            entry point — opens WebSocket, mounts the Ink app
  app.tsx            root component — chat pane + runtime pane, keybindings
  chat.tsx           message history, slash-command menu, input
  runtime.tsx        mounts the compiled sandbox component
  sandbox.ts         esbuild transpile + vm.runInContext
  runtime-globals.ts globals exposed to sandboxed components
  components.tsx     widget library (Button, Checkbox, Select, Table, Progress)
  mouse.ts           SGR mouse parser + hover/click hooks
  client.ts          WebSocket client with exponential-backoff reconnect
  types.ts           wire protocol (ChatMessage, AppError, ServerMessage, …)

server/
  bridge.js          OpenAI chat-completions bridge
  codex-bridge.js    Codex CLI bridge (spawns `codex exec --json`)
  codex/AGENTS.md    system prompt / contract consumed by the Codex bridge

scripts/
  smoke-codex.mjs    end-to-end sanity check against a running bridge
```

## Component contract

The AI is instructed to return a single arrow function:

```jsx
({ sendEvent, submitEvent, context }) => {
  const [count, setCount] = useState(0);
  return (
    <Box>
      <Text>Count: {count}</Text>
      <Button label="+1" onPress={() => {
        setCount(c => c + 1);
        sendEvent('inc', { value: count + 1 });
      }} />
    </Box>
  );
}
```

Available in sandbox scope (no imports needed):

- **React**: `React`, `useState`, `useEffect`, `useRef`, `useMemo`, `useCallback`, `useReducer`
- **Ink**: `Box`, `Text`, `Newline`, `Spacer`, `Static`, `Transform`, `useFocus`, `useFocusManager`, `useInput`
- **Widgets**: `TextInput`, `Button`, `Checkbox`, `Select`, `Table`, `Progress`

Props the component receives:

- `sendEvent(eventType, data?)` — silent, recorded locally, sent as context next turn
- `submitEvent(eventType, data?)` — loud, triggers an immediate AI response
- `context.events` — past interaction records

## Keyboard

| Key | Action |
|-----|--------|
| `Ctrl+A` | Focus chat pane |
| `Ctrl+E` | Focus runtime pane |
| `Tab` | From chat → jump into runtime. Inside runtime, Tab cycles focus through buttons, inputs, and other focusable widgets. Use `Ctrl+A` to return to chat. |
| `Enter` / `Space` | Activate focused button |
| `PgUp` / `PgDn` | Scroll chat history |
| `/` | Open slash-command menu (in chat) — `↑`/`↓` to browse, `Tab`/`Enter` to accept |
| `Esc` | Cancel the in-flight turn or close an open dialog |
| `Ctrl+K` | Toggle the keyboard cheatsheet |
| `Ctrl+P` | Toggle mouse tracking |
| `Ctrl+C` | Quit |

## Codex backend

Use [OpenAI Codex CLI](https://developers.openai.com/codex) as the reasoning engine instead of the bare OpenAI bridge. This unlocks live system/service UIs: Codex runs real shell commands and MCP tools, embeds the results as literals in the JSX component, and wires up buttons to follow-up actions.

### Setup

```bash
# 1. Install Codex CLI
brew install codex   # or: npm install -g @openai/codex

# 2. Authenticate
codex login

# 3. Start the bridge (uses server/codex/AGENTS.md for the system prompt)
npm run codex-bridge

# 4. In another terminal, launch the TUI
npm run build && npm start
```

### What you can ask

- `show me my processes` → sortable `ps` table with kill buttons
- `show me my repos in ~/Projects` → repo list with git status, open button per row
- `what's eating my disk` → `du` tree drill-down
- `show my unread emails` *(requires Gmail MCP — see below)*
- `what's the git diff on the current branch` → diff viewer

Every data view has a **Refresh** button that re-runs the underlying tools.

### Environment

| Variable | Default | What it controls |
|----------|---------|------------------|
| `CODEX_BRIDGE_PORT` | `8080` | WebSocket port |
| `CODEX_BIN` | `codex` | Codex CLI binary path |
| `CODEX_MODEL` | (codex default) | Override the reasoning model — e.g. `gpt-5.4-mini`. Passed to `codex exec -m <model>`. Must be a model your Codex account is allowed to use |
| `CODEX_SANDBOX` | `workspace-write` | Sandbox mode — one of `read-only`, `workspace-write`, `danger-full-access` |

### MCP servers (recommended)

The real power comes from Codex's MCP ecosystem. Add entries to `~/.codex/config.toml`:

- **Gmail MCP** — inbox, compose, archive
- **GitHub MCP** — PR review, issue browsing
- **Filesystem MCP** — safe file operations outside the workspace
- **Postgres / SQLite MCP** — query UIs

Once configured, Codex picks them up automatically — no changes to ShapeshifTUI needed.

## Roadmap

Next up: an OpenClaw Channel plugin — persistent memory and a multi-channel surface so the same chat/component protocol can drive panes beyond the terminal.

## License

MIT
