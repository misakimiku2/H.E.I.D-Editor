import { useEffect } from 'react';
import {
  X, RotateCcw, Settings, Palette, Sparkles, Type, LayoutGrid, Save,
  Check, Moon, Sun, ArrowLeft, Minus, Plus, Usb,
} from 'lucide-react';
import { DeviceLinkSection } from './DeviceLinkSection';
import { cn } from '../lib/utils';
import { IS_TOUCH_PRIMARY } from '../lib/platform';
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
  /** 手机端整页形态：铺满窗口，顶栏返回、底栏操作，不用遮罩关闭；
      平板与桌面仍是居中弹窗（平板屏幕够大，弹窗的信息密度更合适） */
  asPage?: boolean;
  /** 设备互联里「浏览这台电脑的文件」：转发给 App 去开文件树 */
  onBrowseRemote?: (rootPath: string) => void;
}

/**
 * 设置：毛玻璃面板 + 分区图标 + 图形化控件（分段开关、字号滑杆/步进、主题预览卡片）。
 * 代码高亮主题按界面深浅各存一份（settings.codeThemeDark / codeThemeLight），
 * 卡片即选即生效；修改即时持久化（App 层负责写 localStorage）。
 * asPage=true（手机端）时整页呈现，否则为居中弹窗。
 */

const FONT_LABEL_KEYS: Record<string, MessageKey> = {
  default: 'font.default',
  consolas: 'font.consolas',
  jetbrains: 'font.jetbrains',
  fira: 'font.fira',
  cascadia: 'font.cascadia',
  'system-mono': 'font.system-mono',
};

/** 开关：触屏把命中区扩到 48×48（视觉仍是 36×20 的胶囊，包在按钮里） */
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  const pill = (
    <span
      className={cn(
        'relative block w-9 h-5 rounded-full transition-all shrink-0',
        checked ? 'bg-[#A3B3FF] shadow-[0_0_10px_rgba(163,179,255,0.45)]' : 'bg-zinc-400/50'
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all',
          checked ? 'left-[18px]' : 'left-0.5'
        )}
      />
    </span>
  );
  if (!IS_TOUCH_PRIMARY) {
    return (
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className="shrink-0"
      >
        {pill}
      </button>
    );
  }
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="w-12 h-12 shrink-0 flex items-center justify-center"
    >
      {pill}
    </button>
  );
}

