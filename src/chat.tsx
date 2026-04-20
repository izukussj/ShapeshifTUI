import React, { useEffect, useMemo, useState, type MutableRefObject } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { ChatMessage } from './types.js';

interface SlashCommand {
  name: string;
  args: string;
  help: string;
  example: string;
}

const COMMANDS: SlashCommand[] = [
  { name: '/save', args: '<name>', help: 'save the current view for later', example: '/save dashboard' },
  { name: '/load', args: '<name>', help: 'restore a saved view', example: '/load dashboard' },
  { name: '/views', args: '', help: 'list saved views', example: '/views' },
  { name: '/mcp', args: '<list|add|remove>', help: 'manage Codex MCP servers', example: '/mcp list' },
  { name: '/plugin', args: '', help: 'show Codex plugin setup guidance', example: '/plugin' },
  { name: '/delete', args: '<name>', help: 'remove a saved view', example: '/delete dashboard' },
  { name: '/help', args: '', help: 'show all commands', example: '/help' },
];

const EXAMPLE_PROMPTS = [
  'a todo list with priority tags',
  'a pomodoro timer with start/pause',
  'a markdown cheatsheet I can scroll',
];

interface ChatProps {
  messages: ChatMessage[];
  onSend: (content: string) => void;
  focused: boolean;
  scrollOffset: number;
  onScrollOffsetChange: (offset: number) => void;
  width: number | string;
  // Rows allocated to the chat pane by the flex parent (terminal height minus
  // app chrome). Used to slice messages so the chat never overflows its box —
  // overflow scrolls the whole frame and clips the top header row.
  availableRows: number;
  // Mutated each render to signal whether Tab should be consumed by the chat
  // (slash menu open) or pass through to the app-level Tab pane-switch.
  captureTabRef: MutableRefObject<boolean>;
}

const PREFIX_WIDTH = 7;

