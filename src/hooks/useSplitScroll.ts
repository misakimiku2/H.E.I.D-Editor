/**
 * Markdown 分屏同步滚动：按滚动比例映射到另一侧，带短时锁防止回环。
 * 两侧滚动容器由 App 经 attach 回调登记（CodeEditor / MarkdownPreview 的 onScroller）。
 */
import { useCallback, useRef } from 'react';

export function useSplitScroll() {
  const editorScrollerRef = useRef<HTMLElement | null>(null);
  const previewScrollerRef = useRef<HTMLElement | null>(null);
  const scrollLockRef = useRef<{ owner: 'editor' | 'preview'; until: number } | null>(null);

  const syncScrollFrom = useCallback((owner: 'editor' | 'preview') => {
    const el = owner === 'editor' ? editorScrollerRef.current : previewScrollerRef.current;
    const other = owner === 'editor' ? previewScrollerRef.current : editorScrollerRef.current;
    if (!el || !other) return;
    const now = performance.now();
    const lock = scrollLockRef.current;
    if (lock && lock.owner !== owner && now < lock.until) return;
    scrollLockRef.current = { owner, until: now + 80 };
    const max = el.scrollHeight - el.clientHeight;
    const otherMax = other.scrollHeight - other.clientHeight;
    if (max <= 0 || otherMax <= 0) return;
    other.scrollTop = (el.scrollTop / max) * otherMax;
  }, []);

  const handleEditorScroll = useCallback(() => syncScrollFrom('editor'), [syncScrollFrom]);
  const handlePreviewScroll = useCallback(() => syncScrollFrom('preview'), [syncScrollFrom]);

  const attachEditorScroller = useCallback((el: HTMLElement | null) => {
    const prev = editorScrollerRef.current;
    if (prev && prev !== el) prev.removeEventListener('scroll', handleEditorScroll);
    editorScrollerRef.current = el;
    if (el) el.addEventListener('scroll', handleEditorScroll, { passive: true });
  }, [handleEditorScroll]);

  const attachPreviewScroller = useCallback((el: HTMLElement | null) => {
    const prev = previewScrollerRef.current;
    if (prev && prev !== el) prev.removeEventListener('scroll', handlePreviewScroll);
    previewScrollerRef.current = el;
    if (el) el.addEventListener('scroll', handlePreviewScroll, { passive: true });
  }, [handlePreviewScroll]);

  return { attachEditorScroller, attachPreviewScroller };
}
