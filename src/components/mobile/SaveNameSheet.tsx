/**
 * 安卓保存前的确认抽屉：一次问清 **叫什么** 与 **存手机还是存电脑**。
 *
 * 名字必须在这里问：EMUI 的系统保存框按 MIME 强补 .txt，用户在系统框里改扩展名应用永远
 * 拿不到真名（返回的是 xx.md.txt）。目的地也必须在这里问：那张系统框根本不认识「那台电脑」，
 * 存过去走的是链路上一条 `create`，没有系统框可走。
 *
 * 没连着桌面（或桌面那侧没开文件夹树）时**整排目的地都不摆** —— 摆一颗点不出结果的
 * 「电脑」比不摆更糟，那等于让用户去猜是自己哪里没配对好。
 *
 * 停靠在窗口底缘、键盘之上（.heid-savename-dock 读 --heid-kb，WebView 不因输入法收缩视口）；
 * 返回键经 OverlayState 关这层（resolve(null) = 取消保存）。
 */
import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, Folder, Monitor, Smartphone } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useT } from '../../lib/i18nContext';
import { formatBytes } from '../../lib/largeFile';
import type { RemoteOccupied, SaveTarget } from '../../lib/fileIO';
import { decodeRemoteSegment, makeRemotePath, parseRemotePath, remoteScope } from '../../lib/remote';
import { fetchStatus } from '../../lib/link';
import { RemoteFolderSheet } from './RemoteFolderSheet';

interface SaveNameSheetProps {
  defaultName: string;
  isDarkMode: boolean;
  /** 桌面上那个位置被占着的现场；有它就是「撞名之后再问一次」那一趟 */
  occupied?: RemoteOccupied;
  onResolve: (target: SaveTarget | null) => void;
}

/** 那台电脑能不能收这一份的探测上限：链路假活时那条请求要等满 30 秒才失败 */
const DESKTOP_PROBE_MS = 3000;

/** 连着的那台电脑，以及能不能往它身上存 */
interface DesktopTarget {
  deviceId: string;
  deviceName: string;
  /** 共享根那一层的远程路径（默认目的地） */
  rootPath: string;
}

