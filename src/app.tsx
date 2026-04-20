import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { Chat } from './chat.js';
import { Runtime } from './runtime.js';
import { Client } from './client.js';
import { Button, FocusActiveContext } from './components.js';
import { extractCodeBlock, type SendEvent, type SubmitEvent, type InteractionContext } from './sandbox.js';
import { McpPanel, type McpPanelMode } from './mcp.js';
import { PluginGuidePanel } from './plugin-guide.js';
import type { AppError, ApprovalRequest, ChatMessage, InteractionRecord, McpAddPayload, McpOpResult, McpServer, ServerMessage } from './types.js';
import { onMouse, setMouseEnabled, isMouseEnabled } from './mouse.js';

const HISTORY_LIMIT = 50;
const MAX_RETRIES = 2;

type Pane = 'chat' | 'runtime';
type ConnectionState = 'connected' | 'reconnecting' | 'lost';
type McpAdminView = { mode: McpPanelMode; name?: string };
type AdminView = McpAdminView | { mode: 'plugin' };

interface AppProps {
  client: Client;
}

export function App({ client }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [interactions, setInteractions] = useState<InteractionRecord[]>([]);
  const [activePane, setActivePane] = useState<Pane>('chat');
  const [status, setStatus] = useState<string | null>(null);
  const [mouseOn, setMouseOn] = useState<boolean>(isMouseEnabled());
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  // scrollOffset = how many newest messages to hide. 0 means pinned to latest.
  const [scrollOffset, setScrollOffset] = useState(0);
  // Vertical offset into the runtime pane. 0 means the generated layout starts
  // at the top of its viewport.
  const [runtimeScrollOffset, setRuntimeScrollOffset] = useState(0);
  // Derived from AppError codes from the network layer. Drives the StatusLine
  // dot for conditions that persist longer than a single chat entry.
  const [connectionState, setConnectionState] = useState<ConnectionState>('connected');
  const [helpOpen, setHelpOpen] = useState(false);
  // Native admin overlay that takes over the runtime pane (replaces sandbox
  // source while open). Cleared via the panel's Close button.
  const [adminView, setAdminView] = useState<AdminView | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServer[] | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpLastOp, setMcpLastOp] = useState<McpOpResult | null>(null);
  // Some terminals update process.stdout.columns/rows on SIGWINCH but Ink may
  // not repaint until the next input event. This no-op state bump makes resize
  // responsiveness immediate for the shell and generated runtime components.
  const [, forceResizeRender] = useState(0);
  const retryCount = useRef(0);
  // Chat toggles this when its slash-suggestion menu is open so the app-level
  // Tab handler yields to the chat's Tab-accept behavior.
  const chatCapturesTab = useRef(false);

  const respondToApproval = useCallback(
    (id: string, approved: boolean) => {
      client.send({ type: 'approval_response', id, approved });
      setApprovals((prev) => prev.filter((a) => a.id !== id));
    },
    [client],
  );

  const scrollChat = useCallback((delta: number) => {
    setScrollOffset((offset) => Math.max(0, offset + delta));
  }, []);

  const scrollRuntime = useCallback((delta: number) => {
    setRuntimeScrollOffset((offset) => Math.max(0, offset + delta));
  }, []);

  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') exit();
    if (key.ctrl && _input === 'a') setActivePane('chat');
    if (key.ctrl && _input === 'e') setActivePane('runtime');
    if (key.ctrl && _input === 'k') setHelpOpen((v) => !v);
    if (key.ctrl && _input === 'p') {
      const next = setMouseEnabled(!mouseOn);
      setMouseOn(next);
      // State shows in the bottom hint — no status spinner for a mode toggle.
    }

    // Esc: cancel in priority order — help → pending approval → active turn.
    const pending = approvals[0];
    if (key.escape) {
      if (helpOpen) {
        setHelpOpen(false);
      } else if (pending) {
        respondToApproval(pending.id, false);
      } else if (status) {
        client.send({ type: 'cancel' });
      }
      return;
    }

    // Scroll whichever pane owns focus. Chat's offset is "newest messages
    // hidden" (PgUp increases it); runtime's offset is "lines from top"
    // (PgDn increases it).
    if (!pending && !helpOpen && (key.pageUp || key.pageDown)) {
      if (activePane === 'chat') {
        scrollChat(key.pageUp ? 3 : -3);
      } else {
        scrollRuntime(key.pageUp ? -3 : 3);
      }
      return;
    }

    // Tab from chat → hop into runtime. Once inside runtime, Tab is NOT
    // intercepted here — Ink's default focus manager cycles through the
    // sandboxed useFocus hooks. Ctrl+A returns to chat. Yields to chat's
    // slash menu, approvals, and help.
    if (key.tab && !key.shift && !pending && !helpOpen && !chatCapturesTab.current && activePane === 'chat') {
      setActivePane('runtime');
      return;
    }
  });

  useEffect(() => {
    return onMouse((e) => {
      const narrowMode = stdout.columns < 80;
      const chatW = narrowMode ? stdout.columns : Math.min(60, Math.floor(stdout.columns * 0.4));
      const overPane: Pane = narrowMode ? activePane : e.x < chatW ? 'chat' : 'runtime';

      if (e.type === 'wheel') {
        if (helpOpen || approvals.length > 0) return;
        if (e.direction !== 'up' && e.direction !== 'down') return;
        if (overPane === 'chat') {
          scrollChat(e.direction === 'up' ? 3 : -3);
        } else {
          scrollRuntime(e.direction === 'up' ? -3 : 3);
        }
        return;
      }

      if (e.type !== 'press') return;
      // In narrow/stacked mode only one pane is visible; clicks don't move focus.
      if (narrowMode) return;
      setActivePane(overPane);
    });
  }, [activePane, approvals.length, helpOpen, scrollChat, scrollRuntime, stdout.columns]);

  useEffect(() => {
    const out = process.stdout;
    if (!out.isTTY) return;
    const onResize = () => forceResizeRender((n) => n + 1);
    out.on('resize', onResize);
    return () => {
      out.off('resize', onResize);
    };
  }, []);

  // Single canonical error sink. Writes a severity-tagged chat entry, clears
  // the status spinner, bumps scroll (so pinned-to-latest users keep seeing
  // the newest line), derives persistent connection state from network codes,
  // and emits a structured stderr log that never appears in the UI.
  const reportError = useCallback((err: AppError) => {
    setStatus(null);
    setMessages((prev) => [
      ...prev,
      {
        id: `err-${Date.now()}`,
        sender: 'system',
        content: err.message,
        timestamp: Date.now(),
        severity: err.severity,
      },
    ]);
    setScrollOffset((o) => (o > 0 ? o + 1 : 0));

    if (err.source === 'network') {
      if (err.code === 'ws_disconnected') setConnectionState('reconnecting');
      else if (err.code === 'ws_lost') setConnectionState('lost');
    }

    console.error('[shapeshiftui]', err);
  }, []);

  useEffect(() => {
    const handler = (msg: ServerMessage) => {
      if (msg.type === 'message') {
        setMessages((prev) => [...prev, msg.message]);
        setScrollOffset((o) => (o > 0 ? o + 1 : 0));
        const code = extractCodeBlock(msg.message.content);
        if (code) {
          setSource(code);
          setRuntimeScrollOffset(0);
          retryCount.current = 0;
        }
        // Any inbound message proves the socket is alive — clear a transient
        // 'reconnecting' state. Leave 'lost' alone: that's terminal and
        // shouldn't be silently reset by a stray late-arriving frame.
        setConnectionState((s) => (s === 'reconnecting' ? 'connected' : s));
      } else if (msg.type === 'error') {
        if (msg.error.code.startsWith('mcp_')) setMcpLoading(false);
        reportError(msg.error);
      } else if (msg.type === 'status') {
        setStatus(msg.text);
      } else if (msg.type === 'restore') {
        setMessages([
          ...msg.messages,
          { id: `sys-${Date.now()}`, sender: 'system', content: `loaded "${msg.name}"`, timestamp: Date.now() },
        ]);
        setInteractions([]);
        setScrollOffset(0);
        retryCount.current = 0;
        // Scan backward for the most recent AI message that actually carries a
        // layout — a trailing plain-text turn would otherwise blank the canvas.
        let code: string | null = null;
        for (let i = msg.messages.length - 1; i >= 0; i--) {
          const m = msg.messages[i];
          if (m?.sender !== 'ai') continue;
          const block = extractCodeBlock(m.content);
          if (block) { code = block; break; }
        }
        setSource(code);
        setRuntimeScrollOffset(0);
      } else if (msg.type === 'approval_request') {
        setApprovals((prev) => [...prev, msg.request]);
      } else if (msg.type === 'mcp_list_result') {
        setMcpServers(msg.servers);
        setMcpLoading(false);
      } else if (msg.type === 'mcp_op_result') {
        setMcpLastOp(msg.result);
        setMcpLoading(false);
        // Any mutation invalidates the list we're showing — refetch.
        if (msg.result.ok) {
          setMcpLoading(true);
          client.send({ type: 'mcp-list' });
        }
      }
    };
    const remove = client.onMessage(handler);
    return remove;
  }, [client, reportError]);

  // Called by Runtime when compilation fails — auto-retries with the backend.
  const onCompileError = useCallback(
    (err: AppError) => {
      if (retryCount.current >= MAX_RETRIES) return;
      retryCount.current++;
      reportError({
        ...err,
        message: `Compile error (retry ${retryCount.current}/${MAX_RETRIES}): ${err.message}`,
      });
      client.send({
        type: 'chat',
        content: `Compile error: ${err.message}\nPlease fix the component.`,
        interactions: [],
      });
    },
    [client, reportError],
  );

  const pushSystem = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      { id: `sys-${Date.now()}`, sender: 'system', content, timestamp: Date.now() },
    ]);
  }, []);

  const openMcp = useCallback((mode: McpPanelMode, name?: string) => {
    setAdminView({ mode, name });
    setActivePane('runtime');
    setRuntimeScrollOffset(0);
    setMcpLastOp(null);
    if (mode === 'list') {
      setMcpLoading(true);
      client.send({ type: 'mcp-list' });
    } else {
      setMcpLoading(false);
    }
  }, [client]);

  const onSend = useCallback(
    (content: string) => {
      const trimmed = content.trim();
      if (trimmed.startsWith('/')) {
        const [cmd, ...rest] = trimmed.split(/\s+/);
        const arg = rest.join(' ').trim();
        if (cmd === '/save') {
          if (!arg) return pushSystem('usage: /save <name>');
          client.send({ type: 'save', name: arg });
          return;
        }
        if (cmd === '/load') {
          if (!arg) return pushSystem('usage: /load <name>');
          client.send({ type: 'load', name: arg });
          return;
        }
        if (cmd === '/views' || cmd === '/list') {
          client.send({ type: 'list-views' });
          return;
        }
        if (cmd === '/delete' || cmd === '/rm') {
          if (!arg) return pushSystem('usage: /delete <name>');
          client.send({ type: 'delete-view', name: arg });
          return;
        }
        if (cmd === '/mcp') {
          const [subcommand = 'list', ...subArgs] = arg.split(/\s+/).filter(Boolean);
          const name = subArgs.join(' ').trim();
          if (subcommand === 'list') {
            openMcp('list');
            return pushSystem('opened MCP server list');
          }
          if (subcommand === 'add') {
            openMcp('add', name);
            return pushSystem(name ? `opened MCP add form for "${name}"` : 'opened MCP add form');
          }
          if (subcommand === 'remove' || subcommand === 'rm') {
            if (!name) return pushSystem('usage: /mcp remove <name>');
            openMcp('remove', name);
            return pushSystem(`confirm MCP removal for "${name}"`);
          }
          return pushSystem('usage: /mcp list | /mcp add <name> | /mcp remove <name>');
        }
        if (cmd === '/plugin' || cmd === '/plugins') {
          setAdminView({ mode: 'plugin' });
          setActivePane('runtime');
          setRuntimeScrollOffset(0);
          return pushSystem('opened plugin setup guide');
        }
        if (cmd === '/help') {
          return pushSystem(
            'commands:\n' +
              '  /save <name>    save the current view\n' +
              '  /load <name>    restore a saved view\n' +
              '  /views          list saved views\n' +
              '  /mcp list       list Codex MCP servers\n' +
              '  /mcp add <name> open native add form\n' +
              '  /mcp remove <name> confirm removal\n' +
              '  /plugin         show Codex plugin setup guide\n' +
              '  /delete <name>  remove a saved view\n' +
              'tip: start typing "/" — Tab completes.',
          );
        }
        return pushSystem(`unknown command: ${cmd} — try /help`);
      }

      const userMsg: ChatMessage = {
        id: `u-${Date.now()}`,
        sender: 'user',
        content,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setScrollOffset(0);
      setStatus(null);
      client.send({ type: 'chat', content, interactions });
    },
    [client, interactions, openMcp, pushSystem],
  );

  const refreshMcp = useCallback(() => {
    setMcpLoading(true);
    client.send({ type: 'mcp-list' });
  }, [client]);

  const addMcp = useCallback((payload: McpAddPayload) => {
    setMcpLastOp(null);
    setMcpLoading(true);
    client.send({ type: 'mcp-add', payload });
  }, [client]);

  const removeMcp = useCallback((name: string) => {
    setMcpLastOp(null);
    setMcpLoading(true);
    client.send({ type: 'mcp-remove', name });
  }, [client]);

  const closeAdminView = useCallback(() => {
    setAdminView(null);
    setRuntimeScrollOffset(0);
  }, []);

  const recordEvent = useCallback((eventType: string, data: unknown) => {
    setInteractions((prev) => {
      const next = [...prev, { eventType, data, timestamp: Date.now() }];
      return next.length > HISTORY_LIMIT ? next.slice(-HISTORY_LIMIT) : next;
    });
  }, []);

  const sendEvent: SendEvent = useCallback((eventType, data) => {
    recordEvent(eventType, data);
  }, [recordEvent]);

  const submitEvent: SubmitEvent = useCallback((eventType, data) => {
    recordEvent(eventType, data);
    client.send({ type: 'event', eventType, data });
  }, [client, recordEvent]);

  const context: InteractionContext = { events: interactions };

  const pendingApproval = approvals[0] ?? null;

  // Below this width, a 40/60 split crushes both panes — show only the active
  // one full-width. Above it, cap chat so it doesn't stretch absurdly wide.
  const NARROW_THRESHOLD = 80;
  const MAX_CHAT_WIDTH = 60;
  const narrow = stdout.columns < NARROW_THRESHOLD;
  const chatWidth = narrow
    ? stdout.columns
    : Math.min(MAX_CHAT_WIDTH, Math.floor(stdout.columns * 0.4));
  // Pin the runtime pane to the remainder so wide sandbox content can't
  // push the chat pane around — layout shifts are the worst thing.
  const runtimeWidth = narrow ? stdout.columns : Math.max(20, stdout.columns - chatWidth);
  const showChat = !narrow || activePane === 'chat';
  const showRuntime = !narrow || activePane === 'runtime';

  // Rough accounting of the app chrome outside the panes so Chat doesn't
  // over-reserve and overflow its allocation (which would scroll the header
  // off the top of the terminal). StatusLine always renders minHeight=1 —
  // do NOT gate it on `status`, or the frame shifts by a row when a turn
  // starts.
  const chromeRows =
    1 /* header */ +
    1 /* status line (always min 1 row) */ +
    1 /* bottom hint */ +
    (pendingApproval ? 6 : 0) +
    (helpOpen ? 10 : 0);
  const availableRows = Math.max(5, stdout.rows - chromeRows);

  return (
    <Box flexDirection="column" width={stdout.columns} height={stdout.rows}>
      <Header connectionState={connectionState} />
      <Box flexDirection="row" flexGrow={1}>
        {showChat ? (
          <FocusActiveContext.Provider value={activePane === 'chat' && !pendingApproval}>
            <Chat
              messages={messages}
              onSend={onSend}
              focused={activePane === 'chat' && !pendingApproval}
              scrollOffset={scrollOffset}
              onScrollOffsetChange={setScrollOffset}
              width={chatWidth}
              availableRows={availableRows}
              captureTabRef={chatCapturesTab}
            />
          </FocusActiveContext.Provider>
        ) : null}
        {showRuntime ? (
          <FocusActiveContext.Provider value={activePane === 'runtime' && !pendingApproval}>
            <Box width={runtimeWidth} flexDirection="column" flexShrink={0}>
              {adminView?.mode === 'plugin' ? (
                <PluginGuidePanel
                  focused={activePane === 'runtime' && !pendingApproval}
                  onClose={closeAdminView}
                />
              ) : adminView ? (
                <McpPanel
                  key={`${adminView.mode}:${adminView.name ?? ''}`}
                  servers={mcpServers}
                  lastOp={mcpLastOp}
                  loading={mcpLoading}
                  initialMode={adminView.mode}
                  initialName={adminView.name}
                  onRefresh={refreshMcp}
                  onAdd={addMcp}
                  onRemove={removeMcp}
                  onClose={closeAdminView}
                  focused={activePane === 'runtime' && !pendingApproval}
                />
              ) : (
                <Runtime
                  source={source}
                  sendEvent={sendEvent}
                  submitEvent={submitEvent}
                  context={context}
                  focused={activePane === 'runtime' && !pendingApproval}
                  scrollOffset={runtimeScrollOffset}
                  availableRows={availableRows}
                  onCompileError={onCompileError}
                />
              )}
            </Box>
          </FocusActiveContext.Provider>
        ) : null}
      </Box>
      {helpOpen ? <CheatsheetModal mouseOn={mouseOn} /> : null}
      {pendingApproval ? (
        <ApprovalBanner
          request={pendingApproval}
          queued={approvals.length - 1}
          onApprove={() => respondToApproval(pendingApproval.id, true)}
          onDeny={() => respondToApproval(pendingApproval.id, false)}
        />
      ) : null}
      <StatusLine status={status} />
      <Box paddingX={1}>
        <Text dimColor>
          {pendingApproval
            ? 'Enter: approve  ·  Tab then Enter: deny  ·  Esc: cancel'
            : helpOpen
              ? 'Esc: close help  ·  Ctrl+K: toggle'
              : status
                ? `Esc: cancel turn  ·  PgUp/PgDn: scroll  ·  mouse ${mouseOn ? 'on' : 'off'}  ·  Ctrl+C: quit`
                : `Ctrl+A/E: panes  ·  PgUp/PgDn: scroll  ·  mouse ${mouseOn ? 'on' : 'off'} (Ctrl+P)  ·  Ctrl+C: quit`}
        </Text>
      </Box>
    </Box>
  );
}

