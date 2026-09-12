/**
 * i18n 的 React 分发：I18nProvider 注入当前语言，useT 返回绑定的 t 函数。
 * 非 React 模块（纯函数里的 alert 等）用 setRuntimeLang + rt 取文案。
 */
import { createContext, useContext, type ReactNode } from 'react';
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

export function useT(): Translate {
  const lang = useContext(LangContext);
  return (key, vars) => translate(lang, key, vars);
}

let runtimeLang: Lang = 'zh';

export function setRuntimeLang(lang: Lang): void {
  runtimeLang = lang;
}

export function rt(key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(runtimeLang, key, vars);
}
