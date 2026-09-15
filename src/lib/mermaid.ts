/**
 * Mermaid 渲染与模板库：预览与「图表编辑器」面板共用。
 * mermaid 体积大，全部经动态 import 做代码分割，首次真正渲染图表时才下载。
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

export interface MermaidTemplate {
  /** 语法关键字（模板首行，也用作类型身份） */
  type: string;
  /** 类型下拉显示名 */
  label: string;
  /** 模板正文（不含 ``` 围栏） */
  code: string;
}

export const MERMAID_TEMPLATES: MermaidTemplate[] = [
  {
    type: 'flowchart',
    label: '流程图',
    code: `flowchart TD
    A[开始] --> B{判断?}
    B -->|是| C[处理]
    B -->|否| D[结束]`,
  },
  {
    type: 'sequenceDiagram',
    label: '时序图',
    code: `sequenceDiagram
    participant U as 用户
    participant S as 服务器
    U->>S: 发送请求
    S-->>U: 返回结果`,
  },
  {
    type: 'classDiagram',
    label: '类图',
    code: `classDiagram
    class Animal {
        +name: string
        +move()
    }
    class Dog {
        +bark()
    }
    Animal <|-- Dog`,
  },
  {
    type: 'stateDiagram-v2',
    label: '状态图',
    code: `stateDiagram-v2
    [*] --> 待机
    待机 --> 运行 : 启动
    运行 --> 待机 : 暂停
    运行 --> [*]`,
  },
  {
    type: 'gantt',
    label: '甘特图',
    code: `gantt
    title 项目计划
    dateFormat YYYY-MM-DD
    section 阶段一
    需求分析 :a1, 2026-09-01, 7d
    设计开发 :a2, after a1, 14d`,
  },
  {
    type: 'erDiagram',
    label: 'ER 图',
    code: `erDiagram
    USER ||--o{ ORDER : 下单
    USER {
        string name
    }
    ORDER {
        int id
    }`,
  },
  {
    type: 'pie',
    label: '饼图',
    code: `pie title 访问来源
    "直接访问" : 40
    "搜索引擎" : 35
    "外部链接" : 25`,
  },
  {
    type: 'journey',
    label: '用户旅程图',
    code: `journey
    title 用户旅程
    section 核心流程
        打开应用: 5: 用户
        浏览内容: 4: 用户
        完成操作: 3: 用户`,
  },
  {
    type: 'mindmap',
    label: '思维导图',
    code: `mindmap
  root((项目))
    前端
      界面
      逻辑
    后端
      接口
      数据`,
  },
  {
    type: 'timeline',
    label: '时间线',
    code: `timeline
    title 里程碑
    2026 Q1 : 立项 : 需求分析
    2026 Q2 : 开发 : 测试
    2026 Q3 : 发布`,
  },
  {
    type: 'xychart-beta',
    label: 'XY 统计图',
    code: `xychart-beta
    title "季度销售额"
    x-axis [一季度, 二季度, 三季度]
    y-axis "金额" 0 --> 100
    line [30, 60, 88]`,
  },
];

const TYPE_KEYWORDS = MERMAID_TEMPLATES.map((t) => t.type);

/** 从源码首行识别图型；未知返回 flowchart */
export function detectMermaidType(code: string): string {
  const first = (code.trim().split('\n')[0] || '').trim();
  for (const kw of TYPE_KEYWORDS) {
    if (new RegExp(`^\\s*${kw}\\b`).test(first)) return kw;
  }
  return 'flowchart';
}

/** 取某类型模板；未知类型返回 flowchart 模板 */
export function mermaidTemplateOf(type: string): MermaidTemplate {
  return MERMAID_TEMPLATES.find((t) => t.type === type) ?? MERMAID_TEMPLATES[0];
}