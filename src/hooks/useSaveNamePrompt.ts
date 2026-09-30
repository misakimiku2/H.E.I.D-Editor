/**
 * 保存文件名确认（安卓另存为 / 首次保存）：EMUI 的系统保存对话框按 MIME 强补 .txt，
 * 用户在系统框里改扩展名（删掉 txt 敲 md）应用永远拿不到真名——返回的是 xx.md.txt。
 * 所以落盘前先在自己应用里问一句文件名，系统对话框只负责选位置。
 * Promise 经 state 回调完成，与 useDiscardConfirm 同构；已有待确认项时拒绝新请求。
 */
import { useCallback, useRef, useState } from 'react';

export interface PendingSaveName {
  defaultName: string;
  resolve: (name: string | null) => void;
}

export function useSaveNamePrompt() {
  const [pendingSaveName, setPendingSaveName] = useState<PendingSaveName | null>(null);
  const pendingRef = useRef<PendingSaveName | null>(null);
  pendingRef.current = pendingSaveName;

  const askSaveName = useCallback((defaultName: string): Promise<string | null> => {
    if (pendingRef.current) return Promise.resolve(null);
    return new Promise(resolve => {
      setPendingSaveName({
        defaultName,
        resolve: name => {
          setPendingSaveName(null);
          resolve(name);
        },
      });
    });
  }, []);

  return { pendingSaveName, askSaveName };
}
