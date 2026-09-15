/**
 * Markdown 导出为单文件 HTML：复用预览渲染栈（react-markdown + remark-gfm），
 * 经 react-dom/server 的 renderToStaticMarkup 产出无外部引用的独立文档。
 * 围栏代码块带语言标注时经 react-syntax-highlighter（Prism）输出内联着色 span，
 * 与预览同一套主题（oneDark / ghcolors）；行内与无语言代码块维持普通样式。
 * 渲染库全部动态 import（独立懒加载 chunk，不进主包）。
 * 样式为内联 <style>（元素选择器，渲染产物无 class），按导出时主题生成深/浅一套。
 */

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSS = (dark: boolean): string => {
  const bg = dark ? '#18181b' : '#ffffff';
  const fg = dark ? '#d4d4d8' : '#27272a';
  const muted = dark ? '#a1a1aa' : '#71717a';
  const border = dark ? '#3f3f46' : '#e4e4e7';
  const codeBg = dark ? '#27272a' : '#f4f4f5';
  const quoteBg = dark ? '#1f1f23' : '#fafafa';
  const accent = dark ? '#818cf8' : '#4f46e5';
  return [
    `body{margin:0;background:${bg};color:${fg};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;font-size:16px;line-height:1.7}`,
    'main{max-width:860px;margin:0 auto;padding:2.5rem 1.25rem 4rem}',
    `h1,h2,h3,h4,h5,h6{line-height:1.3;margin:1.6em 0 .6em;font-weight:700}`,
    `h1{font-size:1.9em}h2{font-size:1.5em}h3{font-size:1.25em}`,
    `h1,h2{border-bottom:1px solid ${border};padding-bottom:.3em}`,
    'p{margin:.8em 0}',
    `a{color:${accent}}`,
    `blockquote{margin:1em 0;padding:.4em 1em;border-left:4px solid ${border};background:${quoteBg};color:${muted}}`,
    `code{background:${codeBg};border:1px solid ${border};border-radius:4px;padding:.1em .35em;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.875em}`,
    /* 语法高亮块外层：边框圆角与背景统一样式，内层 pre 的内联背景会覆盖背景色 */
    `.code-block{margin:1em 0;border:1px solid ${border};border-radius:8px;overflow-x:auto;background:${codeBg}}`,
    `.code-block pre{margin:0;padding:1em;overflow-x:auto;background:transparent !important}`,
    '.code-block code{background:none;border:none;padding:0;font-size:.875em}',
    `pre{background:${codeBg};border:1px solid ${border};border-radius:8px;padding:1em;overflow-x:auto}`,
    'pre code{background:none;border:none;padding:0;font-size:.875em}',
    `table{border-collapse:collapse;margin:1em 0;display:block;overflow-x:auto;max-width:100%}`,
    `th,td{border:1px solid ${border};padding:.45em .8em;text-align:left}`,
    `th{background:${codeBg}}`,
    'img{max-width:100%;height:auto;border-radius:6px}',
    `hr{border:none;border-top:1px solid ${border};margin:2em 0}`,
    'ul,ol{padding-left:1.6em}',
    'li{margin:.25em 0}',
  ].join('');
};

export async function renderMarkdownToHtml(
  md: string,
  opts: { title: string; dark: boolean },
): Promise<string> {
  const [{ renderToStaticMarkup }, React, reactMarkdown, { default: remarkGfm }, { Prism: SyntaxHighlighter }, styles] = await Promise.all([
    import('react-dom/server'),
    import('react'),
    import('react-markdown'),
    import('remark-gfm'),
    import('react-syntax-highlighter'),
    import('react-syntax-highlighter/dist/esm/styles/prism'),
  ]);
  const Markdown = (reactMarkdown as { default: React.ComponentType<Record<string, unknown>> }).default;
  const hlTheme: Record<string, any> = opts.dark
    ? (styles as any).oneDark
    : (styles as any).ghcolors;
  const theme = {
    ...hlTheme,
    'pre[class*="language-"]': { ...(hlTheme?.['pre[class*="language-"]'] ?? {}), background: 'transparent' },
    'code[class*="language-"]': { ...(hlTheme?.['code[class*="language-"]'] ?? {}), background: 'transparent' },
  };
  /* 有语言标注的围栏代码块着色；行内 code 与无语言块保持普通样式。
     围栏块 children 恒以换行结尾（块级内容含末换行），行内代码不含换行——以此区分 */
  const CodeRenderer = ({ className, children, node, ...rest }: any) => {
    const raw = String(children);
    const code = raw.replace(/\n$/, '');
    const isBlock = raw.endsWith('\n');
    const match = /language-([\w+-]+)/.exec(className || '');
    if (!isBlock) {
      return React.createElement('code', { ...rest, className }, children);
    }
    if (!match) {
      return React.createElement('pre', null, React.createElement('code', null, code));
    }
    return React.createElement(
      'div',
      { className: 'code-block' },
      React.createElement(SyntaxHighlighter as any, {
        language: match[1],
        style: theme,
        PreTag: 'pre',
        customStyle: { margin: 0, background: 'transparent' },
        children: code,
      }),
    );
  };
  const body = renderToStaticMarkup(
    React.createElement(Markdown, {
      remarkPlugins: [remarkGfm],
      components: { code: CodeRenderer },
    }, md),
  );
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(opts.title)}</title>`,
    `<style>${CSS(opts.dark)}</style>`,
    '</head>',
    '<body>',
    `<main>${body}</main>`,
    '</body>',
    '</html>',
  ].join('\n');
}
