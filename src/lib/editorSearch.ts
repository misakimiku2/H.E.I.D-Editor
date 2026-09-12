/**
 * 编辑器查找高亮扩展：
 * 用 StateField 保存当前查询的匹配装饰（cm-searchMatch / cm-searchMatch-selected），
 * 由查找栏通过 setFindMatchesEffect 下发最新匹配；文档变化时装饰区间随 changes 映射平移，
 * 直到查找栏下一次重扫，避免任何隐藏的面板状态耦合。
 * 样式类已在 lib/codemirror.ts 的 VS Code 主题中定义。
 */

import { StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet } from '@codemirror/view';
import type { MatchRange } from './searchCore';

/** 下发最新匹配列表与当前选中下标；null 表示清除高亮 */
export const setFindMatchesEffect = StateEffect.define<{ matches: MatchRange[]; current: number } | null>();

const searchMatchMark = Decoration.mark({ class: 'cm-searchMatch' });
const searchMatchSelectedMark = Decoration.mark({ class: 'cm-searchMatch cm-searchMatch-selected' });

/** 匹配装饰数量上限：与 MAX_MATCHES 一致，防止超大文档装饰爆炸 */
const MAX_DECORATIONS = 5000;

function buildDecorations(matches: MatchRange[], current: number): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const count = Math.min(matches.length, MAX_DECORATIONS);
  for (let i = 0; i < count; i++) {
    const m = matches[i];
    ranges.push((i === current ? searchMatchSelectedMark : searchMatchMark).range(m.from, m.to));
  }
  return Decoration.set(ranges, true);
}

export function findHighlightExtension(): Extension {
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, tr) {
      for (const effect of tr.effects) {
        if (effect.is(setFindMatchesEffect)) {
          const payload = effect.value;
          if (!payload) return Decoration.none;
          return buildDecorations(payload.matches, payload.current);
        }
      }
      if (tr.docChanged) return value.map(tr.changes);
      return value;
    },
  });
}
