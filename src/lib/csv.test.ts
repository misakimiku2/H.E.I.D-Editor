import { describe, expect, it } from 'vitest';
import {
  blockToHtml, computeFill, detectDelimiter, estimateColumnWidths, parseCsv, serializeCsv,
  estimateWrappedLines, moveCol, moveRow, swapCols, swapRows,
} from './csv';

describe('parseCsv', () => {
  it('基本解析：逗号分隔、按行拆分', () => {
    expect(parseCsv('a,b\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('空文本产出空网格', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('空字段保留占位', () => {
    expect(parseCsv('a,,c\n,d')).toEqual([['a', '', 'c'], ['', 'd', '']]);
  });

  it('末尾换行不产生空行', () => {
    expect(parseCsv('a,b\n')).toEqual([['a', 'b']]);
  });

  it('防御性处理 CRLF 与 CR', () => {
    expect(parseCsv('a,b\r\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseCsv('a,b\rc,d')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('引号字段内含分隔符', () => {
    expect(parseCsv('a,"b,c",d')).toEqual([['a', 'b,c', 'd']]);
  });

  it('引号内双写引号转义', () => {
    expect(parseCsv('"a""b",c')).toEqual([['a"b', 'c']]);
  });

  it('引号内含换行的多行单元格', () => {
    expect(parseCsv('"a\nb",c')).toEqual([['a\nb', 'c']]);
  });

  it('引号字段可跨行且解析器整体消耗', () => {
    expect(parseCsv('x,"1\n2\n3",y\nnext,row')).toEqual([['x', '1\n2\n3', 'y'], ['next', 'row', '']]);
  });

  it('不规则行补齐到最宽行', () => {
    expect(parseCsv('a,b\nc')).toEqual([['a', 'b'], ['c', '']]);
  });

  it('自定义分隔符（分号）', () => {
    expect(parseCsv('a;b,c', ';')).toEqual([['a', 'b,c']]);
  });

  it('自定义分隔符（制表符）', () => {
    expect(parseCsv('a\tb', '\t')).toEqual([['a', 'b']]);
  });

  it('字段两端空格按内容保留', () => {
    expect(parseCsv('a, b')).toEqual([['a', ' b']]);
  });
});

describe('serializeCsv', () => {
  it('普通字段不加引号，每行以换行结尾', () => {
    expect(serializeCsv([['a', 'b'], ['c', 'd']])).toBe('a,b\nc,d\n');
  });

  it('含分隔符/引号/换行的字段加引号并翻倍引号', () => {
    expect(serializeCsv([['a,b', 'c"d', 'e\nf']])).toBe('"a,b","c""d","e\nf"\n');
  });

  it('行内尾部空字段保留占位（列对齐不丢失）', () => {
    expect(serializeCsv([['a', 'b'], ['c', '']])).toBe('a,b\nc,\n');
  });

  it('裁剪尾部整行全空的区域', () => {
    expect(serializeCsv([['a', 'b'], ['', ''], ['', '']])).toBe('a,b\n');
  });

  it('裁剪尾部整列全空的区域', () => {
    expect(serializeCsv([['a', 'b', ''], ['c', '', '']])).toBe('a,b\nc,\n');
  });

  it('空网格与全空网格序列化为空文本', () => {
    expect(serializeCsv([])).toBe('');
    expect(serializeCsv([['']])).toBe('');
    expect(serializeCsv([['', ''], ['', '']])).toBe('');
  });

  it('非默认分隔符按指定符号序列化', () => {
    expect(serializeCsv([['a', 'b,c']], ';')).toBe('a;b,c\n');
  });
});

describe('parse ⇄ serialize 往返', () => {
  it('规范文本往返稳定', () => {
    for (const text of ['a,b\nc,d\n', '"a,b",c\n', 'a\n\nb\n']) {
      expect(serializeCsv(parseCsv(text))).toBe(text);
    }
  });

  it('任意文本二次往返幂等（首笔序列化做规范化）', () => {
    for (const text of ['a,b', 'a,\n', 'a,,\n,b', '"multi\nline",x', 'a;b', '', 'a,b,\nc\n']) {
      const once = serializeCsv(parseCsv(text));
      expect(serializeCsv(parseCsv(once))).toBe(once);
    }
  });
});

describe('detectDelimiter', () => {
  it('按引号外出现频次判定逗号/分号/制表符', () => {
    expect(detectDelimiter('a,b\nc,d')).toBe(',');
    expect(detectDelimiter('a;b\nc;d')).toBe(';');
    expect(detectDelimiter('a\tb\nc\td')).toBe('\t');
  });

  it('引号内分隔符不计数', () => {
    expect(detectDelimiter('"a,b";c')).toBe(';');
    expect(detectDelimiter('"a;b",c')).toBe(',');
  });

  it('平票回退逗号，空文本回退逗号', () => {
    expect(detectDelimiter('a,b\nc;d')).toBe(',');
    expect(detectDelimiter('')).toBe(',');
    expect(detectDelimiter('abc')).toBe(',');
  });
});

describe('computeFill', () => {
  it('单格下拉重复该值（数字也一样）', () => {
    expect(computeFill([['x']], 3, 1)).toEqual([['x'], ['x'], ['x']]);
    expect(computeFill([['5']], 3, 1)).toEqual([['5'], ['5'], ['5']]);
  });

  it('多格纵向循环重复（非数字内容）', () => {
    expect(computeFill([['a'], ['b']], 6, 1))
      .toEqual([['a'], ['b'], ['a'], ['b'], ['a'], ['b']]);
  });

  it('≥2 格纯数字纵向等差递增', () => {
    expect(computeFill([['1'], ['2']], 5, 1))
      .toEqual([['1'], ['2'], ['3'], ['4'], ['5']]);
    expect(computeFill([['1'], ['3']], 4, 1))
      .toEqual([['1'], ['3'], ['5'], ['7']]);
    expect(computeFill([['0.5'], ['1']], 4, 1))
      .toEqual([['0.5'], ['1'], ['1.5'], ['2']]);
    expect(computeFill([['2'], ['1']], 4, 1))
      .toEqual([['2'], ['1'], ['0'], ['-1']]);
  });

  it('数字与非数字混合退回循环', () => {
    expect(computeFill([['1'], ['a']], 4, 1))
      .toEqual([['1'], ['a'], ['1'], ['a']]);
  });

  it('公差非常数退回循环', () => {
    expect(computeFill([['1'], ['2'], ['4']], 6, 1))
      .toEqual([['1'], ['2'], ['4'], ['1'], ['2'], ['4']]);
  });

  it('横向填充同理：纯数字递增，否则循环', () => {
    expect(computeFill([['1', '2']], 1, 4)).toEqual([['1', '2', '3', '4']]);
    expect(computeFill([['a', 'b']], 1, 4)).toEqual([['a', 'b', 'a', 'b']]);
  });

  it('二维块下拉按列循环', () => {
    expect(computeFill([['1', 'x'], ['2', 'y']], 4, 2)).toEqual([
      ['1', 'x'], ['2', 'y'], ['1', 'x'], ['2', 'y'],
    ]);
  });

  it('目标不大于源时原样返回', () => {
    expect(computeFill([['1'], ['2']], 2, 1)).toEqual([['1'], ['2']]);
  });

  it('向上/向左拖拽由调用方以相同规则取值（负方向序列延续）', () => {
    /* 向上拖 1,2 选区到其上方一格：等价于对延伸块 [-2..2] 取窗口，
       实现约定：computeFill 只向正方向扩展，负方向由组件把源选区
       平移到拖拽起点后调用（源内容不变）。这里验证平移语义下的结果。 */
    expect(computeFill([['-1'], ['0']], 3, 1)).toEqual([['-1'], ['0'], ['1']]);
  });
});

describe('estimateColumnWidths', () => {
  it('按列最长内容估宽，钳制在 [6, 40]', () => {
    expect(estimateColumnWidths([['1'], ['2']])).toEqual([6]);
    expect(estimateColumnWidths([['short', 'x'], ['longer', 'y']])).toEqual([6, 6]);
    expect(estimateColumnWidths([['a'.repeat(50)]])).toEqual([40]);
  });

  it('CJK 按两倍宽度估算', () => {
    expect(estimateColumnWidths([['中文']])).toEqual([6]);
    expect(estimateColumnWidths([['中'.repeat(30)]])).toEqual([40]);
  });

  it('多行单元格按最长行计', () => {
    expect(estimateColumnWidths([['ab\ncd']])).toEqual([6]);
  });

  it('空网格返回空数组', () => {
    expect(estimateColumnWidths([])).toEqual([]);
  });
});

/* ---- 变更操作（组件事件分发的纯函数核心） ---- */

import {
  applyFill, clearCells, deleteCols, deleteRows, fillInto, insertColAfter, insertColBefore,
  insertRowAbove, insertRowBelow, parseClipboardTable, selectionToTsv, setCells,
  type GridRect,
} from './csv';

const rect = (r1: number, c1: number, r2: number, c2: number): GridRect => ({ r1, c1, r2, c2 });

describe('setCells / clearCells', () => {
  it('写入选区，不越界不扩格', () => {
    const g = [['a', 'b'], ['c', 'd']];
    expect(setCells(g, rect(0, 1, 1, 1), [['x'], ['y']])).toEqual([['a', 'x'], ['c', 'y']]);
  });

  it('写入超出网格时自动扩展行列', () => {
    const g = [['a']];
    expect(setCells(g, rect(0, 0, 2, 1), [['1', '2'], ['3', '4'], ['5', '6']]))
      .toEqual([['1', '2'], ['3', '4'], ['5', '6']]);
    expect(setCells([['a']], rect(1, 1, 1, 1), [['n']])).toEqual([['a', ''], ['', 'n']]);
  });

  it('原网格不被修改（不可变）', () => {
    const g = [['a']];
    setCells(g, rect(0, 0, 0, 0), [['z']]);
    expect(g).toEqual([['a']]);
  });

  it('clearCells 清空选区内容', () => {
    const g = [['a', 'b'], ['c', 'd']];
    expect(clearCells(g, rect(0, 0, 1, 0))).toEqual([['', 'b'], ['', 'd']]);
  });
});

describe('增删行列', () => {
  const g = [['a', 'b', 'c'], ['d', 'e', 'f']];

  it('上方/下方插入行', () => {
    expect(insertRowAbove(g, 1)).toEqual([['a', 'b', 'c'], ['', '', ''], ['d', 'e', 'f']]);
    expect(insertRowBelow(g, 0)).toEqual([['a', 'b', 'c'], ['', '', ''], ['d', 'e', 'f']]);
  });

  it('左侧/右侧插入列', () => {
    expect(insertColBefore(g, 1)).toEqual([['a', '', 'b', 'c'], ['d', '', 'e', 'f']]);
    expect(insertColAfter(g, 1)).toEqual([['a', 'b', '', 'c'], ['d', 'e', '', 'f']]);
  });

  it('删除行/列（含区间）', () => {
    const g3 = [['1'], ['2'], ['3']];
    expect(deleteRows(g3, 0, 1)).toEqual([['3']]);
    expect(deleteCols(g, 0, 1)).toEqual([['c'], ['f']]);
  });

  it('删空所有行列时至少保留一格', () => {
    expect(deleteRows([['x']], 0, 0)).toEqual([['']]);
    expect(deleteCols([['x']], 0, 0)).toEqual([['']]);
  });
});

describe('selectionToTsv / parseClipboardTable', () => {
  it('选区导出为 TSV（字段含制表符/换行时加引号），末行带换行', () => {
    expect(selectionToTsv([['a', 'b'], ['c', 'd']], rect(0, 0, 1, 1))).toBe('a\tb\nc\td\n');
    expect(selectionToTsv([['x\ty', 'm\nn']], rect(0, 0, 0, 1))).toBe('"x\ty"\t"m\nn"\n');
  });

  it('剪贴板表格按制表符解析（与 Sheets/Excel 互通）', () => {
    expect(parseClipboardTable('a\tb\nc\td\n')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseClipboardTable('hello, world')).toEqual([['hello, world']]);
    expect(parseClipboardTable('"x\ty"\tz')).toEqual([['x\ty', 'z']]);
  });
});

describe('applyFill', () => {
  it('下拉填充：以选区为源、目标块尺寸铺值后写回网格（覆盖路径数据）', () => {
    const g = [['1'], ['2'], ['']];
    expect(applyFill(g, rect(0, 0, 1, 0), 5, 1))
      .toEqual([['1'], ['2'], ['3'], ['4'], ['5']]);
  });

  it('目标不大于选区时网格不变', () => {
    const g = [['1'], ['2']];
    expect(applyFill(g, rect(0, 0, 1, 0), 2, 1)).toEqual(g);
  });
});

describe('fillInto（负方向泛化：向上/向左填充）', () => {
  it('循环模式：负偏移取正模（源锚定于原位）', () => {
    /* 源 [a,b] 锚定第 2 行(idx1)：r=-2→mod(-3,2)=1→'b'，r=-1→mod(-2,2)=0→'a'；r=-3→'a' */
    expect(fillInto([['a'], ['b']], 1, 0, -2, 0, 2, 1)).toEqual([['b'], ['a']]);
    expect(fillInto([['a'], ['b']], 1, 0, -3, 0, 1, 1)).toEqual([['a']]);
  });

  it('数字序列：负方向自然延续（1,2 向上出 0,-1）', () => {
    /* 源 [1,2] 锚定 idx0，向上扩 2 行：r=-2,-1 → 1+1*(-2)=-1, 0 */
    expect(fillInto([['1'], ['2']], 0, 0, -2, 0, 2, 1)).toEqual([['-1'], ['0']]);
  });

  it('正方向与 computeFill 一致', () => {
    expect(fillInto([['1'], ['2']], 0, 0, 0, 0, 5, 1)).toEqual(computeFill([['1'], ['2']], 5, 1));
  });
});

/* ---------- 只读态排序 / 筛选 ---------- */
import { compareCells, computeRowOrder, type CsvSortState } from './csv';

describe('compareCells', () => {
  it('纯数值按数值比较（10 排在 9 后）', () => {
    expect(compareCells('9', '10')).toBeLessThan(0);
    expect(compareCells('10', '9')).toBeGreaterThan(0);
    expect(compareCells('-1.5', '2')).toBeLessThan(0);
  });

  it('文本 localeCompare 数字感知', () => {
    expect(compareCells('a2', 'a10')).toBeLessThan(0);
  });

  it('空串恒排最后（与方向无关由调用方翻转）', () => {
    expect(compareCells('', 'x')).toBeGreaterThan(0);
    expect(compareCells('x', '')).toBeLessThan(0);
    expect(compareCells('', '')).toBe(0);
  });
});

describe('computeRowOrder', () => {
  const grid = [
    ['name', 'score'],
    ['b', '10'],
    ['a', '9'],
    ['c', ''],
    ['d', '2'],
  ];

  it('无排序筛选：恒等映射（含表头置前）', () => {
    expect(computeRowOrder(grid, { headerOn: true })).toEqual([0, 1, 2, 3, 4]);
    expect(computeRowOrder(grid, {})).toEqual([0, 1, 2, 3, 4]);
  });

  it('按列排序：数值列、空值恒最后（升降序一致）、等值稳定', () => {
    const order = computeRowOrder(grid, { headerOn: true, sort: { col: 1, dir: 'asc' } });
    expect(order).toEqual([0, 4, 2, 1, 3]);
    const desc = computeRowOrder(grid, { headerOn: true, sort: { col: 1, dir: 'desc' } });
    expect(desc).toEqual([0, 1, 2, 4, 3]);
  });

  it('文本列排序', () => {
    const order = computeRowOrder(grid, { headerOn: true, sort: { col: 0, dir: 'asc' } });
    expect(order).toEqual([0, 2, 1, 3, 4]);
  });

  it('筛选：子串不区分大小写，命中任一列保留；表头恒在', () => {
    const order = computeRowOrder(grid, { headerOn: true, filter: 'A' });
    expect(order).toEqual([0, 2]); // 'a' 行
    expect(computeRowOrder(grid, { filter: 'score' })).toEqual([0]);
    expect(computeRowOrder(grid, { headerOn: true, filter: '  ' })).toEqual([0, 1, 2, 3, 4]);
  });

  it('排序与筛选叠加（先筛后排）', () => {
    const two = [
      ['h'],
      ['b10'],
      ['a9'],
      ['c2'],
    ];
    const order = computeRowOrder(two, { headerOn: true, filter: '', sort: { col: 0, dir: 'asc' } });
    expect(order).toEqual([0, 2, 1, 3]); // a9 < b10 < c2（数字感知）
  });
});

describe('swapCols / swapRows（列标/行号拖拽互换）', () => {
  it('整列互换：所有行逐行对调', () => {
    const grid = [['a1', 'b1', 'c1'], ['a2', 'b2', 'c2']];
    expect(swapCols(grid, 0, 2)).toEqual([['c1', 'b1', 'a1'], ['c2', 'b2', 'a2']]);
    /* 原网格不变（纯函数） */
    expect(grid).toEqual([['a1', 'b1', 'c1'], ['a2', 'b2', 'c2']]);
  });

  it('同列 / 负下标原样返回', () => {
    const grid = [['a', 'b']];
    expect(swapCols(grid, 1, 1)).toBe(grid);
    expect(swapCols(grid, -1, 0)).toBe(grid);
  });

  it('目标列超出网格宽度：扩齐矩形后互换（拖入空白列区 = 移动）', () => {
    const grid = [['a', 'b']];
    expect(swapCols(grid, 0, 3)).toEqual([['', 'b', '', 'a']]);
  });

  it('整行互换', () => {
    const grid = [['r1a', 'r1b'], ['r2a', 'r2b'], ['r3a', 'r3b']];
    expect(swapRows(grid, 0, 2)).toEqual([['r3a', 'r3b'], ['r2a', 'r2b'], ['r1a', 'r1b']]);
  });

  it('目标行超出网格：空行扩齐后互换（拖入空白行区 = 移动），原位留空', () => {
    const grid = [['r1'], ['r2']];
    expect(swapRows(grid, 0, 4)).toEqual([[''], ['r2'], [''], [''], ['r1']]);
  });

  it('互换后再序列化：拖入空白区的列不会被尾部裁剪，中段空列保留占位对齐', () => {
    expect(serializeCsv(swapCols(parseCsv('a,b\n1,2'), 0, 3), ',')).toBe(',b,,a\n,2,,1\n');
  });
});

describe('swapRows 向上拖回归（曾把尾部行裁掉的数据丢失事故）', () => {
  it('8 行网格把第 4 行拖到第 2 行：全部 8 行保留，仅两行互换', () => {
    const g = Array.from({ length: 8 }, (_, i) => [`r${i + 1}`]);
    const out = swapRows(g, 3, 1);
    expect(out).toHaveLength(8);
    expect(out.map(r => r[0])).toEqual(['r1', 'r4', 'r3', 'r2', 'r5', 'r6', 'r7', 'r8']);
  });
});

describe('moveCol / moveRow（网格线插入式移动）', () => {
  it('列插入：a,b,c 把 a 插到 b/c 之间', () => {
    expect(moveCol([['a', 'b', 'c']], 0, 2)).toEqual([['b', 'a', 'c']]);
  });

  it('列插到末尾边界（= 列数处）', () => {
    expect(moveCol([['a', 'b', 'c']], 0, 3)).toEqual([['b', 'c', 'a']]);
  });

  it('列从后往前插', () => {
    expect(moveCol([['a', 'b', 'c']], 2, 0)).toEqual([['c', 'a', 'b']]);
  });

  it('原位边界（to=from 或 from+1）原网格原样返回', () => {
    const g = [['a', 'b', 'c']];
    expect(moveCol(g, 1, 1)).toBe(g);
    expect(moveCol(g, 1, 2)).toBe(g);
  });

  it('行插入：r1 插到 r3/r4 之间', () => {
    const g = [['r1'], ['r2'], ['r3'], ['r4']];
    expect(moveRow(g, 0, 3)).toEqual([['r2'], ['r3'], ['r1'], ['r4']]);
  });

  it('行向后插到末尾边界', () => {
    const g = [['r1'], ['r2'], ['r3']];
    expect(moveRow(g, 0, 3)).toEqual([['r2'], ['r3'], ['r1']]);
  });
});

describe('estimateWrappedLines（自适应行高的折行估算）', () => {
  it('短文本单行', () => {
    expect(estimateWrappedLines('abc', 6)).toBe(1);
  });

  it('超宽文本按列宽进位折行（CJK 双宽）', () => {
    // 30 个 CJK = 60 显示宽；列宽 6 → 可用 4 → ceil(60/4) = 15 行
    expect(estimateWrappedLines('长'.repeat(30), 6)).toBe(15);
  });

  it('硬换行逐行累计', () => {
    expect(estimateWrappedLines('a\nb\nc', 6)).toBe(3);
  });
});

describe('blockToHtml（剪贴板 text/html 通道）', () => {
  it('单元格内换行保留为文本换行，特殊字符转义', () => {
    expect(blockToHtml([['a<b', 'x&y'], ['l1\nl2', '']]))
      .toBe('<table><tr><td>a&lt;b</td><td>x&amp;y</td></tr><tr><td>l1\nl2</td><td></td></tr></table>');
  });
});
