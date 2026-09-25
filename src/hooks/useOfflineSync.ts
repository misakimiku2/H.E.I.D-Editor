/**
 * 离线写队列的运行时（v1.5 阶段 5）：断连时把改动落进手机，重连后按排队顺序回写桌面。
 *
 * 一条队列同时被三处用（保存路径写入、文件树标记、横幅与设备面板的计数和动作），
 * 所以状态只存在这个 hook 里一份，别处读它的返回值 —— 存两份就会有一份晚一步，
 * 表现为「树上还标着待同步，其实早就写回去了」。
 *
 * 三条判据都不是这里新造的：
 * - **什么时候算连上**：`connected` 只在收到对端第一帧之后为真（阶段 1 的 (b) 条），
 *   所以桌面还在等 TOFU 确认时不会来动队列（那一刻每条请求都要等满 30 秒才失败）；
 * - **权威是内容哈希，不是「收到过帧」**：回放直接发 `write`，桌面拿基线判，
 *   不一致就一个字都不写、并把它那一份带回来；`fs` 帧只代表「该去看一眼」；
 * - **销账只在桌面确认之后**：写完拿到新哈希才摘条目。中途杀进程、断电、再断网，
 *   条目都还在库里，下次接着放 —— 「拔网线编辑不丢」全靠这一条顺序。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchStatus, subscribeLinkStatus, type LinkStatus } from '../lib/link';
import { isLinkDown, parseRemoteError, remoteWrite, type RemoteWriteArgs } from '../lib/remote';
import {
  clearQueue, enqueue, forDevice, loadQueue, MAX_OFFLINE_ENTRIES, putEntry, removeEntry,
  sortForReplay, type OfflineEntry, type OfflineInput,
} from '../lib/offlineQueue';
import { appAlert } from '../lib/appAlert';
import { showNotification } from '../lib/notifications';
import { normalizeToLf } from '../lib/lineEndings';
import type { RemoteConflict } from '../lib/fileIO';
import type { MessageKey } from '../lib/i18n';

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export interface OfflineSyncOptions {
  /** 回放成功后：清这一份的脏标记，并把基线换成桌面回传的新哈希。
      `textLf` 是这一份在编辑器空间（LF）里的样子 —— 标签内容比它更新时不清脏，
      用户可能在回写这一版的同时又打了几行。
      不换基线，桌面随后推来的那一帧会被手机端读成「桌面改了我的文件」 */
  onSynced: (path: string, textLf: string, baseHash: string) => void;
  /** 回放撞上「桌面期间也改过」：与交互式保存那条冲突**共用同一个入口**（同一条 diff 时间线） */
  onConflict: (path: string, conflict: RemoteConflict) => void;
  /** 这个远程标签此刻开着吗：时间线的存活域是「被标签引用的路径」，没开着就别假装给了差异 */
  hasTab: (path: string) => boolean;
  t: Translate;
}

/** 一条回放的结局。`down` 与 `retry` 分开是因为前者不该算一次尝试 */
type Outcome = 'synced' | 'conflict' | 'retry' | 'down';

export interface OfflineSync {
  entries: OfflineEntry[];
  /** 树行标记：标签身份键 → 状态。「已同步」= 不在这张表里（设计稿 §9.2 的无标记那一行） */
  markers: Map<string, OfflineEntry['state']>;
  /** 等着回写的份数 / 要人裁决的份数 */
  pending: number;
  conflicts: number;
  /** 回放进行中（null = 没在跑）。横幅用它出进度与「取消」 */
  progress: { done: number; total: number } | null;
  /** 客户端且当前没连上：横幅那句「已断开连接 · N 项待同步」的前提 */
  offline: boolean;
  /** 保存路径的落点。true = 这一份确实存进手机；false = 没存进，且已经当场说清 */
  enqueueOffline: (input: OfflineInput) => Promise<boolean>;
  /** 手机上这一份不要了：只摘队列里的条目，桌面那个文件一个字都不碰。
      桌面确认收下同一份之后也是这同一个动作 —— 「已经写回去了」和「不用写了」
      对队列来说本来就是同一件事，没必要留两个名字 */
  dropForPath: (path: string) => Promise<void>;
  /** 立刻回放：不带参数是「全部」，带路径是长按菜单那句「立即同步这一份」 */
  syncNow: (path?: string) => void;
  /** 取消进行中的回放：写回去的不会退回来，没轮到的原地留在队列里 */
  cancel: () => void;
  clearAll: () => Promise<void>;
}

const REJECT_KEY: Record<'toobig' | 'full' | 'nobaseline' | 'storage', MessageKey> = {
  toobig: 'offline.rejectTooBig',
  full: 'offline.rejectFull',
  nobaseline: 'offline.rejectNoBaseline',
  storage: 'offline.rejectStorage',
};

