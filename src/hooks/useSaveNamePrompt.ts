/**
 * 保存前的应用内确认（安卓另存为 / 新建文档的首次保存）：一次问清两件绑在一起的事 ——
 * **叫什么** 与 **存手机还是存电脑**。
 *
 * 名字必须自己问：EMUI 的系统保存框按 MIME 强补 .txt，用户在系统框里改扩展名应用永远拿不到
 * 真名（返回的是 xx.md.txt）。目的地也必须在这里问：系统那张框根本不认识「那台电脑」，
 * 存到电脑走的是链路上一条 `create`，压根没有系统框可走。
 *
 * 桌面上那个位置被占着时（`occupied`），同一层再问一次：换个名字，或明确覆盖那一份。
 * 覆盖要带回桌面刚给的基线 —— 于是「问的那一份」与「写下去的那一份」是同一份。
 *
 * Promise 经 state 回调完成，与 useDiscardConfirm 同构；已有待确认项时拒绝新请求。
 */
import { useCallback, useRef, useState } from 'react';
import type { RemoteOccupied, SaveTarget } from '../lib/fileIO';

export interface PendingSaveName {
  defaultName: string;
  /** 桌面上那份占着位置的现场；有它就是「撞名之后再问一次」那一趟 */
  occupied?: RemoteOccupied;
  resolve: (target: SaveTarget | null) => void;
}

export function useSaveNamePrompt() {
  const [pendingSaveName, setPendingSaveName] = useState<PendingSaveName | null>(null);
  const pendingRef = useRef<PendingSaveName | null>(null);
  pendingRef.current = pendingSaveName;

  const askSaveName = useCallback(
    (defaultName: string, occupied?: RemoteOccupied): Promise<SaveTarget | null> => {
      if (pendingRef.current) return Promise.resolve(null);
      return new Promise(resolve => {
        setPendingSaveName({
          defaultName,
          occupied,
          resolve: target => {
            /* ref 当场清掉，不等那一次重渲染：`saveToDesktop` 拿到结果后可能立刻再问一次
               （撞名 → 换名字或覆盖），而 React 尚未提交 `pendingSaveName = null` 的那几毫秒里，
               只认 state 的话这次再问会被当成"已经有一层在问着"，返回 null = 用户取消，
               于是保存静默不发生。这是本轮设计里唯一一次「弹窗自己接着问自己」。 */
            pendingRef.current = null;
            setPendingSaveName(null);
            resolve(target);
          },
        });
      });
    },
    [],
  );

  return { pendingSaveName, askSaveName };
}
