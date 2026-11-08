/**
 * 会话快照 → 标签页恢复例程(纯异步,无 React 依赖)。
 * 两条入口复用:主窗口启动读 localStorage 快照;多窗口会话恢复拉起的子窗口
 * 经 IPC 载荷拿到等价的 SessionState。恢复语义:
 * - file 条目并行重读磁盘(文件已删除/移动则跳过);virtual 条目(welcome / 空
 *   untitled)确定性重建;脏标签内容由草稿(lib/drafts)叠加并标脏;
 * - 从草稿叠加回来的标签(标题 + 草稿时刻)随结果回报,调用方据此发一条恢复通知;
 * - 尺寸分层与打开路由同判定:超限跳过(失效条目),大文件恢复为分块预览标签。
 */
import { readLocalPath } from './fileIO';
import { detectLanguageFromPath } from './codemirror';
import { displayNameFromPath } from './platform';
import { classifyBySize, fileSize } from './largeFile';
import {
  LARGE_FILE_CHARS, makeLargePreviewTab, makeUntitledTab, makeWelcomeTab, nextTabId,
  type FileTab,
} from './tabModel';
import { draftKeyForTab, loadDrafts } from './drafts';
import { dedupeVirtualByTitle, type SessionState } from './session';

export interface RestoredSession {
  tabs: FileTab[];
  activeId: string;
  /**
   * 从草稿叠加回来的那些标签（标题 + 草稿最后一次落草稿的时刻）：
   * 标签上的脏点说不清「这是上次没保存的内容」，调用方据此说一句。
   */
  drafted: { title: string; at: number }[];
}

/** 激活标签还原(纯函数):file 按路径;无路径(activePath=null)按 activeVirtualTitle
    精确匹配——否则「激活的是导入的 md」重启后会错误地落在第一个无路径标签(welcome)上 */
export function pickActiveTab(restored: FileTab[], session: SessionState): FileTab | null {
  return (
    (session.activePath === null
      ? restored.find(t => !t.path && t.title === session.activeVirtualTitle) ?? restored.find(t => !t.path)
      : restored.find(t => t.path === session.activePath))
    ?? restored[restored.length - 1]
    ?? null
  );
}

/** 按快照重建标签页;全部条目失效返回 null(调用方清快照) */
export async function restoreSessionTabs(session: SessionState): Promise<RestoredSession | null> {
  /* 历史快照可能含同标题的重复虚拟条目(welcome 复活 bug 的遗留产物),先收敛 */
  const entries = dedupeVirtualByTitle(session.tabs);
  /* 草稿整份读一次:逐个 getDraft 会把整张 map 反复 parse,恢复十几个标签就是十几次 */
  const drafts = loadDrafts();
  /* 并行读盘:串行时总耗时为各文件读取之和,一个大文件就能把恢复拖长数秒;
     结果按快照原顺序归位,激活标签的匹配逻辑不受读盘次序影响 */
  type Settled = { tab: FileTab | null; draft: { title: string; at: number } | null };
  const settled = await Promise.all(entries.map(async (st): Promise<Settled> => {
    if (st.kind === 'virtual') {
      const base = st.title === 'welcome.ts' ? makeWelcomeTab() : makeUntitledTab(st.title);
      if (st.title !== 'welcome.ts') {
        /* 无路径标签的语言按标题扩展名还原(makeUntitledTab 默认 plaintext,
           否则导入的 .md 恢复后丢失 markdown 预览/分屏入口) */
        base.language = detectLanguageFromPath(st.title);
        if (base.language === 'markdown' && st.mdView) base.mdView = st.mdView;
      }
      if (st.draft) {
        /* 脏的无路径标签:内容在草稿里,恢复并标脏(草稿丢失则退化为空标签) */
        const entry = drafts[draftKeyForTab({ path: null, title: st.title })];
        if (entry) {
          base.content = entry.content;
          base.isDirty = true;
          return { tab: base, draft: { title: st.title, at: entry.at } };
        }
      }
      return { tab: base, draft: null };
    }
    try {
      /* 尺寸分层与打开路由同判定:超限跳过(视为失效条目),大文件恢复为分块预览标签 */
      const size = await fileSize(st.path);
      if (size != null) {
        const cls = classifyBySize(size);
        if (cls === 'reject') return { tab: null, draft: null };
        if (cls === 'preview') {
          const name = displayNameFromPath(st.path);
          return { tab: makeLargePreviewTab(st.path, name, detectLanguageFromPath(name)), draft: null };
        }
      }
      const file = await readLocalPath(st.path);
      const language = detectLanguageFromPath(file.name);
      /* 草稿叠加:上次退出时该文件有未保存内容,恢复并标脏。
         只比内容不比时间——磁盘那份后来又被外部改过时，这里仍然端出用户自己的未保存版，
         丢掉任何一边都不可接受；恢复通知会把「这份草稿最后一次是什么时候」说出来 */
      const entry = drafts[draftKeyForTab({ path: st.path, title: file.name })];
      const hasDraft = entry !== undefined && entry.content !== file.content;
      const tab: FileTab = {
        id: nextTabId(),
        title: file.name,
        path: st.path,
        handle: null,
        content: hasDraft ? entry.content : file.content,
        originalContent: file.content,
        language,
        isDirty: hasDraft,
        readOnly: !!file.binary,
        mdView: language === 'markdown' ? st.mdView : 'edit',
        encoding: file.encoding,
        bom: file.bom,
        eol: file.eol,
        originalEol: file.eol,
        binary: file.binary,
        large: file.content.length > LARGE_FILE_CHARS,
      };
      return { tab, draft: hasDraft ? { title: file.name, at: entry.at } : null };
    } catch {
      // 文件已被删除/移动:跳过该标签
      return { tab: null, draft: null };
    }
  }));
  const restored = settled.map(s => s.tab).filter((t): t is FileTab => t !== null);
  if (restored.length === 0) return null;
  return {
    tabs: restored,
    activeId: pickActiveTab(restored, session)?.id ?? '',
    drafted: settled.map(s => s.draft).filter((d): d is NonNullable<Settled['draft']> => d !== null),
  };
}
