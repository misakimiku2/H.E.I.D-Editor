/**
 * Mermaid 渲染：Markdown 预览与「图表编辑器」共用。
 * mermaid 体积大，全部经动态 import 做代码分割，首次真正渲染图表时才下载。
 * （图型模板与结构化模型见 lib/mermaidModel.ts）
 */

let mermaidPromise: Promise<typeof import('mermaid')> | null = null;

export function loadMermaid() {
  if (!mermaidPromise) mermaidPromise = import('mermaid');
  return mermaidPromise;
}

let seq = 0;

function nextId() {
  return `md-mermaid-${Date.now()}-${seq++}`;
}

/** 渲染一份 mermaid 源码为内联 SVG 字符串；失败抛错。传入 id 供绑定事件（预览用） */
export async function renderMermaidSvg(
  code: string,
  isDarkMode: boolean,
  uid = nextId(),
): Promise<{ svg: string; uid: string; bind?: (el: Element | null) => void }> {
  const { default: mermaid } = await loadMermaid();
  mermaid.initialize({
    startOnLoad: false,
    theme: isDarkMode ? 'dark' : 'default',
    securityLevel: 'strict',
    fontFamily: 'inherit',
  });
  const { svg, bindFunctions } = await mermaid.render(uid, code);
  const bind = bindFunctions
    ? (el: Element | null) => {
        if (!el) return;
        try {
          bindFunctions(el);
        } catch {
          /* 静态图无交互，绑定失败可忽略 */
        }
      }
    : undefined;
  return { svg, uid, bind };
}
