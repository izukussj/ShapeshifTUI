import React from 'react';
import path from 'node:path';
import net from 'node:net';
import fs from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { render } from 'ink';
import { App } from './app.js';
import { Client } from './client.js';
import { setMouseEnabled } from './mouse.js';

function enterAltScreen() {
  process.stdout.write('\x1b[?1049h\x1b[H');
}

function exitAltScreen() {
  setMouseEnabled(false);
  process.stdout.write('\x1b[?1049l');
}

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
const SANDBOX_MODES: SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
const DEFAULT_BRIDGE_PORT = 8080;
const FALLBACK_BRIDGE_PORTS = Array.from({ length: 20 }, (_, i) => DEFAULT_BRIDGE_PORT + i);
const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));

interface CliArgs {
  url: string;
  urlProvided: boolean;
  cwd: string;
  serve: boolean;
  sandbox: SandboxMode | null;
}

export function readPackageVersion(startDir = CLI_DIR): string {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof pkg.version === 'string') return pkg.version;
    }

    const parent = path.dirname(dir);
    if (parent === dir) return 'unknown';
    dir = parent;
  }
}

export function helpText(version = readPackageVersion()): string {
  return [
    `Usage: shapeshiftui [ws-url] [options]`,
    '',
    `ShapeshifTUI ${version}`,
    '',
    `Launches the TUI. If no URL is given, spawns the Codex bridge on :${DEFAULT_BRIDGE_PORT}.`,
    '',
    'Options:',
    '  --cwd <path>           run codex from this directory (default: current directory)',
    '  --write                allow codex to edit files in the workspace',
    '                         (shorthand for --sandbox workspace-write)',
    '  --sandbox <mode>       set codex sandbox mode explicitly:',
    '                           read-only             default; no writes (safest)',
    '                           workspace-write       edits within --cwd only',
    '                           danger-full-access    no sandboxing (use with care)',
    '  --no-serve             skip spawning a bridge (use when one is already running)',
    '  -v, --version          print the shapeshiftui version and exit',
    '  -h, --help             show this help and exit',
  ].join('\n');
}

function parseArgs(argv: string[]): CliArgs {
  let url = `ws://localhost:${DEFAULT_BRIDGE_PORT}`;
  let urlProvided = false;
  let cwd = path.resolve(process.cwd());
  let serve = true;
  let sandbox: SandboxMode | null = null;
  const setSandbox = (mode: SandboxMode, flag: string) => {
    if (sandbox && sandbox !== mode) {
      throw new Error(`Conflicting sandbox flags: already set to "${sandbox}", got ${flag} (${mode})`);
    }
    sandbox = mode;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') {
      const next = argv[++i];
      if (!next) throw new Error('--cwd requires a path argument');
      cwd = path.resolve(next);
    } else if (a === '--no-serve') {
      serve = false;
    } else if (a === '--write' || a === '--writable') {
      // Shorthand for --sandbox workspace-write: codex may edit files in cwd.
      setSandbox('workspace-write', a);
    } else if (a === '--sandbox') {
      const next = argv[++i];
      if (!next) throw new Error(`--sandbox requires one of: ${SANDBOX_MODES.join(', ')}`);
      if (!SANDBOX_MODES.includes(next as SandboxMode)) {
        throw new Error(`--sandbox: unknown mode "${next}" — expected one of: ${SANDBOX_MODES.join(', ')}`);
      }
      setSandbox(next as SandboxMode, '--sandbox');
    } else if (a === '--help' || a === '-h') {
      console.log(helpText());
      process.exit(0);
    } else if (a === '--version' || a === '-v') {
      console.log(readPackageVersion());
      process.exit(0);
    } else if (a && !a.startsWith('--')) {
      url = a;
      urlProvided = true;
    }
  }
  return { url, urlProvided, cwd, serve, sandbox };
}

export function bridgeUrlWithPort(url: string, port: number): string {
  const u = new URL(url);
  u.port = String(port);
  return u.toString();
}

export async function firstFreePort(
  host: string,
  ports: readonly number[],
  isPortOpen: (host: string, port: number) => Promise<boolean> = probePort,
): Promise<number | null> {
  for (const port of ports) {
    if (!(await isPortOpen(host, port))) return port;
  }
  return null;
}