/** 字号步进：触屏不用滑杆（滑块本体远小于 48dp，且拖动是精确操作） */
function Stepper({ value, min, max, onStep, dark, ariaLabel }: {
  value: number; min: number; max: number; onStep: (delta: number) => void; dark: boolean; ariaLabel: string;
}) {
  const btn = (disabled: boolean) => cn(
    'w-12 h-12 rounded-lg border flex items-center justify-center transition-colors shrink-0',
    disabled
      ? (dark ? 'border-zinc-700 text-zinc-600' : 'border-zinc-200 text-zinc-300')
      : (dark
        ? 'border-zinc-600 bg-zinc-900/60 text-zinc-200 active:bg-zinc-700'
        : 'border-zinc-300 bg-white/90 text-zinc-700 active:bg-zinc-100')
  );
  return (
    <span className="flex items-center gap-1.5 shrink-0">
      <button onClick={() => onStep(-1)} disabled={value <= min} className={btn(value <= min)} aria-label={ariaLabel + ' -1'}>
        <Minus size={16} />
      </button>
      <span className={cn("w-14 text-center text-sm tabular-nums", dark ? "text-zinc-300" : "text-zinc-600")}>{value}</span>
      <button onClick={() => onStep(1)} disabled={value >= max} className={btn(value >= max)} aria-label={ariaLabel + ' +1'}>
        <Plus size={16} />
      </button>
    </span>
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
          'flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium pointer-coarse:min-h-[44px] pointer-coarse:px-3 pointer-coarse:text-sm',
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

export function SettingsDialog({ isDarkMode, settings, onChange, onClose, asPage, onBrowseRemote }: SettingsDialogProps) {
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
    "relative flex flex-col overflow-hidden",
    asPage
      ? "fixed inset-0 z-[100] h-full w-full"
      : "w-[min(560px,94vw)] max-h-[85vh] rounded-2xl border shadow-2xl heid-pop-in pointer-coarse:w-[min(760px,94vw)]",
    dark
      ? asPage ? "bg-zinc-900 text-zinc-100" : "border-zinc-700 bg-zinc-800/85 backdrop-blur-xl text-zinc-100"
      : asPage ? "bg-zinc-50 text-zinc-800" : "border-zinc-200/90 bg-white/85 backdrop-blur-xl text-zinc-800"
  );
  const rowCls = cn(
    "flex items-center justify-between gap-3 mx-2.5 rounded-lg transition-colors",
    /* 触屏：整行按 Android 偏好行的尺寸走，开关/步进按钮本身就有 48dp 命中区 */
    IS_TOUCH_PRIMARY ? "px-3 py-2 min-h-[56px]" : "px-2.5 py-2",
    dark ? "hover:bg-zinc-700/30" : "hover:bg-zinc-100/70"
  );
  const labelCls = "text-xs font-medium pointer-coarse:text-sm";

  /** 分段开关：横排互斥选项（缩进用）；触屏每段命中区 48dp */
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
            "rounded-md font-medium transition-all",
            IS_TOUCH_PRIMARY ? "min-h-[48px] px-4 text-sm" : "px-3 py-0.5 text-xs",
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

  const sectionNode = (icon: React.ComponentType<{ size?: number | string; className?: string }>, title: string, children: React.ReactNode) => (
    <section>
      <div className={cn("flex items-center gap-2 pt-4 pb-1.5", asPage ? "px-4" : "px-5")}>
        <span className="text-[#A3B3FF] shrink-0">
          {(() => { const Icon = icon; return <Icon size={12} className="pointer-coarse:w-3.5 pointer-coarse:h-3.5" />; })()}
        </span>
        <span className={cn("text-[11px] font-semibold tracking-wider pointer-coarse:text-sm", dark ? "text-zinc-400" : "text-zinc-500")}>{title}</span>
        <span className={cn("flex-1 h-px", dark ? "bg-zinc-700/60" : "bg-zinc-200")} />
      </div>
      {children}
    </section>
  );

  /** 主题分组：组内单选（radio 语义），应用到对应界面模式的槽位 */
  const themeGroup = (ids: { themes: CodeTheme[]; slot: 'codeThemeDark' | 'codeThemeLight'; label: string; icon: React.ComponentType<{ size?: number | string }>; appliesNow: boolean }) => (
    <div>
      <div className={cn("flex items-center gap-1.5 pt-2 pb-1 text-[10px] font-semibold pointer-coarse:text-xs", asPage ? "px-4" : "px-5")}>
        {(() => { const Icon = ids.icon; return <Icon size={11} />; })()}
        {ids.label}
        {ids.appliesNow && (
          <span className={cn("px-1.5 py-px rounded-full text-[9px] font-medium pointer-coarse:text-[11px]", dark ? "bg-[#A3B3FF]/15 text-[#A3B3FF]" : "bg-[#A3B3FF]/10 text-[#A3B3FF]")}>
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

  /** 顶栏：整页形态用返回箭头（48dp 命中区，替代弹窗那个小关闭钮）；弹窗形态保持原样 */
  const header = asPage ? (
    <div
      className={cn("flex items-center gap-1 shrink-0 safe-top border-b", dark ? "border-zinc-700 bg-zinc-800" : "border-zinc-200 bg-white")}
      style={{ height: 'calc(3rem + var(--heid-safe-top, 0px))' }}
    >
      <button
        onClick={onClose}
        aria-label={t('common.back')}
        className={cn(
          "w-12 h-12 rounded-md flex items-center justify-center shrink-0 transition-colors",
          dark ? "text-zinc-300 active:bg-zinc-700" : "text-zinc-600 active:bg-zinc-100"
        )}
      >
        <ArrowLeft size={20} />
      </button>
      <span className="text-[#A3B3FF] shrink-0 pr-1"><Settings size={16} /></span>
      <h2 className="text-base font-bold flex-1 truncate">{t('settings.title')}</h2>
    </div>
  ) : (
    <div className="flex items-center gap-2.5 px-5 pt-4 pb-1 shrink-0">
      <span className="text-[#A3B3FF] shrink-0">
        <Settings size={16} />
      </span>
      <h2 className="text-base font-bold flex-1 pointer-coarse:text-lg">{t('settings.title')}</h2>
      <button
        onClick={onClose}
        /* 触屏弹窗：不显示顶部小关闭钮（命中区太小）——点外部/完成/系统返回关闭 */
        className={cn(
          "p-1 rounded-md transition-colors pointer-coarse:hidden",
          dark ? "hover:bg-zinc-700 text-zinc-400" : "hover:bg-zinc-200 text-zinc-500"
        )}
        title={t('common.close')}
      >
        <X size={14} />
      </button>
    </div>
  );

  const panel = (
    <div className={panelCls} role="dialog" aria-label={t('settings.title')}>
      {header}

        {/* 触屏：滚动条隐藏（内容仍可滚，滚动条原生即窄，heid-scroll 的 10px 常驻条不需要）。
            整页形态要吃满剩余高度所以 flex-1；弹窗形态靠 max-h 限高，不能给 flex-basis:0 */}
        <div className={cn("overflow-auto heid-scroll heid-scroll-none min-h-0 pb-2", asPage && "flex-1")}>
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
              <p className={cn("pb-1 text-[10px] pointer-coarse:text-xs", asPage ? "px-4" : "px-5", dark ? "text-zinc-500" : "text-zinc-400")}>
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
                  {/* 触屏不用滑杆：原生滑块拇指只有 ~20dp，且拖动属精确操作——改步进按钮 */}
                  {IS_TOUCH_PRIMARY ? (
                    <Stepper
                      value={settings.fontSize}
                      min={12}
                      max={24}
                      dark={dark}
                      ariaLabel={t('settings.fontSize')}
                      onStep={(d) => set('fontSize', Math.min(24, Math.max(12, settings.fontSize + d)))}
                    />
                  ) : (
                    <>
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
                    </>
                  )}
                  <span
                    className={cn(
                      "w-9 h-7 rounded-md border flex items-center justify-center leading-none shrink-0",
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
                    {hint && <span className={cn("ml-2 text-[10px] pointer-coarse:text-xs", dark ? "text-zinc-500" : "text-zinc-400")}>{hint}</span>}
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
              <p className={cn("pb-2 pt-1 text-[10px] leading-relaxed pointer-coarse:text-xs", asPage ? "px-4" : "px-5", dark ? "text-zinc-500" : "text-zinc-400")}>
                {t('settings.draftNote')}
              </p>
            </>
          ))}

          {sectionNode(Usb, t('settings.section.deviceLink'), (
            <DeviceLinkSection dark={dark} rowCls={rowCls} labelCls={labelCls} onBrowseRemote={onBrowseRemote} />
          ))}
        </div>

        {/* 底栏：恢复默认 / 完成。触屏两个按钮都按 48dp 命中区做 */}
        <div
          className={cn(
            "flex items-center justify-between gap-3 border-t shrink-0",
            asPage ? "px-4 py-2 safe-bottom" : "px-5 py-3",
            dark ? "border-zinc-700/80" : "border-zinc-200"
          )}
        >
          <button
            onClick={() => onChange({ ...DEFAULT_SETTINGS })}
            className={cn(
              "rounded-lg font-medium flex items-center gap-1.5 transition-colors",
              IS_TOUCH_PRIMARY ? "min-h-[48px] px-3 text-sm" : "px-2.5 py-1.5 text-xs",
              dark ? "hover:bg-zinc-700 text-zinc-400" : "hover:bg-zinc-100 text-zinc-500"
            )}
          >
            <RotateCcw size={12} /> {t('common.resetDefault')}
          </button>
          <button
            onClick={onClose}
            className={cn(
              "rounded-lg font-medium bg-white hover:bg-zinc-100 text-zinc-900 border border-zinc-300/80 transition-colors shadow-sm",
              IS_TOUCH_PRIMARY ? "min-h-[48px] px-6 text-sm" : "px-4 py-1.5 text-xs"
            )}
          >
            {t('common.done')}
          </button>
        </div>
    </div>
  );

  return asPage ? panel : (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-zinc-950/30 backdrop-blur-md heid-fade-in" onClick={onClose} />
      {panel}
    </div>
  );
}
