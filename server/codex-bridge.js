#!/usr/bin/env node
/**
 * Codex CLI bridge for ShapeshifTUI.
 *
 * Exposes the same WebSocket wire protocol as bridge.js but routes every
 * turn through `codex exec --json`. The system prompt and operating style
 * live in ./codex/AGENTS.md (picked up because we -C into that directory).
 */

import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODEX_CWD = path.join(__dirname, 'codex');
const LOG_DIR = path.join(__dirname, 'logs');
const VIEWS_DIR = path.join(os.homedir(), '.shapeshiftui', 'views');
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(VIEWS_DIR, { recursive: true });

function cwdHash(cwd) {
  return crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 12);
}

/**
 * Build a structured AppError. Matches the shape in src/types.ts. Keep this
 * the single way errors leave the bridge — every sendError call gets one.
 */
function buildError({ source = 'bridge', code, message, severity = 'error', recoverable = true, details }) {
  return { source, code, message, severity, recoverable, details };
}

/**
 * Log a swallowed/silent error to stderr with structured context. Replaces
 * bare `catch {}` — dev gets full context, user sees nothing (these are
 * internal parse failures, not actionable).
 */
function logSilent(code, message, err) {
  console.error('[shapeshiftui]', { source: 'bridge', code, message, err: err?.message ?? String(err) });
}

function viewDir(cwd) {
  return path.join(VIEWS_DIR, cwdHash(cwd));
}

function viewFile(cwd, name) {
  return path.join(viewDir(cwd), `${encodeURIComponent(name)}.json`);
}

function safeMessages(value) {
  return Array.isArray(value)
    ? value.filter((m) =>
      m &&
      typeof m === 'object' &&
      typeof m.id === 'string' &&
      typeof m.sender === 'string' &&
      typeof m.content === 'string' &&
      typeof m.timestamp === 'number')
    : [];
}

function safeInteractions(value) {
  return Array.isArray(value)
    ? value.filter((e) =>
      e &&
      typeof e === 'object' &&
      typeof e.eventType === 'string' &&
      typeof e.timestamp === 'number')
    : [];
}

function latestSourceFromMessages(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.sender !== 'ai' || typeof message.content !== 'string') continue;
    const match = message.content.match(/```shapeshiftui\s*\n([\s\S]*?)```/);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function summarizeView(obj) {
  return {
    name: obj.name,
    savedAt: typeof obj.saved_at === 'number' ? obj.saved_at : null,
    turns: Array.isArray(obj.messages) ? obj.messages.length : 0,
  };
}

function readJsonFiles(dir, code) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch (err) {
        logSilent(code, `skipping unreadable JSON file ${f}`, err);
        return null;
      }
    })
    .filter(Boolean);
}

function listViewSummaries(cwd) {
  return readJsonFiles(viewDir(cwd), 'view_corrupt')
    .map(summarizeView)
    .filter((v) => typeof v.name === 'string' && v.name.length > 0)
    .sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0) || a.name.localeCompare(b.name));
}

function savedViewContextPrompt(saved) {
  const messages = safeMessages(saved.messages).slice(-30);
  const transcript = messages
    .map((m) => {
      const text = m.content
        .replace(/```shapeshiftui\s*\n[\s\S]*?```/g, '[layout code omitted here; current source is provided below]')
        .trim()
        .slice(0, 2500);
      return `${m.sender}: ${text || '(layout)'}`;
    })
    .join('\n\n');
  const source = typeof saved.source === 'string' && saved.source.trim()
    ? `\n\nCurrent rendered layout source:\n\`\`\`shapeshiftui\n${saved.source}\n\`\`\``
    : '';
  return [
    `You are starting a fresh ShapeshifTUI run from saved point "${saved.name}".`,
    'Use the saved transcript and current rendered source as prior context, then answer the next user request normally.',
    transcript ? `\nRecent saved transcript:\n${transcript}` : '',
    source,
  ].join('\n');
}

const PORT = process.env.CODEX_BRIDGE_PORT || process.env.PORT || 8080;
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const SANDBOX = process.env.CODEX_SANDBOX || 'read-only';
// Passed to codex as `-m <model>`. Empty → let codex pick its own default.
const CODEX_MODEL = process.env.CODEX_MODEL || '';
const MODEL_ARGS = CODEX_MODEL ? ['-m', CODEX_MODEL] : [];
const MAX_QUEUED_TURNS = 3;

