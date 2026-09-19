import React, { useEffect, useRef, useState } from 'react';
import { X, ImagePlus, Trash2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import type { SourceSnippet } from './MarkdownPreview';

/* ---- 插入图片弹窗：本地（可多选）/ 网络链接（可多条），带缩略图预览 ----
   顶部源码框显示右键位置的上下文（最多 7 行），移动光标即可精确选择插入点 */

export interface InsertImage {
  name: string;
  src: string;
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'];

const MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon',
};

/* 本地路径 → 可预览 URL：优先 fs 读为 blob（不依赖资源协议配置），失败回退 convertFileSrc */
const previewUrlCache = new Map<string, string>();

async function resolvePreviewUrl(path: string): Promise<string> {
  const cached = previewUrlCache.get(path);
  if (cached) return cached;
  try {
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const data = await readFile(path);
    const ext = path.split('.').pop()?.toLowerCase() || 'png';
    const blob = new Blob([new Uint8Array(data)], { type: MIME_MAP[ext] || 'image/png' });
    const url = URL.createObjectURL(blob);
    previewUrlCache.set(path, url);
    return url;
  } catch {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    const p = /^[A-Za-z]:/.test(path) ? '/' + path.replace(/\\/g, '/') : path;
    return convertFileSrc(p);
  }
}

const PreviewThumb = React.memo<{ img: InsertImage; isDarkMode: boolean }>(({ img, isDarkMode }) => {
  const [src, setSrc] = useState('');
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    setBroken(false);
    if (/^(https?:|data:)/.test(img.src)) {
      setSrc(img.src);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const url = await resolvePreviewUrl(img.src);
        if (!cancelled) {
          if (url) setSrc(url);
          else setBroken(true);
        }
      } catch {
        if (!cancelled) setBroken(true);
      }
    })();
    return () => { cancelled = true; };
  }, [img.src]);

  if (broken || !src) {
    return (
      <div className={cn(
        "w-full h-20 rounded-md border border-dashed flex flex-col items-center justify-center text-[10px] gap-1 overflow-hidden",
        isDarkMode ? "border-zinc-600 text-zinc-500" : "border-zinc-300 text-zinc-400"
      )}>
        <ImagePlus size={16} className="shrink-0" />
        <span className="px-1 truncate max-w-full">{img.name}</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={img.name}
      loading="lazy"
      onError={() => setBroken(true)}
      className={cn(
        "block w-full h-20 object-cover rounded-md border",
        isDarkMode ? "border-zinc-600" : "border-zinc-200"
      )}
    />
  );
});

PreviewThumb.displayName = 'PreviewThumb';