interface HeaderProps {
  connectionState: ConnectionState;
}

// Thin top bar. Anchors the app identity and hosts the persistent connection
// dot so the bottom row can stay quiet when nothing is happening.
function Header({ connectionState }: HeaderProps): React.ReactElement {
  const dot =
    connectionState === 'reconnecting' ? { color: 'yellow', label: 'reconnecting' } :
    connectionState === 'lost' ? { color: 'red', label: 'connection lost' } :
    null;

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box>
        <Text color="cyan" bold>◆ </Text>
        <Text bold>ShapeshifTUI</Text>
      </Box>
      {dot ? (
        <Box>
          <Text color={dot.color} bold>● </Text>
          <Text color={dot.color}>{dot.label}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Rotating braille frame. Self-contained so the interval starts/stops with
// the component lifecycle — stops redrawing the moment StatusLine hides it.
function Spinner(): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((n) => (n + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return <Text color="cyan">{SPINNER_FRAMES[frame]}</Text>;
}

interface StatusLineProps {
  status: string | null;
}

// Transient turn activity only. Persistent connection state lives in the
// Header, so this row is free to stay empty when nothing is happening.
function StatusLine({ status }: StatusLineProps): React.ReactElement {
  if (!status) return <Box minHeight={1} />;
  return (
    <Box paddingX={1}>
      <Spinner />
      <Text> </Text>
      <Text dimColor italic>{status}</Text>
    </Box>
  );
}

interface CheatsheetRow {
  keys: string;
  label: string;
}

interface CheatsheetGroup {
  title: string;
  rows: CheatsheetRow[];
}

// Ctrl+K-toggled panel. Sits above the status line so the main panes stay
// legible underneath — closes with Esc or Ctrl+K. Content is authored here
// rather than generated, because the bindings live across app.tsx and chat.tsx
// and a stale cheatsheet is worse than a short one.
function CheatsheetModal({ mouseOn }: { mouseOn: boolean }): React.ReactElement {
  const groups: CheatsheetGroup[] = [
    {
      title: 'Panes',
      rows: [
        { keys: 'Ctrl+A', label: 'focus chat' },
        { keys: 'Ctrl+E', label: 'focus component' },
        { keys: 'Tab', label: 'chat → runtime, then cycles focus inside' },
        { keys: 'PgUp / PgDn', label: 'scroll active pane' },
        { keys: 'Wheel', label: 'scroll pane under cursor' },
      ],
    },
    {
      title: 'Chat input',
      rows: [
        { keys: '/', label: 'open command menu' },
        { keys: '↑ / ↓', label: 'navigate slash suggestions' },
        { keys: 'Tab / Enter', label: 'accept selected suggestion' },
      ],
    },
    {
      title: 'App',
      rows: [
        { keys: 'Ctrl+K', label: 'toggle this help' },
        { keys: 'Ctrl+P', label: `toggle mouse (${mouseOn ? 'on' : 'off'})` },
        { keys: 'Esc', label: 'cancel turn / close dialog' },
        { keys: 'Ctrl+C', label: 'quit' },
      ],
    },
  ];

  return (
    <Box borderStyle="double" borderColor="cyan" paddingX={1} flexDirection="column">
      <Box>
        <Text bold color="cyan">? Keybindings</Text>
        <Text dimColor>  ·  Esc or Ctrl+K to close</Text>
      </Box>
      <Box flexDirection="row" marginTop={1}>
        {groups.map((g, i) => (
          <Box key={g.title} flexDirection="column" marginRight={i < groups.length - 1 ? 3 : 0}>
            <Text bold>{g.title}</Text>
            {g.rows.map((r) => (
              <Box key={r.keys}>
                <Box width={14}>
                  <Text color="green">{r.keys}</Text>
                </Box>
                <Text dimColor>{r.label}</Text>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

interface ApprovalBannerProps {
  request: ApprovalRequest;
  queued: number;
  onApprove: () => void;
  onDeny: () => void;
}

function ApprovalBanner({ request, queued, onApprove, onDeny }: ApprovalBannerProps): React.ReactElement {
  return (
    <Box
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      flexDirection="column"
    >
      <Box>
        <Text bold color="yellow">Approval required</Text>
        {queued > 0 ? <Text dimColor> ({queued} more queued)</Text> : null}
      </Box>
      <Box marginY={0}>
        <Text>{request.summary}</Text>
      </Box>
      <Box marginTop={1}>
        <Button label="Approve" onPress={onApprove} autoFocus />
        <Box marginLeft={1}>
          <Button label="Deny" onPress={onDeny} />
        </Box>
      </Box>
    </Box>
  );
}
