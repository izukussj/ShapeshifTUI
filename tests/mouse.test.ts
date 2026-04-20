import { describe, it, expect } from 'vitest';
import { parseMouseChunk } from '../src/mouse.js';

describe('parseMouseChunk', () => {
  it('parses a left-button press (SGR, 1-indexed → 0-indexed)', () => {
    const { events, cleaned } = parseMouseChunk('\x1b[<0;10;5M');
    expect(events).toEqual([{ button: 0, x: 9, y: 4, type: 'press' }]);
    expect(cleaned).toBe('');
  });

  it('parses a release (lowercase m)', () => {
    const { events } = parseMouseChunk('\x1b[<0;10;5m');
    expect(events).toEqual([{ button: 0, x: 9, y: 4, type: 'release' }]);
  });

  it('treats button-bit 32 as motion regardless of M/m', () => {
    // Mode 1003 motion with no button: rawBtn=35 (32|3). button = 35 & 3 = 3.
    const hoverNoButton = parseMouseChunk('\x1b[<35;10;5M');
    expect(hoverNoButton.events).toEqual([{ button: 3, x: 9, y: 4, type: 'motion' }]);

    // Motion with left drag: rawBtn=32 (32|0). button = 0.
    const drag = parseMouseChunk('\x1b[<32;10;5M');
    expect(drag.events).toEqual([{ button: 0, x: 9, y: 4, type: 'motion' }]);
  });

  it('parses wheel packets separately from button presses', () => {
    const { events, cleaned } = parseMouseChunk('\x1b[<64;10;5M\x1b[<65;10;5M');
    expect(events).toEqual([
      { button: 0, x: 9, y: 4, type: 'wheel', direction: 'up' },
      { button: 1, x: 9, y: 4, type: 'wheel', direction: 'down' },
    ]);
    expect(cleaned).toBe('');
  });

  it('extracts multiple events from one chunk and strips mouse bytes', () => {
    const input = 'a\x1b[<0;1;1Mb\x1b[<0;2;2mc';
    const { events, cleaned } = parseMouseChunk(input);
    expect(events).toEqual([
      { button: 0, x: 0, y: 0, type: 'press' },
      { button: 0, x: 1, y: 1, type: 'release' },
    ]);
    expect(cleaned).toBe('abc');
  });

  it('returns the chunk unchanged when there are no mouse bytes', () => {
    const input = 'hello\x1b[A'; // arrow-up escape, not a mouse sequence
    const { events, cleaned } = parseMouseChunk(input);
    expect(events).toEqual([]);
    expect(cleaned).toBe(input);
  });

  it('is safe to call repeatedly (regex lastIndex reset)', () => {
    const input = '\x1b[<0;5;5M';
    const first = parseMouseChunk(input);
    const second = parseMouseChunk(input);
    expect(first.events).toEqual(second.events);
    expect(first.events).toHaveLength(1);
  });
});
