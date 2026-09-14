import React, { useEffect, useMemo, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';

/**
 * SVG 可视化编辑工作台：左侧源码编辑器（由 App 传入），右侧实时预览。
 * 预览经 blob URL 以 <img> 渲染——SVG 作为图片加载时内部脚本不执行、外部资源不加载，天然安全；
 * 源码停顿 180ms 后刷新；窄屏（手机）自动上下堆叠。
 */
export const SvgWorkbench = React.memo<{
  /** 实时源码（标签页内容） */
  content: string;
  isDarkMode: boolean;
  /** 窄屏：预览堆叠在源码下方 */
  stacked?: boolean;
  /** 源码编辑器（App 的 renderEditor()，带全部既有接线） */
  children: React.ReactNode;
}>(({ content, isDarkMode, stacked, children }) => {
  const t = useT();

  /* 预览解析防抖：连续输入停顿 180ms 后才重新渲染（与 markdown 预览同策略） */
  const [rendered, setRendered] = useState(content);
  useEffect(() => {
    if (content === rendered) return;
    const id = setTimeout(() => setRendered(content), 180);
    return () => clearTimeout(id);
  }, [content, rendered]);

  /* 源码 → blob URL；旧 URL 在效果清理时回收，避免泄漏 */
  const [url, setUrl] = useState('');
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (!rendered.trim()) { setUrl(''); setInvalid(false); return; }
    const blob = new Blob([rendered], { type: 'image/svg+xml' });
    const u = URL.createObjectURL(blob);
    setUrl(u);
    setInvalid(false);
    return () => URL.revokeObjectURL(u);
  }, [rendered]);

  /* 透明区域棋盘格底（跟随主题） */
  const checker = useMemo(() => ({
    backgroundImage: isDarkMode
      ? 'conic-gradient(#27272a 0 25%, #3f3f46 0 50%, #27272a 0 75%, #3f3f46 0)'
      : 'conic-gradient(#e4e4e7 0 25%, #f4f4f5 0 50%, #e4e4e7 0 75%, #f4f4f5 0)',
    backgroundSize: '16px 16px',
  }), [isDarkMode]);

  return (
    <div className={cn('flex min-w-0 flex-1 overflow-hidden', stacked ? 'flex-col' : 'flex-row')}>
      <div className={cn('min-w-0 overflow-hidden', stacked ? 'h-1/2 shrink-0' : 'w-[55%] shrink-0')}>
        {children}
      </div>
      <div className={cn('shrink-0', stacked ? 'h-px w-full' : 'h-full w-px', isDarkMode ? 'bg-zinc-700' : 'bg-zinc-200')} />
      <div className="flex min-w-0 flex-1 items-center justify-center overflow-auto p-3" style={checker}>
        {url && !invalid ? (
          <img
            src={url}
            alt="SVG"
            draggable={false}
            onError={() => setInvalid(true)}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <div className={cn(
            'flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-4 text-xs',
            isDarkMode ? 'border-zinc-600 text-zinc-500' : 'border-zinc-300 text-zinc-400',
          )}>
            <ImageOff size={18} />
            <span>{invalid ? t('svg.invalid') : t('svg.empty')}</span>
          </div>
        )}
      </div>
    </div>
  );
});

SvgWorkbench.displayName = 'SvgWorkbench';