// Loaded once at startup. Prepended on the first turn of sessions whose cwd
// is not the default (i.e. the client passed --cwd to run codex elsewhere).
// When the default cwd is used, codex's own AGENTS.md discovery handles it.
const CANONICAL_INSTRUCTIONS = fs.readFileSync(path.join(CODEX_CWD, 'AGENTS.md'), 'utf8');

class Session {
  constructor(ws) {
    this.ws = ws;
    this.threadId = null;
    this.interactions = [];
    this.logFile = path.join(LOG_DIR, `codex-session-${Date.now()}.jsonl`);
    this.busy = false;
    this.cwd = CODEX_CWD;
    // Transcript of chat-visible turns (user + ai + system), used for save/load.
    // Not the same as this.log() which is the full JSONL debug stream.
    this.transcript = [];
    // When forking from a save, the next user turn seeds a fresh Codex thread
    // with the saved context instead of resuming an append-only historical thread.
    this.pendingForkContext = null;
    // Pending approval gate entries, keyed by id. Value: { eventType, data }.
    this.pendingApprovals = new Map();
    // The codex child for the in-flight turn, or null when idle. Lets
    // handleCancel() SIGTERM the process on user request.
    this.currentChild = null;
    this.cancelled = false;
    // Turns can arrive during the short gap after Codex emits an agent
    // message and before the child process closes. Queue them so render-repair
    // prompts and quick user submits are not dropped.
    this.queuedTurns = [];
    // Pre-spawned `codex exec resume … -` process waiting on stdin. Consumed
    // at the start of the next turn to skip the 500ms–1s cold-spawn cost.
    // Null until we have a threadId and a completed turn behind us.
    this.nextChild = null;
    this.nextChildKey = null;
    this.nextChildBornAt = 0;
    this.needsResumePreamble = false;
  }

  summarizeAction(data) {
    const d = data ?? {};
    if (d.tool === 'shell') return { tool: 'shell', summary: `shell: ${d.cmd ?? '(no cmd)'}` };
    if (d.tool === 'mcp') {
      const args = d.args ? ` ${JSON.stringify(d.args)}` : '';
      return { tool: 'mcp', summary: `mcp ${d.server}/${d.name}${args}` };
    }
    return { tool: 'other', summary: `action: ${JSON.stringify(d).slice(0, 120)}` };
  }

