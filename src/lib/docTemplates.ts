/**
 * 文档模板：纯函数 + 内置示例。模板本体作为设置字段持久化（见 settings.ts），
 * 这里只负责渲染占位符、文件名规整与校验，不碰存储与 UI。
 */

export interface DocTemplate {
  id: string;
  name: string;
  content: string;
}

/** 文件名校验结果：null = 合法；否则为错误码（UI 侧映射文案） */
export type FileNameError = 'empty' | 'invalidChar' | null;

export const TEMPLATE_NAME_MAX = 60;
export const TEMPLATE_CONTENT_MAX = 20000;
export const TEMPLATE_COUNT_MAX = 50;

export const NIKKE_SAMPLE: DocTemplate = {
  id: 'builtin-nikke',
  name: 'NIKKE 角色',
  content: `# {{title}}

> 记录日期：{{date}}

## 基础信息

| 项目 | 内容 |
| --- | --- |
| 稀有度 |  |
| 爆裂阶段 |  |
| 属性 |  |
| 类型 |  |
| 武器 |  |
| 部队 |  |
| 企业 |  |
| 实装时间 |  |
| 声优 |  |

## 角色简介



## 技能

### 普通攻击
- 最大装弹数：
- 换弹时间：
- 伤害：

### 技能 1
- 类型 / CD：
- 效果：

### 技能 2
- 类型 / CD：
- 效果：

### 爆裂技能
- CD：
- 效果：

## 评测
- 强度评级：
- 推图 / Boss / PVP：
- 抽取建议：
- 定位：

## 养成与配队
- 魔方推荐：
- 词条优先级：
- 技能升级优先级：
- 配队：

## 备注

`,
};

/** 替换 {{title}} / {{date}}（容忍花括号内侧空白）；未知键原样保留。 */
export function renderTemplate(content: string, vars: { title: string; date: string }): string {
  return content.replace(/\{\{\s*(title|date)\s*\}\}/g, (_, key: 'title' | 'date') => vars[key]);
}

/** 不以 .md 结尾（大小写不敏感）则追加 .md。 */
export function ensureMdExtension(name: string): string {
  return /\.md$/i.test(name) ? name : `${name}.md`;
}

/** 取文件名去 .md 扩展名作为文档标题。 */
export function templateTitle(name: string): string {
  return name.replace(/\.md$/i, '');
}

/** Windows 非法文件名字符 + 空名检查（trim 后判断）。 */
export function validateFileName(name: string): FileNameError {
  const trimmed = name.trim();
  if (!trimmed) return 'empty';
  if (/[\\/:*?"<>|]/.test(trimmed)) return 'invalidChar';
  return null;
}