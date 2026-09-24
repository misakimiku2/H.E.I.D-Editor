import { useEffect, useRef } from 'react';
import { fileTouched, subscribeFileChanges, type FsDirs } from '../lib/remoteChanges';
import { parseRemotePath, remoteRead, remoteStat } from '../lib/remote';
import { normalizeToLf } from '../lib/lineEndings';

/** 一个正被标签页看着的远程文件。`baseHash` 是打开/保存时桌面带回的内容基线 */
export interface RemoteWatched {
  path: string;
  /** 手机上认为磁盘上此刻就是这一份（编辑器内容空间：LF 归一） */
  originalContent: string;
  baseHash: string;
}

export interface UseRemoteFileChangesOptions {
  tabs: RemoteWatched[];
  /** 检测到桌面的内容与基线不一致。before = 手机上那份基线，after = 桌面当前那份，
      hash = 这一份的新基线 —— 调用方要把它写回标签，否则用户接着改完再保存，
      会撞上一次本不该有的「桌面期间也改过」 */
  onExternalChange: (path: string, before: string, after: string, hash: string) => void;
}

/**
 * 打开着的远程文件被桌面改了 → 走**与桌面外部修改完全同一套**时间线语义（v1.5 阶段 4）。
 * 判据与代价都不是这里新造的：谁核对、核对完显示成什么样，都沿用 `useExternalFileWatcher`
 * 那一条入口（App 侧同一个 handleExternalChange），所以手机端不会多一种提示。
 *
 * 为什么这里是「按目录命中 → 去 stat 一个文件」而不是桌面那种「一个文件一份监听」：
 * 推送帧只列**变了哪些目录**（载荷形状与理由见 `src/lib/remoteChanges.ts`），
 * 文件名不在里面。多那一次 `stat` 往返就是这条设计的代价，如实记在 ROADMAP 阶段 4 那一节。
 *
 * 判据只用内容哈希：桌面把我们刚写回去的那份也推一帧，而那次哈希与基线相同 → 无事发生。
 * 自己写的东西不会在自己屏幕上变成一次外部修改，这条不靠"记住自己刚写过"来实现。
 *
 * 两条如实的限制：
 * - **哈希为空的不核对**：目录与超过远程上限（6 MB）的文件在 `stat` 里就是不报哈希。
 *   拿 mtime 判等会被"桌面刚保存的那一秒"糊过去，所以宁可这次不提醒，也不误报一次覆盖；
 * - **桌面把文件删了这里不提示**：`stat` 直接失败，与桌面那份 watcher 的处理一致
 *   （它也只忽略读取失败的事件，不做删除场景）。标签里的内容仍在，
 *   真去保存时会以冲突的形式回来。
 */
export function useRemoteFileChanges({
  tabs,
  onExternalChange,
}: UseRemoteFileChangesOptions): void {
  const tabsRef = useRef<RemoteWatched[]>(tabs);
  tabsRef.current = tabs;
  const cbRef = useRef(onExternalChange);
  cbRef.current = onExternalChange;
  /* 同一路径同时只跑一次核对：帧最快 300 ms 一帧，而一次 stat + read 可能跨两帧 */
  const busyRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const check = async (dirs: FsDirs): Promise<void> => {
      const wanted = tabsRef.current.filter(t => {
        const ref = parseRemotePath(t.path);
        // 没有基线的（异常路径）不核对：拿了哈希也没法判断"变了没"
        return !!ref && !!t.baseHash && fileTouched(ref.rel, dirs);
      });
      for (const tab of wanted) {
        if (busyRef.current.has(tab.path)) continue;
        busyRef.current.add(tab.path);
        try {
          const rel = parseRemotePath(tab.path)?.rel ?? '';
          const st = await remoteStat(rel);
          // 空哈希 = 桌面不给判据；与基线相同 = 没变，包含我们自己刚写回去的那一次
          if (!st.hash || st.hash === tab.baseHash) continue;
          const fresh = await remoteRead(rel);
          if (fresh.binary) continue;
          cbRef.current(
            tab.path,
            normalizeToLf(tab.originalContent),
            normalizeToLf(fresh.text),
            fresh.hash,
          );
        } catch {
          // 读不到（被删 / 被换根 / 链路断了）：与桌面侧同一处理，忽略这一帧而不是弹一次错
        } finally {
          busyRef.current.delete(tab.path);
        }
      }
    };

    return subscribeFileChanges({
      onDirs: dirs => void check(dirs),
      // 换根之后手里那些 rel 十有八九指向别处，整份按「都该核对一遍」处理
      onRootChanged: () => void check('all'),
    });
  }, []);
}
