import { describe, expect, it } from 'vitest';
import {
  deriveChatDraftState,
  normalizePastedText,
  pastedDraftLabel,
  type ChatDraftState,
} from '../src/chat.js';

describe('chat paste handling', () => {
  it('normalizes bracketed paste markers and line endings', () => {
    expect(normalizePastedText('\x1B[200~one\r\ntwo\rthree\x1B[201~')).toBe('one\ntwo\nthree');
  });

  it('collapses multiline input into a pasted payload', () => {
    const state = deriveChatDraftState({ draft: '', pastedText: null }, 'first\nsecond\nthird');

    expect(state).toEqual({
      draft: '',
      pastedText: 'first\nsecond\nthird',
    });
    expect(pastedDraftLabel(state.pastedText!)).toBe('Pasted 3 lines, 18 chars');
  });

  it('keeps single-line input editable', () => {
    const state = deriveChatDraftState({ draft: '', pastedText: null }, 'plain prompt');

    expect(state).toEqual({
      draft: 'plain prompt',
      pastedText: null,
    });
  });

  it('clears pasted payload when the placeholder is edited backward', () => {
    const current: ChatDraftState = { draft: '', pastedText: 'a\nb\nc' };
    const state = deriveChatDraftState(current, 'Pasted 3 lines, 5 char');

    expect(state).toEqual({
      draft: '',
      pastedText: null,
    });
  });
});
