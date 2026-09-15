/**
 * 打印 / 导出 PDF：为当前标签页构建独立打印文档，经隐藏 iframe 调起系统打印
 * （WebView2 / Chromium 的打印对话框自带「另存为 PDF」目的地）。
 * - markdown：复用 markdownHtml 的整篇渲染（含代码高亮），App 侧调用；
 * - 代码 / 文本：行号 + 等宽 pre（pre-wrap 分页友好）；
 * - CSV：解析层 → HTML 表格（全量数据）。
 * 文档自带头部标题与打印 CSS（@page 边距、深浅主题一套），零外部引用。
 */

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 打印文档外框：标题 + 主题样式（浅色纸面为主，打印以白纸为准，深色仅代码块底） */
function wrapPrintDoc(title: string, bodyHtml: string, dark: boolean): string {
  const fg = dark ? '#d4d4d8' : '#18181b';
  const border = dark ? '#3f3f46' : '#d4d4d7';
  const codeBg = dark ? '#27272a' : '#f4f4f5';
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    '@page{margin:14mm 12mm}',
    'body{margin:0;color:#18181b;font-family:-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;font-size:11pt;line-height:1.6}',
    `h1.doc-title{font-size:15pt;margin:0 0 12px;padding-bottom:8px;border-bottom:1px solid ${border};color:${fg}}`,
    'pre{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:9pt;line-height:1.5;white-space:pre-wrap;word-break:break-all}',
    `code{background:${codeBg};font-family:inherit}`,
    '.line{display:flex}',
    '.ln{flex:none;width:3.2em;padding-right:.8em;text-align:right;color:#a1a1aa;user-select:none}',
    '.lc{flex:1;min-width:0}',
    'table{border-collapse:collapse;width:100%;font-size:9pt;table-layout:auto}',
    'th,td{border:1px solid #d4d4d7;padding:3px 6px;text-align:left;word-break:break-word;vertical-align:top}',
    'th{background:#f4f4f5;font-weight:600}',
    'tr{page-break-inside:avoid}',
    '@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}',
    '</style>',
    '</head>',
    '<body>',
    `<h1 class="doc-title">${escapeHtml(title)}</h1>`,
    bodyHtml,
    '</body>',
    '</html>',
  ].join('\n');
}

/** 代码 / 纯文本：行号 + 等宽（长行换行，跨页自然分割） */
export function buildPlainPrintHtml(title: string, content: string, dark = false): string {
  const lines = content.split('\n');
  const body = `<pre>${lines.map((line, i) =>
    `<span class="line"><span class="ln">${i + 1}</span><span class="lc">${escapeHtml(line) || ' '}</span></span>`
  ).join('')}</pre>`;
  return wrapPrintDoc(title, body, dark);
}

/** CSV：解析后的网格 → 全量 HTML 表格（首行作表头由调用方决定） */
export function buildCsvPrintHtml(
  title: string,
  grid: string[][],
  opts: { headerOn?: boolean; dark?: boolean } = {},
): string {
  const { headerOn = true, dark = false } = opts;
  const escapeCell = (v: string) => escapeHtml(v).replaceAll('\n', '<br>');
  const rowsHtml = grid.map((row, r) => {
    const tag = headerOn && r === 0 ? 'th' : 'td';
    const cells = row.map(c => `<${tag}>${escapeCell(c)}</${tag}>`).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return wrapPrintDoc(title, `<table>${rowsHtml}</table>`, dark);
}

/**
 * 调起系统打印：隐藏 iframe 载入文档，就绪后 contentWindow.print()。
 * 打印对话框关闭（afterprint）或超时后移除 iframe；文档就绪失败（极罕见）时抛错。
 */
export function printHtml(html: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(fallbackTimer);
      iframe.remove();
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fallbackTimer = window.setTimeout(finish, 120_000); // afterprint 缺失兜底（对话框长时间挂着）
    iframe.onload = () => {
      try {
        const win = iframe.contentWindow;
        if (!win) throw new Error('print frame unavailable');
        win.addEventListener('afterprint', finish);
        win.focus();
        win.print();
        /* WebView2 的 print() 阻塞到对话框关闭，afterprint 随后触发；
           非 afterprint 环境由 fallbackTimer 兜底 resolve */
      } catch (e) {
        settled = true;
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    iframe.onerror = () => {
      settled = true;
      cleanup();
      reject(new Error('print document failed to load'));
    };
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
  });
}
