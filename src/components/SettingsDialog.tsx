import { useEffect } from 'react';
import {
  X, RotateCcw, Settings, Palette, Sparkles, Type, LayoutGrid, Save,
  Check, Moon, Sun,
} from 'lucide-react';
import { cn } from '../lib/utils';
import {
  DEFAULT_SETTINGS, FONT_OPTIONS,
  type EditorSettings, type LanguagePref, type LineWrapMode,
} from '../lib/settings';
import { CODE_THEMES, type CodeTheme } from '../lib/editorThemes';
import { Dropdown } from './Dropdown';
import { useT, type MessageKey } from '../lib/i18nContext';

interface SettingsDialogProps {
  isDarkMode: boolean;
  settings: EditorSettings;
  onChange: (next: EditorSettings) => void;
  onClose: () => void;
}

/**
 * 设置弹窗：毛玻璃面板 + 分区图标 + 图形化控件（分段开关、字号滑杆、主题预览卡片）。
 * 代码高亮主题按界面深浅各存一份（settings.codeThemeDark / codeThemeLight），
 * 卡片即选即生效；修改即时持久化（App 层负责写 localStorage）。
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
        'w-9 h-5 rounded-full relative transition-all shrink-0',
        checked ? 'bg-[#A3B3FF] shadow-[0_0_10px_rgba(163,179,255,0.45)]' : 'bg-zinc-400/50'
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

/** 主题预览卡片：固定示例片段按主题调色板着色，选中描边 + 对勾角标 */
function ThemeCard({ theme, selected, isDarkMode, onSelect }: {
  theme: CodeTheme;
  selected: boolean;
  isDarkMode: boolean;
  onSelect: () => void;
}) {
  const k = theme.palette.tokens;
  return (
    <button
      onClick={onSelect}
      role="radio"
      aria-checked={selected}
      aria-label={theme.label}
      title={theme.label}
      className={cn(
        'heid-theme-card group relative rounded-xl border overflow-hidden text-left transition-all',
        selected
          ? 'border-[#A3B3FF] ring-2 ring-[#A3B3FF]/40'
          : isDarkMode
            ? 'border-zinc-700 hover:border-zinc-500'
            : 'border-zinc-200 hover:border-zinc-400'
      )}
    >
      <div
        className="heid-theme-preview h-[52px] px-2.5 py-1.5 font-mono text-[9px] leading-[1.7] overflow-hidden whitespace-pre"
        style={{ backgroundColor: theme.palette.background }}
      >
        <div style={{ color: k.punctuation }}>
          <span style={{ color: k.keyword }}>const </span>
          <span style={{ color: k.func }}>spark</span>
          <span>{' = '}</span>
          <span style={{ color: k.string }}>{'"✦"'}</span>
          <span>{';'}</span>
        </div>
        <div style={{ color: k.comment }}>{'// nexus editor'}</div>
        <div>
          <span style={{ color: k.keyword }}>{'return '}</span>
          <span style={{ color: k.type }}>{'nex '}</span>
          <span style={{ color: k.operator }}>{'+ '}</span>
          <span style={{ color: k.number }}>42</span>
          <span style={{ color: k.punctuation }}>{';'}</span>
        </div>
      </div>
      <div
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium pointer-coarse:min-h-[40px] pointer-coarse:px-3 pointer-coarse:text-xs',
          isDarkMode ? 'bg-zinc-900/60 text-zinc-200' : 'bg-zinc-50 text-zinc-700'
        )}
      >
        <span
          className="w-2 h-2 rounded-full shrink-0 border border-white/20"
          style={{ backgroundColor: k.keyword }}
        />
        <span className="truncate">{theme.label}</span>
        {selected && <Check size={12} className="ml-auto shrink-0 text-[#A3B3FF]" />}
      </div>
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

  const dark = isDarkMode;
  const panelCls = cn(
    "relative w-[min(560px,94vw)] max-h-[85vh] flex flex-col rounded-2xl border shadow-2xl overflow-hidden heid-pop-in",
    dark ? "border-zinc-700 bg-zinc-800/85 backdrop-blur-xl text-zinc-100" : "border-zinc-200/90 bg-white/85 backdrop-blur-xl text-zinc-800"
  );
  const rowCls = cn(
    "flex items-center justify-between gap-3 mx-2.5 px-2.5 py-2 rounded-lg transition-colors",
    dark ? "hover:bg-zinc-700/30" : "hover:bg-zinc-100/70"
  );
  const labelCls = "text-xs font-medium";

  /** 分段开关：横排互斥选项（缩进用） */
  const segmentedNode = (value: string, onPick: (v: string) => void, options: Array<{ value: string; label: string }>) => (
    <span className={cn(
      "inline-flex rounded-lg border p-0.5 gap-0.5 shrink-0",
      dark ? "border-zinc-600/70 bg-zinc-900/60" : "border-zinc-200 bg-zinc-100"
    )}>
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => onPick(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            "px-3 py-0.5 rounded-md text-xs font-medium transition-all",
            value === o.value
              ? dark
                ? "bg-zinc-700 text-[#A3B3FF] shadow-sm"
                : "bg-white text-[#A3B3FF] shadow-sm border border-zinc-200"
              : dark
                ? "text-zinc-400 hover:text-zinc-200"
                : "text-zinc-500 hover:text-zinc-700"
          )}
        >
          {o.label}
        </button>
      ))}
    </span>
  );

  const sectionNode = (icon: React.ComponentType<{ size?: number | string }>, title: string, children: React.ReactNode) => (
    <section>
      <div className="flex items-center gap-2 px-5 pt-4 pb-1.5">
        <span className="text-[#A3B3FF] shrink-0">
          {(() => { const Icon = icon; return <Icon size={12} />; })()}
        </span>
        <span className={cn("text-[11px] font-semibold tracking-wider", dark ? "text-zinc-400" : "text-zinc-500")}>{title}</span>
        <span className={cn("flex-1 h-px", dark ? "bg-zinc-700/60" : "bg-zinc-200")} />
      </div>
      {children}
    </section>
  );

  /** 主题分组：组内单选（radio 语义），应用到对应界面模式的槽位 */
  const themeGroup = (ids: { themes: CodeTheme[]; slot: 'codeThemeDark' | 'codeThemeLight'; label: string; icon: React.ComponentType<{ size?: number | string }>; appliesNow: boolean }) => (
    <div>
      <div className={cn("flex items-center gap-1.5 px-5 pt-2 pb-1 text-[10px] font-semibold", dark ? "text-zinc-500" : "text-zinc-400")}>
        {(() => { const Icon = ids.icon; return <Icon size={11} />; })()}
        {ids.label}
        {ids.appliesNow && (
          <span className={cn("px-1.5 py-px rounded-full text-[9px] font-medium", dark ? "bg-[#A3B3FF]/15 text-[#A3B3FF]" : "bg-[#A3B3FF]/10 text-[#A3B3FF]")}>
            {t('settings.themeInUse')}
          </span>
        )}
      </div>
      <div className="px-3 grid grid-cols-2 sm:grid-cols-3 gap-2" role="radiogroup" aria-label={ids.label}>
        {ids.themes.map(theme => (
          <ThemeCard
            key={theme.id}
            theme={theme}
            selected={settings[ids.slot] === theme.id}
            isDarkMode={isDarkMode}
            onSelect={() => set(ids.slot, theme.id)}
          />
        ))}
      </div>
    </div>
  );

  const darkThemes = CODE_THEMES.filter(x => x.palette.dark);
  const lightThemes = CODE_THEMES.filter(x => !x.palette.dark);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-zinc-950/30 backdrop-blur-md heid-fade-in" onClick={onClose} />
      <div className={panelCls} role="dialog" aria-label={t('settings.title')}>
        {/* 标题行：与菜单一致的设置图标 */}
        <div className="flex items-center gap-2.5 px-5 pt-4 pb-1 shrink-0">
          <span className="text-[#A3B3FF] shrink-0">
            <Settings size={16} />
          </span>
          <h2 className="text-base font-bold flex-1">{t('settings.title')}</h2>
          <button
            onClick={onClose}
            className={cn(
              "p-1 rounded-md transition-colors",
              dark ? "hover:bg-zinc-700 text-zinc-400" : "hover:bg-zinc-200 text-zinc-500"
            )}
            title={t('common.close')}
          >
            <X size={14} />
          </button>
        </div>

        <div className="overflow-auto heid-scroll min-h-0 pb-2">
          {sectionNode(Palette, t('settings.section.interface'), (
            <div className={rowCls}>
              <span className={labelCls}>{t('settings.language')}</span>
              <Dropdown
                value={settings.language}
                onChange={(v) => set('language', v as LanguagePref)}
                dark={dark}
                align="right"
                className="min-w-[150px]"
                label={t('settings.language')}
                options={[
                  { value: 'system', label: t('settings.langSystem') },
                  { value: 'zh', label: '简体中文' },
                  { value: 'en', label: 'English' },
                ]}
              />
            </div>
          ))}

          {sectionNode(Sparkles, t('settings.codeTheme'), (
            <>
              <p className={cn("px-5 pb-1 text-[10px]", dark ? "text-zinc-500" : "text-zinc-400")}>
                {t('settings.codeThemeHint')}
              </p>
              {themeGroup({
                themes: darkThemes, slot: 'codeThemeDark',
                label: t('settings.themeDarkGroup'), icon: Moon,
                appliesNow: isDarkMode,
              })}
              {themeGroup({
                themes: lightThemes, slot: 'codeThemeLight',
                label: t('settings.themeLightGroup'), icon: Sun,
                appliesNow: !isDarkMode,
              })}
            </>
          ))}

          {sectionNode(Type, t('settings.section.editor'), (
            <>
              <div className={rowCls}>
                <span className={labelCls}>{t('settings.font')}</span>
                <Dropdown
                  value={settings.fontFamily}
                  onChange={(v) => set('fontFamily', v)}
                  dark={dark}
                  align="right"
                  className="min-w-[150px]"
                  label={t('settings.font')}
                  options={FONT_OPTIONS.map(f => ({ value: f.stack, label: t(FONT_LABEL_KEYS[f.id] ?? 'font.default') }))}
                />
              </div>
              <div className={rowCls}>
                <span className={labelCls}>{t('settings.fontSize')}</span>
                <span className="flex items-center gap-2.5 shrink-0">
                  <input
                    type="range"
                    min={12}
                    max={24}
                    step={1}
                    value={settings.fontSize}
                    onChange={(e) => set('fontSize', Number(e.target.value))}
                    aria-label={t('settings.fontSize')}
                    className="w-24 accent-[#A3B3FF] cursor-pointer"
                  />
                  <span className={cn("text-[11px] tabular-nums w-8 text-right", dark ? "text-zinc-400" : "text-zinc-500")}>
                    {settings.fontSize}px
                  </span>
                  <span
                    className={cn(
                      "w-9 h-7 rounded-md border flex items-center justify-center leading-none",
                      dark ? "border-zinc-600 bg-zinc-900/80" : "border-zinc-300 bg-white/90"
                    )}
                    style={{ fontFamily: settings.fontFamily, fontSize: Math.min(settings.fontSize, 16) }}
                    aria-hidden
                  >
                    Aa
                  </span>
                </span>
              </div>
              <div className={rowCls}>
                <span className={labelCls}>{t('settings.lineHeight')}</span>
                <Dropdown
                  value={String(settings.lineHeight)}
                  onChange={(v) => set('lineHeight', Number(v))}
                  dark={dark}
                  align="right"
                  className="min-w-[150px]"
                  label={t('settings.lineHeight')}
                  options={[1.3, 1.4, 1.55, 1.7, 1.9, 2.2].map(n => ({ value: String(n), label: String(n) }))}
                />
              </div>
              <div className={rowCls}>
                <span className={labelCls}>{t('settings.tabWidth')}</span>
                <Dropdown
                  value={String(settings.tabSize)}
                  onChange={(v) => set('tabSize', Number(v))}
                  dark={dark}
                  align="right"
                  className="min-w-[150px]"
                  label={t('settings.tabWidth')}
                  options={[2, 4, 8].map(n => ({ value: String(n), label: t('settings.tabSizeChars', { n }) }))}
                />
              </div>
              <div className={rowCls}>
                <span className={labelCls}>{t('settings.indentWith')}</span>
                {segmentedNode(
                  settings.insertSpaces ? 'space' : 'tab',
                  (v) => set('insertSpaces', v === 'space'),
                  [
                    { value: 'space', label: t('settings.indentSpaces') },
                    { value: 'tab', label: t('settings.indentTabs') },
                  ]
                )}
              </div>
              <div className={rowCls}>
                <span className={labelCls}>{t('settings.lineWrap')}</span>
                <Dropdown
                  value={settings.lineWrapMode}
                  onChange={(v) => set('lineWrapMode', v as LineWrapMode)}
                  dark={dark}
                  align="right"
                  className="min-w-[150px]"
                  label={t('settings.lineWrap')}
                  options={[
                    { value: 'markdown', label: t('settings.wrapMarkdownOnly') },
                    { value: 'always', label: t('settings.wrapAlways') },
                    { value: 'never', label: t('settings.wrapNever') },
                  ]}
                />
              </div>
            </>
          ))}

          {sectionNode(LayoutGrid, t('settings.section.uiAids'), (
            <>
              {([
                { key: 'showWhitespace', label: t('settings.showWhitespace'), hint: undefined as string | undefined },
                { key: 'minimap', label: t('settings.minimap'), hint: t('settings.hintPhoneOnly') },
                { key: 'stickyScroll', label: t('settings.stickyScroll'), hint: t('settings.hintUnavailable') },
                { key: 'colorDecorations', label: t('settings.colorDecorations'), hint: undefined as string | undefined },
              ] as const).map(({ key, label, hint }) => (
                <div key={key} className={rowCls}>
                  <span className={labelCls}>
                    {label}
                    {hint && <span className={cn("ml-2 text-[10px]", dark ? "text-zinc-500" : "text-zinc-400")}>{hint}</span>}
                  </span>
                  <Toggle
                    checked={settings[key] as boolean}
                    onChange={(v) => set(key, v as never)}
                    label={label}
                  />
                </div>
              ))}
            </>
          ))}

          {sectionNode(Save, t('settings.section.autosave'), (
            <>
              <div className={rowCls}>
                <span className={labelCls}>{t('settings.autosaveToggle')}</span>
                <Toggle
                  checked={settings.autosaveEnabled}
                  onChange={(v) => set('autosaveEnabled', v)}
                  label={t('settings.autosave')}
                />
              </div>
              {settings.autosaveEnabled && (
                <div className={rowCls + ' heid-fade-in'}>
                  <span className={labelCls}>{t('settings.autosaveInterval')}</span>
                  <Dropdown
                    value={String(settings.autosaveIntervalSec)}
                    onChange={(v) => set('autosaveIntervalSec', Number(v))}
                    dark={dark}
                    align="right"
                className="min-w-[150px]"
                    label={t('settings.autosaveInterval')}
                    options={[10, 30, 60, 120, 300].map(n => ({
                      value: String(n),
                      label: n >= 60 ? t('settings.autosaveMinutes', { n: n / 60 }) : t('settings.autosaveSeconds', { n }),
                    }))}
                  />
                </div>
              )}
              <p className={cn("px-5 pb-2 pt-1 text-[10px] leading-relaxed", dark ? "text-zinc-500" : "text-zinc-400")}>
                {t('settings.draftNote')}
              </p>
            </>
          ))}
        </div>

        {/* 底栏 */}
        <div className={cn("flex items-center justify-between px-5 py-3 border-t shrink-0", dark ? "border-zinc-700/80" : "border-zinc-200")}>
          <button
            onClick={() => onChange({ ...DEFAULT_SETTINGS })}
            className={cn(
              "px-2.5 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors",
              dark ? "hover:bg-zinc-700 text-zinc-400" : "hover:bg-zinc-100 text-zinc-500"
            )}
          >
            <RotateCcw size={12} /> {t('common.resetDefault')}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-md text-xs font-medium pointer-coarse:min-h-[44px] pointer-coarse:text-sm bg-white hover:bg-zinc-100 text-zinc-900 border border-zinc-300/80 transition-colors shadow-sm"
          >
            {t('common.done')}
          </button>
        </div>
      </div>
    </div>
  );
}
