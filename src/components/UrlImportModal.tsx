import { useEffect, useState } from 'react';
import { Link2, Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import { importFromFetched, type UrlFetchResult, type UrlImportResult } from '../lib/urlImport';
import { renderFetch } from '../lib/renderFetch';

interface UrlImportModalProps {
  isDarkMode: boolean;
  onImported: (result: UrlImportResult) => void;
  onClose: () => void;
}

/** 网址导入弹窗：输入 URL → 原生抓取 → 提取正文转 Markdown → 新标签页打开 */
export function UrlImportModal({ isDarkMode, onImported, onClose }: UrlImportModalProps) {
  const t = useT();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const submit = async () => {
    const u = url.trim();
    if (!/^https?:\/\/\S+$/i.test(u)) {
      setError(t('import.errUrl'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const fetched = await invoke<UrlFetchResult>('http_get', { url: u });
      /* 编排在 importFromFetched：静态转换 → 正文过短/失败时渲染兜底 → 择优 */
      const result = await importFromFetched(
        fetched.text,
        fetched.final_url,
        () => renderFetch(fetched.final_url),
        phase => setRendering(phase === 'rendering'),
      );
      onImported(result);
    } catch (e: any) {
      setError(String(e?.message ?? e).replace(/^"|"$/g, ''));
    } finally {
      setBusy(false);
      setRendering(false);
    }
  };

  const inputCls = cn(
    "w-full px-3 py-2 rounded-lg text-xs outline-none border transition-colors",
    isDarkMode
      ? "bg-zinc-900/60 border-zinc-600 focus:border-indigo-400 text-zinc-200 placeholder:text-zinc-500"
      : "bg-white border-zinc-300 focus:border-indigo-400 text-zinc-800 placeholder:text-zinc-400",
  );

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-zinc-950/30 backdrop-blur-md" onClick={() => { if (!busy) onClose(); }} />
      <div className={cn(
        "relative w-[460px] max-w-[92vw] rounded-2xl border shadow-2xl p-5 flex flex-col gap-3",
        isDarkMode ? "border-zinc-700 bg-zinc-800/95 text-zinc-100" : "border-zinc-200 bg-white/95 text-zinc-800",
      )}>
        <div className="text-sm font-semibold shrink-0">{t('import.title')}</div>
        <div className="flex gap-2">
          <input
            autoFocus
            value={url}
            onChange={(e) => { setUrl(e.target.value); setError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void submit(); }}
            placeholder={t('import.urlPlaceholder')}
            spellCheck={false}
            className={inputCls}
          />
          <button
            onClick={() => void submit()}
            disabled={busy}
            className={cn(
              "px-3 rounded-lg text-xs font-medium transition-colors shrink-0 flex items-center gap-1.5 disabled:opacity-50",
              "bg-indigo-600 hover:bg-indigo-500 text-white",
            )}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
            {busy ? (rendering ? t('import.rendering') : t('import.fetching')) : t('import.fetch')}
          </button>
        </div>
        {error && <div className="text-[11px] text-red-500 shrink-0">{error}</div>}
        <p className="text-[10px] opacity-50 shrink-0">{t('import.note')}</p>
      </div>
    </div>
  );
}
