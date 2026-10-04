/**
 * 电脑上「存到哪个文件夹」的选择抽屉（保存弹窗选了「电脑」那一档之后进来）。
 *
 * 数据源复用远程树的 `remoteList`，行样式沿用文件树那一套（48dp、目录在前、缩进一层 14px），
 * 但**不把 FileTreeSidebar 塞进弹窗**：那一身绑着标签脏点、离线队列标记、跨文件搜索、
 * 长按菜单与边缘滑入关闭，选位置一样都用不上，带进来只会多出一堆「在这一层里根本不该出现」
 * 的入口（其中新建/重命名那几条今天还会误走 SAF 桥，见 fileOps.ts 的远程分支）。
 *
 * 只列目录，且只允许选到**桌面确实列出来过**的那一层：新建文件要落的位置由服务端校验，
 * 这里凭空拼一条路径出去只会换来一句看不懂的下级错误。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Folder, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useT } from '../../lib/i18nContext';
import { makeRemotePath, parseRemotePath, remoteList, type RemoteEntry } from '../../lib/remote';
import { appAlert } from '../../lib/appAlert';
import { Sheet } from './Sheet';

interface RemoteFolderSheetProps {
  isDarkMode: boolean;
  /** 标题那一行给的人话设备名 */
  deviceName: string;
  /** 进来的时候已经选在哪一层（远程路径形态；裸根 = `hide-remote://<设备>`） */
  pickedPath: string;
  /** 确认：把选中的那一层以远程路径交回去，并带上它的人话名字。
      名字必须一起给 —— 根那一层的尾段是 keyId 那串十六进制，拿它当标签等于把身份键摆到界面上 */
  onConfirm: (path: string, name: string) => void;
  onClose: () => void;
}

