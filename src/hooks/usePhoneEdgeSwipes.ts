import { useEffect, useRef } from 'react';

/**
 * 手机端左右边缘的「拉开」手势：左边缘 → 文件树，右边缘 → 标签页抽屉。
 *
 * 走 touch 流而不是 pointer 流：编辑器那一侧的处理器会在 ~9 CSS px 就发 `pointercancel`
 * 把 pointer 流掐掉（见 `FileTreeSidebar` 里收合树那一段的同款取舍），touchmove 在那之后仍继续派发。
 */

/** 系统给返回手势留的那一档：模拟器实测 CSS 23 起手被判成返回、27.8 不再触发（约 25dp）。
    起手带从它内侧开始——贴着物理屏幕边的那一下无论如何都归系统，应用抢不到。 */
const EDGE_INNER = 32;
/** 起手带宽度：再往里这么一档算「从边缘起手」 */
const EDGE_WIDTH = 48;
/** 向内走出这么多 CSS px 才算一次拉开；没到就不 preventDefault，点按与光标定位照常 */
const COMMIT_PX = 48;

export interface PhoneEdgeSwipesOptions {
  enabled: boolean;
  /** 有弹层摊开时不接（左滑不该在相机层上把文件树拉出来） */
  blocked: () => boolean;
  onLeftEdge: () => void;
  onRightEdge: () => void;
}

export function usePhoneEdgeSwipes({ enabled, blocked, onLeftEdge, onRightEdge }: PhoneEdgeSwipesOptions) {
  const handlers = useRef({ blocked, onLeftEdge, onRightEdge });
  useEffect(() => {
    handlers.current = { blocked, onLeftEdge, onRightEdge };
  });

  useEffect(() => {
    if (!enabled) return;
    /* side：-1 = 左边缘起手向右拉，1 = 右边缘起手向左拉，0 = 这一串不接 */
    const st = { x: 0, y: 0, side: 0 as 0 | 1 | -1, fired: false };

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      const w = window.innerWidth;
      /* 最外 EDGE_INNER 那一档归系统返回，从它内侧才算起手 */
      const inLeft = t.clientX >= EDGE_INNER && t.clientX <= EDGE_INNER + EDGE_WIDTH;
      const inRight = t.clientX <= w - EDGE_INNER && t.clientX >= w - EDGE_INNER - EDGE_WIDTH;
      st.side = inLeft ? -1 : inRight ? 1 : 0;
      st.x = t.clientX;
      st.y = t.clientY;
      st.fired = false;
    };

    const onMove = (e: TouchEvent) => {
      if (!st.side || st.fired) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - st.x;
      const dy = t.clientY - st.y;
      /* 竖向为主 = 在滚页面，整个手势让出去 */
      if (Math.abs(dy) >= Math.abs(dx)) { st.side = 0; return; }
      /* 只认朝屏幕内侧走的那一下：左边缘起手向右为正，右边缘起手向左为正 */
      if (dx * -st.side < COMMIT_PX) return;
      if (handlers.current.blocked()) { st.side = 0; return; }
      st.fired = true;
      e.preventDefault();
      if (st.side < 0) handlers.current.onLeftEdge();
      else handlers.current.onRightEdge();
    };

    const onEnd = () => { st.side = 0; st.fired = false; };
    const opts = { capture: true, passive: false } as const;
    document.addEventListener('touchstart', onStart, opts);
    document.addEventListener('touchmove', onMove, opts);
    document.addEventListener('touchend', onEnd, opts);
    document.addEventListener('touchcancel', onEnd, opts);
    return () => {
      document.removeEventListener('touchstart', onStart, opts);
      document.removeEventListener('touchmove', onMove, opts);
      document.removeEventListener('touchend', onEnd, opts);
      document.removeEventListener('touchcancel', onEnd, opts);
    };
  }, [enabled]);
}
