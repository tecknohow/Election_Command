import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Positions its child near the pointer, flipping sides / clamping so it never leaves the
 * viewport. When `pinned`, it accepts pointer events (scroll, close button).
 */
export function FloatingCard({ x, y, pinned, children }: { x: number; y: number; pinned: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x + 18, top: y + 18 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x + 22;
    let top = y - height / 2;
    if (left + width + pad > vw) left = x - width - 22;
    if (left < pad) left = pad;
    if (top + height + pad > vh) top = vh - height - pad;
    if (top < 56) top = 56;
    setPos({ left, top });
  }, [x, y, children]);

  return (
    <div ref={ref} className={`floating-card ${pinned ? 'pinned' : ''}`} style={{ left: pos.left, top: pos.top }} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}
