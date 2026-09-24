/**
 * 仓库内自维护的 stream 着色器：INI 与 Makefile。
 *
 * 为什么自己写：`@codemirror/legacy-modes` 收录了 shell / dockerfile / toml / ruby / swift /
 * clike(C#、Kotlin、Scala) / css(SCSS、Less)，但**没有** ini 与 makefile；npm 上唯一的
 * `codemirror-lang-makefile` 最后发布停在 2024-06，按 ROADMAP 51 的口径（不为一种语言引入
 * 无人维护的包）不取。两者的语法都很薄，用官方 stream 基座描述即可。
 *
 * 两条会咬人的实现账（都已在 codemirror.test.ts 里断言）：
 * ① token 名直接映射到 `@lezer/highlight` 的 tag；写错名字不报错、只 console.warn 且**不着色**，
 *    表现与纯文本逐字相同。`definition` / `function` 这类是「修饰函数」，裸用等于没标签，
 *    要修饰就用传统别名（`def` → variableName.definition）。
 * ② `simpleMode` 的行首**不重置状态**（它没有 sol 钩子），所以任何 `push` 都会漏到下一行。
 *    INI 无跨行状态，适合 simpleMode；Makefile 的「Tab 开头是配方行」必须逐行判定，
 *    因此写成手工 StreamParser。
 */
import type { StreamParser } from '@codemirror/language';
import { simpleMode } from '@codemirror/legacy-modes/mode/simple-mode';

/** ; 与 # 注释、[section] 段头、key = value、引号串、布尔、数字、%(x)s / ${ENV} 插值 */
export const ini: StreamParser<unknown> = simpleMode({
  start: [
    { regex: /[;#].*/, token: 'comment' },
    { regex: /[ \t]*\[[^\]\n]*\]?/, token: 'meta', sol: true },
    { regex: /[^\s=:]+(?=\s*[:=])/, token: 'propertyName' },
    { regex: /[:=]/, token: 'operator' },
    { regex: /"(?:[^"\\\n]|\\.)*"?/, token: 'string' },
    { regex: /'(?:[^'\\\n]|\\.)*'?/, token: 'string' },
    { regex: /\b(?:true|false|on|off|yes|no)\b/i, token: 'bool' },
    { regex: /-?\b\d+(?:\.\d+)?\b/, token: 'number' },
    { regex: /%[(][^)\n]*[)]|\${[^}\n]*}|\$\w+/, token: 'variableName' },
  ],
});

/** 指令行（Make 的条件/包含/导出），以及变量赋值的右值符号 */
const MAKE_KEYWORD =
  /(?:define|endef|ifeq|ifneq|ifdef|ifndef|else|endif|include|-include|sinclude|export|unexport|override|vpath)\b/;

/** 逐行记「本行是不是配方行」：Make 以行首 Tab 界定配方，配方整行交给 shell */
interface MakeState { recipe: boolean }

/** StreamParser.token 的入参类型（`Stream` 类本身没从 @codemirror/language 导出） */
type MakeStream = Parameters<StreamParser<MakeState>['token']>[0];

/** `$(...)` / `${...}` / `$X`：整段当一个 variableName token，括号按同种符号配平 */
function readExpansion(stream: MakeStream): string {
  stream.next();                       // $
  const open = stream.next();
  if (open === '(' || open === '{') {
    let depth = 1;
    while (!stream.eol() && depth > 0) {
      const ch = stream.next();
      if (ch === open) depth++;
      else if (ch === (open === '(' ? ')' : '}')) depth--;
    }
  } else if (open && !/\w/.test(open)) {
    stream.backUp(1);                  // 单独的 $，不属于变量
  }
  return 'variableName';
}

function readQuoted(stream: MakeStream, quote: string): void {
  stream.next();
  while (!stream.eol()) {
    const ch = stream.next();
    if (ch === '\\') stream.next();
    else if (ch === quote) break;
  }
}

export const makefile: StreamParser<MakeState> = {
  name: 'Makefile',
  startState: () => ({ recipe: false }),
  copyState: state => ({ recipe: state.recipe }),
  token(stream, state) {
    if (stream.sol()) state.recipe = stream.eatWhile('\t');
    if (stream.eatSpace()) return null;
    if (stream.peek() === '#') { stream.skipToEnd(); return 'comment'; }
    if (stream.peek() === '$') return readExpansion(stream);
    if (state.recipe) {
      const ch = stream.peek();
      if (ch === '"' || ch === "'") { readQuoted(stream, ch); return 'string'; }
      stream.eatWhile(/[^\s"'$#]/);
      return 'content';               // 命令原文：主题未给 content 配色，等于不着色，正是想要的
    }
    if (stream.match(MAKE_KEYWORD)) return 'keyword';
    if (stream.match(/[A-Za-z_][\w.\-]*(?=\s*[:?+]?=)/)) return 'propertyName';
    if (stream.match(/[:?+]?=/)) return 'operator';
    /* 目标名用传统别名 def（= variableName.definition），设置里的配色主题已给它上色 */
    if (stream.match(/[^\s:#=]+(?=\s*:)/)) return 'def';
    if (stream.match(/:/)) return 'operator';
    stream.eatWhile(/[^\s:=#$]+/);
    return null;
  },
};
