import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Check, CheckCheck, RotateCcw, FileText, GitCompare, Minus, Plus, ArrowLeft,
  ChevronDown, ChevronRight, ChevronLeft, ArrowUp, ArrowDown, ChevronsUpDown, ChevronsDownUp,
} from 'lucide-react';
import { cn } from '../lib/utils';
import {
  buildDiffRows,
  buildUnifiedLines,
  diffStats,
  foldDiffRows,
  stepCountOf,
  MAX_DIFF_ENTRIES,
  MIN_DIFF_ENTRIES,
  COALESCE_WINDOW_CHOICES,
  type CoalesceWindow,
  type DiffFold,
  type DiffRow,
  type ExternalDiffEntry,
  type InternalDiffEntry,
  type UnifiedLine,
} from '../lib/diffTimeline';
import { ConfirmDialog } from './ConfirmDialog';
import { Dropdown } from './Dropdown';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useLang, useT } from '../lib/i18nContext';

/** 时间线类别：外部修改（磁盘监听）/ 软件内编辑（编辑爆发记录） */
export type DiffKind = 'external' | 'internal';

/* ---------- entry 级增删统计缓存：条目对象不可变且跨渲染稳定 ----------
   对比行不缓存：它只算选中的那一份，用 useMemo 按内容判定即可，
   免得为过程步再建一套会随合并失效的键 */

