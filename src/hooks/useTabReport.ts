/**
 * 桌面把「本窗口现在开着什么」报给设备互联链路（v1.5 阶段 3，设计稿 §6.1）。
 *
 * 手机端看到的标签列表就是这里报上去的那一份，所以两件事必须在这里定死：
 *
 * 1. **只报元数据，永不报内容**。内容永远由手机发起一次 `read` 现取 ——
 *    一次上报里带上内容，就等于允许两端各存一份"正在改的"，那正是 §2 决策 5 要杜绝的。
 * 2. **节流 + 按可见变化去重**。打字会让 `tabs` 每击一键都变一次（脏标记、光标），
 *    而手机上那份列表上看不到任何这些；不节流的话，一边敲字一边就往局域网推帧。
 *    桌面上的标签变化是人手速的动作，1.2 秒的尾沿延迟用户看不出来。
 */
import { useEffect, useRef } from 'react';
import { reportTabs, setSharedRoot, tabReports, type TabReport } from '../lib/link';
import type { FileTab } from '../lib/tabModel';

/** 尾沿节流间隔：见文件头第 2 条 */
export const TAB_REPORT_THROTTLE_MS = 1200;

export interface TabReportOptions {
  /** 只有 Tauri 桌面才报（手机恒为客户端，一台手机上没暴露过任何文件） */
  enabled: boolean;
  /** 本窗口标签（main / win-N）：多窗口下聚焦那一份决定手机上看到什么 */
  windowLabel: string;
  /** 本窗口文件树当前的根；null = 没开树 */
  rootPath: string | null;
  tabs: FileTab[];
  activeTabId: string;
  /** 激活标签的光标（编辑器只报当前这一份），手机端打开后定位一次用 */
  cursor: { line: number; col: number };
}

/**
 * 一次上报的「可见变化」判据：手机上那份列表看得出来的东西。
 * 光标不在其中 —— 它变了列表上什么都没变，为它推一帧只是吵。
 */
export function tabReportSignature(list: TabReport[]): string {
  return JSON.stringify(list.map(t => [t.path, t.title, t.language, t.mdView, t.dirty, t.readOnly]));
}

export function useTabReport({ enabled, windowLabel, rootPath, tabs, activeTabId, cursor }: TabReportOptions) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 节流窗口里攒下的最新一份（尾沿必须发它，不能发触发排队的那一份） */
  const pending = useRef<TabReport[] | null>(null);
  const lastSent = useRef<string | null>(null);
  /** 上一次真正发出的时刻；0 = 从没发过，于是第一份立刻就走 */
  const lastAt = useRef(0);
  const label = useRef(windowLabel);
  label.current = windowLabel;

  useEffect(() => {
    if (!enabled) return;
    void setSharedRoot(label.current, rootPath);
  }, [enabled, rootPath]);

  useEffect(() => {
    if (!enabled) return;
    const next = tabReports(tabs, activeTabId, cursor);
    const sig = tabReportSignature(next);
    if (sig === lastSent.current) return;
    if (timer.current) {
      // 已经排上了：只换待发的那一份，不另开定时器
      pending.current = next;
      return;
    }
    const fire = () => {
      timer.current = null;
      const list = pending.current ?? next;
      pending.current = null;
      lastSent.current = tabReportSignature(list);
      lastAt.current = Date.now();
      void reportTabs(label.current, list);
    };
    const wait = TAB_REPORT_THROTTLE_MS - (Date.now() - lastAt.current);
    if (wait <= 0) fire();
    else timer.current = setTimeout(fire, wait);
  }, [enabled, tabs, activeTabId, cursor]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      pending.current = null;
    },
    [],
  );
}