export const ImageInsertModal = React.memo<{
  isDarkMode: boolean;
  snippet: SourceSnippet;
  /** absolutePos = snippet.start + 源码框内光标偏移 */
  onConfirm: (images: InsertImage[], absolutePos: number) => void;
  onClose: () => void;
}>(({ isDarkMode, snippet, onConfirm, onClose }) => {
  const t = useT();
  const [tab, setTab] = useState<'local' | 'url'>('local');
  const [images, setImages] = useState<InsertImage[]>([]);
  const [urlInput, setUrlInput] = useState('');
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const snippetRef = useRef<HTMLTextAreaElement | null>(null);

  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

  /* 挂载后聚焦源码框并把光标放到右键位置 */
  useEffect(() => {
    const ta = snippetRef.current;
    if (!ta) return;
    ta.focus();
    const pos = Math.min(Math.max(0, snippet.caret), snippet.text.length);
    ta.setSelectionRange(pos, pos);
  }, [snippet]);

  /* Esc 关闭 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const addImage = (img: InsertImage) => {
    setError('');
    setImages(prev => prev.some(i => i.src === img.src) ? prev : [...prev, img]);
  };

  const removeImage = (src: string) => {
    setImages(prev => prev.filter(i => i.src !== src));
  };

  const pickLocalTauri = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        multiple: true,
        directory: false,
        filters: [{ name: t('image.filterName'), extensions: IMAGE_EXTENSIONS }],
      });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      paths.forEach(p => {
        const name = p.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || t('image.defaultName');
        addImage({ name, src: p });
      });
    } catch {
      setError(t('image.errPicker'));
    }
  };

  const pickLocalWeb = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    Array.from(files).forEach(f => {
      if (!f.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => {
        addImage({ name: f.name.replace(/\.[^.]+$/, ''), src: String(reader.result) });
      };
      reader.readAsDataURL(f);
    });
  };

  const addUrl = () => {
    const u = urlInput.trim();
    if (!/^https?:\/\/\S+$/.test(u)) {
      setError(t('image.errUrl'));
      return;
    }
    let name = t('image.defaultName');
    try {
      const seg = new URL(u).pathname.split('/').filter(Boolean).pop();
      if (seg) name = decodeURIComponent(seg).replace(/\.[^.]+$/, '') || t('image.defaultName');
    } catch { /* 保持默认名 */ }
    addImage({ name, src: u });
    setUrlInput('');
  };

  const confirm = () => {
    if (images.length === 0) return;
    const ta = snippetRef.current;
    const caret = ta ? ta.selectionStart : snippet.caret;
    onConfirm(images, snippet.start + caret);
  };

  /* 源码框只作定位用：放行光标移动/全选/复制，拦截一切会修改内容的输入（含中文输入法） */
  const SNIPPET_NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
  const blockSnippetEdit = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (SNIPPET_NAV_KEYS.has(e.key)) return;
    if ((e.ctrlKey || e.metaKey) && ['a', 'c'].includes(e.key.toLowerCase())) return;
    e.preventDefault();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-zinc-950/30 backdrop-blur-md"
        onClick={onClose}
      />
      <div className={cn(
        "relative w-[460px] max-w-[92vw] max-h-[550px] rounded-2xl border shadow-2xl p-5 flex flex-col gap-3",
        isDarkMode ? "border-zinc-700 bg-zinc-800/95 text-zinc-100" : "border-zinc-200 bg-white/95 text-zinc-800"
      )}>
        <button
          onClick={onClose}
          className={cn(
            "absolute top-3 right-3 p-1 rounded-md transition-colors",
            isDarkMode ? "hover:bg-zinc-700 text-zinc-400" : "hover:bg-zinc-200 text-zinc-500"
          )}
          title={t('common.close')}
        >
          <X size={14} />
        </button>
        <div className="text-sm font-semibold shrink-0">{t('image.title')}</div>

        {/* 源码上下文：光标位置 = 插入点 */}
        <div className="flex flex-col gap-1 shrink-0">
          <div className={cn("text-[10px]", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
            {t('image.snippetLabel')}
          </div>
          <textarea
            ref={snippetRef}
            rows={7}
            spellCheck={false}
            value={snippet.text}
            onKeyDown={blockSnippetEdit}
            onPaste={(e) => e.preventDefault()}
            onDrop={(e) => e.preventDefault()}
            onCompositionStart={(e) => e.preventDefault()}
            className={cn(
              "w-full box-border px-3 py-2 rounded-lg text-xs outline-none border transition-colors resize-none font-mono leading-5 whitespace-pre overflow-auto caret-indigo-500",
              isDarkMode
                ? "bg-zinc-900/60 border-zinc-600 focus:border-indigo-400 text-zinc-200"
                : "bg-white border-zinc-300 focus:border-indigo-400 text-zinc-800"
            )}
          />
        </div>

        {/* 来源切换：本地 | 网络 */}
        <div
          role="group"
          aria-label={t('image.sourceGroup')}
          className={cn(
            "flex items-center rounded-full p-0.5 w-fit shrink-0",
            isDarkMode ? "bg-zinc-700/60" : "bg-zinc-200/80"
          )}
        >
          {([
            { key: 'local', label: t('image.tabLocal') },
            { key: 'url', label: t('image.tabUrl') },
          ] as const).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                "px-3 h-6 rounded-full text-xs font-medium transition-all",
                tab === key
                  ? (isDarkMode ? "bg-zinc-600 text-zinc-100 shadow-sm" : "bg-white text-zinc-700 shadow-sm")
                  : (isDarkMode ? "text-zinc-500 hover:text-zinc-300" : "text-zinc-500 hover:text-zinc-700")
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* 本地：选择文件（Tauri 原生多选 / Web 文件输入多选） */}
        {tab === 'local' && (
          <div className="flex flex-col gap-2 shrink-0">
            <button
              onClick={() => {
                if (isTauri) pickLocalTauri();
                else fileInputRef.current?.click();
              }}
              className={cn(
                "w-full py-2.5 rounded-lg text-xs font-medium border border-dashed transition-colors flex items-center justify-center gap-2",
                isDarkMode
                  ? "border-zinc-600 hover:bg-zinc-700/50 text-zinc-300"
                  : "border-zinc-300 hover:bg-zinc-50 text-zinc-600"
              )}
            >
              <ImagePlus size={14} />
              {t('image.pickLocal')}
            </button>
            {!isTauri && (
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*"
                className="hidden"
                onChange={(e) => { pickLocalWeb(e.target.files); e.target.value = ''; }}
              />
            )}
            {!isTauri && (
              <p className="text-[10px] opacity-50">{t('image.webEmbedNote')}</p>
            )}
          </div>
        )}

        {/* 网络：输入链接，逐条添加 */}
        {tab === 'url' && (
          <div className="flex flex-col gap-2 shrink-0">
            <div className="flex gap-2">
              <input
                value={urlInput}
                onChange={(e) => { setUrlInput(e.target.value); setError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') addUrl(); }}
                placeholder="https://example.com/image.png"
                className={cn(
                  "flex-1 min-w-0 px-3 py-2 rounded-lg text-xs outline-none border transition-colors",
                  isDarkMode
                    ? "bg-zinc-900/60 border-zinc-600 focus:border-indigo-400 text-zinc-200 placeholder:text-zinc-500"
                    : "bg-white border-zinc-300 focus:border-indigo-400 text-zinc-800 placeholder:text-zinc-400"
                )}
              />
              <button
                onClick={addUrl}
                className={cn(
                  "px-3 rounded-lg text-xs font-medium pointer-coarse:min-h-[44px] transition-colors shrink-0",
                  "bg-indigo-600 hover:bg-indigo-500 text-white"
                )}
              >
                {t('image.add')}
              </button>
            </div>
            <p className="text-[10px] opacity-50">{t('image.urlNote')}</p>
          </div>
        )}

        {error && <div className="text-[11px] text-red-500 shrink-0">{error}</div>}

        {/* 已选图片预览：区域弹性伸缩，仅纵向滚动；内边距给删除按钮留出空间 */}
        {images.length > 0 ? (
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pt-2 pr-2 -mt-1">
            <div className="grid grid-cols-3 gap-2">
              {images.map(img => (
                <div key={img.src} className="relative group min-w-0">
                  <PreviewThumb img={img} isDarkMode={isDarkMode} />
                  <button
                    onClick={() => removeImage(img.src)}
                    className={cn(
                      "absolute -top-1.5 -right-1.5 w-[18px] h-[18px] p-1 rounded-full shadow transition-colors flex items-center justify-center",
                      isDarkMode ? "bg-zinc-700 hover:bg-red-500 text-zinc-300" : "bg-white hover:bg-red-500 hover:text-white text-zinc-500 border"
                    )}
                    title={t('image.remove')}
                  >
                    <Trash2 size={9} />
                  </button>
                  <div className="mt-0.5 text-[9px] opacity-60 truncate text-center" title={img.name}>{img.name}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className={cn(
            "h-16 rounded-lg flex items-center justify-center text-[11px] border border-dashed shrink-0",
            isDarkMode ? "border-zinc-600 text-zinc-500" : "border-zinc-300 text-zinc-400"
          )}>
            {t('image.none')}
          </div>
        )}

        {/* 底部操作 */}
        <div className="flex justify-end gap-2 pt-1 shrink-0">
          <button
            onClick={onClose}
            className={cn(
              "px-3 py-1.5 text-xs rounded-lg pointer-coarse:min-h-[44px] pointer-coarse:text-sm transition-colors",
              isDarkMode ? "bg-zinc-700 hover:bg-zinc-600 text-zinc-300" : "bg-zinc-200 hover:bg-zinc-300 text-zinc-600"
            )}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={confirm}
            disabled={images.length === 0}
            className={cn(
              "px-4 py-1.5 text-xs rounded-lg font-medium pointer-coarse:min-h-[44px] pointer-coarse:text-sm transition-colors bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40 disabled:cursor-not-allowed"
            )}
          >
            {images.length > 0 ? t('image.insertCount', { n: images.length }) : t('image.insert')}
          </button>
        </div>
      </div>
    </div>
  );
});

ImageInsertModal.displayName = 'ImageInsertModal';