function probePort(host: string, port: number, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
    sock.connect(port, host);
  });
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePort(host, port)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function hasBinary(name: string): boolean {
  const result = spawnSync(name, ['--version'], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  return result.status === 0 || (result.status === null && !result.error);
}

type Backend = { label: string; script: string };

function pickBackend(): Backend | null {
  if (hasBinary('codex')) {
    return { label: 'Codex', script: 'codex-bridge.js' };
  }
  if (process.env.OPENAI_API_KEY) {
    return { label: 'OpenAI', script: 'bridge.js' };
  }
  return null;
}

async function spawnBridge(url: string, sandbox: SandboxMode | null): Promise<ChildProcess> {
  const u = new URL(url);
  const port = Number(u.port) || 8080;
  const host = u.hostname || 'localhost';

  if (await probePort(host, port)) {
    return null as unknown as ChildProcess;
  }

  const backend = pickBackend();
  if (!backend) {
    throw new Error(
      'No backend available.\n' +
      '  Install Codex CLI:   brew install codex && codex login\n' +
      '                       (or: npm install -g @openai/codex && codex login)\n' +
      '  Or set OPENAI_API_KEY in your environment / .env.local.',
    );
  }

  const bridgePath = fileURLToPath(new URL(`../server/${backend.script}`, import.meta.url));
  const sandboxNote = sandbox ? ` [sandbox: ${sandbox}]` : '';
  process.stderr.write(`starting ${backend.label} bridge on ws://${host}:${port}${sandboxNote}…\n`);

  const child = spawn(process.execPath, [bridgePath], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      CODEX_BRIDGE_PORT: String(port),
      PORT: String(port),
      // Flag wins over inherited env so `--write` survives a stale shell.
      ...(sandbox ? { CODEX_SANDBOX: sandbox } : {}),
    },
  });

  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });

  const ready = await waitForPort(host, port, 10000);
  if (!ready) {
    child.kill();
    const hint = stderrTail.trim() ? `\n\nBridge stderr:\n${stderrTail.trim()}` : '';
    throw new Error(`${backend.label} bridge did not start on :${port} within 10s.${hint}`);
  }
  return child;
}

async function spawnBridgeOnFreePort(
  baseUrl: string,
  sandbox: SandboxMode | null,
  ports = FALLBACK_BRIDGE_PORTS,
): Promise<{ url: string; child: ChildProcess }> {
  const u = new URL(baseUrl);
  const host = u.hostname || 'localhost';
  const port = await firstFreePort(host, ports);
  if (port === null) {
    throw new Error(`No free bridge port found in range ${ports[0]}-${ports[ports.length - 1]}.`);
  }

  const nextUrl = bridgeUrlWithPort(baseUrl, port);
  const child = await spawnBridge(nextUrl, sandbox);
  if (!child) {
    throw new Error(`Bridge port ${port} became unavailable before startup; retry the command.`);
  }

  return { url: nextUrl, child };
}

async function connectClient(url: string): Promise<Client> {
  const client = new Client(url);
  try {
    await client.waitForOpen();
    return client;
  } catch (err) {
    client.close();
    throw err;
  }
}

async function main() {
  const { url, urlProvided, cwd, serve, sandbox } = parseArgs(process.argv.slice(2));
  let effectiveUrl = url;

  if (sandbox && urlProvided) {
    process.stderr.write(
      `note: --sandbox/--write only applies when spawning a bridge. ` +
      `Connecting to an existing bridge at ${url} — its sandbox is whatever that process was started with.\n`,
    );
  }

  let bridgeChild: ChildProcess | null = null;
  if (serve && !urlProvided) {
    try {
      const child = await spawnBridge(effectiveUrl, sandbox);
      bridgeChild = child ?? null;
    } catch (err) {
      console.error(`\n${(err as Error).message}\n`);
      process.exit(1);
    }
  }

  let client: Client;
  try {
    client = await connectClient(effectiveUrl);
  } catch (err) {
    bridgeChild?.kill();
    bridgeChild = null;

    if (!serve || urlProvided) {
      console.error(`Failed to connect to ${effectiveUrl}: ${(err as Error).message}`);
      process.exit(1);
    }

    try {
      const occupiedPort = Number(new URL(effectiveUrl).port) || DEFAULT_BRIDGE_PORT;
      const fallbackPorts = FALLBACK_BRIDGE_PORTS.filter((port) => port !== occupiedPort);
      process.stderr.write(
        `failed to connect to ${effectiveUrl}; trying a free fallback port…\n`,
      );
      const fallback = await spawnBridgeOnFreePort(effectiveUrl, sandbox, fallbackPorts);
      effectiveUrl = fallback.url;
      bridgeChild = fallback.child;
      client = await connectClient(effectiveUrl);
    } catch (fallbackErr) {
      bridgeChild?.kill();
      console.error(
        `Failed to connect to ${url}: ${(err as Error).message}\n` +
        `Fallback failed: ${(fallbackErr as Error).message}`,
      );
      process.exit(1);
    }
  }

  client.send({ type: 'init', cwd });

  enterAltScreen();
  // Mouse on by default — set SHAPESHIFTUI_MOUSE=0 to disable at launch.
  if (process.env.SHAPESHIFTUI_MOUSE !== '0') setMouseEnabled(true);

  const cleanup = () => {
    exitAltScreen();
    bridgeChild?.kill();
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  process.on('uncaughtException', (err) => {
    cleanup();
    console.error(err);
    process.exit(1);
  });

  const { waitUntilExit } = render(<App client={client} />);
  await waitUntilExit();
  client.close();
  bridgeChild?.kill();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    exitAltScreen();
    console.error(err);
    process.exit(1);
  });
}
