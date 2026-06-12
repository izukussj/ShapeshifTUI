import { describe, expect, it } from 'vitest';
import { bridgeUrlWithPort, firstFreePort } from '../src/cli.js';

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
});
