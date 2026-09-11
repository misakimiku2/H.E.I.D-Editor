import React, { useEffect, useRef, useState } from 'react';
import { X, ImagePlus, Trash2 } from 'lucide-react';
import { cn } from '../lib/utils';

/* ---- 插入图片弹窗：本地（可多选）/ 网络链接（可多条），带缩略图预览 ---- */

export interface InsertImage {
  name: string;
  src: string;
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'];

/* 预览图：本地绝对路径经 convertFileSrc 转换，网络/数据 URL 直接使用 */
const PreviewThumb = React.memo<{ img: InsertImage }>(({ img }) => {
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
        const { convertFileSrc } = await import('@tauri-apps/api/core');
        const p = /^[A-Za-z]:/.test(img.src) ? '/' + img.src.replace(/\\/g, '/') : img.src;
        if (!cancelled) setSrc(convertFileSrc(p));
      } catch {
        if (!cancelled) setSrc('');
      }
    })();
    return () => { cancelled = true; };
  }, [img.src]);

  if (broken || !src) {
    return (
      <div className="w-full h-20 rounded-md border border-dashed border-zinc-400/50 flex flex-col items-center justify-center text-zinc-400 text-[10px] gap-1">
        <ImagePlus size={16} />
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
      className="w-full h-20 object-cover rounded-md border"
    />
  );
});

PreviewThumb.displayName = 'PreviewThumb';

export const ImageInsertModal = React.memo<{
  isDarkMode: boolean;
  onConfirm: (images: InsertImage[]) => void;
  onClose: () => void;
}>(({ isDarkMode, onConfirm, onClose }) => {
  const [tab, setTab] = useState<'local' | 'url'>('local');
  const [images, setImages] = useState<InsertImage[]>([]);
  const [urlInput, setUrlInput] = useState('');
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

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
        filters: [{ name: '图片', extensions: IMAGE_EXTENSIONS }],
      });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      paths.forEach(p => {
        const name = p.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || '图片';
        addImage({ name, src: p });
      });
    } catch (e) {
      setError('无法打开文件选择器');
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
      setError('请输入有效的 http(s) 图片链接');
      return;
    }
    let name = '图片';
    try {
      const seg = new URL(u).pathname.split('/').filter(Boolean).pop();
      if (seg) name = decodeURIComponent(seg).replace(/\.[^.]+$/, '') || '图片';
    } catch { /* 保持默认名 */ }
    addImage({ name, src: u });
    setUrlInput('');
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-zinc-950/30 backdrop-blur-md"
        onClick={onClose}
      />
      <div className={cn(
        "relative w-[440px] rounded-2xl border shadow-2xl p-5 flex flex-col gap-3",
        isDarkMode ? "border-zinc-700 bg-zinc-800/95 text-zinc-100" : "border-zinc-200 bg-white/95 text-zinc-800"
      )}>
        <button
          onClick={onClose}
          className={cn(
            "absolute top-3 right-3 p-1 rounded-md transition-colors",
            isDarkMode ? "hover:bg-zinc-700 text-zinc-400" : "hover:bg-zinc-200 text-zinc-500"
          )}
          title="关闭"
        >
          <X size={14} />
        </button>
        <div className="text-sm font-semibold">插入图片</div>

        {/* 来源切换：本地 | 网络 */}
        <div
          role="group"
          aria-label="图片来源"
          className={cn(
            "flex items-center rounded-full p-0.5 w-fit",
            isDarkMode ? "bg-zinc-700/60" : "bg-zinc-200/80"
          )}
        >
          {([
            { key: 'local', label: '本地图片' },
            { key: 'url', label: '网络图片' },
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
          <div className="flex flex-col gap-2">
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
              选择本地图片（可多选）
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
              <p className="text-[10px] opacity-50">浏览器模式下图片将以 base64 数据嵌入文档，体积较大；桌面端仅记录本地路径。</p>
            )}
          </div>
        )}

        {/* 网络：输入链接，逐条添加 */}
        {tab === 'url' && (
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <input
                value={urlInput}
                onChange={(e) => { setUrlInput(e.target.value); setError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') addUrl(); }}
                placeholder="https://example.com/image.png"
                className={cn(
                  "flex-1 px-3 py-2 rounded-lg text-xs outline-none border transition-colors",
                  isDarkMode
                    ? "bg-zinc-900/60 border-zinc-600 focus:border-indigo-400 text-zinc-200 placeholder:text-zinc-500"
                    : "bg-white border-zinc-300 focus:border-indigo-400 text-zinc-800 placeholder:text-zinc-400"
                )}
              />
              <button
                onClick={addUrl}
                className={cn(
                  "px-3 rounded-lg text-xs font-medium transition-colors",
                  isDarkMode ? "bg-indigo-600 hover:bg-indigo-500 text-white" : "bg-indigo-600 hover:bg-indigo-500 text-white"
                )}
              >
                添加
              </button>
            </div>
            <p className="text-[10px] opacity-50">可连续添加多条链接，插入后逐行排列。</p>
          </div>
        )}

        {error && <div className="text-[11px] text-red-500">{error}</div>}

        {/* 已选图片预览 */}
        {images.length > 0 ? (
          <div className="grid grid-cols-3 gap-2 max-h-44 overflow-auto pr-1">
            {images.map(img => (
              <div key={img.src} className="relative group">
                <PreviewThumb img={img} />
                <button
                  onClick={() => removeImage(img.src)}
                  className={cn(
                    "absolute -top-1.5 -right-1.5 w-4.5 h-4.5 p-1 rounded-full shadow transition-colors flex items-center justify-center",
                    isDarkMode ? "bg-zinc-700 hover:bg-red-500 text-zinc-300" : "bg-white hover:bg-red-500 hover:text-white text-zinc-500 border"
                  )}
                  title="移除"
                >
                  <Trash2 size={9} />
                </button>
                <div className="mt-0.5 text-[9px] opacity-60 truncate text-center" title={img.name}>{img.name}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className={cn(
            "h-16 rounded-lg flex items-center justify-center text-[11px] border border-dashed",
            isDarkMode ? "border-zinc-600 text-zinc-500" : "border-zinc-300 text-zinc-400"
          )}>
            尚未选择图片
          </div>
        )}

        {/* 底部操作 */}
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className={cn(
              "px-3 py-1.5 text-xs rounded-lg transition-colors",
              isDarkMode ? "bg-zinc-700 hover:bg-zinc-600 text-zinc-300" : "bg-zinc-200 hover:bg-zinc-300 text-zinc-600"
            )}
          >
            取消
          </button>
          <button
            onClick={() => onConfirm(images)}
            disabled={images.length === 0}
            className={cn(
              "px-4 py-1.5 text-xs rounded-lg font-medium transition-colors bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40 disabled:cursor-not-allowed"
            )}
          >
            插入{images.length > 0 ? `（${images.length} 张）` : ''}
          </button>
        </div>
      </div>
    </div>
  );
});

ImageInsertModal.displayName = 'ImageInsertModal';
