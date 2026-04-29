import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Chat } from '../src/chat.js';

const stripAnsi = (value: string): string =>
  value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');

describe('Chat layout', () => {
  it('wraps long input inside the chat pane', async () => {
    const app = render(React.createElement(Chat, {
      messages: [],
      onSend: () => {},
      focused: true,
      scrollOffset: 0,
      onScrollOffsetChange: () => {},
      width: 30,
      availableRows: 12,
      captureTabRef: { current: false },
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    app.stdin.write('abcdefghijklmnopqrstuvwxyz0123456789');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const lines = stripAnsi(app.lastFrame() ?? '').split('\n');
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(30);
    expect(lines.some((line) => line.includes('abcdef'))).toBe(true);
    expect(lines.some((line) => line.includes('yz012345'))).toBe(true);

    app.unmount();
  });
});
