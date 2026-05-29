import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SavedViewSummary } from './types.js';

const LOGO_FULL: readonly string[] = [
  '███████╗██╗  ██╗ █████╗ ██████╗ ███████╗███████╗██╗  ██╗██╗███████╗████████╗██╗   ██╗██╗',
  '██╔════╝██║  ██║██╔══██╗██╔══██╗██╔════╝██╔════╝██║  ██║██║██╔════╝╚══██╔══╝██║   ██║██║',
  '███████╗███████║███████║██████╔╝█████╗  ███████╗███████║██║█████╗     ██║   ██║   ██║██║',
  '╚════██║██╔══██║██╔══██║██╔═══╝ ██╔══╝  ╚════██║██╔══██║██║██╔══╝     ██║   ██║   ██║██║',
  '███████║██║  ██║██║  ██║██║     ███████╗███████║██║  ██║██║██║        ██║   ╚██████╔╝██║',
  '╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚══════╝╚══════╝╚═╝  ╚═╝╚═╝╚═╝        ╚═╝    ╚═════╝ ╚═╝',
];

const LOGO_COMPACT: readonly string[] = [
  '███████╗████████╗██╗   ██╗██╗',
  '██╔════╝╚══██╔══╝██║   ██║██║',
  '███████╗   ██║   ██║   ██║██║',
  '╚════██║   ██║   ██║   ██║██║',
  '███████║   ██║   ╚██████╔╝██║',
  '╚══════╝   ╚═╝    ╚═════╝ ╚═╝',
];

export type LandingAction =
  | { kind: 'new' }
  | { kind: 'quit' }
  | { kind: 'load'; name: string }
  | { kind: 'fork'; name: string };

interface LandingProps {
  columns: number;
  rows: number;
  focused: boolean;
  views: SavedViewSummary[] | null;
  viewsLoading: boolean;
  onAction: (action: LandingAction) => void;
  onRequestViews: () => void;
}

type Mode = 'menu' | 'load' | 'fork';

const MENU: readonly { label: string; mode: Mode | 'new' | 'quit' }[] = [
  { label: 'New session', mode: 'new' },
  { label: 'Load saved', mode: 'load' },
  { label: 'Fork from save', mode: 'fork' },
  { label: 'Quit', mode: 'quit' },
];

export function Landing({
  columns,
  rows,
  focused,
  views,
  viewsLoading,
  onAction,
  onRequestViews,
}: LandingProps): React.ReactElement {
  const [mode, setMode] = useState<Mode>('menu');
  const [menuIdx, setMenuIdx] = useState(0);
  const [savesIdx, setSavesIdx] = useState(0);

  // Fetch saves the moment we enter a list mode. Keeps Landing self-contained
  // so the App doesn't need to predict which sub-view will be opened.
  useEffect(() => {
    if (mode === 'load' || mode === 'fork') onRequestViews();
  }, [mode, onRequestViews]);

  useEffect(() => {
    setSavesIdx(0);
  }, [mode, views?.length]);

  useInput((_input, key) => {
    if (mode === 'menu') {
      if (key.escape) return onAction({ kind: 'new' });
      if (key.upArrow) setMenuIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow) setMenuIdx((i) => Math.min(MENU.length - 1, i + 1));
      else if (key.return) {
        const pick = MENU[menuIdx];
        if (!pick) return;
        if (pick.mode === 'new') onAction({ kind: 'new' });
        else if (pick.mode === 'quit') onAction({ kind: 'quit' });
        else setMode(pick.mode);
      }
      return;
    }

    if (key.escape) {
      setMode('menu');
      return;
    }
    const list = views ?? [];
    if (key.upArrow) setSavesIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow) setSavesIdx((i) => Math.min(Math.max(0, list.length - 1), i + 1));
    else if (key.return && list.length > 0) {
      const pick = list[savesIdx];
      if (pick) onAction({ kind: mode, name: pick.name });
    }
  }, { isActive: focused });

  const variant: 'full' | 'compact' | 'text' =
    columns >= 100 ? 'full' : columns >= 60 ? 'compact' : 'text';
  const canvasHeight = Math.max(8, rows - 3);

  return (
    <Box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      height={canvasHeight}
      width={columns}
    >
      <Logo variant={variant} />
      <Box marginTop={1}>
        <Text dimColor>shapeshif·tui — describe a UI, see it render</Text>
      </Box>
      <Box marginTop={2} flexDirection="column" alignItems="center">
        {mode === 'menu' ? (
          <MenuList index={menuIdx} />
        ) : (
          <SavesList
            mode={mode}
            views={views}
            loading={viewsLoading}
            index={savesIdx}
          />
        )}
      </Box>
    </Box>
  );
}

function MenuList({ index }: { index: number }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2}>
      {MENU.map((opt, i) => {
        const active = i === index;
        return (
          <Text key={opt.label} color={active ? 'cyan' : undefined} bold={active}>
            {active ? '▸ ' : '  '}{opt.label}
          </Text>
        );
      })}
    </Box>
  );
}

function SavesList({
  mode,
  views,
  loading,
  index,
}: {
  mode: 'load' | 'fork';
  views: SavedViewSummary[] | null;
  loading: boolean;
  index: number;
}): React.ReactElement {
  const title = mode === 'fork' ? 'Fork from save' : 'Load saved';
  const list = views ?? [];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} minWidth={48}>
      <Box>
        <Text bold color="cyan">{title}</Text>
        <Text dimColor>  ·  Esc: back</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {views === null || loading ? (
          <Text dimColor>loading...</Text>
        ) : list.length === 0 ? (
          <Text dimColor>no saved views — use /save &lt;name&gt; after a render</Text>
        ) : (
          list.map((v, i) => {
            const active = i === index;
            return (
              <Box key={v.name}>
                <Text color={active ? 'cyan' : undefined} bold={active}>
                  {active ? '▸ ' : '  '}
                </Text>
                <Box width={28}>
                  <Text color={active ? 'cyan' : undefined} bold={active} wrap="truncate-end">
                    {v.name}
                  </Text>
                </Box>
                <Text dimColor>{formatDate(v.savedAt)}  ·  {v.turns} msgs</Text>
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
}

function Logo({ variant }: { variant: 'full' | 'compact' | 'text' }): React.ReactElement {
  if (variant === 'text') {
    return <Text bold color="cyan">◆ ShapeshifTUI</Text>;
  }
  const lines = variant === 'full' ? LOGO_FULL : LOGO_COMPACT;
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} color="cyan" bold>{line}</Text>
      ))}
    </Box>
  );
}

function formatDate(value: number | null): string {
  if (!value) return 'unknown';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toISOString().slice(0, 10);
}

export const LANDING_HINT = '↑/↓: navigate  ·  Enter: pick  ·  Esc: back/dismiss  ·  Ctrl+C: quit';
