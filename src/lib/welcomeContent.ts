/**
 * 欢迎标签页示例内容（独立模块：纯展示文案，避免混入标签模型）。
 * rt 在模块加载时求值——与原先内联在 App.tsx 中的行为一致。
 */
import { rt } from './i18nContext';

const RAW_SAMPLE_CODE = `// 欢迎使用 H.I.D.E
// Highlighting Intelligent Document Editor
// 特性：语法高亮 / 迷你地图 / 粘性滚动 / 行号拖选 / 代码折叠

import { EditorView } from '@codemirror/view';

interface EditorOptions {
  theme: 'dark' | 'light';
  lineNumbers: boolean;
  minimap: boolean;
}

function createEditor(target: HTMLElement, options: EditorOptions): EditorView {
  const view = new EditorView({
    parent: target,
    doc: rt('editor.placeholder'),
    extensions: [
      options.lineNumbers ? lineNumbers() : [],
      EditorView.theme({ '&': { backgroundColor: options.theme === 'dark' ? '#1e1e1e' : '#ffffff' } }),
    ],
  });
  return view;
}

# Python 也支持
def greet(name: str) -> str:
    """简单的问候函数"""
    return f"Hello, {name}!"

`;

/* 源文件经 git autocrlf 检出为 CRLF 时，模板字面量会把 \r 带进内容：
   CodeMirror 归一为 \n 后与 originalContent 不一致，welcome 标签启动即被标脏，
   会话恢复的「删掉未编辑初始 welcome」随之失效（每重启复制出一个 welcome）。
   此处统一归一为 \n，对 LF / CRLF 两种检出席均安全。 */
export const SAMPLE_CODE = RAW_SAMPLE_CODE.replace(/\r\n/g, '\n');
