import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror, { ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine } from '@codemirror/view';
import { history, indentWithTab } from '@codemirror/commands';import { syntaxTree, ensureSyntaxTree, indentUnit, foldGutter, bracketMatching, indentOnInput, syntaxHighlighting, foldKeymap, HighlightStyle, defaultHighlightStyle } from '@codemirror/language';
import { highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { Tag, tags as t, highlightTree, type Highlighter } from '@lezer/highlight';
import type { Tree } from '@lezer/common';
import { EditorState, Extension, StateEffect } from '@codemirror/state';
import {
  vsCodeDarkTheme, vsCodeLightTheme,
  vsCodeDarkHighlightStyle, vsCodeLightHighlightStyle,
  getLanguageExtension,
} from '../lib/codemirror';

const CODE_FONT = '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace';

/* ---------- sticky scroll helpers (extracted from CanvasWorkspace) ---------- */

function getLineIndent(text: string): number {
  let indent = 0;
  for (const ch of text) {
    if (ch === ' ') indent++;
    else if (ch === '\t') indent += 2;
    else break;
  }
  return indent;
}

function isScopeStarter(text: string): boolean {
  if (!text || text.startsWith('}') || text.startsWith(']') || text.startsWith(')')) return false;
  if (/^#{1,6}\s/.test(text)) return true;
  if (/^(export\s+)?(default\s+)?(async\s+)?function\s/.test(text)) return true;
  if (/^(export\s+)?(default\s+)?class\s/.test(text)) return true;
  if (/^(export\s+)?(abstract\s+)?class\s/.test(text)) return true;
  if (/^(export\s+)?interface\s/.test(text)) return true;
  if (/^(export\s+)?type\s+\w+\s*=/.test(text)) return true;
  if (/^(export\s+)?enum\s/.test(text)) return true;
  if (/^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?(\(|function|\[|React\.)/.test(text)) return true;
  if (/^(export\s+)?(const|let|var)\s+\w+\s*=\s*\{/.test(text)) return true;
  if (/^(if|else\s+if|else)\s*[\({]/.test(text)) return true;
  if (/^else\s*\{/.test(text)) return true;
  if (/^(for|while|do)\s*[\({]/.test(text)) return true;
  if (/^switch\s*\(/.test(text)) return true;
  if (/^case\s/.test(text)) return true;
  if (/^try\s*\{?/.test(text)) return true;
  if (/^catch\s*[\({]/.test(text)) return true;
  if (/^finally\s*\{?/.test(text)) return true;
  if (/^(def|class)\s/.test(text)) return true;
  if (/^(if|elif|else)\s.*:/.test(text)) return true;
  if (/^(for|while)\s.*:/.test(text)) return true;
  if (/^(try|except|finally)\s*:/.test(text)) return true;
  if (/^with\s.*:/.test(text)) return true;
  if (/^(pub\s+)?(async\s+)?fn\s/.test(text)) return true;
  if (/^(pub\s+)?(struct|enum|trait|impl)\s/.test(text)) return true;
  if (/^(if|else|loop|while|for|match)\b/.test(text)) return true;
  if (/^(public|private|protected)\s+(static\s+)?(class|interface|enum)\s/.test(text)) return true;
  if (/^(public|private|protected)\s+(static\s+)?(void|int|String|boolean|long|double|float)\s+\w+\s*\(/.test(text)) return true;
  if (text.endsWith('{')) return true;
  if (text.endsWith(':') && !text.startsWith('//') && !text.startsWith('/*') && !text.startsWith('*')) return true;
  return false;
}

function findEnclosingScopes(view: EditorView, currentLineNum: number): number[] {
  const doc = view.state.doc;
  const maxStickyLines = 5;
  const stack: { lineNum: number; depthAfter: number }[] = [];
  let depth = 0;

  for (let i = 1; i <= currentLineNum; i++) {
    const line = doc.line(i);
    const text = line.text;
    const trimmed = text.trim();

    let opens = 0, closes = 0;
    for (const ch of text) {
      if (ch === '{') opens++;
      else if (ch === '}') closes++;
    }

    const prevDepth = depth;
    depth = depth - closes + opens;

    while (stack.length > 0 && stack[stack.length - 1].depthAfter > depth) {
      stack.pop();
    }

    if (opens > closes && trimmed && isScopeStarter(trimmed)) {
      stack.push({ lineNum: i, depthAfter: depth });
    }
  }

  return stack.slice(-maxStickyLines).map(s => s.lineNum);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getHighlightedLineHTML(view: EditorView, from: number, to: number, highlightStyle: HighlightStyle): string {
  const tree = syntaxTree(view.state);
  const parts: { from: number; to: number; cls: string }[] = [];

  highlightTree(tree, highlightStyle, (from, to, cls) => {
    if (cls) parts.push({ from, to, cls });
  }, from, to);

  parts.sort((a, b) => a.from - b.from || a.to - b.to);

  let html = '';
  let pos = from;
  const doc = view.state.doc;

  for (const part of parts) {
    if (part.from > pos) {
      html += escapeHtml(doc.sliceString(pos, part.from));
    }
    html += `<span class="${part.cls}">${escapeHtml(doc.sliceString(part.from, part.to))}</span>`;
    pos = part.to;
  }
  if (pos < to) {
    html += escapeHtml(doc.sliceString(pos, to));
  }

  return html;
}

/* ---------- CodeEditor component ---------- */

export interface CodeEditorProps {
  value: string;
  language: string;
  isDarkMode: boolean;
  editable?: boolean;
  onChange?: (value: string) => void;
  onSave?: () => void;
  onCreateEditor?: (view: EditorView) => void;
}

export const CodeEditor: React.FC<CodeEditorProps> = ({
  value,
  language,
  isDarkMode,
  editable = true,
  onChange,
  onSave,
  onCreateEditor,
}) => {
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const stickyRef = useRef<HTMLElement | null>(null);
  const minimapRef = useRef<{ canvas: HTMLCanvasElement; container: HTMLElement } | null>(null);
  const minimapRafRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const viewReadyRef = useRef<EditorView | null>(null);
  const cleanupFns = useRef<(() => void)[]>([]);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  /* line-number click & drag selection */
  const setupLineNumberClick = useCallback((view: EditorView) => {
    const gutters = view.dom.querySelector('.cm-gutters') as HTMLElement | null;
    if (!gutters) return;

    let isDragging = false;
    let startLineNum = 0;

    const getLineAtY = (clientY: number): number | null => {
      const editorRect = view.dom.getBoundingClientRect();
      const y = clientY - editorRect.top + view.scrollDOM.scrollTop;
      try {
        const block = view.lineBlockAtHeight(y);
        if (block && block.from !== undefined) {
          return view.state.doc.lineAt(block.from).number;
        }
      } catch {}
      return null;
    };

    const selectLines = (fromLine: number, toLine: number) => {
      const doc = view.state.doc;
      const minLine = Math.min(fromLine, toLine);
      const maxLine = Math.max(fromLine, toLine);
      const from = doc.line(minLine).from;
      const to = doc.line(maxLine).to;
      view.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: 'nearest' }),
      });
      view.focus();
    };

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.cm-lineNumbers')) return;
      e.preventDefault();
      const lineNum = getLineAtY(e.clientY);
      if (lineNum === null) return;
      isDragging = true;
      startLineNum = lineNum;
      selectLines(lineNum, lineNum);
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const lineNum = getLineAtY(e.clientY);
      if (lineNum === null) return;
      selectLines(startLineNum, lineNum);
    };

    const handleMouseUp = () => {
      isDragging = false;
    };

    gutters.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    cleanupFns.current.push(() => {
      gutters.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    });
  }, []);

  /* sticky scope headers */
  const setupStickyScroll = useCallback((view: EditorView) => {
    const highlightStyle = isDarkMode ? vsCodeDarkHighlightStyle : vsCodeLightHighlightStyle;
    const bgColor = isDarkMode ? '#1e1e1e' : '#ffffff';
    const bgColorHover = isDarkMode ? '#2d2d2d' : '#f0f0f0';
    const borderColor = isDarkMode ? '#3f3f46' : '#e1e4e8';
    const lineColor = isDarkMode ? '#d4d4d4' : '#1e1e1e';

    const container = document.createElement('div');
    Object.assign(container.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      right: '0',
      zIndex: '20',
      display: 'none',
      userSelect: 'none',
    });

    view.dom.style.position = 'relative';
    view.dom.appendChild(container);
    stickyRef.current = container;

    const updateSticky = () => {
      const scrollTop = view.scrollDOM.scrollTop;
      if (scrollTop <= 20) {
        container.style.display = 'none';
        return;
      }

      try {
        const block = view.lineBlockAtHeight(scrollTop);
        if (!block || block.from === undefined) {
          container.style.display = 'none';
          return;
        }

        const currentLine = view.state.doc.lineAt(block.from);
        const scopeLines = findEnclosingScopes(view, currentLine.number);

        if (scopeLines.length === 0) {
          container.style.display = 'none';
          return;
        }

        const guttersEl = view.dom.querySelector('.cm-gutters');
        const gutterWidth = guttersEl ? guttersEl.getBoundingClientRect().width : 50;

        container.innerHTML = '';

        for (const lineNum of scopeLines) {
          const line = view.state.doc.line(lineNum);
          const indent = getLineIndent(line.text);
          const lineEl = document.createElement('div');
          Object.assign(lineEl.style, {
            background: bgColor,
            borderBottom: `1px solid ${borderColor}`,
            padding: `1px 12px 1px ${gutterWidth + indent * 4}px`,
            fontSize: '13px',
            color: lineColor,
            fontFamily: CODE_FONT,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            lineHeight: '1.5',
            cursor: 'pointer',
            transition: 'background-color 0.15s ease',
          });

          lineEl.addEventListener('mouseenter', () => {
            lineEl.style.backgroundColor = bgColorHover;
          });
          lineEl.addEventListener('mouseleave', () => {
            lineEl.style.backgroundColor = bgColor;
          });
          lineEl.addEventListener('click', () => {
            const targetLine = view.state.doc.line(lineNum);
            view.dispatch({
              effects: EditorView.scrollIntoView(targetLine.from, { y: 'center' }),
              selection: { anchor: targetLine.from },
            });
            view.focus();
          });

          const html = getHighlightedLineHTML(view, line.from, line.to, highlightStyle);
          lineEl.innerHTML = html;
          container.appendChild(lineEl);
        }

        container.style.display = 'block';
      } catch {
        container.style.display = 'none';
      }
    };

    let lastStickyScrollTop = 0;

    const handleScroll = () => {
      const currentScrollTop = view.scrollDOM.scrollTop;
      if (Math.abs(currentScrollTop - lastStickyScrollTop) > 300) {
        container.style.display = 'none';
        lastStickyScrollTop = currentScrollTop;
        return;
      }
      lastStickyScrollTop = currentScrollTop;
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        updateSticky();
      });
    };

    view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true });
    cleanupFns.current.push(() => view.scrollDOM.removeEventListener('scroll', handleScroll));
    cleanupFns.current.push(() => {
      if (container.parentNode) container.parentNode.removeChild(container);
      stickyRef.current = null;
    });
  }, [isDarkMode]);

  /* canvas minimap */
  const setupMinimap = useCallback((view: EditorView) => {
    const bgColor = isDarkMode ? '#1e1e1e' : '#ffffff';
    const viewportColor = isDarkMode ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.08)';
    const viewportBorderColor = isDarkMode ? 'rgba(255, 255, 255, 0.25)' : 'rgba(0, 0, 0, 0.18)';
    const selectionColor = isDarkMode ? 'rgba(100, 150, 255, 0.3)' : 'rgba(50, 100, 255, 0.25)';
    const MINIMAP_WIDTH_MIN = 60;
    const MINIMAP_WIDTH_MAX = 170;
    let minimapWidth = Math.min(MINIMAP_WIDTH_MAX, Math.max(MINIMAP_WIDTH_MIN, Math.round(view.dom.clientWidth * 0.08)));
    const BLOCK_HEIGHT = 3;
    const LINE_GAP = 2;
    const LINE_PITCH = BLOCK_HEIGHT + LINE_GAP;
    const CHAR_WIDTH = 1.15;
    const PADDING = 6;

    const existingContainer = view.dom.querySelector('.cm-minimap-container') as HTMLElement | null;
    if (existingContainer) existingContainer.remove();

    const container = document.createElement('div');
    container.className = 'cm-minimap-container';
    Object.assign(container.style, {
      position: 'absolute',
      top: '0',
      right: '0',
      bottom: '0',
      width: `${minimapWidth}px`,
      backgroundColor: bgColor,
      borderLeft: isDarkMode ? '1px solid #3f3f46' : '1px solid #e1e4e8',
      overflow: 'hidden',
      cursor: 'default',
      zIndex: '25',
    });

    const innerWrapper = document.createElement('div');
    Object.assign(innerWrapper.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      willChange: 'transform',
    });
    container.appendChild(innerWrapper);

    const contentCanvas = document.createElement('canvas');
    contentCanvas.style.display = 'block';
    innerWrapper.appendChild(contentCanvas);

    const selectionDiv = document.createElement('div');
    Object.assign(selectionDiv.style, {
      position: 'absolute',
      left: `${PADDING}px`,
      width: `${minimapWidth - PADDING * 2}px`,
      backgroundColor: selectionColor,
      pointerEvents: 'none',
      display: 'none',
    });
    innerWrapper.appendChild(selectionDiv);

    const viewportDiv = document.createElement('div');
    Object.assign(viewportDiv.style, {
      position: 'absolute',
      left: `${PADDING}px`,
      width: `${minimapWidth - PADDING * 2}px`,
      backgroundColor: viewportColor,
      border: `0.5px solid ${viewportBorderColor}`,
      pointerEvents: 'none',
      borderRadius: '2px',
    });
    container.appendChild(viewportDiv);

    view.dom.appendChild(container);
    view.scrollDOM.style.paddingRight = `${minimapWidth}px`;

    minimapRef.current = { canvas: contentCanvas, container };

    let isDragging = false;
    let isDraggingViewport = false;
    let dragStartClientY = 0;
    let dragStartScrollTop = 0;
    let currentMinimapScrollTop = 0;
    let dragRafId = 0;
    let fullParseScheduled = false;
    let forcedTree: Tree | null = null;
    const MIN_VP_HEIGHT = 30;

    const defaultColor = isDarkMode ? '#3d3d42' : '#d8d8db';
    const commentColor = isDarkMode ? '#6a9955' : '#008000';
    const variableColor = isDarkMode ? '#9cdcfe' : '#001080';
    const stringColor = isDarkMode ? '#ce9178' : '#a31515';
    const keywordColor = isDarkMode ? '#569cd6' : '#0000ff';
    const typeColor = isDarkMode ? '#4ec9b0' : '#267f99';
    const funcColor = isDarkMode ? '#dcdcaa' : '#795e26';
    const numberColor = isDarkMode ? '#b5cea8' : '#098658';
    const regexpColor = isDarkMode ? '#d16969' : '#800000';
    const escapeColor = isDarkMode ? '#d7ba7d' : '#098658';
    const operatorColor = isDarkMode ? '#d4d4d4' : '#000000';
    const punctuationColor = isDarkMode ? '#d4d4d4' : '#000000';
    const tagNameColor = isDarkMode ? '#569cd6' : '#800000';
    const attributeNameColor = isDarkMode ? '#9cdcfe' : '#0000ff';
    const attributeValueColor = isDarkMode ? '#ce9178' : '#a31515';
    const metaColor = isDarkMode ? '#d4d4d4' : '#000000';
    const invalidColor = isDarkMode ? '#f44747' : '#ff0000';
    const deletedColor = isDarkMode ? '#ce9178' : '#a31515';
    const insertedColor = isDarkMode ? '#b5cea8' : '#098658';

    const tagColorMap = new Map<string, string>();
    const addTag = (tag: Tag, color: string) => { if (tag) tagColorMap.set(tag.toString(), color); };
    const addStrTag = (name: string, color: string) => { tagColorMap.set(name, color); };
    addTag(t.comment, commentColor);
    addTag(t.lineComment, commentColor);
    addTag(t.blockComment, commentColor);
    addTag(t.docComment, commentColor);
    addTag(t.variableName, variableColor);
    addTag(t.typeName, typeColor);
    addTag(t.className, typeColor);
    addTag(t.namespace, typeColor);
    addTag(t.tagName, tagNameColor);
    addTag(t.propertyName, variableColor);
    addTag(t.attributeName, attributeNameColor);
    addTag(t.attributeValue, attributeValueColor);
    addTag(t.string, stringColor);
    addTag(t.docString, stringColor);
    addTag(t.character, stringColor);
    addTag(t.number, numberColor);
    addTag(t.integer, numberColor);
    addTag(t.float, numberColor);
    addTag(t.bool, keywordColor);
    addTag(t.null, keywordColor);
    addTag(t.atom, keywordColor);
    addTag(t.keyword, keywordColor);
    addTag(t.self, keywordColor);
    addTag(t.operatorKeyword, keywordColor);
    addTag(t.modifier, keywordColor);
    addTag(t.controlKeyword, keywordColor);
    addTag(t.definitionKeyword, keywordColor);
    addTag(t.moduleKeyword, keywordColor);
    addTag(t.operator, operatorColor);
    addTag(t.punctuation, punctuationColor);
    addTag(t.separator, punctuationColor);
    addTag(t.bracket, punctuationColor);
    addTag(t.regexp, regexpColor);
    addTag(t.escape, escapeColor);
    addTag(t.meta, metaColor);
    addTag(t.processingInstruction, keywordColor);
    addTag(t.monospace, stringColor);
    addTag(t.link, keywordColor);
    addTag(t.heading, keywordColor);
    addTag(t.deleted, deletedColor);
    addTag(t.inserted, insertedColor);
    addTag(t.invalid, invalidColor);
    addTag(t.list, metaColor);

    addStrTag('paren', punctuationColor);
    addStrTag('squareBracket', punctuationColor);
    addStrTag('brace', punctuationColor);
    addStrTag('derefOperator', operatorColor);
    addStrTag('definitionOperator', operatorColor);
    addStrTag('arithmeticOperator', operatorColor);
    addStrTag('special(string)', stringColor);

    const minimapHighlighter: Highlighter = {
      style(tagList: readonly Tag[]): string | null {
        for (const tag of tagList) {
          const color = tagColorMap.get(tag.toString());
          if (color) return color;
          if ((tag as any).modified && (tag as any).modified.length > 0) {
            const hasFuncMod = (tag as any).modified.some((m: any) => m.name === 'function');
            if (hasFuncMod) return funcColor;
            const base = (tag as any).base;
            if (base) {
              const baseColor = tagColorMap.get(base.toString());
              if (baseColor) return baseColor;
            }
          }
        }
        return null;
      }
    };

    const renderContent = () => {
      const doc = view.state.doc;
      const lineCount = typeof doc.lines === 'number' ? doc.lines : 1;
      const displayWidth = minimapWidth - PADDING * 2;
      const contentH = Math.max(lineCount * LINE_PITCH + PADDING * 2, container.clientHeight);
      const containerH = container.clientHeight;
      const dpr = window.devicePixelRatio || 1;

      const scrollH = view.scrollDOM.scrollHeight;
      const scrollTop = view.scrollDOM.scrollTop;
      const scrollerH = view.scrollDOM.clientHeight;
      const maxScroll = Math.max(0, scrollH - scrollerH);

      const naturalVpH = scrollH > 0
        ? (scrollerH / scrollH) * containerH
        : containerH;
      const minVpH = Math.max(MIN_VP_HEIGHT, containerH * 0.08);
      const logicalVpH = Math.max(naturalVpH, minVpH);
      const vpY = maxScroll > 0
        ? (scrollTop / maxScroll) * (containerH - logicalVpH)
        : 0;
      const vpYInContent = scrollH > 0
        ? (scrollTop / scrollH) * contentH
        : 0;
      const maxMinimapScroll = Math.max(0, contentH - containerH);
      const minimapScrollTop = maxMinimapScroll > 0
        ? Math.max(0, Math.min(maxMinimapScroll, vpYInContent - vpY))
        : 0;
      currentMinimapScrollTop = minimapScrollTop;

      const BUFFER_LINES = 15;
      const highlightFirstLine = Math.max(1, Math.floor((minimapScrollTop - PADDING) / LINE_PITCH) + 1 - BUFFER_LINES);
      const highlightLastLine = Math.min(lineCount, Math.ceil((minimapScrollTop + containerH - PADDING) / LINE_PITCH) + BUFFER_LINES);

      contentCanvas.width = displayWidth * dpr;
      contentCanvas.height = contentH * dpr;
      contentCanvas.style.width = `${displayWidth}px`;
      contentCanvas.style.height = `${contentH}px`;
      contentCanvas.style.marginLeft = `${PADDING}px`;
      const ctx = contentCanvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, displayWidth, contentH);

      const tree = forcedTree || syntaxTree(view.state);
      const rangeFrom = doc.line(highlightFirstLine).from;
      const rangeTo = doc.line(highlightLastLine).to;

      const colorRanges: { from: number; to: number; color: string }[] = [];
      highlightTree(tree, minimapHighlighter, (from, to, color) => {
        if (color && from < rangeTo && to > rangeFrom) {
          colorRanges.push({ from, to, color });
        }
      }, rangeFrom, rangeTo);
      colorRanges.sort((a, b) => a.from - b.from || a.to - b.to);

      const lineTokenMap = new Map<number, { from: number; to: number; color: string }[]>();
      for (const range of colorRanges) {
        const fromLine = doc.lineAt(range.from).number;
        const toLine = doc.lineAt(Math.max(range.from, range.to - 1)).number;
        for (let ln = fromLine; ln <= toLine; ln++) {
          if (ln < highlightFirstLine || ln > highlightLastLine) continue;
          if (!lineTokenMap.has(ln)) lineTokenMap.set(ln, []);
          const ls = doc.line(ln).from;
          const le = doc.line(ln).to;
          lineTokenMap.get(ln)!.push({
            from: Math.max(range.from, ls),
            to: Math.min(range.to, le),
            color: range.color
          });
        }
      }

      for (let i = 1; i <= lineCount; i++) {
        const line = doc.line(i);
        const y = PADDING + (i - 1) * LINE_PITCH;
        const lineLen = line.text.length;
        if (lineLen === 0) continue;
        const ranges = lineTokenMap.get(i);
        if (!ranges || ranges.length === 0) {
          ctx.fillStyle = defaultColor;
          ctx.fillRect(0, y, Math.min(lineLen * CHAR_WIDTH, displayWidth), BLOCK_HEIGHT);
          continue;
        }
        let pos = line.from;
        let x = 0;
        for (const range of ranges) {
          if (range.from > pos) {
            const gapLen = range.from - pos;
            ctx.fillStyle = defaultColor;
            ctx.fillRect(x, y, gapLen * CHAR_WIDTH, BLOCK_HEIGHT);
            x += gapLen * CHAR_WIDTH;
            pos = range.from;
          }
          const len = range.to - range.from;
          ctx.fillStyle = range.color;
          ctx.fillRect(x, y, len * CHAR_WIDTH, BLOCK_HEIGHT);
          x += len * CHAR_WIDTH;
          pos = range.to;
          if (x > displayWidth) break;
        }
        if (pos < line.to && x <= displayWidth) {
          const len = line.to - pos;
          ctx.fillStyle = defaultColor;
          ctx.fillRect(x, y, len * CHAR_WIDTH, BLOCK_HEIGHT);
        }
      }

      const treeAfterRender = forcedTree || syntaxTree(view.state);
      if (treeAfterRender.length < doc.length * 0.98 && !fullParseScheduled) {
        fullParseScheduled = true;
        const syncTree = ensureSyntaxTree(view.state, doc.length, 100);
        if (syncTree) {
          forcedTree = syncTree;
          renderContent();
          updateOverlay();
          fullParseScheduled = false;
        } else {
          requestAnimationFrame(() => {
            scheduleProgressiveParse();
          });
        }
      }
      return contentH;

      function scheduleProgressiveParse() {
        const TIMEOUTS = [50, 100, 200, 500, 1000, 2000, 5000];
        let step = 0;

        function parseStep() {
          if (step >= TIMEOUTS.length) {
            renderContent();
            updateOverlay();
            fullParseScheduled = false;
            return;
          }

          const timeout = TIMEOUTS[step++];
          const forced = ensureSyntaxTree(view.state, doc.length, timeout);

          if (forced) {
            forcedTree = forced;
          }

          renderContent();
          updateOverlay();

          if (forcedTree && forcedTree.length >= doc.length * 0.98) {
            fullParseScheduled = false;
            return;
          }

          requestAnimationFrame(parseStep);
        }
        requestAnimationFrame(parseStep);
      }
    };

    const updateOverlay = () => {
      const doc = view.state.doc;
      const lineCount = typeof doc.lines === 'number' ? doc.lines : 1;
      const contentH = Math.max(lineCount * LINE_PITCH + PADDING * 2, container.clientHeight);
      const containerH = container.clientHeight;
      const scrollerH = view.scrollDOM.clientHeight;
      const scrollH = view.scrollDOM.scrollHeight;
      const scrollTop = view.scrollDOM.scrollTop;
      const maxScroll = Math.max(0, scrollH - scrollerH);

      const naturalVpH = scrollH > 0
        ? (scrollerH / scrollH) * containerH
        : containerH;

      const vpW = minimapWidth - PADDING * 2;
      const minVpH = Math.max(MIN_VP_HEIGHT, containerH * 0.08);
      const vpH = Math.max(naturalVpH, minVpH);

      const logicalVpH = Math.max(naturalVpH, minVpH);
      const vpY = maxScroll > 0
        ? (scrollTop / maxScroll) * (containerH - logicalVpH)
        : 0;

      viewportDiv.style.left = `${PADDING}px`;
      viewportDiv.style.width = `${vpW}px`;
      viewportDiv.style.top = `${vpY}px`;
      viewportDiv.style.height = `${vpH}px`;

      const vpYInContent = scrollH > 0
        ? (scrollTop / scrollH) * contentH
        : 0;
      const maxMinimapScroll = Math.max(0, contentH - containerH);
      const minimapScrollTop = maxMinimapScroll > 0
        ? Math.max(0, Math.min(maxMinimapScroll, vpYInContent - vpY))
        : 0;
      innerWrapper.style.transform = `translateY(${-minimapScrollTop}px)`;
      currentMinimapScrollTop = minimapScrollTop;

      const sel = view.state.selection.main;
      if (!sel.empty) {
        const startLine = doc.lineAt(sel.from).number;
        const endLine = doc.lineAt(sel.to).number;
        selectionDiv.style.display = 'block';
        selectionDiv.style.top = `${PADDING + (startLine - 1) * LINE_PITCH}px`;
        selectionDiv.style.height = `${(endLine - startLine + 1) * LINE_PITCH}px`;
      } else {
        selectionDiv.style.display = 'none';
      }
    };

    const onScroll = () => {
      if (minimapRafRef.current !== null) return;
      minimapRafRef.current = requestAnimationFrame(() => {
        minimapRafRef.current = null;
        renderContent();
        updateOverlay();
      });
    };

    const scheduleFullRender = () => {
      if (minimapRafRef.current !== null) cancelAnimationFrame(minimapRafRef.current);
      minimapRafRef.current = requestAnimationFrame(() => {
        minimapRafRef.current = null;
        renderContent();
        updateOverlay();
      });
    };

    const scrollToY = (clientY: number) => {
      const rect = container.getBoundingClientRect();
      const relY = clientY - rect.top;
      const contentH = parseFloat(contentCanvas.style.height) || container.clientHeight;
      const scrollH = view.scrollDOM.scrollHeight;
      const contentY = relY + currentMinimapScrollTop;
      const targetScrollTop = contentH > 0 ? (contentY / contentH) * scrollH : 0;
      const maxScroll = Math.max(0, scrollH - view.scrollDOM.clientHeight);
      view.scrollDOM.scrollTop = Math.max(0, Math.min(maxScroll, targetScrollTop));
    };

    const handleMinimapMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const relY = e.clientY - rect.top;
      const vpTop = parseFloat(viewportDiv.style.top) || 0;
      const vpHeight = parseFloat(viewportDiv.style.height) || 0;
      const clickedOnViewport = relY >= vpTop && relY <= vpTop + vpHeight;
      isDragging = true;
      isDraggingViewport = clickedOnViewport;
      dragStartClientY = e.clientY;
      dragStartScrollTop = view.scrollDOM.scrollTop;
      if (!clickedOnViewport) {
        scrollToY(e.clientY);
      }
    };

    const handleMinimapMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      if (dragRafId) return;
      const currentClientY = e.clientY;
      dragRafId = requestAnimationFrame(() => {
        dragRafId = 0;
        if (isDraggingViewport) {
          const deltaY = currentClientY - dragStartClientY;
          const containerH = container.clientHeight;
          const scrollerH = view.scrollDOM.clientHeight;
          const scrollH = view.scrollDOM.scrollHeight;
          const maxScroll = Math.max(0, scrollH - scrollerH);
          const naturalVpH = scrollH > 0 ? (scrollerH / scrollH) * containerH : containerH;
          const minVpH = Math.max(MIN_VP_HEIGHT, containerH * 0.08);
          const logicalVpH = Math.max(naturalVpH, minVpH);
          const scrollRange = containerH - logicalVpH;
          if (scrollRange > 0 && maxScroll > 0) {
            const scrollDelta = (deltaY / scrollRange) * maxScroll;
            view.scrollDOM.scrollTop = Math.max(0, Math.min(maxScroll, dragStartScrollTop + scrollDelta));
          }
        } else {
          scrollToY(currentClientY);
        }
      });
    };

    const handleMinimapMouseUp = () => {
      isDragging = false;
      isDraggingViewport = false;
      if (dragRafId) {
        cancelAnimationFrame(dragRafId);
        dragRafId = 0;
      }
    };

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged || update.geometryChanged) {
        scheduleFullRender();
      } else if (update.selectionSet) {
        updateOverlay();
      }
    });

    renderContent();
    updateOverlay();

    view.dispatch({ effects: StateEffect.appendConfig.of([updateListener]) });
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    container.addEventListener('mousedown', handleMinimapMouseDown);
    window.addEventListener('mousemove', handleMinimapMouseMove);
    window.addEventListener('mouseup', handleMinimapMouseUp);

    let resizeRafId = 0;
    const resizeObserver = new ResizeObserver(() => {
      const newWidth = Math.min(MINIMAP_WIDTH_MAX, Math.max(MINIMAP_WIDTH_MIN, Math.round(view.dom.clientWidth * 0.08)));
      if (newWidth === minimapWidth) return;
      if (resizeRafId) return;
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = 0;
        if (newWidth === minimapWidth) return;
        minimapWidth = newWidth;
        container.style.width = `${minimapWidth}px`;
        selectionDiv.style.width = `${minimapWidth - PADDING * 2}px`;
        viewportDiv.style.width = `${minimapWidth - PADDING * 2}px`;
        view.scrollDOM.style.paddingRight = `${minimapWidth}px`;
        scheduleFullRender();
      });
    });
    resizeObserver.observe(view.dom);

    cleanupFns.current.push(() => {
      view.scrollDOM.removeEventListener('scroll', onScroll);
      container.removeEventListener('mousedown', handleMinimapMouseDown);
      window.removeEventListener('mousemove', handleMinimapMouseMove);
      window.removeEventListener('mouseup', handleMinimapMouseUp);
      resizeObserver.disconnect();
      if (resizeRafId) cancelAnimationFrame(resizeRafId);
      if (minimapRafRef.current !== null) cancelAnimationFrame(minimapRafRef.current);
      if (dragRafId) cancelAnimationFrame(dragRafId);
      if (container.parentNode) container.parentNode.removeChild(container);
      view.scrollDOM.style.paddingRight = '';
      minimapRef.current = null;
    });
  }, [isDarkMode]);

  const fixSelectionLayer = useCallback((view: EditorView) => {
    const selectionLayer = view.scrollDOM.querySelector('.cm-selectionLayer') as HTMLElement | null;
    if (selectionLayer) {
      selectionLayer.style.removeProperty('z-index');
    }
    const contentEl = view.scrollDOM.querySelector('.cm-content') as HTMLElement | null;
    if (contentEl) {
      contentEl.style.removeProperty('position');
      contentEl.style.removeProperty('z-index');
    }
  }, []);

  const handleCreateEditor = useCallback((view: EditorView) => {
    viewReadyRef.current = view;
    cleanupFns.current.forEach(fn => fn());
    cleanupFns.current = [];
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (minimapRafRef.current !== null) {
      cancelAnimationFrame(minimapRafRef.current);
      minimapRafRef.current = null;
    }
    if (stickyRef.current?.parentNode) {
      stickyRef.current.parentNode.removeChild(stickyRef.current);
    }
    stickyRef.current = null;
    if (minimapRef.current?.container.parentNode) {
      minimapRef.current.container.parentNode.removeChild(minimapRef.current.container);
    }
    minimapRef.current = null;
    fixSelectionLayer(view);
    setupLineNumberClick(view);
    setupStickyScroll(view);
    setupMinimap(view);
    onCreateEditor?.(view);
  }, [fixSelectionLayer, setupLineNumberClick, setupStickyScroll, setupMinimap, onCreateEditor]);

  /* re-setup features on theme change */
  useEffect(() => {
    const view = viewReadyRef.current;
    if (!view) return;
    cleanupFns.current.forEach(fn => fn());
    cleanupFns.current = [];
    if (stickyRef.current?.parentNode) {
      stickyRef.current.parentNode.removeChild(stickyRef.current);
    }
    stickyRef.current = null;
    if (minimapRef.current?.container.parentNode) {
      minimapRef.current.container.parentNode.removeChild(minimapRef.current.container);
    }
    minimapRef.current = null;
    if (minimapRafRef.current !== null) {
      cancelAnimationFrame(minimapRafRef.current);
      minimapRafRef.current = null;
    }
    fixSelectionLayer(view);
    setupStickyScroll(view);
    setupMinimap(view);
  }, [isDarkMode, fixSelectionLayer, setupStickyScroll, setupMinimap]);

  useEffect(() => {
    return () => {
      cleanupFns.current.forEach(fn => fn());
      cleanupFns.current = [];
      viewReadyRef.current = null;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (minimapRafRef.current !== null) {
        cancelAnimationFrame(minimapRafRef.current);
        minimapRafRef.current = null;
      }
    };
  }, []);

  const extensions = useMemo(() => {
    const lineCount = value.split('\n').length;
    const isLargeFile = lineCount > 1000;
    const exts: Extension[] = [
      syntaxHighlighting(isDarkMode ? vsCodeDarkHighlightStyle : vsCodeLightHighlightStyle),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentUnit.of('  '),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      foldGutter({
        openText: '▾',
        closedText: '▸',
        markerDOM: (open) => {
          const span = document.createElement('span');
          span.textContent = open ? '▾' : '▸';
          span.style.color = isDarkMode ? '#858585' : '#6e6e6e';
          span.style.fontSize = '12px';
          span.style.cursor = 'pointer';
          return span;
        },
      }),
      keymap.of([
        ...closeBracketsKeymap,
        indentWithTab,
        { key: 'Mod-s', run: () => { onSaveRef.current?.(); return true; } },
        ...foldKeymap,
      ]),
    ];
    if (language === 'markdown') {
      exts.push(EditorView.lineWrapping);
    }
    const langExt = getLanguageExtension(language);
    if (langExt) exts.push(langExt);
    if (!isLargeFile) {
      exts.push(highlightSelectionMatches());
      exts.push(autocompletion());
      exts.push(indentOnInput());
    }
    return exts;
  }, [language, value, isDarkMode]);

  return (
    <CodeMirror
      ref={cmRef}
      value={value}
      onChange={onChange}
      extensions={extensions}
      readOnly={!editable}
      editable={editable}
      basicSetup={false}
      theme={isDarkMode ? vsCodeDarkTheme : vsCodeLightTheme}
      onCreateEditor={handleCreateEditor}
      className="h-full w-full"
      style={{
        height: '100%',
        width: '100%',
        fontSize: '13px',
      }}
    />
  );
};
