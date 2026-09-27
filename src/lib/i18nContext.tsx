/**
 * i18n 的 React 分发：I18nProvider 注入当前语言，useT 返回绑定的 t 函数。
 * 非 React 模块（纯函数里的 alert 等）用 setRuntimeLang + rt 取文案。
 */
import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { translate, type Lang, type MessageKey } from './i18n';

export type { Lang, MessageKey };

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

const LangContext = createContext<Lang>('zh');

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>;
}

export function useLang(): Lang {
  return useContext(LangContext);
}

/**
 * `t` 必须按语言记忆：它出现在不少 effect / useCallback 的依赖里，每渲染给一个新函数
 * 等于让那些订阅每次重渲染都退掉再挂（清理时顺手丢掉的东西就没了）。
 */
export function useT(): Translate {
  const lang = useContext(LangContext);
  return useCallback((key, vars) => translate(lang, key, vars), [lang]);
}

let runtimeLang: Lang = 'zh';

export function setRuntimeLang(lang: Lang): void {
  runtimeLang = lang;
}

export function rt(key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(runtimeLang, key, vars);
}
