import React from 'react';
import { Box, Text } from 'ink';
import { Button } from './components.js';
import type { CodexSessionSummary } from './types.js';

export interface SessionsPanelProps {
  sessions: CodexSessionSummary[] | null;
  loading: boolean;
  focused: boolean;
  availableRows: number;
  onRefresh: () => void;
  onResume: (id: string) => void;
  onClose: () => void;
}

export function SessionsPanel({
  sessions,
  loading,
  focused,
  availableRows,
  onRefresh,
  onResume,
  onClose,
}: SessionsPanelProps): React.ReactElement {
  const borderColor = focused ? 'cyan' : 'gray';
  const rows = sessions ?? [];
  const visibleRows = rows.slice(0, Math.max(1, availableRows - 7));

  return (
    <Box borderStyle="round" borderColor={borderColor} padding={1} flexDirection="column" flexGrow={1} height={Math.max(5, availableRows)} overflowY="hidden">
      <Box>
        <Text bold color="cyan">◆ Codex Sessions</Text>
        <Text dimColor>{loading ? '  ·  loading...' : '  ·  resume a thread from this directory'}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column" flexGrow={1}>
        {sessions === null ? (
          <Text dimColor>{loading ? 'loading...' : 'no data yet'}</Text>
        ) : rows.length === 0 ? (
          <Box flexDirection="column">
            <Text dimColor>No Codex sessions found for this directory.</Text>
            <Text dimColor>Start a Codex or ShapeshifTUI turn here, then refresh.</Text>
          </Box>
        ) : (
          visibleRows.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              onResume={() => onResume(session.id)}
            />
          ))
        )}
        {rows.length > visibleRows.length ? (
          <Text dimColor>Showing {visibleRows.length} of {rows.length}. Newest sessions first.</Text>
        ) : null}
      </Box>
      <Box marginTop={1}>
        <Button label="Refresh" onPress={onRefresh} autoFocus />
        <Box marginLeft={1}>
          <Button label="Close" onPress={onClose} />
        </Box>
      </Box>
    </Box>
  );
}

function SessionRow({
  session,
  onResume,
}: {
  session: CodexSessionSummary;
  onResume: () => void;
}): React.ReactElement {
  return (
    <Box marginBottom={1} flexDirection="column">
      <Box>
        <Box width={25}>
          <Text bold wrap="truncate-end">{session.title || '(untitled)'}</Text>
        </Box>
        <Box width={11}>
          <Text dimColor>{formatDate(session.updatedAt)}</Text>
        </Box>
        <Text dimColor>{session.turns} turns</Text>
      </Box>
      <Box>
        <Box width={38}>
          <Text dimColor wrap="truncate-end">{session.id}</Text>
        </Box>
        <Button label="Resume" onPress={onResume} />
      </Box>
    </Box>
  );
}

function formatDate(value: number): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toISOString().slice(0, 10);
}
