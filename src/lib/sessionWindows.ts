/**
 * 多窗口会话存储（lib/session 之上的按窗口编排）：
 * - 快照按窗口隔离：主窗口沿用旧键 heid-session（老用户会话无缝升级），
 *   子窗口写 heid-session:<label>——所有窗口共享同一份 localStorage，不隔离会互相覆盖；
 * - manifest 键登记窗口 label 列表（顺序即窗口顺序），供主窗口启动时逐一拉起子窗口；
 * - releaseWindowSession 实现关闭规则：关单窗（尚有其他窗口）清快照并注销；
 *   关最后一个窗口（= 退出应用）保留全部快照，下次启动整体还原。
 * 全部函数显式接收 Storage（可注入桩测试），不可用时静默降级。
 */
import { loadSessionState, saveSessionState, type SessionState, type SessionStorageKey } from './session';

export const MANIFEST_KEY = 'heid-session:manifest';

/** localStorage 访问可能抛错（隐私模式）：收敛为 null 供各函数静默降级 */
export function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** 主窗口沿用旧键，子窗口按 label 隔离 */
export function sessionKeyForLabel(label: string): SessionStorageKey {
  return label === 'main' ? 'heid-session' : `heid-session:${label}`;
}

/* ---- manifest ---- */

export function readManifest(storage: Storage | null): string[] {
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(MANIFEST_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const out: string[] = [];
    for (const item of data) {
      if (typeof item !== 'string' || item.length === 0 || out.includes(item)) continue;
      out.push(item);
    }
    return out;
  } catch {
    return [];
  }
}

export function writeManifest(storage: Storage | null, labels: string[]): void {
  if (!storage) return;
  try {
    storage.setItem(MANIFEST_KEY, JSON.stringify(labels));
  } catch { /* 静默 */ }
}

export function registerWindowInManifest(storage: Storage | null, label: string): void {
  if (!storage) return;
  const list = readManifest(storage);
  if (list.includes(label)) return;
  writeManifest(storage, [...list, label]);
}

export function unregisterWindowFromManifest(storage: Storage | null, label: string): void {
  if (!storage) return;
  const list = readManifest(storage);
  const next = list.filter(l => l !== label);
  if (next.length !== list.length) writeManifest(storage, next);
}

/* ---- 按 label 的快照读写 ---- */

export function loadSessionForLabel(storage: Storage | null, label: string): SessionState | null {
  return loadSessionState(storage, sessionKeyForLabel(label));
}

export function saveSessionForLabel(storage: Storage | null, label: string, state: SessionState): void {
  saveSessionState(state, storage, sessionKeyForLabel(label));
}

export function clearSessionForLabel(storage: Storage | null, label: string): void {
  try {
    storage?.removeItem(sessionKeyForLabel(label));
  } catch { /* 静默 */ }
}

/**
 * 窗口关闭时的会话处置（返回值供日志/测试）：
 * - isLast=true（这是最后一个窗口，等于退出应用）：保留全部快照，下次启动整体还原；
 * - 否则：清自己的快照并从 manifest 注销——窗口没了，它的标签页不应在下次启动复活。
 */
export function releaseWindowSession(storage: Storage | null, label: string, isLast: boolean): 'kept' | 'cleared' {
  if (isLast) return 'kept';
  clearSessionForLabel(storage, label);
  unregisterWindowFromManifest(storage, label);
  return 'cleared';
}
