import React, { useEffect, useMemo, useState } from 'react';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18nContext';
import { writeClipboardText } from '../lib/fileOps';
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, AlertTriangle } from 'lucide-react';
import {
  buildTree, parseStructured, TREE_CHILD_RENDER_LIMIT, type JsonNode, type StructKind,
} from '../lib/jsonTree';

/**
 * JSON / YAML 只读结构树：解析 tab.content → JsonNode → 折叠树浏览。
 * 折叠态零渲染成本（子节点不进 DOM），展开态单容器最多渲染 500 个直接子节点；
 * 深层默认折叠，配合性能闸门（App 侧 200 万字符）保证大文档可用。
 * 双击标量复制原值；解析失败显示错误横幅（含切回文本入口，由 App 提供）。
 */

export interface JsonTreeViewerProps {
  content: string;
  kind: StructKind;
  isDarkMode: boolean;
  /** 解析失败横幅里的「切回文本视图」回调（不提供则只显示错误） */
  onFallbackText?: () => void;
  /** 滚动容器回调（分屏同步滚动用，与编辑器按比例联动） */
  onScroller?: (el: HTMLDivElement | null) => void;
}

/** 折叠态以节点路径 id 记（父 id + '/' + 子下标），同一标签内随解析结果稳定 */
const ROOT_ID = '';

function nodeLabelId(parentId: string, index: number): string {
  return `${parentId}/${index}`;
}

/** 大数组/对象折叠态摘要：{ a, b } / [ 1, 2, 3 ] 的预览片段 */
function previewOf(node: JsonNode, depth = 0): string {
  if (node.kind === 'value') return node.raw;
  const items = node.children.slice(0, 3).map(c => previewOf(c, depth + 1));
  const more = node.children.length > 3 ? ', …' : '';
  const inner = items.join(', ') + more;
  return node.kind === 'object' ? `{ ${inner} }` : `[ ${inner} ]`;
}