export function SaveNameSheet({ defaultName, isDarkMode, occupied, onResolve }: SaveNameSheetProps) {
  const t = useT();
  const [value, setValue] = useState(defaultName);
  /* 撞名再问的那一趟是**重新挂载**的一层：目的地与选中的文件夹要从 `occupied` 里接回来，
     否则默认的「本机」会悄悄生效 —— 屏幕上写着「覆盖电脑上那份」，存出来的却在手机里
     （2026-10-04 模拟器上实拍到的一刀）。 */
  const [dest, setDest] = useState<'local' | 'desktop'>(occupied?.dest ?? 'local');
  const [desktop, setDesktop] = useState<DesktopTarget | null>(null);
  const [dir, setDir] = useState<string>(occupied?.dir ?? '');
  /** 选中的那一层的人话名字（选择抽屉交回来时一起给的；根那一层的尾段是 keyId，不能拿来显示） */
  const [dirName, setDirName] = useState<string>(() => folderTail(occupied?.dir));
  const [folderOpen, setFolderOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /* 打开即聚焦并全选：多数时候只是改扩展名，敲一个字就能覆盖原标题 */
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  /* 这台电脑能不能收这一份：连着 + 有身份键 + 那侧确实开着文件夹树。
     问不到就什么都不摆（`remoteScope` 一次轻探测，不搬目录）。
     探测带 3 秒上限：链路"看着连着其实断了"时那条请求要等满 30 秒才失败，
     而这一层是用户正准备敲名字的地方 —— 让一个可能根本不出现的选项把他卡在半路，
     比这次不摆这一档更糟（下一次保存会重新问）。 */
  useEffect(() => {
    let alive = true;
    void (async () => {
      const s = await fetchStatus().catch(() => null);
      if (!alive || !s?.connected || !s.peerKeyId) return;
      const probe = await Promise.race([
        remoteScope().catch(() => null),
        new Promise<null>(r => setTimeout(() => r(null), DESKTOP_PROBE_MS)),
      ]);
      if (!alive || !probe?.hasRoot) return;
      setDesktop({
        deviceId: s.peerKeyId,
        deviceName: s.peerDevice || s.peerKeyId.slice(0, 8),
        rootPath: makeRemotePath(s.peerKeyId, ''),
      });
    })();
    return () => { alive = false; };
  }, []);

  const chosenDir = dir || desktop?.rootPath || '';
  /* 名字没动就是「还要那一个位置」：这时主按钮的意思只能是覆盖。
     改了名字就回到「保存」，让桌面按新名字再判一次。 */
  const sameName = !!occupied && value.trim() === occupied.name;
  const canOverwrite = !!occupied && !!occupied.serverHash;
  const primaryIsOverwrite = sameName && canOverwrite;
  const primaryDisabled = !!occupied && sameName && !canOverwrite;

  const confirm = () => {
    const name = value.trim() || defaultName;
    if (dest === 'desktop' && desktop) {
      onResolve({
        name,
        dest: 'desktop',
        dir: chosenDir || desktop.rootPath,
        overwrite: primaryIsOverwrite ? true : undefined,
        baseHash: primaryIsOverwrite ? occupied?.serverHash : undefined,
      });
      return;
    }
    onResolve({ name, dest: 'local' });
  };

  /* 那一行的标签：选过就用选的那一层，没选过就说清它默认落在共享根那一层
     （远程路径的尾段是那串 keyId，永远不该出现在界面上） */
  const shownDirName = dirName || t('folder.root');

  return (
    <div className="fixed inset-0 z-[92]">
      <div className="heid-fade-in absolute inset-0 bg-zinc-950/40" onClick={() => onResolve(null)} />
      <div
        className={cn(
          'heid-savename-dock heid-sheet-panel heid-narrow-sheet rounded-t-2xl border-x border-t shadow-2xl',
          isDarkMode ? 'border-zinc-700 bg-zinc-800' : 'border-zinc-200 bg-white'
        )}
      >
        <div className="flex justify-center pt-2">
          <div className={cn('w-9 h-1 rounded-full', isDarkMode ? 'bg-zinc-600' : 'bg-zinc-300')} />
        </div>
        <div className={cn('px-4 pt-2 pb-1.5 text-sm font-semibold', isDarkMode ? 'text-zinc-200' : 'text-zinc-700')}>
          {t('save.nameTitle')}
        </div>
        <div className="px-4 pb-2">
          <input
            ref={inputRef}
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (!primaryDisabled) confirm(); } }}
            className={cn(
              'w-full h-12 px-3 rounded-xl border text-base outline-none',
              isDarkMode
                ? 'bg-zinc-900 border-zinc-600 text-zinc-100 placeholder-zinc-500'
                : 'bg-zinc-50 border-zinc-300 text-zinc-800 placeholder-zinc-400'
            )}
            enterKeyHint="done"
            spellCheck={false}
          />
        </div>

        {/* 那个位置被桌面占着：一句现场 + 主按钮换意思，不再多开一层确认框 */}
        {occupied && (
          <div className={cn(
            'mx-4 mb-2 rounded-xl px-3 py-2 text-sm leading-snug',
            isDarkMode ? 'bg-amber-500/15 text-amber-200' : 'bg-amber-50 text-amber-800'
          )}>
            {canOverwrite
              ? t('save.occupied', { size: formatBytes(occupied.size) })
              : t('save.occupiedTooLarge', { size: formatBytes(occupied.size) })}
          </div>
        )}

        {/* 目的地：只有连着电脑且那侧开着树才摆这一排 */}
        {desktop && (
          <div className="px-4">
            <div className={cn('mb-1.5 text-xs font-medium', isDarkMode ? 'text-zinc-400' : 'text-zinc-500')}>
              {t('save.destTitle')}
            </div>
            <div className="flex gap-2">
              {([['local', Smartphone, t('save.destLocal')], ['desktop', Monitor, `${t('save.destDesktop')} · ${desktop.deviceName}`]] as const)
                .map(([key, Icon, label]) => (
                  <button
                    key={key}
                    onClick={() => setDest(key)}
                    aria-pressed={dest === key}
                    className={cn(
                      'flex h-12 flex-1 items-center justify-center gap-1.5 rounded-xl border text-sm font-medium active:opacity-70',
                      dest === key
                        ? 'border-emerald-500 bg-emerald-600/15 text-emerald-600'
                        : isDarkMode
                          ? 'border-zinc-600 bg-zinc-900 text-zinc-300'
                          : 'border-zinc-300 bg-zinc-50 text-zinc-600'
                    )}
                  >
                    <Icon size={15} />
                    <span className="truncate">{label}</span>
                  </button>
                ))}
            </div>
            {dest === 'desktop' && (
              <button
                onClick={() => setFolderOpen(true)}
                className={cn(
                  'mt-2 flex w-full items-center gap-2 rounded-xl border px-3 min-h-[48px] text-left active:opacity-70',
                  isDarkMode ? 'border-zinc-600 bg-zinc-900' : 'border-zinc-300 bg-zinc-50'
                )}
              >
                <Folder size={16} className="shrink-0 text-emerald-500" />
                <span className={cn('min-w-0 flex-1 truncate text-sm', isDarkMode ? 'text-zinc-200' : 'text-zinc-700')}>
                  {shownDirName}
                </span>
                <ChevronRight size={15} className="shrink-0 text-zinc-400" />
              </button>
            )}
          </div>
        )}

        <div className={cn('flex gap-2 px-4 pt-3 pb-2 safe-bottom')}>
          <button
            onClick={() => onResolve(null)}
            className={cn(
              'flex-1 h-12 rounded-xl text-base font-medium active:opacity-70',
              isDarkMode ? 'bg-zinc-700 text-zinc-200' : 'bg-zinc-200 text-zinc-700'
            )}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={confirm}
            disabled={primaryDisabled}
            className={cn(
              'flex-1 h-12 rounded-xl text-base font-medium active:opacity-80',
              primaryDisabled ? 'bg-zinc-400 text-zinc-200' : 'bg-emerald-600 text-white'
            )}
          >
            {primaryIsOverwrite ? t('save.overwrite') : t('menu.save')}
          </button>
        </div>
      </div>

      {folderOpen && desktop && (
        <RemoteFolderSheet
          isDarkMode={isDarkMode}
          deviceName={desktop.deviceName}
          pickedPath={chosenDir}
          onConfirm={(path, name) => { setDir(path); setDirName(name); setFolderOpen(false); }}
          onClose={() => setFolderOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * 远程路径尾段的人话名字（给上一趟选中的那一层）：根那一层的尾段是 keyId 那串十六进制，
 * 那种一律回空串 —— 界面上退回「共享的文件夹」，绝不把身份键摆给人看。
 */
function folderTail(path?: string): string {
  if (!path) return '';
  const ref = parseRemotePath(path);
  if (!ref || !ref.rel) return '';
  return decodeRemoteSegment(ref.rel.split('/').filter(Boolean).pop() ?? '');
}
