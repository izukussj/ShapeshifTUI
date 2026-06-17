export type Sender = 'user' | 'ai' | 'system';

export type ErrorSeverity = 'info' | 'warn' | 'error';
export type ErrorSource = 'bridge' | 'runtime' | 'sandbox' | 'network' | 'codex' | 'user';

/**
 * Canonical error shape across the wire and inside the client. Classified at
 * origin so the sink can render, log, and derive persistent state without
 * pattern-matching strings.
 */
export interface AppError {
  source: ErrorSource;
  code: string;
  message: string;
  severity: ErrorSeverity;
  recoverable: boolean;
  details?: unknown;
}

export interface ChatMessage {
  id: string;
  sender: Sender;
  content: string;
  timestamp: number;
  severity?: ErrorSeverity;
}

export interface InteractionRecord {
  eventType: string;
  data: unknown;
  timestamp: number;
}

export interface ApprovalRequest {
  id: string;
  tool: 'shell' | 'mcp' | 'other';
  summary: string;
  details: unknown;
}

/**
 * MCP server record as returned by `codex mcp list --json`. The bridge passes
 * the parsed output through unchanged — we accept whatever codex emits rather
 * than remapping, because codex owns the schema.
 */
export interface McpStdioTransport {
  type: 'stdio';
  command: string;
  args?: string[] | null;
  env?: Record<string, string> | null;
  env_vars?: string[] | null;
  cwd?: string | null;
}

export interface McpHttpTransport {
  type: 'streamable_http';
  url: string;
  bearer_token_env_var?: string | null;
  http_headers?: Record<string, string> | null;
  env_http_headers?: Record<string, string> | null;
}

export type McpTransport = McpStdioTransport | McpHttpTransport;

export interface McpServer {
  name: string;
  enabled: boolean;
  disabled_reason?: string | null;
  transport: McpTransport;
  startup_timeout_sec?: number | null;
  tool_timeout_sec?: number | null;
  auth_status?: string | null;
}

/**
 * Payload for client → server mcp-add. `transport` picks the variant; the
 * bridge translates into `codex mcp add` flags.
 */
export type McpAddPayload =
  | {
      transport: 'stdio';
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      transport: 'http';
      name: string;
      url: string;
      bearerTokenEnvVar?: string;
    };

export interface McpOpResult {
  op: 'add' | 'remove';
  name: string;
  ok: boolean;
  message?: string;
}

export interface SavedViewSummary {
  name: string;
  savedAt: number | null;
  turns: number;
}

export interface ForkedView {
  name: string;
  messages: ChatMessage[];
  source: string | null;
  interactions: InteractionRecord[];
}

/**
 * Wire protocol — minimal JSON over websocket. No JSON-RPC envelope, no
 * handshake. The first message either side sends sets the contract.
 */
export type ServerMessage =
  | { type: 'message'; message: ChatMessage }
  | { type: 'error'; error: AppError }
  | { type: 'status'; text: string | null }
  | {
      type: 'restore';
      name: string;
      messages: ChatMessage[];
      source?: string | null;
      interactions?: InteractionRecord[];
    }
  | { type: 'approval_request'; request: ApprovalRequest }
  | { type: 'mcp_list_result'; servers: McpServer[] }
  | { type: 'mcp_op_result'; result: McpOpResult }
  | { type: 'views_list_result'; views: SavedViewSummary[] }
  | { type: 'view_forked'; view: ForkedView };

export type ClientMessage =
  | { type: 'init'; cwd: string; codexThreadId?: string | null }
  | { type: 'chat'; content: string; interactions: InteractionRecord[] }
  | { type: 'event'; eventType: string; data: unknown }
  | { type: 'save'; name: string }
  | { type: 'load'; name: string }
  | { type: 'list-views' }
  | { type: 'delete-view'; name: string }
  | { type: 'approval_response'; id: string; approved: boolean }
  | { type: 'cancel' }
  | { type: 'mcp-list' }
  | { type: 'mcp-add'; payload: McpAddPayload }
  | { type: 'mcp-remove'; name: string }
  | { type: 'fork-view'; name: string };