  requestApproval(eventType, data) {
    const id = `a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { tool, summary } = this.summarizeAction(data);
    this.pendingApprovals.set(id, { eventType, data });
    this.ws.send(JSON.stringify({
      type: 'approval_request',
      request: { id, tool, summary, details: data ?? null },
    }));
    this.log({ type: 'approval-request', id, tool, summary });
  }

  async handleApprovalResponse(id, approved) {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return;
    this.pendingApprovals.delete(id);
    this.log({ type: 'approval-response', id, approved });
    if (!approved) {
      const { summary } = this.summarizeAction(pending.data);
      this.send('system', `denied — ${summary}`);
      return;
    }
    await this.runTurn(this.formatEventPrompt(pending.eventType, pending.data) + this.interactionContext());
  }

  recordTurn(sender, content) {
    this.transcript.push({
      id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sender,
      content,
      timestamp: Date.now(),
    });
  }

  handleInit({ cwd, codexThreadId }) {
    if (typeof cwd !== 'string' || !cwd) return;
    const resolved = path.resolve(cwd);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      this.emitError({
        source: 'user',
        code: 'bad_cwd',
        severity: 'error',
        recoverable: true,
        message: `--cwd path does not exist or is not a directory: ${resolved}`,
      });
      return;
    }
    const changed = resolved !== this.cwd;
    this.cwd = resolved;
    if (changed) {
      this.pendingForkContext = null;
      this.clearQueuedTurns('cwd_changed');
      this.killHotSpare();
    }

    const resumeThreadId = typeof codexThreadId === 'string' ? codexThreadId.trim() : '';
    if (resumeThreadId) {
      this.threadId = resumeThreadId;
      this.pendingForkContext = null;
      this.needsResumePreamble = true;
      this.killHotSpare();
      this.log({ type: 'init', cwd: resolved, codexThreadId: resumeThreadId, resume: true });
      this.send('ai', `Resumed Codex thread \`${resumeThreadId}\`. Working in \`${resolved}\`.`);
      return;
    }

    this.log({ type: 'init', cwd: resolved });
    this.send('ai', `Working in \`${resolved}\`.`);
  }

  log(entry) {
    fs.appendFileSync(this.logFile, JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n');
  }

  send(sender, content) {
    const message = {
      id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sender,
      content,
      timestamp: Date.now(),
    };
    this.ws.send(JSON.stringify({ type: 'message', message }));
    this.transcript.push(message);
    this.log({ type: 'outgoing', sender, content });
  }

  sendError(error) {
    this.sendStatus(null);
    this.ws.send(JSON.stringify({ type: 'error', error }));
    this.log({ type: 'error', error });
  }

  // Shortcut: build + send in one call. Keeps call sites terse.
  emitError(fields) {
    this.sendError(buildError(fields));
  }

  sendStatus(text) {
    this.ws.send(JSON.stringify({ type: 'status', text }));
    this.log({ type: 'status', text });
  }

  queueTurn(prompt) {
    this.queuedTurns.push({ prompt, queuedAt: Date.now() });
    if (this.queuedTurns.length > MAX_QUEUED_TURNS) {
      const dropped = this.queuedTurns.shift();
      this.log({
        type: 'turn-queue-dropped',
        count: this.queuedTurns.length,
        promptPreview: dropped?.prompt.slice(0, 200) ?? '',
      });
    }
    this.sendStatus(`queued next turn (${this.queuedTurns.length})`);
    this.log({ type: 'turn-queued', count: this.queuedTurns.length, promptPreview: prompt.slice(0, 200) });
  }

  clearQueuedTurns(reason) {
    if (this.queuedTurns.length === 0) return;
    this.log({ type: 'turn-queue-cleared', reason, count: this.queuedTurns.length });
    this.queuedTurns = [];
  }

  drainQueuedTurn() {
    if (this.busy || this.queuedTurns.length === 0) return;
    const next = this.queuedTurns.shift();
    this.log({
      type: 'turn-dequeued',
      remaining: this.queuedTurns.length,
      ageMs: Date.now() - next.queuedAt,
      promptPreview: next.prompt.slice(0, 200),
    });
    setImmediate(() => {
      if (!this.busy) this.runTurn(next.prompt);
    });
  }

  mergeInteractions(incoming) {
    if (!incoming?.length) return;
    this.interactions.push(...incoming);
    if (this.interactions.length > 50) this.interactions = this.interactions.slice(-50);
  }

  interactionContext() {
    if (!this.interactions.length) return '';
    const recent = this.interactions.slice(-10)
      .map((e) => `  - ${e.eventType}: ${JSON.stringify(e.data ?? {})}`)
      .join('\n');
    return `\n\n[Recent user interactions]\n${recent}`;
  }

  formatEventPrompt(eventType, data) {
    // See AGENTS.md "Action conventions"
    if (eventType === 'refresh') {
      return '[User clicked Refresh — re-run the tools for the current view and re-emit it with fresh data.]';
    }
    if (eventType === 'action') {
      const d = data ?? {};
      if (d.tool === 'shell') {
        return `[User requested shell action: \`${d.cmd}\`]\nExecute it (subject to sandbox), then re-emit the previous view with updated state.`;
      }
      if (d.tool === 'mcp') {
        return `[User requested MCP action: server=${d.server}, tool=${d.name}, args=${JSON.stringify(d.args ?? {})}]\nCall the MCP tool, then re-emit the previous view with updated state.`;
      }
      return `[User triggered action]\nData: ${JSON.stringify(d)}`;
    }
    if (eventType === 'navigate') {
      return `[User navigated]\nData: ${JSON.stringify(data ?? {})}\nEmit the requested view.`;
    }
    return `[User triggered event: ${eventType}]\nData: ${JSON.stringify(data ?? {})}`;
  }

  hotSpareKey() {
    return `${this.cwd}|${SANDBOX}|${CODEX_MODEL}`;
  }

  spawnHotSpare() {
    if (!this.threadId) return;
    this.killHotSpare();
    const args = ['exec', 'resume', this.threadId, '--json', '--skip-git-repo-check', ...MODEL_ARGS, '-'];
    let child;
    try {
      child = spawn(CODEX_BIN, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
    } catch (err) {
      this.log({ type: 'hot-spare-spawn-failed', err: err.message });
      return;
    }

    // Drain both pipes into local buffers so the OS pipe doesn't fill while
    // the hot-spare is idle. These buffers are handed off on promotion.
    let earlyStdout = '';
    let earlyStderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const drainStdout = (chunk) => { earlyStdout += chunk; };
    const drainStderr = (chunk) => { earlyStderr += chunk; };
    child.stdout.on('data', drainStdout);
    child.stderr.on('data', drainStderr);
    child.__drainStdout = drainStdout;
    child.__drainStderr = drainStderr;
    child.__getEarlyStdout = () => earlyStdout;
    child.__getEarlyStderr = () => earlyStderr;

    child.on('error', (err) => {
      this.log({ type: 'hot-spare-error', err: err.message });
      if (this.nextChild === child) {
        this.nextChild = null;
        this.nextChildKey = null;
        this.nextChildBornAt = 0;
      }
    });
    child.on('exit', (code, signal) => {
      if (this.nextChild === child) {
        this.log({ type: 'hot-spare-exit', code, signal });
        this.nextChild = null;
        this.nextChildKey = null;
        this.nextChildBornAt = 0;
      }
    });

    this.nextChild = child;
    this.nextChildKey = this.hotSpareKey();
    this.nextChildBornAt = Date.now();
    this.log({ type: 'hot-spare-spawned', key: this.nextChildKey });
  }

  killHotSpare() {
    if (!this.nextChild) return;
    const child = this.nextChild;
    this.nextChild = null;
    this.nextChildKey = null;
    this.nextChildBornAt = 0;
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
  }

  async runTurn(prompt) {
    if (this.busy) {
      this.queueTurn(prompt);
      return;
    }
    this.busy = true;

    // `codex exec resume` inherits sandbox/cwd from the original session, so
    // we only pass -s/-C on the first turn. It doesn't accept them on resume.
    const resume = this.threadId !== null;
    // On first turn with a non-default cwd, codex can't discover our AGENTS.md
    // (it lives in server/codex/). Prepend the canonical contract as a preamble
    // so the widget rendering protocol applies wherever codex runs.
    const needsPreamble = (!resume && this.cwd !== CODEX_CWD) || this.needsResumePreamble;
    const finalPrompt = needsPreamble
      ? `${CANONICAL_INSTRUCTIONS}\n\n---\n\nUser: ${prompt}`
      : prompt;
    this.needsResumePreamble = false;

    let stderrBuf = '';
    let stdoutBuf = '';
    let anyOutput = false;
    let toolCount = 0;
    let child = null;
    let usedHotSpare = false;

    const status = (text) => this.sendStatus(text);

    // Try to consume the hot-spare if key matches and process is still alive.
    const key = this.hotSpareKey();
    if (resume && this.nextChild && this.nextChildKey === key && !this.nextChild.killed && this.nextChild.exitCode === null) {
      const candidate = this.nextChild;
      const age = Date.now() - this.nextChildBornAt;
      this.nextChild = null;
      this.nextChildKey = null;
      this.nextChildBornAt = 0;

      stdoutBuf += candidate.__getEarlyStdout();
      stderrBuf += candidate.__getEarlyStderr();
      candidate.stdout.off('data', candidate.__drainStdout);
      candidate.stderr.off('data', candidate.__drainStderr);

      try {
        candidate.stdin.write(finalPrompt);
        candidate.stdin.end();
        child = candidate;
        usedHotSpare = true;
        this.log({ type: 'hot-spare-hit', ageMs: age, promptPreview: prompt.slice(0, 200) });
      } catch (err) {
        this.log({ type: 'hot-spare-stdin-failed', err: err.message });
        try { candidate.kill('SIGTERM'); } catch { /* already dead */ }
        stdoutBuf = '';
        stderrBuf = '';
      }
    }

    if (!child) {
      const args = resume
        ? ['exec', 'resume', this.threadId, '--json', '--skip-git-repo-check', ...MODEL_ARGS, finalPrompt]
        : ['exec', '--json', '--skip-git-repo-check', '-s', SANDBOX, '-C', this.cwd, ...MODEL_ARGS, finalPrompt];
      this.log({ type: 'codex-spawn', resume, threadId: this.threadId, cwd: this.cwd, preamble: needsPreamble, promptPreview: prompt.slice(0, 200), hotSpare: false });
      // shell:true on Windows so `.cmd`/`.bat` shims (how codex usually installs
      // via npm on Windows) resolve. No-op on POSIX.
      child = spawn(CODEX_BIN, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
    }

    this.currentChild = child;
    this.cancelled = false;
    status('thinking…');

    const processLines = () => {
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          this.log({ type: 'codex-event', evt });

          if (evt.type === 'thread.started' && evt.thread_id) {
            this.threadId = evt.thread_id;
            continue;
          }

          if (evt.type === 'item.started' && evt.item) {
            const it = evt.item;
            let label;
            if (it.type === 'command_execution') {
              const raw = String(it.command || '').replace(/\s+/g, ' ');
              label = raw.length > 100 ? raw.slice(0, 97) + '…' : raw;
            } else if (it.type === 'mcp_tool_call' || String(it.type || '').startsWith('mcp')) {
              // Codex MCP event shape not pinned in our captured logs; try
              // common field names, fall back to the type string.
              const name = it.tool_name || it.name || it.server || it.type;
              label = `mcp ${name}`;
            } else if (it.type === 'agent_message') {
              continue; // not a tool; don't advance counter
            } else {
              label = it.type; // generic fallback beats silence
            }
            toolCount++;
            status(`working — #${toolCount}: ${label}`);
            continue;
          }

          if (evt.type === 'item.completed' && evt.item?.type === 'command_execution') {
            const outLen = (evt.item.aggregated_output || '').length;
            const ec = evt.item.exit_code;
            status(`#${toolCount} done (exit ${ec}, ${outLen}b) — thinking…`);
            continue;
          }

          if (evt.type === 'item.completed' && evt.item?.type === 'agent_message' && typeof evt.item.text === 'string') {
            anyOutput = true;
            this.send('ai', evt.item.text);
            continue;
          }

          if (evt.type === 'turn.completed') {
            status(null);
            // Eat the cold-spawn cost for the next turn while the user reads.
            if (!this.cancelled && this.threadId) this.spawnHotSpare();
            continue;
          }

          if (evt.type === 'turn.failed') {
            const detail = JSON.stringify(evt.error ?? {}).slice(0, 200);
            this.emitError({
              source: 'codex',
              code: 'turn_failed',
              severity: 'error',
              recoverable: true,
              message: `turn failed: ${detail}`,
              details: evt.error ?? null,
            });
            // Don't pre-spawn when codex is in a bad state; defer to the next
            // runTurn's cold path.
            this.killHotSpare();
            continue;
          }
        } catch (err) {
          logSilent('codex_stdout_parse_failed', 'codex emitted a non-JSON line; dropped', err);
        }
      }
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      processLines();
    });

    child.stderr.on('data', (c) => { stderrBuf += c; });

    // If we inherited buffered stdout from the hot-spare, parse it now rather
    // than waiting for the next chunk.
    if (usedHotSpare && stdoutBuf) processLines();

    child.on('close', (code) => {
      this.busy = false;
      this.currentChild = null;
      this.sendStatus(null);
      if (this.cancelled) {
        this.clearQueuedTurns('cancelled');
        this.send('system', 'turn cancelled');
        return;
      }
      if (code !== 0) {
        this.emitError({
          source: 'codex',
          code: 'exit_nonzero',
          severity: 'error',
          recoverable: true,
          message: `codex exited with code ${code}${stderrBuf ? `: ${stderrBuf.trim().slice(-500)}` : ''}`,
          details: { exitCode: code, stderrTail: stderrBuf.trim().slice(-2000) },
        });
        this.killHotSpare();
        this.drainQueuedTurn();
        return;
      }
      if (!anyOutput) {
        this.emitError({
          source: 'codex',
          code: 'no_output',
          severity: 'warn',
          recoverable: true,
          message: 'codex finished without producing a message',
        });
        this.killHotSpare();
      }
      this.drainQueuedTurn();
    });

    child.on('error', (err) => {
      this.busy = false;
      this.currentChild = null;
      this.emitError({
        source: 'codex',
        code: 'spawn_failed',
        severity: 'error',
        recoverable: false,
        message: `Failed to launch codex (${CODEX_BIN}): ${err.message}`,
        details: { bin: CODEX_BIN, err: err.message },
      });
      this.killHotSpare();
      this.clearQueuedTurns('spawn_failed');
    });
  }

  handleCancel() {
    if (!this.currentChild) {
      this.clearQueuedTurns('cancelled');
      return;
    }
    this.cancelled = true;
    this.clearQueuedTurns('cancelled');
    this.currentChild.kill('SIGTERM');
    this.log({ type: 'cancel' });
  }

  async handleChat(content, clientInteractions) {
    this.mergeInteractions(clientInteractions);
    this.recordTurn('user', content);
    this.log({ type: 'incoming', kind: 'chat', content, interactions: clientInteractions });
    const forkContext = this.pendingForkContext;
    this.pendingForkContext = null;
    const prompt = forkContext
      ? `${forkContext}\n\nNext user request: ${content}`
      : content;
    await this.runTurn(prompt + this.interactionContext());
  }

  async handleEvent(eventType, data) {
    this.interactions.push({ eventType, data, timestamp: Date.now() });
    if (this.interactions.length > 50) this.interactions = this.interactions.slice(-50);
    this.log({ type: 'incoming', kind: 'event', eventType, data });

    if (eventType === 'load-view' && data && typeof data.name === 'string') {
      this.handleLoad(data.name);
      return;
    }

    // Gate any `action` event behind an explicit user approval. `navigate`,
    // `refresh`, and other signaling events pass through as before.
    if (eventType === 'action') {
      this.requestApproval(eventType, data);
      return;
    }

    await this.runTurn(this.formatEventPrompt(eventType, data) + this.interactionContext());
  }

  handleSave(name) {
    if (!name || typeof name !== 'string') {
      this.emitError({ source: 'user', code: 'bad_args', severity: 'info', recoverable: true, message: 'save: missing name' });
      return;
    }
    if (this.transcript.length === 0) {
      this.emitError({ source: 'user', code: 'empty_transcript', severity: 'info', recoverable: true, message: 'save: nothing to save yet — chat first' });
      return;
    }
    const dir = viewDir(this.cwd);
    fs.mkdirSync(dir, { recursive: true });
    const payload = {
      name,
      cwd: this.cwd,
      thread_id: this.threadId,
      messages: this.transcript,
      source: latestSourceFromMessages(this.transcript),
      interactions: this.interactions,
      saved_at: Date.now(),
    };
    fs.writeFileSync(viewFile(this.cwd, name), JSON.stringify(payload, null, 2));
    this.send('system', `saved "${name}" (${this.transcript.length} messages)`);
  }

  handleLoad(name) {
    const file = viewFile(this.cwd, name);
    if (!fs.existsSync(file)) {
      this.emitError({
        source: 'user',
        code: 'view_not_found',
        severity: 'info',
        recoverable: true,
        message: `load: no view named "${name}" for this directory`,
      });
      return;
    }
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      this.emitError({
        source: 'bridge',
        code: 'view_corrupt',
        severity: 'warn',
        recoverable: true,
        message: `load: corrupt save file: ${err.message}`,
        details: { file, err: err.message },
      });
      return;
    }
    this.threadId = saved.thread_id || null;
    this.cwd = saved.cwd || this.cwd;
    this.transcript = safeMessages(saved.messages);
    this.interactions = safeInteractions(saved.interactions);
    this.pendingForkContext = null;
    this.clearQueuedTurns('load');
    this.ws.send(JSON.stringify({
      type: 'restore',
      name,
      messages: this.transcript,
      source: typeof saved.source === 'string' ? saved.source : latestSourceFromMessages(this.transcript),
      interactions: this.interactions,
    }));
    this.log({ type: 'load', name, thread_id: this.threadId, cwd: this.cwd });
  }

  handleListViews() {
    this.ws.send(JSON.stringify({ type: 'views_list_result', views: listViewSummaries(this.cwd) }));
  }

  handleForkView(name) {
    if (typeof name !== 'string' || !name.trim()) {
      this.emitError({ source: 'user', code: 'view_bad_args', severity: 'info', recoverable: true, message: 'fork: missing save name' });
      return;
    }
    const file = viewFile(this.cwd, name.trim());
    if (fs.existsSync(file)) {
      let saved;
      try {
        saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        this.emitError({
          source: 'bridge',
          code: 'view_corrupt',
          severity: 'warn',
          recoverable: true,
          message: `fork: corrupt save file: ${err.message}`,
          details: { file, err: err.message },
        });
        return;
      }
      const messages = safeMessages(saved.messages);
      const interactions = safeInteractions(saved.interactions);
      const source = typeof saved.source === 'string'
        ? saved.source
        : latestSourceFromMessages(messages);
      const view = {
        name: saved.name || name.trim(),
        messages,
        source,
        interactions,
      };

      this.threadId = null;
      this.transcript = messages;
      this.interactions = interactions;
      this.pendingForkContext = savedViewContextPrompt(view);
      this.clearQueuedTurns('fork');
      this.killHotSpare();
      this.ws.send(JSON.stringify({ type: 'view_forked', view }));
      this.log({ type: 'fork-view', name: view.name, messages: messages.length });
      return;
    }

    this.emitError({
      source: 'user',
      code: 'view_not_found',
      severity: 'info',
      recoverable: true,
      message: `fork: no save named "${name}" for this directory`,
    });
  }

  runCodex(args, { stdinChunk } = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(CODEX_BIN, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
        });
      } catch (err) {
        resolve({ code: -1, stdout: '', stderr: err.message });
        return;
      }
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr || err.message }));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      if (stdinChunk !== undefined) {
        try { child.stdin.end(stdinChunk); } catch { /* child already gone */ }
      } else {
        try { child.stdin.end(); } catch { /* child already gone */ }
      }
    });
  }

  async handleMcpList() {
    const { code, stdout, stderr } = await this.runCodex(['mcp', 'list', '--json']);
    this.log({ type: 'mcp-list', code, stderrTail: stderr.slice(-400) });
    if (code !== 0) {
      this.emitError({
        source: 'codex',
        code: 'mcp_list_failed',
        severity: 'error',
        recoverable: true,
        message: `codex mcp list failed (exit ${code}): ${stderr.trim().slice(-300) || '(no stderr)'}`,
      });
      return;
    }
    let servers;
    try {
      servers = JSON.parse(stdout);
    } catch (err) {
      this.emitError({
        source: 'bridge',
        code: 'mcp_list_parse',
        severity: 'error',
        recoverable: true,
        message: `could not parse codex mcp list output: ${err.message}`,
        details: { stdoutTail: stdout.slice(-400) },
      });
      return;
    }
    if (!Array.isArray(servers)) servers = [];
    this.ws.send(JSON.stringify({ type: 'mcp_list_result', servers }));
  }

  async handleMcpAdd(payload) {
    if (!payload || typeof payload !== 'object' || typeof payload.name !== 'string' || !payload.name.trim()) {
      this.emitError({
        source: 'user', code: 'mcp_add_bad_args', severity: 'info', recoverable: true,
        message: 'mcp add: missing name',
      });
      return;
    }
    const name = payload.name.trim();
    const args = ['mcp', 'add'];

    if (payload.transport === 'http') {
      if (!payload.url || typeof payload.url !== 'string') {
        this.emitError({ source: 'user', code: 'mcp_add_bad_args', severity: 'info', recoverable: true, message: 'mcp add: http transport requires url' });
        return;
      }
      args.push(name, '--url', payload.url);
      if (payload.bearerTokenEnvVar) args.push('--bearer-token-env-var', payload.bearerTokenEnvVar);
    } else {
      // stdio (default)
      if (!payload.command || typeof payload.command !== 'string') {
        this.emitError({ source: 'user', code: 'mcp_add_bad_args', severity: 'info', recoverable: true, message: 'mcp add: stdio transport requires command' });
        return;
      }
      if (payload.env && typeof payload.env === 'object') {
        for (const [k, v] of Object.entries(payload.env)) {
          if (typeof v === 'string' && k) args.push('--env', `${k}=${v}`);
        }
      }
      args.push(name, '--', payload.command, ...(Array.isArray(payload.args) ? payload.args : []));
    }

    const { code, stderr } = await this.runCodex(args);
    const ok = code === 0;
    this.log({ type: 'mcp-add', name, transport: payload.transport, code, stderrTail: stderr.slice(-400) });
    const message = ok ? null : `codex mcp add failed (exit ${code}): ${stderr.trim().slice(-300) || '(no stderr)'}`;
    this.ws.send(JSON.stringify({
      type: 'mcp_op_result',
      result: { op: 'add', name, ok, message: message ?? undefined },
    }));
    if (ok) this.killHotSpare(); // new config — next turn must cold-spawn to pick it up
  }

  async handleMcpRemove(name) {
    if (typeof name !== 'string' || !name.trim()) {
      this.emitError({
        source: 'user', code: 'mcp_remove_bad_args', severity: 'info', recoverable: true,
        message: 'mcp remove: missing name',
      });
      return;
    }
    const { code, stderr } = await this.runCodex(['mcp', 'remove', name.trim()]);
    const ok = code === 0;
    this.log({ type: 'mcp-remove', name, code, stderrTail: stderr.slice(-400) });
    const message = ok ? null : `codex mcp remove failed (exit ${code}): ${stderr.trim().slice(-300) || '(no stderr)'}`;
    this.ws.send(JSON.stringify({
      type: 'mcp_op_result',
      result: { op: 'remove', name, ok, message: message ?? undefined },
    }));
    if (ok) this.killHotSpare();
  }

  handleDeleteView(name) {
    const file = viewFile(this.cwd, name);
    if (!fs.existsSync(file)) {
      this.emitError({
        source: 'user',
        code: 'view_not_found',
        severity: 'info',
        recoverable: true,
        message: `delete: no view named "${name}"`,
      });
      return;
    }
    fs.unlinkSync(file);
    this.send('system', `deleted "${name}"`);
  }
}