export function useOfflineSync({ onSynced, onConflict, hasTab, t }: OfflineSyncOptions): OfflineSync {
  const [entries, setEntries] = useState<OfflineEntry[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [status, setStatus] = useState<LinkStatus | null>(null);

  /* 回放是异步的，读到的必须是当下最新那份，不是闭包里的旧快照 */
  const entriesRef = useRef<OfflineEntry[]>(entries);
  const statusRef = useRef<LinkStatus | null>(status);
  const tRef = useRef(t);
  tRef.current = t;
  statusRef.current = status;
  entriesRef.current = entries;

  /** 内存里那份跟着库走：回放途中用户又存了一次时，新那条不该被旧快照盖回去 */
  const reload = useCallback(async () => {
    const list = await loadQueue().catch(() => entriesRef.current);
    entriesRef.current = list;
    setEntries(list);
  }, []);

  /* 启动：把上次留下的队列读回来（进程被杀与应用重启之后它仍在这条库里），
     顺手请一次「持久存储」，成不成都不说话 —— 它失败不等于这次保存失败。 */
  useEffect(() => {
    void reload();
    void import('../lib/idb').then(m => m.requestPersistentStorage()).catch(() => {});
  }, [reload]);

  useEffect(() => {
    let alive = true;
    fetchStatus().then(s => { if (alive) setStatus(s); }).catch(() => {});
    const off = subscribeLinkStatus(s => { if (alive) setStatus(s); });
    return () => { alive = false; off(); };
  }, []);

  /** 一条的回放。桌面直接给结论：写成功、要人裁决、这次没送到，或者被拒 */
  const replayOne = useCallback(async (e: OfflineEntry): Promise<Outcome> => {
    const args: RemoteWriteArgs = {
      relPath: e.relPath, text: e.text, encoding: e.encoding, bom: e.bom, baseHash: e.baseHash,
    };
    try {
      const r = await remoteWrite(args);
      if (r.conflict) {
        /* 冲突不是一次「失败」，lastError 原样留着：那是上一次尝试为什么没成的原话，
           覆盖成一句机器码只会让界面要么显示代码要么显示谎 */
        await putEntry({ ...e, state: 'conflict', attempts: e.attempts + 1 });
        if (e.path && hasTab(e.path)) {
          const conflict: RemoteConflict = {
            serverText: r.serverText ?? '', serverHash: r.serverHash ?? '',
            serverEncoding: r.serverEncoding ?? 'utf-8', serverBom: r.serverBom ?? false,
            serverTooLarge: r.serverText === undefined,
          };
          onConflict(e.path, conflict);
        }
        return 'conflict';
      }
      await removeEntry(e.id);
      /* 编辑器空间是 LF，队列里那份是落盘态（换行符已还原）—— 比内容前先归一，
         否则 CRLF 文件永远对不上，标签会一直挂着脏标记 */
      if (e.path) onSynced(e.path, normalizeToLf(e.text), r.hash);
      return 'synced';
    } catch (err) {
      /* 断连不计尝试：这一条压根没到过桌面，attempts 记的是「桌面拒了几次」 */
      if (isLinkDown(err)) return 'down';
      await putEntry({ ...e, attempts: e.attempts + 1, lastError: parseRemoteError(err).message });
      return 'retry';
    }
  }, [hasTab, onConflict, onSynced]);

  const runningRef = useRef(false);
  const cancelRef = useRef(false);

  const runReplay = useCallback(async (onlyPath?: string) => {
    if (runningRef.current) return;
    const s = statusRef.current;
    /* 只在客户端这一侧放：桌面是服务端，它的队列永远是空的；peerKeyId 决定放哪一台的条目
       （连着 A 时绝不能把当年在 B 上攒的那份写进 A 的同名文件） */
    if (!s?.connected || !s.peerKeyId || s.role !== 'client') return;
    const list = sortForReplay(forDevice(entriesRef.current, s.peerKeyId))
      .filter(e => !onlyPath || e.path === onlyPath);
    if (!list.length) return;
    runningRef.current = true;
    cancelRef.current = false;
    setProgress({ done: 0, total: list.length });
    let synced = 0;
    let conflict = 0;
    for (let i = 0; i < list.length; i++) {
      if (cancelRef.current) break;
      const outcome = await replayOne(list[i]);
      await reload();
      if (outcome === 'synced') synced += 1;
      else if (outcome === 'conflict') conflict += 1;
      // 途中又断了：剩下的原样留在队列里，等下一次连上。「下次接着放」是同一条机制的下半句
      if (outcome === 'down') break;
      setProgress({ done: i + 1, total: list.length });
    }
    runningRef.current = false;
    setProgress(null);
    if (conflict) {
      showNotification({
        id: 'heid-offline', kind: 'error',
        title: tRef.current('offline.needDecision', { n: conflict }),
        message: tRef.current('offline.needDecisionHint'),
        timeoutMs: 12_000,
      });
    } else if (synced && entriesRef.current.every(e => e.state !== 'queued')) {
      showNotification({
        id: 'heid-offline', kind: 'success', title: tRef.current('offline.allDone'), timeoutMs: 6_000,
      });
    }
    /* 还欠着、但攒在**另一台电脑**上的那些由下面那条效果负责说 —— 回放根本不会为它们开始 */
  }, [replayOne, reload]);

  const runRef = useRef(runReplay);
  runRef.current = runReplay;

  /* 什么时候放：连着桌面（客户端）且手里确实有要放的那一条。
     两个条件缺一不可，而且**不能只认 connected 那一条边** —— 免扫重连往往比
     从 IndexedDB 读回队列更快，只认边的话这一次就没有下一次了，
     用户看到的正是「重启之后欠的那份再也没写回去」。
     每一次「断开 → 连上」算一趟（epoch）：同一趟里失败的那条不立刻重试，
     下次重连再放，attempts 也才有意义。 */
  const connected = status?.connected === true;
  const wasConnectedRef = useRef(false);
  const epochRef = useRef(0);
  const drainedEpochRef = useRef(-1);
  useEffect(() => {
    if (!connected) {
      wasConnectedRef.current = false;
      return;
    }
    if (!wasConnectedRef.current) {
      wasConnectedRef.current = true;
      epochRef.current += 1;
    }
    const s = statusRef.current;
    const mine = s?.role === 'client' && s.peerKeyId
      ? sortForReplay(forDevice(entries, s.peerKeyId))
      : [];
    if (!mine.length || drainedEpochRef.current === epochRef.current) return;
    drainedEpochRef.current = epochRef.current;
    void runRef.current();
  }, [connected, entries]);

  /* 攒在**另一台电脑**上的那些必须说出来，一条都不许默默留着。
     设备键是每次配对新生成的那把 LS 的标识，所以「重新配对一次」（而不是免扫重连）之后，
     之前攒的那几条按判就不该往这台写 —— 那是另一台机上的文件。
     但不说就是「我明明存过，它再也想不起来」：2026-09-25 模拟器实测正是这个形状。
     单独一条效果是因为回放压根不会为它们开始（它们不在 `mine` 里）。 */
  const toldEpochRef = useRef(-1);
  useEffect(() => {
    if (!connected) { toldEpochRef.current = -1; return; }
    const s = statusRef.current;
    if (!s?.peerKeyId) return;
    const stranded = entries.filter(e => e.state === 'queued' && e.deviceId !== s.peerKeyId).length;
    if (!stranded || toldEpochRef.current === epochRef.current) return;
    toldEpochRef.current = epochRef.current;
    showNotification({
      id: 'heid-offline-stranded', kind: 'info',
      title: tRef.current('offline.stranded', { n: stranded }),
      message: tRef.current('offline.strandedHint'),
    });
  }, [connected, entries]);

  const enqueueOffline = useCallback(async (input: OfflineInput): Promise<boolean> => {
    const r = await enqueue(input);
    if (!r.ok) {
      /* 这一句是整个子系统里最不能说谎的地方：内容确实没留在手机上，就得让他现在复制走 */
      appAlert(r.reason === 'full'
        ? tRef.current(REJECT_KEY[r.reason], { n: MAX_OFFLINE_ENTRIES })
        : tRef.current(REJECT_KEY[r.reason]));
      return false;
    }
    await reload();
    showNotification({
      id: 'heid-offline', kind: 'info',
      title: tRef.current('offline.queued'),
      message: tRef.current('offline.queuedHint'),
      timeoutMs: 8_000,
    });
    return true;
  }, [reload]);

  /** 队列与「这条已经写回桌面了」之间只认一个动作：桌面确认收下 → 摘掉这一条。
      交互式保存成功（离线攒过之后又当场存了一次）与长按菜单的「弃用」都走它 */
  const dropForPath = useCallback(async (path: string) => {
    const hit = entriesRef.current.filter(e => e.path === path);
    for (const e of hit) await removeEntry(e.id);
    if (hit.length) await reload();
  }, [reload]);

  const clearAll = useCallback(async () => {
    await clearQueue();
    await reload();
  }, [reload]);

  const markers = useMemo(() => {
    const m = new Map<string, OfflineEntry['state']>();
    for (const e of entries) if (e.path) m.set(e.path, e.state);
    return m;
  }, [entries]);

  const pending = useMemo(() => entries.filter(e => e.state === 'queued').length, [entries]);
  const conflicts = useMemo(() => entries.filter(e => e.state === 'conflict').length, [entries]);

  return {
    entries, markers, pending, conflicts, progress,
    offline: status?.role === 'client' && !connected,
    enqueueOffline, dropForPath, clearAll,
    syncNow: (path?: string) => void runRef.current(path),
    cancel: () => { cancelRef.current = true; },
  };
}
