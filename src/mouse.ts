import React, { useState, useEffect, useRef } from 'react';
import { EventEmitter } from 'node:events';
import type { DOMElement } from 'ink';

export interface MouseEvent {
  x: number;
  y: number;
  button: number;
  type: 'press' | 'release' | 'motion' | 'wheel';
  direction?: 'up' | 'down' | 'left' | 'right';
}

const MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const mouseEmitter = new EventEmitter();
mouseEmitter.setMaxListeners(0);

/**
 * Parses SGR mouse escape sequences out of a chunk of stdin data.
 * Returns the extracted events plus the chunk with mouse bytes stripped.
 * Pure function — exported for unit testing.
 */
export function parseMouseChunk(str: string): { events: MouseEvent[]; cleaned: string } {
  MOUSE_RE.lastIndex = 0;
  const events: MouseEvent[] = [];
  let match: RegExpExecArray | null;
  while ((match = MOUSE_RE.exec(str)) !== null) {
    const rawBtn = parseInt(match[1]!, 10);
    const button = rawBtn & 3;
    const isWheel = (rawBtn & 64) !== 0;
    const isMotion = (rawBtn & 32) !== 0;
    const x = parseInt(match[2]!, 10) - 1;
    const y = parseInt(match[3]!, 10) - 1;
    if (isWheel) {
      const direction =
        button === 0 ? 'up' :
        button === 1 ? 'down' :
        button === 2 ? 'left' :
        'right';
      events.push({ button, x, y, type: 'wheel', direction });
      continue;
    }
    events.push({
      button,
      x,
      y,
      type: isMotion ? 'motion' : match[4] === 'M' ? 'press' : 'release',
    });
  }
  const cleaned = events.length === 0 ? str : str.replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, '');
  return { events, cleaned };
}

export function enableMouse(): void {
  // 1003 = all-motion tracking (needed for hover); 1006 = SGR coord format.
  process.stdout.write('\x1b[?1003h\x1b[?1006h');
}

export function disableMouse(): void {
  process.stdout.write('\x1b[?1006l\x1b[?1003l');
}

let uninstall: (() => void) | null = null;
let mouseOn = false;

export function setMouseEnabled(enabled: boolean): boolean {
  if (enabled && !uninstall) {
    uninstall = installMouseInterceptor();
    enableMouse();
    mouseOn = true;
  } else if (!enabled && uninstall) {
    disableMouse();
    uninstall();
    uninstall = null;
    mouseOn = false;
  }
  return mouseOn;
}

export function isMouseEnabled(): boolean {
  return mouseOn;
}

/**
 * Patches process.stdin.read() so mouse escape sequences are stripped from the
 * chunk before Ink's keypress parser sees them. Otherwise Ink treats them as
 * typed text and floods TextInput with garbage on every click. Mouse events are
 * re-emitted on an internal EventEmitter.
 *
 * Must be called before ink's render() so we win the patch race.
 */
export function installMouseInterceptor(): () => void {
  const stdin = process.stdin as unknown as {
    read: (size?: number) => string | Buffer | null;
  };
  const originalRead = stdin.read.bind(stdin);

  stdin.read = function patchedRead(size?: number) {
    const chunk = originalRead(size);
    if (chunk == null) return chunk;

    const isBuffer = Buffer.isBuffer(chunk);
    const str = isBuffer ? chunk.toString('utf8') : (chunk as string);

    const { events, cleaned } = parseMouseChunk(str);
    if (events.length === 0) return chunk;
    for (const e of events) mouseEmitter.emit('mouse', e);
    if (cleaned.length === 0) return isBuffer ? Buffer.alloc(0) : '';
    return isBuffer ? Buffer.from(cleaned, 'utf8') : cleaned;
  };

  return () => { stdin.read = originalRead; };
}

export function onMouse(handler: (e: MouseEvent) => void): () => void {
  mouseEmitter.on('mouse', handler);
  return () => { mouseEmitter.off('mouse', handler); };
}

function getAbsolutePosition(element: DOMElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let node: any = element;
  while (node?.yogaNode) {
    x += node.yogaNode.getComputedLeft();
    y += node.yogaNode.getComputedTop();
    node = node.parentNode;
  }
  return { x, y };
}

export function hitTest(element: DOMElement, clickX: number, clickY: number): boolean {
  const yoga = (element as any).yogaNode;
  if (!yoga) return false;
  const { x, y } = getAbsolutePosition(element);
  const w = yoga.getComputedWidth();
  const h = yoga.getComputedHeight();
  return clickX >= x && clickX < x + w && clickY >= y && clickY < y + h;
}

/**
 * Fires `onClick` exactly once per physical left-press over the referenced
 * element. Uses a ref for the callback so onClick identity changes (common when
 * parents re-render and pass a new closure) don't re-fire or resubscribe.
 */
export function useMouseClick(
  ref: React.RefObject<DOMElement | null>,
  onClick: () => void,
): void {
  const cbRef = useRef(onClick);
  useEffect(() => { cbRef.current = onClick; });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (e.type !== 'press' || e.button !== 0) return;
      if (ref.current && hitTest(ref.current, e.x, e.y)) cbRef.current();
    };
    mouseEmitter.on('mouse', handler);
    return () => { mouseEmitter.off('mouse', handler); };
  }, [ref]);
}

/**
 * Returns true while the cursor is over the referenced element. Subscribes to
 * the mouse emitter directly (not through React context) so motion events don't
 * cascade a re-render through every consumer. setState is idempotent — React
 * bails out when the value is unchanged, so only actual enter/leave re-renders.
 */
export function useMouseHover(ref: React.RefObject<DOMElement | null>): boolean {
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!ref.current) return;
      const inside = hitTest(ref.current, e.x, e.y);
      setHovered((prev) => (prev !== inside ? inside : prev));
    };
    mouseEmitter.on('mouse', handler);
    return () => { mouseEmitter.off('mouse', handler); };
  }, [ref]);

  return hovered;
}
