/// <reference types="vite/client" />

/* turndown-plugin-gfm 无官方类型，手工声明（GFM 表格/删除线/任务列表转换插件） */
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  export function gfm(service: TurndownService): void;
  export function tables(service: TurndownService): void;
  export function strikethrough(service: TurndownService): void;
  export function taskListItems(service: TurndownService): void;
}
