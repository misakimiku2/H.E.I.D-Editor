/**
 * 丢弃确认（应用内自绘弹窗，替代原生 ask / window.confirm）：
 * WebView 的 window.confirm 不可靠，原生系统对话框与应用视觉割裂，
 * 三端（桌面/安卓/浏览器）统一走 ConfirmDialog。
 * 退出应用与关闭脏标签共用同一套弹窗；resolve 经 state 回调完成 Promise。
 * 已有待确认项时直接拒绝新请求，避免叠开多个弹窗。
 */
import { useCallback, useRef, useState } from 'react';

export interface PendingDiscardConfirm {
  /** 弹窗标题；缺省「未保存的更改」（文件树删除等场景传入自己的标题） */
  title?: string;
  message: string;
  confirmText: string;
  saveText: string | null;
  resolve: (decision: 'cancel' | 'discard' | 'save') => void;
}

export type DiscardDecision = 'cancel' | 'discard' | 'save';

export function useDiscardConfirm() {
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscardConfirm | null>(null);
  const pendingDiscardRef = useRef<PendingDiscardConfirm | null>(null);
  pendingDiscardRef.current = pendingDiscard;

  const askDiscardConfirm = useCallback((
    message: string,
    confirmText: string,
    saveText?: string,
    title?: string,
  ): Promise<DiscardDecision> => {
    if (pendingDiscardRef.current) return Promise.resolve('cancel');
    return new Promise(resolve => {
      setPendingDiscard({
        title,
        message,
        confirmText,
        saveText: saveText ?? null,
        resolve: decision => {
          setPendingDiscard(null);
          resolve(decision);
        },
      });
    });
  }, []);

  return { pendingDiscard, pendingDiscardRef, askDiscardConfirm };
}
