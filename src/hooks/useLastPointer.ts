import { useEffect, useRef } from 'react';

export interface PointerPos {
  x: number;
  y: number;
}

/**
 * 全局指针位置跟踪（ref 存储，不触发重渲染）。
 * 返回读取函数；指针尚未移动过时回退到视口右上区域（搜索栏默认落点）。
 */
export function useLastPointer(): () => PointerPos {
  const ref = useRef<PointerPos>({ x: -1, y: -1 });
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      ref.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);
  return () => {
    const p = ref.current;
    if (p.x < 0 || p.y < 0) {
      return { x: Math.max(24, window.innerWidth - 600), y: 12 };
    }
    return p;
  };
}
