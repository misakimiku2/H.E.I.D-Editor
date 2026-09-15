import { useEffect } from 'react';
import { X, RotateCcw } from 'lucide-react';
import { cn } from '../lib/utils';
import {
  DEFAULT_SETTINGS, FONT_OPTIONS,
  type EditorSettings, type LineWrapMode, type LanguagePref,
} from '../lib/settings';
import { useT, type MessageKey } from '../lib/i18nContext';

interface SettingsDialogProps {
  isDarkMode: boolean;
  settings: EditorSettings;
  onChange: (next: EditorSettings) => void;
  onClose: () => void;
}

/**
 * 设置弹窗：界面（语言）、编辑器（字体/字号/行高/缩进/换行/空白符）、
 * 界面辅助（小地图/粘性滚动）、自动保存（开关 + 间隔）。
 * 修改即时生效并持久化（App 层负责写 localStorage）。
 */

const FONT_LABEL_KEYS: Record<string, MessageKey> = {
  default: 'font.default',
  consolas: 'font.consolas',
  jetbrains: 'font.jetbrains',
  fira: 'font.fira',
  cascadia: 'font.cascadia',
  'system-mono': 'font.system-mono',
};

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'w-9 h-5 rounded-full relative transition-colors shrink-0',
        checked ? 'bg-emerald-500' : 'bg-zinc-400/50'
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all',
          checked ? 'left-[18px]' : 'left-0.5'
        )}
      />
    </button>
  );
}

