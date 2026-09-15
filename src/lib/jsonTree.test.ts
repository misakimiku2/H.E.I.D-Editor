import { describe, expect, it } from 'vitest';
import {
  buildTree, formatStructured, indentFromSettings, kindFromPath, nodeCount, parseStructured,
} from './jsonTree';

describe('kindFromPath', () => {
  it('按扩展名识别 json / yaml', () => {
    expect(kindFromPath('a/b/c.JSON')).toBe('json');
    expect(kindFromPath('conf.yaml')).toBe('yaml');
    expect(kindFromPath('conf.YML')).toBe('yaml');
    expect(kindFromPath('notes.md')).toBeNull();
  });
});

describe('parseStructured', () => {
  it('JSON 解析成功与失败', async () => {
    expect(await parseStructured('{"a":1}', 'json')).toEqual({ ok: true, value: { a: 1 } });
    const bad = await parseStructured('{"a":}', 'json');
    expect(bad.ok).toBe(false);
  });

  it('YAML 解析（懒加载 js-yaml）', async () => {
    const res = await parseStructured('a: 1\nb: [x, y]', 'yaml');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ a: 1, b: ['x', 'y'] });
  });

  it('YAML 解析失败返回错误文案', async () => {
    const res = await parseStructured('a: [unclosed', 'yaml');
    expect(res.ok).toBe(false);
  });
});

describe('buildTree', () => {
  it('对象 / 数组 / 标量分类与键归一', () => {
    const tree = buildTree({ name: 'x', n: 1.5, t: true, nil: null, arr: [1, 'two'], obj: { k: 'v' } });
    expect(tree.kind).toBe('object');
    if (tree.kind !== 'object') return;
    const byKey = Object.fromEntries(tree.children.map(c => [c.key, c]));
    expect(byKey.name).toEqual({ kind: 'value', key: 'name', type: 'string', raw: 'x' });
    expect(byKey.n).toEqual({ kind: 'value', key: 'n', type: 'number', raw: '1.5' });
    expect(byKey.t).toEqual({ kind: 'value', key: 't', type: 'boolean', raw: 'true' });
    expect(byKey.nil).toEqual({ kind: 'value', key: 'nil', type: 'null', raw: 'null' });
    expect(byKey.arr?.kind).toBe('array');
    expect(byKey.obj?.kind).toBe('object');
  });

  it('YAML 非字符串键（数字/布尔）String 化，空值按 null 记', async () => {
    const parsed = await parseStructured('1: a\ntrue: b\nc:', 'yaml');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const tree = buildTree(parsed.value);
    if (tree.kind !== 'object') return;
    expect(tree.children.map(c => c.key)).toEqual(['1', 'true', 'c']);
    expect(tree.children[2]).toEqual({ kind: 'value', key: 'c', type: 'null', raw: 'null' });
  });

  it('循环引用截断为占位节点不无限递归', async () => {
    const parsed = await parseStructured('a: &x {b: *x}', 'yaml');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const tree = buildTree(parsed.value);
    expect(() => JSON.stringify(tree)).not.toThrow();
    expect(tree.kind).toBe('object');
  });

  it('nodeCount 返回子节点数', () => {
    expect(nodeCount(buildTree([1, 2, 3]))).toBe(3);
    expect(nodeCount(buildTree('s'))).toBe(0);
  });
});

describe('formatStructured', () => {
  it('JSON 按指定缩进规范化并补尾换行', async () => {
    expect(await formatStructured('{"a":[1,2]}', 'json', '  ')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}\n');
  });

  it('JSON 解析失败抛错', async () => {
    await expect(formatStructured('{', 'json', '  ')).rejects.toThrow();
  });

  it('YAML 缩进规范化为 2 空格', async () => {
    expect(await formatStructured('a:\n    b: 1', 'yaml', '\t')).toBe('a:\n  b: 1\n');
  });

  it('空 YAML 文档格式化为空串', async () => {
    expect(await formatStructured('', 'yaml', '  ')).toBe('');
  });
});

describe('indentFromSettings', () => {
  it('空格缩进取设置宽度（钳制 2..8），Tab 缩进用制表符', () => {
    expect(indentFromSettings(true, 4)).toBe('    ');
    expect(indentFromSettings(true, 1)).toBe('  ');
    expect(indentFromSettings(true, 99)).toBe('        ');
    expect(indentFromSettings(false, 4)).toBe('\t');
  });
});
