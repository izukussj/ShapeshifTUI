import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridgeUrlWithPort, firstFreePort, helpText, isCliEntrypoint, readPackageVersion } from '../src/cli.js';

describe('CLI bridge port helpers', () => {
  it('rewrites the port while preserving the URL host and protocol', () => {
    expect(bridgeUrlWithPort('ws://localhost:8080', 8083)).toBe('ws://localhost:8083/');
    expect(bridgeUrlWithPort('ws://127.0.0.1:8080', 8090)).toBe('ws://127.0.0.1:8090/');
  });

  it('returns the first closed port in order', async () => {
    const open = new Set([8080, 8081]);
    const port = await firstFreePort('localhost', [8080, 8081, 8082, 8083], async (_host, candidate) =>
      open.has(candidate),
    );

    expect(port).toBe(8082);
  });

  it('returns null when every candidate port is open', async () => {
    const port = await firstFreePort('localhost', [8080, 8081], async () => true);

    expect(port).toBeNull();
  });

  it('includes the version option in help output', () => {
    expect(helpText('1.2.3')).toContain('ShapeshifTUI 1.2.3');
    expect(helpText('1.2.3')).toContain('-v, --version');
  });

  it('reads package version by walking up from a nested directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'shapeshiftui-version-'));
    try {
      const nested = join(root, 'dist', 'nested');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '9.8.7' }));

      expect(readPackageVersion(nested)).toBe('9.8.7');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats npm bin symlinks as the CLI entrypoint', () => {
    const root = mkdtempSync(join(tmpdir(), 'shapeshiftui-entrypoint-'));
    try {
      const realCli = join(root, 'lib', 'node_modules', 'shapeshiftui', 'dist', 'cli.js');
      const bin = join(root, 'bin', 'shapeshiftui');
      mkdirSync(join(root, 'bin'), { recursive: true });
      mkdirSync(join(root, 'lib', 'node_modules', 'shapeshiftui', 'dist'), { recursive: true });
      writeFileSync(realCli, '');
      symlinkSync(realCli, bin);

      expect(isCliEntrypoint(bin, pathToFileURL(realCli).toString())).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