const wss = new WebSocketServer({ port: PORT });
console.log(`shapeshiftui codex bridge on ws://localhost:${PORT}`);
console.log(`  sandbox: ${SANDBOX}   binary: ${CODEX_BIN}   cwd: ${CODEX_CWD}`);
console.log(`  model:   ${CODEX_MODEL || '(codex default)'}`);

wss.on('connection', (ws) => {
  const session = new Session(ws);
  console.log(`client connected → ${session.logFile}`);
  session.send('ai', 'Connected to ShapeshifTUI (Codex backend). Ask for anything — I can run tools and render live UIs.');

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      logSilent('wire_parse_failed', 'client sent non-JSON message; dropped', err);
      return;
    }
    if (msg.type === 'init') {
      session.handleInit(msg);
    } else if (msg.type === 'chat') {
      session.handleChat(msg.content, msg.interactions);
    } else if (msg.type === 'event') {
      session.handleEvent(msg.eventType, msg.data);
    } else if (msg.type === 'save') {
      session.handleSave(msg.name);
    } else if (msg.type === 'load') {
      session.handleLoad(msg.name);
    } else if (msg.type === 'list-views') {
      session.handleListViews();
    } else if (msg.type === 'delete-view') {
      session.handleDeleteView(msg.name);
    } else if (msg.type === 'approval_response') {
      session.handleApprovalResponse(msg.id, !!msg.approved);
    } else if (msg.type === 'cancel') {
      session.handleCancel();
    } else if (msg.type === 'mcp-list') {
      session.handleMcpList();
    } else if (msg.type === 'mcp-add') {
      session.handleMcpAdd(msg.payload);
    } else if (msg.type === 'mcp-remove') {
      session.handleMcpRemove(msg.name);
    } else if (msg.type === 'fork-view') {
      session.handleForkView(msg.name);
    }
  });

  ws.on('close', () => {
    console.log('client disconnected');
    session.log({ type: 'disconnect' });
    // Suppress the 'turn cancelled' message on child close — there's no
    // client left to receive it.
    session.cancelled = true;
    session.clearQueuedTurns('disconnect');
    try { session.currentChild?.kill('SIGTERM'); } catch { /* already dead */ }
    session.killHotSpare();
  });
});

process.on('SIGINT', () => {
  console.log('\nshutting down');
  wss.close();
  process.exit(0);
});