/** 一层的列举状态。`entries` 缺席且没有 loading = 还没展开过，一次请求都不发 */
type DirState = { loading?: boolean; entries?: RemoteEntry[] };

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function RemoteFolderSheet({ isDarkMode, deviceName, pickedPath, onConfirm, onClose }: RemoteFolderSheetProps) {
  const t = useT();
  /* 远程路径的身份键里 device 段是 keyId，换一次连接就换一个：这里全程按**相对路径**记状态，
     只在交出结果时拼回远程路径，于是重连之后这份状态不会指向另一台机器 */
  const deviceId = parseRemotePath(pickedPath)?.deviceId ?? '';
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ '': true });
  const [rel, setRel] = useState(() => parseRemotePath(pickedPath)?.rel ?? '');
  const [rootName, setRootName] = useState('');

  const load = useCallback(async (at: string) => {
    setDirs(d => ({ ...d, [at]: { ...d[at], loading: true } }));
    try {
      const r = await remoteList(at);
      setDirs(d => ({ ...d, [at]: { loading: false, entries: r.entries } }));
      // 只有列根那一次桌面给得出那层文件夹叫什么
      if (!at && r.rootName) setRootName(r.rootName);
    } catch (e) {
      /* 列不出来就在这行下面说一句，不要弹一屏模态：用户还在选位置，
         模态会把抽屉关掉，而那正是他要点回来的地方 */
      setDirs(d => ({ ...d, [at]: { loading: false } }));
      appAlert(errText(e));
    }
  }, []);

  useEffect(() => {
    void load('');
  }, [load]);

  /* 展开的层按深度摊平成行；目录在前的顺序是桌面 `list` 那份排序口径给的，不在这里再排 */
  const rows = useMemo(() => {
    const out: { rel: string; name: string; depth: number }[] = [];
    const walk = (parent: string, depth: number) => {
      if (!expanded[parent]) return;
      for (const e of dirs[parent]?.entries ?? []) {
        if (!e.isDir) continue;
        const child = parent ? `${parent}/${e.name}` : e.name;
        out.push({ rel: child, name: e.name, depth });
        if (expanded[child]) walk(child, depth + 1);
      }
    };
    walk('', 0);
    return out;
  }, [dirs, expanded]);

  const toggle = (at: string) => {
    setExpanded(prev => {
      const next = { ...prev, [at]: !prev[at] };
      if (next[at] && !prev[at] && !dirs[at]?.entries) void load(at);
      return next;
    });
  };

  const targetName = rel ? (rel.split('/').filter(Boolean).pop() ?? '') : (rootName || deviceName);
  const rootLoadedEmpty = dirs['']?.entries !== undefined && rows.length === 0;

  return (
    <Sheet open isDarkMode={isDarkMode} onClose={onClose} zClass="z-[93]" panelClass="heid-narrow-sheet"
      title={`${deviceName} · ${t('folder.pickTitle')}`}>
      <div className="px-2 pt-1 pb-2">
        <button
          onClick={() => { setRel(''); setExpanded(p => ({ ...p, '': true })); }}
          className={cn(
            'flex w-full items-center gap-2 rounded-xl px-2 min-h-[48px] text-left',
            rel === '' ? (isDarkMode ? 'bg-emerald-600/20' : 'bg-emerald-50') : 'active:bg-zinc-500/10'
          )}
        >
          <Folder size={16} className={rel === '' ? 'text-emerald-500' : 'text-zinc-400'} />
          <span className={cn('flex-1 truncate text-base', isDarkMode ? 'text-zinc-100' : 'text-zinc-800')}>
            {rootName || t('folder.root')}
          </span>
          {rel === '' && <Check size={16} className="text-emerald-500" />}
        </button>
        {rows.map(row => {
          const state = dirs[row.rel];
          const isOpen = !!expanded[row.rel];
          const picked = row.rel === rel;
          return (
            <button
              key={row.rel}
              onClick={() => { setRel(row.rel); toggle(row.rel); }}
              className={cn(
                'flex w-full items-center gap-1.5 rounded-xl px-2 min-h-[48px] text-left',
                picked ? (isDarkMode ? 'bg-emerald-600/20' : 'bg-emerald-50') : 'active:bg-zinc-500/10'
              )}
              style={{ paddingLeft: 8 + row.depth * 14 }}
            >
              {isOpen
                ? <ChevronDown size={14} className="shrink-0 text-zinc-400" />
                : <ChevronRight size={14} className="shrink-0 text-zinc-400" />}
              <Folder size={16} className={picked ? 'text-emerald-500' : 'text-zinc-400'} />
              <span className={cn('flex-1 truncate text-base', isDarkMode ? 'text-zinc-100' : 'text-zinc-800')}>
                {row.name}
              </span>
              {state?.loading && <Loader2 size={14} className="animate-spin text-zinc-400" />}
              {picked && !state?.loading && <Check size={16} className="text-emerald-500" />}
            </button>
          );
        })}
        {rootLoadedEmpty && (
          <div className={cn('px-3 py-4 text-sm', isDarkMode ? 'text-zinc-400' : 'text-zinc-500')}>
            {t('folder.empty')}
          </div>
        )}
      </div>
      <div className={cn('flex items-center gap-2 border-t px-4 py-2', isDarkMode ? 'border-zinc-700' : 'border-zinc-200')}>
        <div className={cn('min-w-0 flex-1 text-xs', isDarkMode ? 'text-zinc-400' : 'text-zinc-500')}>
          {t('folder.target')}{targetName}
        </div>
        <button
          onClick={onClose}
          className={cn(
            'h-12 rounded-xl px-4 text-base font-medium active:opacity-70',
            isDarkMode ? 'bg-zinc-700 text-zinc-200' : 'bg-zinc-200 text-zinc-700'
          )}
        >
          {t('common.back')}
        </button>
        <button
          onClick={() => onConfirm(makeRemotePath(deviceId, rel), targetName)}
          className="h-12 rounded-xl px-4 text-base font-medium bg-emerald-600 text-white active:opacity-80"
        >
          {t('folder.confirm')}
        </button>
      </div>
    </Sheet>
  );
}
