/**
 * 会话持久化（仅 Tauri）：启动时按快照重建上次会话，快照跟随标签页变化持续写入。
 * - file 条目重读磁盘（文件已删除/移动则跳过）；virtual 条目（未关闭且未编辑的
 *   welcome / 空 untitled）确定性重建，保证「没关的标签页重启后还在」；
 * - 恢复尝试完成前不写入会话快照，避免启动瞬间把上次会话覆盖为空；
 * - 「退出并保存」在销毁窗口前也显式调用 writeSessionSnapshot 一次，
 *   避免状态更新对应的 effect 尚未执行、窗口已被销毁。
 */
import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { loadSessionState, saveSessionState, dedupeVirtualByTitle, type SessionTab } from '../lib/session';
import { readLocalPath, isTauri } from '../lib/fileIO';
import { detectLanguageFromPath } from '../lib/codemirror';
import {
  INITIAL_WELCOME_ID, LARGE_FILE_CHARS, makeUntitledTab, makeWelcomeTab, nextTabId,
  type FileTab,
} from '../lib/tabModel';
import { getDraft, draftKeyForTab } from '../lib/drafts';

export interface SessionPersistenceOptions {
  tabsRef: RefObject<FileTab[]>;
  activeTabIdRef: RefObject<string>;
  setTabs: React.Dispatch<React.SetStateAction<FileTab[]>>;
  setActiveTabId: React.Dispatch<React.SetStateAction<string>>;
}

export function useSessionPersistence({ tabsRef, activeTabIdRef, setTabs, setActiveTabId }: SessionPersistenceOptions) {
  /* 恢复尝试完成前不写入会话快照，避免启动瞬间把上次会话覆盖为空 */
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (!isTauri) return;
    const session = loadSessionState();
    if (!session || session.tabs.length === 0) {
      hydratedRef.current = true;
      return;
    }
    let disposed = false;
    (async () => {
      const restored: FileTab[] = [];
      /* 历史快照可能含同标题的重复虚拟条目（welcome 复活 bug 的遗留产物），先收敛 */
      for (const st of dedupeVirtualByTitle(session.tabs)) {
        if (st.kind === 'virtual') {
          const base = st.title === 'welcome.ts' ? makeWelcomeTab() : makeUntitledTab(st.title);
          if (st.title !== 'welcome.ts') {
            /* 无路径标签的语言按标题扩展名还原（makeUntitledTab 默认 plaintext，
               否则导入的 .md 恢复后丢失 markdown 预览/分屏入口） */
            base.language = detectLanguageFromPath(st.title);
            if (base.language === 'markdown' && st.mdView) base.mdView = st.mdView;
          }
          if (st.draft) {
            /* 脏的无路径标签：内容在草稿里，恢复并标脏（草稿丢失则退化为空标签） */
            const draft = getDraft(draftKeyForTab({ path: null, title: st.title }));
            if (draft !== null) {
              base.content = draft;
              base.isDirty = true;
            }
          }
          restored.push(base);
          continue;
        }
        try {
          const file = await readLocalPath(st.path);
          const language = detectLanguageFromPath(file.name);
          /* 草稿叠加：上次退出时该文件有未保存内容，恢复并标脏 */
          const draft = getDraft(draftKeyForTab({ path: st.path, title: file.name }));
          const hasDraft = draft !== null && draft !== file.content;
          restored.push({
            id: nextTabId(),
            title: file.name,
            path: st.path,
            handle: null,
            content: hasDraft ? draft : file.content,
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
          });
        } catch {
          // 文件已被删除/移动：跳过该标签
        }
      }
      if (disposed) return;
      hydratedRef.current = true;
      if (restored.length === 0) {
        // 全部失效：清掉快照，保留初始 welcome 标签
        saveSessionState({ tabs: [], activePath: null });
        return;
      }
      setTabs(prev => {
        // 快照完整描述上次会话：移除未被编辑过的初始 welcome 标签（若快照含 welcome 会随之重建）；
        // 恢复期间用户新建/编辑过的标签保留
        const kept = prev.filter(t => !(t.id === INITIAL_WELCOME_ID && !t.isDirty));
        return [...kept, ...restored];
      });
      /* 激活标签还原：file 按路径；无路径（activePath=null）按 activeVirtualTitle 精确匹配——
         否则「激活的是导入的 md」重启后会错误地落在第一个无路径标签（welcome）上 */
      const active =
        (session.activePath === null
          ? restored.find(t => !t.path && t.title === session.activeVirtualTitle) ?? restored.find(t => !t.path)
          : restored.find(t => t.path === session.activePath))
        ?? restored[restored.length - 1];
      setActiveTabId(active.id);
    })();
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- 会话快照：跟随标签页变化持续写入 ----
     file 标签存路径；无路径标签仅在未编辑时存为 virtual（内容可确定性重建）；
     脏的无路径标签不持久化——其存亡由退出确认决定，用户确认放弃后不应「复活」。 */
  const writeSessionSnapshot = useCallback(() => {
    if (!isTauri || !hydratedRef.current) return;
    const active = tabsRef.current.find(t => t.id === activeTabIdRef.current);
    saveSessionState({
      tabs: dedupeVirtualByTitle(tabsRef.current.flatMap((t): SessionTab[] => {
        if (t.path) return [{ kind: 'file', path: t.path, mdView: t.mdView }];
        /* 脏的无路径标签：内容在草稿（lib/drafts），快照只记 draft 标志；
           用户确认「不保存」退出时草稿与快照条目一并清除（见 confirmWindowClose / closeTab） */
        return t.isDirty
          ? [{ kind: 'virtual', title: t.title, draft: !t.readOnly, mdView: t.mdView }]
          : [{ kind: 'virtual', title: t.title, mdView: t.mdView }];
      })),
      activePath: active?.path ?? null,
      activeVirtualTitle: active && !active.path ? active.title : null,
    });
  }, [activeTabIdRef, tabsRef]);

  return { writeSessionSnapshot, hydratedRef };
}