const statsCache = new WeakMap<ExternalDiffEntry, { added: number; removed: number }>();
function statsOf(entry: ExternalDiffEntry): { added: number; removed: number } {
  let s = statsCache.get(entry);
  if (!s) {
    s = diffStats(entry.before, entry.after);
    statsCache.set(entry, s);
  }
  return s;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function formatTime(ts: number, locale: string): string {
  return new Date(ts).toLocaleTimeString(locale, { hour12: false });
}

interface Selection {
  path: string;
  id: string;
  /** 下钻到合并条目里的第几次写入；缺省表示看整条总账 */
  step?: number;
}

interface PendingConfirm {
  kind: DiffKind;
  action: 'accept' | 'revert' | 'acceptAll';
  /** acceptAll 作用于整个类别，不带具体条目 */
  path?: string;
  id?: string;
}

export interface DiffModalProps {
  /** 外部修改：文件路径 → 该文件的未处理时间线（空时间线的文件不展示） */
  externalTimelines: Record<string, ExternalDiffEntry[]>;
  /** 软件内编辑：文件路径 → 时间线（未命名标签不记录），与外部时间线相互独立 */
  internalTimelines: Record<string, InternalDiffEntry[]>;
  isDarkMode: boolean;
  /** 打开弹窗时优先展示该文件（当前激活标签页）的最新条目 */
  focusPath?: string | null;
  /** 时间线每文件保留条数（5~50），页脚可调，两类共用 */
  maxEntries: number;
  onChangeMaxEntries: (n: number) => void;
  /** 外部修改的分批间隔（分钟，0 = 不分批）；仅对外部时间线有意义 */
  batchWindow: CoalesceWindow;
  onChangeBatchWindow: (w: CoalesceWindow) => void;
  /** 这台设备上有没有外部文件监听（安卓与浏览器模式没有，分批间隔因此不出现） */
  externalWatch: boolean;
  /** 手机端整页呈现（与设置页同款 asPage）：手机上没必要再套一层悬浮弹窗 */
  asPage?: boolean;
  onClose: () => void;
  onAccept: (kind: DiffKind, path: string, entryId: string) => void;
  /** 接受当前类别下所有文件的全部条目（只移除条目，磁盘与编辑器均不动） */
  onAcceptAll: (kind: DiffKind) => void;
  onRevert: (kind: DiffKind, path: string, entryId: string) => void;
}

/** Diff 时间线弹窗：外部修改 / 软件内编辑两套独立时间线，
 *  左侧按文件分组的时间线 + 右侧选中条目的左右双栏对比，顶部标签切换类别。
 *  对比区只铺变更块 ± 3 行，未变更区域折成可点开的条；一条外部条目代表
 *  一次待审阅的变更（可能由多次写入合并而来），过程步在左侧展开下钻。 */
export function DiffModal({
  externalTimelines,
  internalTimelines,
  isDarkMode,
  focusPath,
  maxEntries,
  onChangeMaxEntries,
  batchWindow,
  onChangeBatchWindow,
  externalWatch,
  asPage = false,
  onClose,
  onAccept,
  onAcceptAll,
  onRevert,
}: DiffModalProps) {
  const t = useT();
  const lang = useLang();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [selected, setSelected] = useState<Selection | null>(null);
  const [confirming, setConfirming] = useState<PendingConfirm | null>(null);
  /* 左侧展开了过程子列表的条目 */
  const [openEntries, setOpenEntries] = useState<ReadonlySet<string>>(new Set());
  /* 右侧对比区：单独展开的折叠段 + 是否全部展开 */
  const [openFolds, setOpenFolds] = useState<ReadonlySet<number>>(new Set());
  const [expandAll, setExpandAll] = useState(false);
  const [hunkIdx, setHunkIdx] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  /**
   * 窄壳（手机）：弹窗宽度撑不起「固定左栏 + 双栏对比」，整套换成单列铺法——
   * 时间线变顶部横向条目条、对比改单栏、过程步改工具条翻页器、页脚换行。
   * 断点与 Tailwind 的 max-sm 对齐，CSS 与 JS 两条路判的是同一个宽度。
   */
  const narrow = useMediaQuery('(max-width: 639px)');

  /* 类别：默认外部（有未处理外部条目时），否则若内部有记录则落在内部 */
  const hasExternal = useMemo(() => Object.values(externalTimelines).some(e => e.length > 0), [externalTimelines]);
  const hasInternal = useMemo(() => Object.values(internalTimelines).some(e => e.length > 0), [internalTimelines]);
  const [kind, setKind] = useState<DiffKind>(() => (hasExternal || !hasInternal ? 'external' : 'internal'));

  const timelines = kind === 'external' ? externalTimelines : internalTimelines;

  const switchKind = (next: DiffKind) => {
    if (next === kind) return;
    setKind(next);
    setSelected(null);
  };

  /* 按文件分组（该类别下含条目的文件才出现），组内时间倒序 */
  const groups = useMemo(() => {
    return Object.entries(timelines)
      .filter(([, entries]) => entries.length > 0)
      .map(([path, entries]) => ({ path, name: basename(path), entries: [...entries].reverse() }));
  }, [timelines]);

  /* 默认选中：优先 focusPath（激活标签页对应文件）的最新条目，否则取第一个文件的最新条目 */
  const preferredSelection = useMemo<Selection | null>(() => {
    const group = focusPath ? groups.find(g => g.path === focusPath) : undefined;
    const first = group ?? groups[0];
    return first ? { path: first.path, id: first.entries[0].id } : null;
  }, [focusPath, groups]);

  /* 选中条目/过程步失效（被接受、撤销移除，或条目被合并改写）时回落到默认选中 */
  const effectiveSelection = useMemo<Selection | null>(() => {
    if (!selected) return preferredSelection;
    const entry = groups.find(g => g.path === selected.path)?.entries.find(e => e.id === selected.id);
    if (!entry) return preferredSelection;
    if (selected.step !== undefined && !(entry.steps && selected.step < entry.steps.length)) {
      return { path: selected.path, id: selected.id };
    }
    return selected;
  }, [selected, groups, preferredSelection]);

  const selectedEntry = useMemo<ExternalDiffEntry | null>(() => {
    if (!effectiveSelection) return null;
    const group = groups.find(g => g.path === effectiveSelection.path);
    return group?.entries.find(e => e.id === effectiveSelection.id) ?? null;
  }, [effectiveSelection, groups]);

  /** 真正要对比的那两份内容：整条总账（before → after），或下钻的某一次写入 */
  const compare = useMemo(() => {
    if (!selectedEntry) return null;
    const steps = selectedEntry.steps;
    const total = stepCountOf(selectedEntry);
    const si = effectiveSelection?.step;
    if (steps && si !== undefined && si < steps.length) {
      return {
        before: si === 0 ? selectedEntry.before : steps[si - 1].content,
        after: steps[si].content,
        /* 过程步触到上限后最旧的边界被并掉，编号从并掉的数量往后排 */
        stepNo: (selectedEntry.mergedSteps ?? 0) + si + 1,
        total,
      };
    }
    return { before: selectedEntry.before, after: selectedEntry.after, stepNo: null, total };
  }, [selectedEntry, effectiveSelection?.step]);

  const rows = useMemo<DiffRow[]>(
    () => (compare ? buildDiffRows(compare.before, compare.after) : []),
    [compare]
  );
  const folded = useMemo(() => foldDiffRows(rows), [rows]);

  /* 换一条条目或换一步：对比区的展开状态与变更位置从头来 */
  useEffect(() => {
    setOpenFolds(new Set());
    setExpandAll(false);
    setHunkIdx(0);
  }, [effectiveSelection?.path, effectiveSelection?.id, effectiveSelection?.step]);

  const totalPending = useMemo(
    () => groups.reduce((sum, g) => sum + g.entries.length, 0),
    [groups]
  );

  /* 两类各自的未处理总数（顶部切换标签上的角标） */
  const externalCount = useMemo(
    () => Object.values(externalTimelines).reduce((sum, e) => sum + e.length, 0),
    [externalTimelines]
  );
  const internalCount = useMemo(
    () => Object.values(internalTimelines).reduce((sum, e) => sum + e.length, 0),
    [internalTimelines]
  );

  /* Esc 关闭（确认弹窗打开时交给它处理） */
  useEffect(() => {
    if (confirming) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [confirming, onClose]);

  /* 整页形态要吃实底（背后没有遮罩可透），弹窗形态才用带描边的浮层底 */
  const panel = isDarkMode
    ? cn(asPage ? "bg-zinc-900" : "border-zinc-700 bg-zinc-800", "text-zinc-100")
    : cn(asPage ? "bg-zinc-50" : "border-zinc-200 bg-white", "text-zinc-800");
  const softBorder = isDarkMode ? "border-zinc-700" : "border-zinc-200";

  const anchors = folded.hunkAnchors;
  const gotoHunk = (delta: number) => {
    if (anchors.length === 0) return;
    const next = (((hunkIdx + delta) % anchors.length) + anchors.length) % anchors.length;
    setHunkIdx(next);
    scrollRef.current
      ?.querySelector(`[data-hunk="${anchors[next]}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  /** 窄壳没有左栏可以展开过程子列表，过程步改在工具条上翻：-1 = 整条总账 */
  const stepIndex = selectedEntry?.steps
    ? (effectiveSelection?.step !== undefined ? effectiveSelection.step : -1)
    : null;
  const stepBy = (d: number) => {
    const steps = selectedEntry?.steps;
    if (!steps || !effectiveSelection || stepIndex === null) return;
    const next = Math.min(steps.length - 1, Math.max(-1, stepIndex + d));
    setSelected(next === -1
      ? { path: effectiveSelection.path, id: effectiveSelection.id }
      : { path: effectiveSelection.path, id: effectiveSelection.id, step: next });
  };

  const toggleEntry = (id: string) => {
    setOpenEntries(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleFold = (i: number) => {
    setOpenFolds(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const runConfirm = () => {
    if (!confirming) return;
    const c = confirming;
    setConfirming(null);
    if (c.action === 'acceptAll') onAcceptAll(c.kind);
    else if (c.action === 'accept') onAccept(c.kind, c.path!, c.id!);
    else onRevert(c.kind, c.path!, c.id!);
  };

  const confirmMeta = confirming
    ? confirming.action === 'acceptAll'
      ? confirming.kind === 'external'
        ? {
            title: t('diff.acceptAllTitleExternal'),
            message: t('diff.acceptAllMessageExternal', { n: externalCount }),
          }
        : {
            title: t('diff.acceptAllTitleInternal'),
            message: t('diff.acceptAllMessageInternal', { n: internalCount }),
          }
      : confirming.action === 'accept'
        ? confirming.kind === 'external'
          ? {
              title: t('diff.acceptTitle'),
              message: t('diff.acceptMessage'),
            }
          : {
              title: t('diff.acceptTitleInternal'),
              message: t('diff.acceptMessageInternal'),
            }
        : confirming.kind === 'external'
          ? {
              title: t('diff.revertTitle'),
              message: t('diff.revertMessage'),
            }
          : {
              title: t('diff.revertTitleInternal'),
              message: t('diff.revertMessageInternal'),
            }
    : null;

  const askConfirm = (action: 'accept' | 'revert') => {
    if (!effectiveSelection) return;
    setConfirming({ kind, action, path: effectiveSelection.path, id: effectiveSelection.id });
  };

  /* 全部接受：作用于当前类别下所有文件。接受只移除条目、不写盘也不改编辑器，
     所以批量做没有副作用；撤销没有批量版本——那要往多个文件写回基线 */
  const askAcceptAll = () => {
    const n = kind === 'external' ? externalCount : internalCount;
    if (n === 0) return;
    setConfirming({ kind, action: 'acceptAll' });
  };

  /** 类别切换（外部修改 / 软件内编辑，各带未处理角标）；full=true 时铺满一行（整页形态） */
  const kindTabs = (full: boolean) => (
    <div className={cn(
      "flex items-center overflow-hidden",
      full ? "w-full" : cn("rounded-md border shrink-0 ml-1", softBorder)
    )}>
      {([
        ['external', externalCount],
        ['internal', internalCount],
      ] as const).map(([k, count]) => (
        <button
          key={k}
          onClick={() => switchKind(k)}
          className={cn(
            full
              ? "flex-1 h-12 text-sm font-medium flex items-center justify-center gap-1.5 transition-colors"
              : "px-2.5 h-6 text-[11px] font-medium flex items-center gap-1.5 transition-colors pointer-coarse:min-h-[48px] pointer-coarse:px-4 pointer-coarse:text-sm",
            kind === k
              ? (isDarkMode ? "bg-zinc-600/70 text-zinc-100" : "bg-zinc-200 text-zinc-800")
              : (isDarkMode ? "text-zinc-400 hover:bg-zinc-700/50" : "text-zinc-500 hover:bg-zinc-100")
          )}
        >
          {t(k === 'external' ? 'diff.tabExternal' : 'diff.tabInternal')}
          {count > 0 && (
            <span className={cn(
              "min-w-[14px] h-[14px] px-1 rounded-full text-[9px] font-bold flex items-center justify-center leading-none",
              k === 'external' ? "bg-orange-500 text-white" : (isDarkMode ? "bg-zinc-700 text-zinc-300" : "bg-zinc-300 text-zinc-700")
            )}>
              {count > 99 ? '99+' : count}
            </span>
          )}
        </button>
      ))}
    </div>
  );

  return (
    <div className={cn(
      "fixed inset-0 z-[100]",
      asPage ? "flex flex-col" : "flex items-center justify-center"
    )}>
      {/* 整页形态自己就是整屏，没有遮罩可点；弹窗形态点遮罩关闭 */}
      {!asPage && (
        <div
          className="absolute inset-0 bg-zinc-950/30 backdrop-blur-sm"
          onClick={() => { if (!confirming) onClose(); }}
        />
      )}
      <div className={cn(
        "flex flex-col overflow-hidden",
        asPage
          ? "relative w-full h-full"
          : "relative w-[min(960px,92vw)] h-[min(620px,88vh)] rounded-xl border shadow-2xl",
        panel
      )}>
        {asPage ? (
          /* 整页形态（手机）：返回箭头 + 标题一行（与设置页同款 48dp 返回钮与安全区），
             类别切换单独铺满一行——412px 宽塞不下返回钮 + 标题 + 切换 + 角标一行 */
          <>
            <div
              className={cn("flex items-center gap-1 shrink-0 safe-top border-b", softBorder)}
              style={{ height: 'calc(3rem + var(--heid-safe-top, 0px))' }}
            >
              <button
                onClick={onClose}
                aria-label={t('common.back')}
                className={cn(
                  "w-12 h-12 rounded-md flex items-center justify-center shrink-0 transition-colors",
                  isDarkMode ? "text-zinc-300 active:bg-zinc-700" : "text-zinc-600 active:bg-zinc-100"
                )}
              >
                <ArrowLeft size={20} />
              </button>
              <GitCompare size={16} className="shrink-0 opacity-70" />
              <h2 className="text-base font-bold flex-1 truncate">{t('diff.title')}</h2>
              <span className={cn(
                "px-2 py-0.5 rounded-full text-[10px] font-medium border shrink-0 mr-2",
                isDarkMode ? "border-zinc-600 text-zinc-400" : "border-zinc-300 text-zinc-500"
              )}>
                {t('diff.pendingCount', { n: totalPending })}
              </span>
            </div>
            <div className={cn("border-b shrink-0", softBorder)}>
              {kindTabs(true)}
            </div>
          </>
        ) : (
          /* 弹窗形态：标题 + 类别切换 + 未处理角标 + 关闭一行
             行高用 min-h：触屏档里面的按钮撑到 48dp（ROADMAP 52②），写死 h-11 会把它们裁掉 */
          <div className={cn("min-h-11 border-b flex items-center px-4 gap-2 shrink-0", softBorder)}>
            <GitCompare size={15} className="shrink-0 opacity-70" />
            <span className="text-sm font-semibold shrink-0">{t('diff.title')}</span>
            {kindTabs(false)}
            <span className={cn(
              "px-2 py-0.5 rounded-full text-[10px] font-medium border shrink-0",
              isDarkMode ? "border-zinc-600 text-zinc-400" : "border-zinc-300 text-zinc-500"
            )}>
              {t('diff.pendingCount', { n: totalPending })}
            </span>
            <div className="flex-1" />
            <button
              onClick={onClose}
              className={cn(
                "p-1.5 rounded-md transition-colors flex items-center justify-center pointer-coarse:min-h-[48px] pointer-coarse:min-w-[48px]",
                isDarkMode ? "hover:bg-zinc-700 text-zinc-400" : "hover:bg-zinc-100 text-zinc-500"
              )}
              title={t('common.close')}
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* body：窄壳单列（顶部横向条目带 + 全宽单栏对比），宽壳左栏 + 双栏对比 */}
        <div className="flex-1 flex flex-col min-h-0">
          {/* 窄壳：时间线压成顶部一条横向滚动的条目带，把宽度全让给对比区 */}
          <div className={cn("sm:hidden border-b overflow-x-auto shrink-0 flex items-center gap-1 px-2 py-1.5", softBorder)}>
            {groups.length === 0 ? (
              <span className={cn("px-2 py-1 text-xs", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
                {t(kind === 'external' ? 'diff.empty' : 'diff.emptyInternal')}
              </span>
            ) : groups.map(group => group.entries.map(entry => {
              const stats = statsOf(entry);
              const isSel = effectiveSelection?.path === group.path && effectiveSelection?.id === entry.id;
              return (
                <button
                  key={entry.id}
                  onClick={() => setSelected({ path: group.path, id: entry.id })}
                  className={cn(
                    "shrink-0 px-2.5 h-9 rounded-md border text-[11px] flex items-center gap-1.5 transition-colors pointer-coarse:min-h-[48px]",
                    isSel
                      ? cn("border-blue-500", isDarkMode ? "bg-zinc-700/70" : "bg-zinc-100")
                      : cn("border-transparent", isDarkMode ? "hover:bg-zinc-700/40" : "hover:bg-zinc-50")
                  )}
                >
                  {groups.length > 1 && (
                    <span className={cn("truncate max-w-[64px]", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
                      {group.name}
                    </span>
                  )}
                  <span className={cn("tabular-nums", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
                    {formatTime(entry.detectedAt, locale)}
                  </span>
                  <span className="font-medium tabular-nums">
                    <span className="text-emerald-500">+{stats.added}</span>{' '}
                    <span className="text-red-500">-{stats.removed}</span>
                  </span>
                </button>
              );
            }))}
          </div>
          <div className="flex-1 flex min-h-0">
          {/* 左侧时间线（窄壳收起，改走上面那条横向条目带） */}
          <div className={cn("w-60 border-r overflow-y-auto shrink-0 py-2 max-sm:hidden", softBorder)}>
            {groups.length === 0 ? (
              <div className={cn("px-4 py-8 text-center text-xs", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
                {t(kind === 'external' ? 'diff.empty' : 'diff.emptyInternal')}
              </div>
            ) : groups.map(group => (
              <div key={group.path} className="mb-2">
                <div className={cn(
                  "px-3 py-1 flex items-center gap-1.5 text-[11px] font-semibold sticky top-0",
                  isDarkMode ? "bg-zinc-800 text-zinc-400" : "bg-white text-zinc-500"
                )}>
                  <FileText size={11} className="shrink-0 opacity-60" />
                  <span className="truncate" title={group.path}>{group.name}</span>
                  <span className="ml-auto opacity-60">{group.entries.length}</span>
                </div>
                {group.entries.map(entry => {
                  const stats = statsOf(entry);
                  const steps = entry.steps;
                  const writes = stepCountOf(entry);
                  const isSel = effectiveSelection?.path === group.path && effectiveSelection?.id === entry.id;
                  /* 整条被选中（不是下钻到某一步）时才高亮这条本身 */
                  const isSelfSel = isSel && effectiveSelection?.step === undefined;
                  const isOpen = openEntries.has(entry.id);
                  return (
                    <div key={entry.id}>
                      <div className={cn(
                        "flex items-stretch border-l-2",
                        isSel ? "border-blue-500" : "border-transparent"
                      )}>
                        <button
                          onClick={() => setSelected({ path: group.path, id: entry.id })}
                          className={cn(
                            "flex-1 min-w-0 px-3 py-1.5 text-[11px] pointer-coarse:min-h-[48px] pointer-coarse:text-sm transition-colors text-left",
                            isSelfSel
                              ? (isDarkMode ? "bg-zinc-700/70" : "bg-zinc-100")
                              : (isDarkMode ? "hover:bg-zinc-700/40" : "hover:bg-zinc-50")
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <span className={cn("shrink-0 tabular-nums", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
                              {formatTime(entry.detectedAt, locale)}
                            </span>
                            <span className="ml-auto shrink-0 font-medium tabular-nums">
                              <span className="text-emerald-500">+{stats.added}</span>{' '}
                              <span className="text-red-500">-{stats.removed}</span>
                            </span>
                          </div>
                          {steps && (
                            <div className={cn(
                              "truncate text-[10px] pointer-coarse:text-xs",
                              isDarkMode ? "text-zinc-500" : "text-zinc-400"
                            )}>
                              {t('diff.mergedCount', { n: writes })}
                            </div>
                          )}
                        </button>
                        {steps && (
                          <button
                            onClick={() => toggleEntry(entry.id)}
                            aria-expanded={isOpen}
                            title={isOpen ? t('diff.stepsCollapse') : t('diff.stepsExpand')}
                            className={cn(
                              "w-6 shrink-0 flex items-center justify-center transition-colors pointer-coarse:w-12",
                              isDarkMode ? "text-zinc-500 hover:bg-zinc-700/60" : "text-zinc-400 hover:bg-zinc-100"
                            )}
                          >
                            {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          </button>
                        )}
                      </div>
                      {/* 过程子列表：只读下钻，接受/撤销始终作用于整条 */}
                      {isOpen && steps && (
                        <div className="pb-1">
                          {steps.map((s, i) => {
                            const isStepSel = isSel && effectiveSelection?.step === i;
                            return (
                              <button
                                key={i}
                                onClick={() => setSelected({ path: group.path, id: entry.id, step: i })}
                                className={cn(
                                  "w-full pl-6 pr-3 py-1 flex items-center gap-2 text-[10px] pointer-coarse:min-h-[48px] pointer-coarse:text-xs transition-colors text-left",
                                  isStepSel
                                    ? (isDarkMode ? "bg-zinc-700/70 text-zinc-200" : "bg-zinc-100 text-zinc-800")
                                    : (isDarkMode ? "text-zinc-500 hover:bg-zinc-700/40" : "text-zinc-400 hover:bg-zinc-50")
                                )}
                              >
                                <span className="shrink-0">
                                  {t('diff.stepLabel', { i: (entry.mergedSteps ?? 0) + i + 1 })}
                                </span>
                                <span className="ml-auto shrink-0 tabular-nums">
                                  {formatTime(s.detectedAt, locale)}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {/* 右侧双栏对比 */}
          {selectedEntry && compare ? (
            <div className="flex-1 min-w-0 flex flex-col">
              {/* 栏头：与下方两半列宽对齐（窄壳是单栏，没有「修改前/后」两半可标） */}
              <div className={cn("h-9 border-b flex items-center shrink-0 text-[11px] font-medium max-sm:hidden", softBorder)}>
                <div className={cn("w-1/2 px-3 truncate", isDarkMode ? "text-zinc-400" : "text-zinc-500")}>
                  {t('diff.before')}
                </div>
                <div className={cn("w-1/2 px-3 truncate border-l", softBorder, isDarkMode ? "text-zinc-400" : "text-zinc-500")}>
                  {t('diff.after')}
                </div>
              </div>

              {/* 工具条：变更处数与跳转 + 展开/折叠未变更区域 */}
              <div className={cn("min-h-8 border-b flex items-center gap-1 px-2 shrink-0", softBorder)}>
                <span className={cn(
                  "text-[11px] font-medium tabular-nums shrink-0",
                  anchors.length === 0 ? (isDarkMode ? "text-zinc-500" : "text-zinc-400") : (isDarkMode ? "text-zinc-300" : "text-zinc-600")
                )}>
                  {anchors.length === 0 ? t('diff.hunkNone') : t('diff.hunkCount', { n: anchors.length })}
                </span>
                {compare.stepNo === null && compare.total > 1 && !narrow && (
                  <span className={cn(
                    "text-[10px] truncate shrink-0",
                    isDarkMode ? "text-zinc-500" : "text-zinc-400"
                  )}>
                    {t('diff.totalChange', { n: compare.total })}
                  </span>
                )}
                {/* 窄壳没有左栏展开过程子列表，过程步在这里翻 */}
                {narrow && stepIndex !== null && (
                  <span className="flex items-center gap-0.5 shrink-0">
                    <IconBtn
                      dark={isDarkMode}
                      disabled={stepIndex <= -1}
                      title={t('diff.prevStep')}
                      onClick={() => stepBy(-1)}
                    >
                      <ChevronLeft size={13} />
                    </IconBtn>
                    <span className={cn("text-[11px] tabular-nums whitespace-nowrap", isDarkMode ? "text-zinc-400" : "text-zinc-500")}>
                      {stepIndex === -1
                        ? t('diff.pagerWhole')
                        : t('diff.stepPager', { i: compare.stepNo ?? 0, n: compare.total })}
                    </span>
                    <IconBtn
                      dark={isDarkMode}
                      disabled={stepIndex >= (selectedEntry?.steps?.length ?? 0) - 1}
                      title={t('diff.nextStep')}
                      onClick={() => stepBy(1)}
                    >
                      <ChevronRight size={13} />
                    </IconBtn>
                  </span>
                )}
                <div className="flex-1" />
                <IconBtn
                  dark={isDarkMode}
                  disabled={anchors.length === 0}
                  title={t('diff.prevHunk')}
                  onClick={() => gotoHunk(-1)}
                >
                  <ArrowUp size={13} />
                </IconBtn>
                <IconBtn
                  dark={isDarkMode}
                  disabled={anchors.length === 0}
                  title={t('diff.nextHunk')}
                  onClick={() => gotoHunk(1)}
                >
                  <ArrowDown size={13} />
                </IconBtn>
                <IconBtn
                  dark={isDarkMode}
                  title={expandAll ? t('diff.collapseAll') : t('diff.expandAll')}
                  onClick={() => setExpandAll(v => !v)}
                >
                  {expandAll ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}
                </IconBtn>
              </div>

              {/* 下钻某一次写入时的说明：接受/撤销仍然是整条的语义，别让人误会 */}
              {compare.stepNo !== null && (
                <div className={cn(
                  "px-3 py-1 text-[11px] border-b shrink-0",
                  softBorder,
                  isDarkMode ? "bg-amber-500/10 text-amber-300" : "bg-amber-500/10 text-amber-700"
                )}>
                  {t('diff.stepsHint', { i: compare.stepNo, n: compare.total })}
                </div>
              )}

              <div ref={scrollRef} className="flex-1 overflow-auto font-mono text-[11px] leading-5">
                {narrow ? folded.items.map((item, i) => {
                  /* 窄壳单栏：一行双栏摊成 − / + 两行，整宽可读 */
                  if (item.kind === 'row') {
                    return (
                      <Fragment key={i}>
                        {buildUnifiedLines([item.row]).map((ln, j) => (
                          <UniLineView key={j} idx={j === 0 ? i : undefined} line={ln} isDarkMode={isDarkMode} />
                        ))}
                      </Fragment>
                    );
                  }
                  if (!expandAll && !openFolds.has(i)) {
                    return <FoldBar key={i} fold={item} isDarkMode={isDarkMode} onExpand={() => toggleFold(i)} />;
                  }
                  return (
                    <Fragment key={i}>
                      {!expandAll && (
                        <CollapseBar isDarkMode={isDarkMode} onCollapse={() => toggleFold(i)} />
                      )}
                      {buildUnifiedLines(rows.slice(item.from, item.to + 1)).map((ln, j) => (
                        <UniLineView key={j} line={ln} isDarkMode={isDarkMode} />
                      ))}
                    </Fragment>
                  );
                }) : folded.items.map((item, i) => {
                  if (item.kind === 'row') {
                    return <RowView key={i} idx={i} row={item.row} isDarkMode={isDarkMode} />;
                  }
                  if (!expandAll && !openFolds.has(i)) {
                    return <FoldBar key={i} fold={item} isDarkMode={isDarkMode} onExpand={() => toggleFold(i)} />;
                  }
                  return (
                    <Fragment key={i}>
                      {!expandAll && (
                        <CollapseBar isDarkMode={isDarkMode} onCollapse={() => toggleFold(i)} />
                      )}
                      {rows.slice(item.from, item.to + 1).map((row, j) => (
                        <RowView key={j} row={row} isDarkMode={isDarkMode} />
                      ))}
                    </Fragment>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-2">
              <GitCompare size={28} className={isDarkMode ? "text-zinc-600" : "text-zinc-300"} />
              <p className={cn("text-xs", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
                {t('diff.pickEntry')}
              </p>
            </div>
          )}
          </div>
        </div>

        {/* footer：左侧保留条数（+ 外部的分批间隔）+ 右侧操作按钮（作用于选中条目）；
            窄壳换行成两排，设置一排、动作一排，谁也不挤谁 */}
        <div className={cn(
          "h-12 border-t flex items-center justify-end px-4 gap-2 shrink-0",
          "max-sm:h-auto max-sm:flex-wrap max-sm:py-2 max-sm:gap-y-2",
          asPage && "safe-bottom",
          softBorder
        )}>
          <div className="mr-auto flex items-center gap-3 text-[11px] min-w-0 max-sm:w-full max-sm:mr-0">
            {/* 时间线保留条数设置：每文件保留的最大条数，超出丢弃最旧 */}
            <div className="flex items-center gap-2 shrink-0">
              <span className={isDarkMode ? "text-zinc-500" : "text-zinc-400"}>{t('diff.keepCount')}</span>
              <div className={cn(
                "flex items-center rounded-md border overflow-hidden shrink-0",
                isDarkMode ? "border-zinc-700" : "border-zinc-200"
              )}>
                <button
                  onClick={() => onChangeMaxEntries(maxEntries - 1)}
                  disabled={maxEntries <= MIN_DIFF_ENTRIES}
                  title={t('diff.decreaseTip', { min: MIN_DIFF_ENTRIES })}
                  className={cn(
                    "w-6 h-6 flex items-center justify-center transition-colors disabled:opacity-30 pointer-coarse:h-12 pointer-coarse:w-12",
                    isDarkMode ? "hover:bg-zinc-700 text-zinc-300" : "hover:bg-zinc-100 text-zinc-600"
                  )}
                >
                  <Minus size={11} />
                </button>
                <span
                  className="w-8 text-center tabular-nums font-medium"
                  title={t('diff.keepTip', { min: MIN_DIFF_ENTRIES, max: MAX_DIFF_ENTRIES })}
                >
                  {maxEntries}
                </span>
                <button
                  onClick={() => onChangeMaxEntries(maxEntries + 1)}
                  disabled={maxEntries >= MAX_DIFF_ENTRIES}
                  title={t('diff.increaseTip', { max: MAX_DIFF_ENTRIES })}
                  className={cn(
                    "w-6 h-6 flex items-center justify-center transition-colors disabled:opacity-30 pointer-coarse:h-12 pointer-coarse:w-12",
                    isDarkMode ? "hover:bg-zinc-700 text-zinc-300" : "hover:bg-zinc-100 text-zinc-600"
                  )}
                >
                  <Plus size={11} />
                </button>
              </div>
            </div>
            {/* 分批间隔：只对外部修改有意义（内部时间线按编辑爆发归条），
                切到内部、或这台设备根本没有外部监听（安卓 / 浏览器模式）就收起 */}
            {kind === 'external' && externalWatch && (
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={cn("shrink-0", isDarkMode ? "text-zinc-500" : "text-zinc-400")}
                  title={t('diff.batchWindowTip')}
                >
                  {t('diff.batchWindow')}
                </span>
                <Dropdown
                  value={String(batchWindow)}
                  onChange={v => onChangeBatchWindow(Number(v) as CoalesceWindow)}
                  options={COALESCE_WINDOW_CHOICES.map(w => ({
                    value: String(w),
                    label: w === 0 ? t('diff.batchOff') : t('diff.batchMinutes', { n: w }),
                  }))}
                  dark={isDarkMode}
                  label={t('diff.batchWindow')}
                  title={t('diff.batchWindowTip')}
                />
              </div>
            )}
          </div>
          {/* 三颗动作按钮包一层：窄壳换行后它们自己占一排、右对齐 */}
          <div className="flex items-center gap-2 shrink-0 max-sm:w-full max-sm:justify-end">
          {/* 全部接受：一次清掉当前类别下所有文件的条目。接受不写盘也不改编辑器，
              所以敢给批量；撤销不给批量（那要往多个文件写回基线） */}
          <button
            onClick={askAcceptAll}
            disabled={(kind === 'external' ? externalCount : internalCount) === 0}
            className={cn(
              "px-3 h-7 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors disabled:opacity-40 pointer-coarse:h-12 pointer-coarse:px-4 pointer-coarse:text-sm shrink-0",
              isDarkMode
                ? "bg-zinc-700 hover:bg-zinc-600 text-zinc-200"
                : "bg-zinc-200 hover:bg-zinc-300 text-zinc-700"
            )}
            title={t(kind === 'external' ? 'diff.acceptAllTipExternal' : 'diff.acceptAllTipInternal')}
          >
            <CheckCheck size={13} /> {t('diff.acceptAll')}
          </button>
          <button
            onClick={() => askConfirm('accept')}
            disabled={!effectiveSelection}
            className={cn(
              "px-3 h-7 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors disabled:opacity-40 pointer-coarse:h-12 pointer-coarse:px-4 pointer-coarse:text-sm shrink-0",
              isDarkMode
                ? "bg-zinc-700 hover:bg-zinc-600 text-zinc-200"
                : "bg-zinc-200 hover:bg-zinc-300 text-zinc-700"
            )}
            title={t(kind === 'external' ? 'diff.acceptTip' : 'diff.acceptTipInternal')}
          >
            <Check size={13} /> {t('diff.accept')}
          </button>
          <button
            onClick={() => askConfirm('revert')}
            disabled={!effectiveSelection}
            className={cn(
              "px-3 h-7 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors disabled:opacity-40 text-white pointer-coarse:h-12 pointer-coarse:px-4 pointer-coarse:text-sm shrink-0",
              "bg-red-600 hover:bg-red-500"
            )}
            title={t(kind === 'external' ? 'diff.revertTip' : 'diff.revertTipInternal')}
          >
            <RotateCcw size={13} /> {t('diff.revert')}
          </button>
          </div>
        </div>

        {/* 二次确认（叠加在本弹窗上层） */}
        {confirming && confirmMeta && (
          <ConfirmDialog
            title={confirmMeta.title}
            message={confirmMeta.message}
            isDarkMode={isDarkMode}
            danger={confirming.action === 'revert'}
            onConfirm={runConfirm}
            onCancel={() => setConfirming(null)}
          />
        )}
      </div>
    </div>
  );
}

/* 工具条上的小图标按钮（触屏档撑到 48dp） */
function IconBtn({
  children, onClick, title, disabled, dark,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  disabled?: boolean;
  dark: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className={cn(
        "w-6 h-6 rounded flex items-center justify-center transition-colors shrink-0 disabled:opacity-30",
        "pointer-coarse:w-12 pointer-coarse:h-12",
        dark ? "text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200" : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
      )}
    >
      {children}
    </button>
  );
}

/* 一行对比：左右两半。data-diff-row 是稳定的行标记（测试按它数可见行），
   idx 有值时再打上 data-hunk 锚点，供「上一处 / 下一处」滚动定位 */
function RowView({ row, idx, isDarkMode }: { row: DiffRow; idx?: number; isDarkMode: boolean }) {
  return (
    <div className="flex" data-diff-row="" data-hunk={idx}>
      <DiffHalf cell={row.left} isDarkMode={isDarkMode} />
      <DiffHalf cell={row.right} isDarkMode={isDarkMode} borderl />
    </div>
  );
}

/* 窄壳单栏的一行：整宽铺一条，删除红底带 −、新增绿底带 +，行号取自己那一侧 */
function UniLineView({ line, idx, isDarkMode }: { line: UnifiedLine; idx?: number; isDarkMode: boolean }) {
  return (
    <div
      className={cn(
        "flex min-w-0",
        line.type === 'del' && "bg-red-500/15",
        line.type === 'add' && "bg-emerald-500/15"
      )}
      data-diff-row=""
      data-hunk={idx}
    >
      <span className="w-9 shrink-0 text-right pr-2 select-none tabular-nums opacity-40">
        {line.lineNo}
      </span>
      <span className={cn(
        "w-4 shrink-0 select-none text-center",
        line.type === 'del' && "text-red-500",
        line.type === 'add' && "text-emerald-500"
      )}>
        {line.type === 'del' ? '-' : line.type === 'add' ? '+' : ' '}
      </span>
      <span className="whitespace-pre-wrap break-words pr-2 min-w-0">
        {line.text}
      </span>
    </div>
  );
}

/* 折叠条：一段未变更区域，点开就地展开 */
function FoldBar({ fold, isDarkMode, onExpand }: { fold: DiffFold; isDarkMode: boolean; onExpand: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onExpand}
      title={t('diff.foldTitle', {
        a: fold.leftFrom, b: fold.leftTo, c: fold.rightFrom, d: fold.rightTo,
      })}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-0.5 text-[10px] transition-colors pointer-coarse:min-h-[48px] pointer-coarse:text-xs",
        isDarkMode
          ? "bg-zinc-900/40 text-zinc-500 hover:bg-zinc-700/60 hover:text-zinc-300"
          : "bg-zinc-50 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
      )}
    >
      <span className={cn("h-px flex-1", isDarkMode ? "bg-zinc-700" : "bg-zinc-200")} />
      <span className="shrink-0 tabular-nums">{t('diff.foldBar', { n: fold.hidden })}</span>
      <span className={cn("h-px flex-1", isDarkMode ? "bg-zinc-700" : "bg-zinc-200")} />
    </button>
  );
}

/* 已单独展开的那段的收起把手 */
function CollapseBar({ isDarkMode, onCollapse }: { isDarkMode: boolean; onCollapse: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onCollapse}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-0.5 text-[10px] transition-colors pointer-coarse:min-h-[48px] pointer-coarse:text-xs",
        isDarkMode
          ? "bg-zinc-900/40 text-zinc-500 hover:bg-zinc-700/60 hover:text-zinc-300"
          : "bg-zinc-50 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
      )}
    >
      <span className={cn("h-px flex-1", isDarkMode ? "bg-zinc-700" : "bg-zinc-200")} />
      <ChevronsDownUp size={10} className="shrink-0" />
      <span className="shrink-0">{t('diff.collapseAll')}</span>
      <span className={cn("h-px flex-1", isDarkMode ? "bg-zinc-700" : "bg-zinc-200")} />
    </button>
  );
}

/* 双栏对比的单侧单元格：行号 + 文本，删除红底 / 新增绿底 / 空位淡填充 */
function DiffHalf({ cell, isDarkMode, borderl }: { cell: DiffRow['left']; isDarkMode: boolean; borderl?: boolean }) {
  return (
    <div className={cn(
      "w-1/2 flex min-w-0",
      borderl && (isDarkMode ? "border-l border-zinc-700" : "border-l border-zinc-200"),
      cell?.type === 'del' && "bg-red-500/15",
      cell?.type === 'add' && "bg-emerald-500/15",
      cell === null && "bg-zinc-500/5"
    )}>
      {cell && (
        <span className="w-9 shrink-0 text-right pr-2 select-none tabular-nums opacity-40">
          {cell.lineNo}
        </span>
      )}
      {/* 按词断行而非逐字符：break-all 会把英文单词从中间劈开，
          且左右两栏差 1px 边框就会一边折一边不折，行高对不齐 */}
      <span className="whitespace-pre-wrap break-words pr-2 min-w-0">
        {cell?.text ?? ''}
      </span>
    </div>
  );
}
