import { FileText, Plus, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Sheet } from './Sheet';
import { useT } from '../../lib/i18nContext';

interface TabSheetProps {
  open: boolean;
  isDarkMode: boolean;
  onClose: () => void;
  tabs: Array<{ id: string; title: string; isDirty: boolean }>;
  activeTabId: string;
  onSelect: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNew: () => void;
}

/** 移动端标签页抽屉：列出全部标签（关闭按钮常显），顶部提供新建 */
export function TabSheet({
  open, isDarkMode, onClose, tabs, activeTabId, onSelect, onCloseTab, onNew,
}: TabSheetProps) {
  const t = useT();
  return (
    <Sheet open={open} isDarkMode={isDarkMode} onClose={onClose} title={t('mobile.tabsTitle', { n: tabs.length })}>
      <div className="px-2 pb-3">
        <button
          onClick={() => { onClose(); onNew(); }}
          className={cn(
            'w-full mb-1 px-3 py-2.5 min-h-[48px] rounded-lg text-sm font-medium flex items-center gap-2.5 transition-colors',
            isDarkMode ? 'hover:bg-zinc-700/70 text-zinc-300' : 'hover:bg-zinc-100 text-zinc-600'
          )}
        >
          <Plus size={16} className="shrink-0" />
          {t('menu.newFile')}
        </button>
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              onClick={() => { onClose(); onSelect(tab.id); }}
              className={cn(
                'w-full px-3 py-2.5 rounded-lg text-sm flex items-center gap-2.5 cursor-pointer transition-colors min-h-[48px]',
                active
                  ? (isDarkMode ? 'bg-zinc-700 text-zinc-100' : 'bg-zinc-200/80 text-zinc-800')
                  : (isDarkMode ? 'hover:bg-zinc-700/50 text-zinc-400' : 'hover:bg-zinc-100 text-zinc-600')
              )}
            >
              <span
                className={cn(
                  'w-1.5 h-1.5 rounded-full shrink-0',
                  tab.isDirty
                    ? 'bg-amber-500'
                    : active
                      ? 'bg-emerald-500'
                      : (isDarkMode ? 'bg-zinc-600' : 'bg-zinc-300')
                )}
              />
              <FileText size={14} className="shrink-0 opacity-60" />
              <span className="truncate flex-1">{tab.title}</span>
              {/* 溢出菜单里的「关闭当前标签页」已移除，这里就是手机端唯一的关标签入口，
                  命中区必须到 48dp（图标仍 14px，靠按钮尺寸撑） */}
              <button
                onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
                className={cn(
                  'w-12 h-12 -mr-2 shrink-0 rounded-md flex items-center justify-center transition-colors',
                  isDarkMode ? 'hover:bg-zinc-600 text-zinc-400' : 'hover:bg-zinc-300/70 text-zinc-500'
                )}
                aria-label={t('mobile.closeTabNamed', { name: tab.title })}
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </Sheet>
  );
}