export function SettingsDialog({ isDarkMode, settings, onChange, onClose }: SettingsDialogProps) {
  const t = useT();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = <K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) =>
    onChange({ ...settings, [key]: value });

  const panelCls = cn(
    "relative w-[min(460px,92vw)] max-h-[85vh] overflow-auto heid-scroll rounded-2xl border shadow-2xl",
    isDarkMode ? "border-zinc-700 bg-zinc-800 text-zinc-100" : "border-zinc-200 bg-white text-zinc-800"
  );
  const sectionCls = "px-5 pt-4 pb-1 text-[11px] font-semibold tracking-wider " +
    (isDarkMode ? "text-zinc-500" : "text-zinc-400");
  const rowCls = "flex items-center justify-between gap-3 px-5 py-2";
  const labelCls = "text-xs font-medium";
  const selectCls = cn(
    "h-7 px-2 rounded-md border text-xs outline-none min-w-[150px]",
    isDarkMode ? "border-zinc-600 bg-zinc-900 text-zinc-200" : "border-zinc-300 bg-white text-zinc-800"
  );

  const languageRow = (
    <div className={rowCls}>
      <span className={labelCls}>{t('settings.language')}</span>
      <select
        value={settings.language}
        onChange={(e) => set('language', e.target.value as LanguagePref)}
        className={selectCls}
      >
        <option value="system">{t('settings.langSystem')}</option>
        <option value="zh">简体中文</option>
        <option value="en">English</option>
      </select>
    </div>
  );

  const rows: Array<{ key: keyof EditorSettings; label: string; node: React.ReactNode }> = [
    { key: 'fontFamily', label: t('settings.font'), node: (
      <select value={settings.fontFamily} onChange={(e) => set('fontFamily', e.target.value)} className={selectCls}>
        {FONT_OPTIONS.map(f => <option key={f.id} value={f.stack}>{t(FONT_LABEL_KEYS[f.id] ?? 'font.default')}</option>)}
      </select>
    ) },
    { key: 'fontSize', label: t('settings.fontSize'), node: (
      <select value={settings.fontSize} onChange={(e) => set('fontSize', Number(e.target.value))} className={selectCls}>
        {[12, 13, 14, 15, 16, 18, 20, 24].map(n => <option key={n} value={n}>{n} px</option>)}
      </select>
    ) },
    { key: 'lineHeight', label: t('settings.lineHeight'), node: (
      <select value={settings.lineHeight} onChange={(e) => set('lineHeight', Number(e.target.value))} className={selectCls}>
        {[1.3, 1.4, 1.55, 1.7, 1.9, 2.2].map(n => <option key={n} value={n}>{n}</option>)}
      </select>
    ) },
    { key: 'tabSize', label: t('settings.tabWidth'), node: (
      <select value={settings.tabSize} onChange={(e) => set('tabSize', Number(e.target.value))} className={selectCls}>
        {[2, 4, 8].map(n => <option key={n} value={n}>{t('settings.tabSizeChars', { n })}</option>)}
      </select>
    ) },
    { key: 'insertSpaces', label: t('settings.indentWith'), node: (
      <select
        value={settings.insertSpaces ? 'space' : 'tab'}
        onChange={(e) => set('insertSpaces', e.target.value === 'space')}
        className={selectCls}
      >
        <option value="space">{t('settings.indentSpaces')}</option>
        <option value="tab">{t('settings.indentTabs')}</option>
      </select>
    ) },
    { key: 'lineWrapMode', label: t('settings.lineWrap'), node: (
      <select
        value={settings.lineWrapMode}
        onChange={(e) => set('lineWrapMode', e.target.value as LineWrapMode)}
        className={selectCls}
      >
        <option value="markdown">{t('settings.wrapMarkdownOnly')}</option>
        <option value="always">{t('settings.wrapAlways')}</option>
        <option value="never">{t('settings.wrapNever')}</option>
      </select>
    ) },
  ];

  const toggles: Array<{ key: keyof EditorSettings; label: string; hint?: string }> = [
    { key: 'showWhitespace', label: t('settings.showWhitespace') },
    { key: 'minimap', label: t('settings.minimap'), hint: t('settings.hintPhoneOnly') },
    { key: 'stickyScroll', label: t('settings.stickyScroll'), hint: t('settings.hintUnavailable') },
    { key: 'colorDecorations', label: t('settings.colorDecorations') },
  ];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-zinc-950/30 backdrop-blur-md" onClick={onClose} />
      <div className={panelCls}>
        <button
          onClick={onClose}
          className={cn(
            "absolute top-3 right-3 p-1 rounded-md transition-colors z-10",
            isDarkMode ? "hover:bg-zinc-700 text-zinc-400" : "hover:bg-zinc-200 text-zinc-500"
          )}
          title={t('common.close')}
        >
          <X size={14} />
        </button>
        <h2 className="px-5 pt-5 pb-1 text-base font-bold">{t('settings.title')}</h2>

        <div className={sectionCls}>{t('settings.section.interface')}</div>
        {languageRow}

        <div className={sectionCls}>{t('settings.section.editor')}</div>
        {rows.map(({ key, label, node }) => (
          <div key={key} className={rowCls}>
            <span className={labelCls}>{label}</span>
            {node}
          </div>
        ))}

        <div className={sectionCls}>{t('settings.section.uiAids')}</div>
        {toggles.map(({ key, label, hint }) => (
          <div key={key} className={rowCls}>
            <span className={labelCls}>
              {label}
              {hint && <span className={cn("ml-2 text-[10px]", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>{hint}</span>}
            </span>
            <Toggle
              checked={settings[key] as boolean}
              onChange={(v) => set(key, v as never)}
              label={label}
            />
          </div>
        ))}

        <div className={sectionCls}>{t('settings.section.autosave')}</div>
        <div className={rowCls}>
          <span className={labelCls}>{t('settings.autosaveToggle')}</span>
          <Toggle
            checked={settings.autosaveEnabled}
            onChange={(v) => set('autosaveEnabled', v)}
            label={t('settings.autosave')}
          />
        </div>
        {settings.autosaveEnabled && (
          <div className={rowCls}>
            <span className={labelCls}>{t('settings.autosaveInterval')}</span>
            <select
              value={settings.autosaveIntervalSec}
              onChange={(e) => set('autosaveIntervalSec', Number(e.target.value))}
              className={selectCls}
            >
              {[10, 30, 60, 120, 300].map(n => (
                <option key={n} value={n}>
                  {n >= 60 ? t('settings.autosaveMinutes', { n: n / 60 }) : t('settings.autosaveSeconds', { n })}
                </option>
              ))}
            </select>
          </div>
        )}
        <p className={cn("px-5 pb-2 text-[10px] leading-relaxed", isDarkMode ? "text-zinc-500" : "text-zinc-400")}>
          {t('settings.draftNote')}
        </p>

        <div className={cn("flex items-center justify-between px-5 py-3 border-t", isDarkMode ? "border-zinc-700" : "border-zinc-200")}>
          <button
            onClick={() => onChange({ ...DEFAULT_SETTINGS })}
            className={cn(
              "px-2.5 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors",
              isDarkMode ? "hover:bg-zinc-700 text-zinc-400" : "hover:bg-zinc-100 text-zinc-500"
            )}
          >
            <RotateCcw size={12} /> {t('common.resetDefault')}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-md text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
          >
            {t('common.done')}
          </button>
        </div>
      </div>
    </div>
  );
}