const NodeRow = React.memo(function NodeRow({
  node, id, depth, expanded, onToggle, isDarkMode, copyTick, onCopy,
}: {
  node: JsonNode;
  id: string;
  depth: number;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  isDarkMode: boolean;
  copyTick: string;
  onCopy: (id: string, raw: string) => void;
}) {
  const t = useT();
  const isBranch = node.kind === 'object' || node.kind === 'array';
  const open = isBranch && expanded.has(id);
  const isRoot = id === ROOT_ID;
  const showKey = !isRoot && !(node.kind !== 'value' && /^\d+$/.test(node.key));

  const typeColor = node.kind === 'value'
    ? node.type === 'string' ? (isDarkMode ? 'text-emerald-300' : 'text-emerald-700')
      : node.type === 'number' ? (isDarkMode ? 'text-sky-300' : 'text-sky-700')
        : (isDarkMode ? 'text-orange-300' : 'text-orange-600')
    : '';

  const keyColor = isDarkMode ? 'text-indigo-300' : 'text-indigo-700';

  return (
    <div data-testid={`json-node${id === ROOT_ID ? '-root' : ''}`} className="select-none">
      <div
        className={cn(
          'group flex items-start gap-1 rounded px-1 py-[1px] text-xs leading-5 font-mono',
          isBranch && 'cursor-pointer',
        )}
        style={{ paddingLeft: depth * 14 + 2 }}
        onClick={() => { if (isBranch) onToggle(id); }}
        onDoubleClick={() => { if (node.kind === 'value') onCopy(id, node.raw); }}
        title={node.kind === 'value' ? t('json.copyTip') : undefined}
      >
        {isBranch ? (
          <ChevronRight
            size={12}
            className={cn('shrink-0 mt-1 transition-transform', open && 'rotate-90', isDarkMode ? 'text-zinc-500' : 'text-zinc-400')}
          />
        ) : (
          <span className="shrink-0 w-3" />
        )}
        {showKey && (
          <>
            <span className={cn('shrink-0 font-medium', keyColor)}>{node.key}:</span>
            <span className="shrink-0 w-1.5" />
          </>
        )}
        {isBranch ? (
          <>
            <span className={cn('shrink-0', isDarkMode ? 'text-zinc-400' : 'text-zinc-500')}>
              {node.kind === 'object' ? `{${node.children.length}}` : `[${node.children.length}]`}
            </span>
            {!open && (
              <span className={cn('truncate', isDarkMode ? 'text-zinc-500' : 'text-zinc-400')}>
                {previewOf(node)}
              </span>
            )}
          </>
        ) : (
          <>
            <span className={cn('truncate max-w-[60ch]', typeColor)}>{node.raw}</span>
            {copyTick === id && (
              <span className="shrink-0 ml-1 text-[10px] text-emerald-500">{t('json.copied')}</span>
            )}
          </>
        )}
        {node.kind === 'value' && (
          <Copy
            size={11}
            className={cn('shrink-0 mt-1 ml-1 opacity-0 group-hover:opacity-60 cursor-pointer', isDarkMode ? 'text-zinc-400' : 'text-zinc-500')}
            onClick={(e) => { e.stopPropagation(); onCopy(id, node.raw); }}
          />
        )}
      </div>
      {isBranch && open && (
        <div>
          {node.children.slice(0, TREE_CHILD_RENDER_LIMIT).map((child, i) => (
            <NodeRow
              key={i}
              node={child}
              id={nodeLabelId(id, i)}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              isDarkMode={isDarkMode}
              copyTick={copyTick}
              onCopy={onCopy}
            />
          ))}
          {node.children.length > TREE_CHILD_RENDER_LIMIT && (
            <div
              className={cn('px-1 py-[1px] text-[11px] italic', isDarkMode ? 'text-zinc-500' : 'text-zinc-400')}
              style={{ paddingLeft: (depth + 1) * 14 + 18 }}
            >
              {t('json.tooManyChildren', { n: node.children.length - TREE_CHILD_RENDER_LIMIT })}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export const JsonTreeViewer = React.memo(function JsonTreeViewer({
  content, kind, isDarkMode, onFallbackText, onScroller,
}: JsonTreeViewerProps) {
  const t = useT();
  const [tree, setTree] = useState<JsonNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copyTick, setCopyTick] = useState<string>('');

  /* 解析（异步：YAML 走懒加载 chunk）；content 变化重解析并重置折叠态 */
  useEffect(() => {
    let alive = true;
    setTree(null);
    setError(null);
    parseStructured(content, kind).then(res => {
      if (!alive) return;
      if (!res.ok) { setError(res.error); return; }
      setTree(buildTree(res.value));
    });
    return () => { alive = false; };
  }, [content, kind]);

  /* 初始默认展开前两层（root 与其子节点）；「默认折叠」层为 2+ */
  useEffect(() => {
    if (!tree || tree.kind === 'value') return;
    const init = new Set<string>([ROOT_ID]);
    for (let i = 0; i < tree.children.length; i++) {
      const child = tree.children[i];
      if (child.kind !== 'value') init.add(nodeLabelId(ROOT_ID, i));
    }
    setExpanded(init);
  }, [tree]);

  const onToggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /* 收集展开容器（不含叶节点）的全部分支 id —— 全部展开/收起用 */
  const collectIds = (node: JsonNode, id: string, acc: string[]) => {
    if (node.kind === 'value') return;
    acc.push(id);
    node.children.forEach((c, i) => collectIds(c, nodeLabelId(id, i), acc));
  };
  const branchIds = useMemo(() => {
    if (!tree) return [];
    const acc: string[] = [];
    collectIds(tree, ROOT_ID, acc);
    return acc;
  }, [tree]);

  /* 复制成功后短暂显示「已复制」标记（1.2s），失败静默 */
  const onCopy = (id: string, raw: string) => {
    writeClipboardText(raw).then(() => {
      setCopyTick(id);
      window.setTimeout(() => setCopyTick(cur => (cur === id ? '' : cur)), 1200);
    }).catch(() => {});
  };

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center">
        <AlertTriangle size={28} className={isDarkMode ? 'text-amber-400' : 'text-amber-500'} />
        <div className={cn('text-sm font-medium', isDarkMode ? 'text-zinc-200' : 'text-zinc-800')}>
          {t('json.parseError')}
        </div>
        <div className={cn('text-xs font-mono max-w-[560px] break-all', isDarkMode ? 'text-zinc-500' : 'text-zinc-400')}>
          {error}
        </div>
        {onFallbackText && (
          <button
            data-testid="json-fallback-text"
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-medium border',
              isDarkMode ? 'border-zinc-600 hover:bg-zinc-700 text-zinc-200' : 'border-zinc-300 hover:bg-zinc-100 text-zinc-700',
            )}
            onClick={onFallbackText}
          >
            {t('json.backToText')}
          </button>
        )}
      </div>
    );
  }

  if (!tree) {
    return (
      <div className={cn('h-full flex items-center justify-center text-xs', isDarkMode ? 'text-zinc-500' : 'text-zinc-400')}>
        {t('json.parsing')}
      </div>
    );
  }

  const nodeTotal = branchIds.length;

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      {/* 工具条：全部展开 / 全部收起 + 节点计数 */}
      <div className={cn(
        'flex items-center gap-2 px-3 py-1.5 border-b shrink-0 text-[11px]',
        isDarkMode ? 'border-zinc-700 bg-zinc-800/60 text-zinc-400' : 'border-zinc-200 bg-zinc-50 text-zinc-500',
      )}>
        <button
          data-testid="json-expand-all"
          className={cn('flex items-center gap-1 px-1.5 py-0.5 rounded font-medium',
            isDarkMode ? 'hover:bg-zinc-700 hover:text-zinc-200' : 'hover:bg-zinc-200 hover:text-zinc-700')}
          title={t('json.expandAll')}
          onClick={() => setExpanded(new Set(branchIds))}
        >
          <ChevronsUpDown size={12} />
          {t('json.expandAll')}
        </button>
        <button
          data-testid="json-collapse-all"
          className={cn('flex items-center gap-1 px-1.5 py-0.5 rounded font-medium',
            isDarkMode ? 'hover:bg-zinc-700 hover:text-zinc-200' : 'hover:bg-zinc-200 hover:text-zinc-700')}
          title={t('json.collapseAll')}
          onClick={() => setExpanded(new Set())}
        >
          <ChevronsDownUp size={12} />
          {t('json.collapseAll')}
        </button>
        <div className="flex-1" />
        {tree.kind === 'value'
          ? <span className={cn('font-mono truncate', isDarkMode ? 'text-emerald-300' : 'text-emerald-700')}>{tree.raw}</span>
          : <span className="tabular-nums">{t('json.nodeCount', { n: nodeTotal })}</span>}
      </div>

      {/* 树主体（长文档纵向滚动） */}
      <div
        ref={onScroller}
        className={cn('flex-1 overflow-auto p-2 font-mono', isDarkMode ? 'bg-zinc-900' : 'bg-white')}
      >
        <NodeRow
          node={tree}
          id={ROOT_ID}
          depth={0}
          expanded={expanded}
          onToggle={onToggle}
          isDarkMode={isDarkMode}
          copyTick={copyTick}
          onCopy={onCopy}
        />
      </div>
    </div>
  );
});