export function Chat({
  messages,
  onSend,
  focused,
  scrollOffset,
  onScrollOffsetChange,
  width,
  availableRows,
  captureTabRef,
}: ChatProps): React.ReactElement {
  const [draft, setDraft] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Slash-command autocomplete. Only active when the draft starts with "/" and
  // the user hasn't typed a space yet — once they're on args, suggestions hide.
  const slashInput = draft.startsWith('/') && !draft.includes(' ');
  const suggestions = slashInput
    ? COMMANDS.filter((c) => c.name.startsWith(draft))
    : [];

  // Report whether the chat owns Tab right now. Idempotent ref write in render
  // is cheap and avoids an effect-tick lag against the Tab handler in app.tsx.
  captureTabRef.current = focused && suggestions.length > 0;

  // Clamp selection to current suggestion count. Resets to 0 when the user
  // types (suggestions filter), stays valid when wrapping with arrows.
  useEffect(() => {
    setSelectedIndex((i) => (suggestions.length === 0 ? 0 : Math.min(i, suggestions.length - 1)));
  }, [suggestions.length]);
  useEffect(() => {
    setSelectedIndex(0);
  }, [draft]);

  // Tab completes toward the selection. If the draft already matches the full
  // completion, Tab stays put (Enter fires the send).
  const completeToSelection = () => {
    const picked = suggestions[selectedIndex] ?? suggestions[0];
    if (!picked) return;
    const completed = picked.args ? `${picked.name} ` : picked.name;
    if (draft !== completed) setDraft(completed);
  };

  useInput((_input, key) => {
    if (!focused || suggestions.length === 0) return;
    if (key.upArrow) {
      setSelectedIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (key.downArrow) {
      setSelectedIndex((i) => (i + 1) % suggestions.length);
    } else if (key.tab) {
      completeToSelection();
    }
  }, { isActive: focused });

  const submit = (value: string) => {
    // Enter progresses the slash menu: complete if the draft is a prefix, or
    // send if the draft already matches an argless command. Without this,
    // argless commands (/views, /help) loop — Enter would just re-complete
    // to the same string and never reach onSend.
    if (suggestions.length > 0) {
      const picked = suggestions[selectedIndex] ?? suggestions[0]!;
      const completed = picked.args ? `${picked.name} ` : picked.name;
      if (draft !== completed) {
        setDraft(completed);
        return;
      }
      // Draft already equals the completion. If the command is argless, ship
      // it; otherwise hold (user still needs to type the argument).
      if (!picked.args) {
        onSend(draft.trim());
        setDraft('');
      }
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setDraft('');
  };

  // Reserve border (2) + padding (2) + input (1); add lines for scrollback hint
  // and suggestion rows so the message window shrinks rather than overflows.
  const frameRows = Math.max(5, availableRows);
  const wantsScrollHint = scrollOffset > 0;
  const maxSuggestionLines = Math.max(0, frameRows - 6 - (wantsScrollHint ? 1 : 0));
  const suggestionLines = suggestions.length > 0
    ? Math.min(suggestions.length + 2, maxSuggestionLines)
    : 0;
  const reserved = 5 + (wantsScrollHint ? 1 : 0) + suggestionLines;
  const messageRows = Math.max(1, frameRows - reserved);
  const numericWidth = typeof width === 'number' ? width : 80;
  const bodyWidth = Math.max(8, numericWidth - 4 - PREFIX_WIDTH);
  const rows = useMemo(() => buildChatRows(messages, bodyWidth), [messages, bodyWidth]);
  const maxScrollOffset = Math.max(0, rows.length - messageRows);
  const clampedScrollOffset = Math.min(scrollOffset, maxScrollOffset);
  const end = Math.max(0, rows.length - clampedScrollOffset);
  const start = Math.max(0, end - messageRows);
  const visible = rows.slice(start, end);
  const olderHidden = start;
  const newerHidden = rows.length - end;

  useEffect(() => {
    if (scrollOffset !== clampedScrollOffset) onScrollOffsetChange(clampedScrollOffset);
  }, [clampedScrollOffset, onScrollOffsetChange, scrollOffset]);

  return (
    <Box
      borderStyle={focused ? 'bold' : 'round'}
      borderColor={focused ? 'cyan' : 'gray'}
      padding={1}
      flexDirection="column"
      width={width}
      height={frameRows}
      flexGrow={1}
      flexShrink={0}
      overflowY="hidden"
    >
      {clampedScrollOffset > 0 ? (
        <Box>
          <Text color="yellow" dimColor>
            ── scrolled: {olderHidden} rows above · {newerHidden} rows below · PageDn/wheel down to resume ──
          </Text>
        </Box>
      ) : null}
      <Box height={messageRows} overflowY="hidden" flexDirection="column" flexShrink={0}>
        {messages.length === 0 ? (
          <EmptyChat />
        ) : (
          visible.map((row) => <ChatRow key={row.key} row={row} />)
        )}
      </Box>
      {suggestions.length > 0 && suggestionLines > 0 ? (
        <Box height={suggestionLines} overflowY="hidden" flexDirection="column" flexShrink={0}>
          <SuggestionPanel
            suggestions={suggestions}
            selectedIndex={selectedIndex}
          />
        </Box>
      ) : null}
      <Box height={1} overflowY="hidden" flexShrink={0}>
        <Text color={focused ? 'cyan' : 'gray'} bold={focused}>{'❯ '}</Text>
        <TextInput
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          focus={focused}
        />
      </Box>
    </Box>
  );
}

function EmptyChat(): React.ReactElement {
  return (
    <Box flexDirection="column" paddingY={1}>
      <Text bold color="cyan">Welcome to ShapeshifTUI</Text>
      <Text dimColor>Describe a UI in plain English — I'll build it in the pane next door.</Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Try asking for:</Text>
        {EXAMPLE_PROMPTS.map((p) => (
          <Box key={p}>
            <Text color="green">  › </Text>
            <Text>{p}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Type </Text>
        <Text color="yellow">/</Text>
        <Text dimColor> for commands.</Text>
      </Box>
    </Box>
  );
}

interface SuggestionPanelProps {
  suggestions: SlashCommand[];
  selectedIndex: number;
}

function SuggestionPanel({ suggestions, selectedIndex }: SuggestionPanelProps): React.ReactElement {
  const selected = suggestions[selectedIndex] ?? suggestions[0]!;
  return (
    <Box flexDirection="column" marginBottom={0}>
      {suggestions.map((c, i) => {
        const active = i === selectedIndex;
        return (
          <Box key={c.name}>
            <Box width={2}>
              <Text color="cyan" bold>{active ? '▸' : ' '}</Text>
            </Box>
            <Box width={10}>
              <Text color={active ? 'cyan' : undefined} bold={active}>{c.name}</Text>
            </Box>
            <Box width={10}>
              <Text dimColor>{c.args}</Text>
            </Box>
            <Text dimColor>{c.help}</Text>
          </Box>
        );
      })}
      <Box marginTop={0}>
        <Text dimColor>↑↓ navigate · </Text>
        <Text dimColor>Tab/Enter accepts · e.g. </Text>
        <Text color="cyan">{selected.example}</Text>
      </Box>
    </Box>
  );
}

interface ChatLineStyle {
  bullet: string;
  label: string;
  color: string;
  bold: boolean;
}

type ChatRowModel =
  | { kind: 'gap'; key: string }
  | {
      kind: 'message';
      key: string;
      text: string;
      first: boolean;
      bodyDim: boolean;
      style: ChatLineStyle;
    };

// (sender, severity) → bullet + label + color. Bullet is the visual anchor
// (scanning a long chat reads as colored dots), label is secondary context.
function styleFor(message: ChatMessage): ChatLineStyle {
  if (message.sender === 'user') return { bullet: '●', label: 'you', color: 'green', bold: false };
  if (message.sender === 'ai') return { bullet: '◆', label: 'ai', color: 'cyan', bold: false };
  if (message.severity === 'error') return { bullet: '✗', label: 'err', color: 'red', bold: true };
  if (message.severity === 'warn') return { bullet: '▲', label: 'warn', color: 'yellow', bold: true };
  return { bullet: '○', label: 'sys', color: 'yellow', bold: false };
}

function buildChatRows(messages: ChatMessage[], bodyWidth: number): ChatRowModel[] {
  const rows: ChatRowModel[] = [];
  messages.forEach((message, index) => {
    const prev = index > 0 ? messages[index - 1] : null;
    if (prev && prev.sender !== message.sender) {
      rows.push({ kind: 'gap', key: `gap-${message.id}` });
    }
    const style = styleFor(message);
    const content = visibleMessageContent(message);
    const bodyDim = !content;
    const body = content || '(layout)';
    const lines = wrapPlainText(body, bodyWidth);
    lines.forEach((line, lineIndex) => {
      rows.push({
        kind: 'message',
        key: `${message.id}:${lineIndex}`,
        text: line,
        first: lineIndex === 0,
        bodyDim,
        style,
      });
    });
  });
  return rows;
}

function visibleMessageContent(message: ChatMessage): string {
  // Strip shapeshiftui code blocks from rendered chat — they're noise once mounted.
  return message.content.replace(/```shapeshiftui\s*\n[\s\S]*?```/g, '').trim();
}

function wrapPlainText(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const rows: string[] = [];
  for (const rawLine of text.replace(/\r/g, '').split('\n')) {
    let line = rawLine;
    if (line.length === 0) {
      rows.push('');
      continue;
    }
    while (line.length > safeWidth) {
      const slice = line.slice(0, safeWidth);
      const breakAt = slice.lastIndexOf(' ');
      const cut = breakAt >= Math.floor(safeWidth * 0.45) ? breakAt : safeWidth;
      rows.push(line.slice(0, cut).trimEnd());
      line = line.slice(cut).trimStart();
    }
    rows.push(line);
  }
  return rows.length > 0 ? rows : [''];
}

function ChatRow({ row }: { row: ChatRowModel }): React.ReactElement {
  if (row.kind === 'gap') return <Box height={1} />;
  const { bullet, label, color, bold } = row.style;
  return (
    <Box height={1} overflowY="hidden">
      <Box width={PREFIX_WIDTH}>
        {row.first ? (
          <>
            <Text color={color} bold={bold}>{bullet} </Text>
            <Text color={color} dimColor={!bold}>{label}</Text>
          </>
        ) : null}
      </Box>
      <Text dimColor={row.bodyDim} wrap="truncate-end">{row.text}</Text>
    </Box>
  );
}
