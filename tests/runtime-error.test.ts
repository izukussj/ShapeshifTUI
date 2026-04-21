import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { Runtime } from '../src/runtime.js';

describe('Runtime render errors', () => {
  it('captures invalid Ink trees instead of throwing out of the app', async () => {
    const onError = vi.fn();
    const app = render(React.createElement(Runtime, {
      source: '() => (<Text><Box><Text>bad</Text></Box></Text>)',
      sendEvent: () => {},
      submitEvent: () => {},
      context: { events: [] },
      focused: true,
      scrollOffset: 0,
      availableRows: 12,
      onCompileError: onError,
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      source: 'runtime',
      code: 'render_failed',
      message: expect.stringContaining('can’t be nested inside <Text>'),
    }));
    expect(app.lastFrame()).toContain('Render error');

    app.unmount();
  });
});
