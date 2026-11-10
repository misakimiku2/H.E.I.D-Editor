/**
 * 大文档 Markdown 查找的 Rust 桥接（Phase 1）：
 * 索引只留在 Rust 内存里，前端拿 indexId 复用；任何一步不可用（浏览器 /
 * 非 Tauri / 命令失败 / 索引被淘汰）都返回 null，调用方回退现有「补载全文 +
 * DOM 扫描」路径，功能不退化。
 */
import { isTauri } from './fileIO';

export interface MdIndexInfo {
  id: number;
  indexMs: number;
  reused: boolean;
  contentHash: string;
}

export interface MdSearchMatch {
  /** 命中起点（UTF-16 下标，与预览块 data-md-start 同一坐标系） */
  sourceStart: number;
  sourceEnd: number;
  /** 命中原文（超长截断，末尾带 …） */
  text: string;
  textTruncated: boolean;
  snippet: string;
}

export interface MdSearchResult {
  /** 全量命中数（不受 matches 数组上限影响） */
  total: number;
  /** matches 被截断（total > matches.length） */
  capped: boolean;
  matches: MdSearchMatch[];
  indexMs: number;
  searchMs: number;
  /** 正则编译错误等；有错误时 total/matches 为空 */
  error: string | null;
}

export interface MdBridgeSearchOptions {
  query: string;
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
  /** 前端展示/导航上限；total 仍全量统计 */
  maxResults?: number;
}

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

async function getInvoke(): Promise<InvokeFn | null> {
  if (!isTauri) return null;
  try {
    const mod = await import('@tauri-apps/api/core');
    return mod.invoke as InvokeFn;
  } catch {
    return null;
  }
}

/** 建立索引；失败返回 null（调用方回退整篇渲染查找） */
export async function buildMdIndex(content: string, cacheKey: string): Promise<MdIndexInfo | null> {
  const invoke = await getInvoke();
  if (!invoke) return null;
  try {
    return await invoke('md_index_build', { cacheKey, content }) as MdIndexInfo;
  } catch {
    return null;
  }
}

/** 在已建立的索引上查找；索引失效或命令失败返回 null */
export async function searchMdIndex(
  indexId: number,
  options: MdBridgeSearchOptions,
): Promise<MdSearchResult | null> {
  const invoke = await getInvoke();
  if (!invoke) return null;
  try {
    return await invoke('md_search', { indexId, options }) as MdSearchResult;
  } catch {
    return null;
  }
}

/** 释放索引（文档切换 / 内容变化 / 预览卸载） */
export async function releaseMdIndex(indexId: number): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) return;
  try {
    await invoke('md_index_release', { indexId });
  } catch {
    /* 索引已被 LRU 淘汰时释放失败无影响 */
  }
}
