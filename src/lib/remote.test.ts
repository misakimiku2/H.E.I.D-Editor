import { describe, expect, it } from 'vitest';
import {
  REMOTE_SCHEME, RemoteError, encodeRemoteSegment, isRemoteError, isRemotePath,
  isOpenRel, makeRemotePath, openRelId, parseRemoteError, parseRemotePath, parseRemoteResponse,
  remoteList, remoteRead, remoteStat, remoteTabs, remoteWrite,
  type RemoteListResult, type RemoteReadResult, type RemoteStatResult, type RemoteWriteResult,
} from './remote';
import { displayNameFromPath } from './platform';

/* 本文件的跑在纯 node 环境（不是 Tauri），所以四条命令封装能验的只有
   「没有链路时如实抛 unavailable」这一条降级分支；invoke 通道不 mock。 */

const DEV = 'a1b2c3d4e5f6a7b8';

describe('makeRemotePath / parseRemotePath 往返', () => {
  it('普通嵌套路径：分隔符原样保留，解回来是同一份相对路径', () => {
    const p = makeRemotePath(DEV, 'notes/2026/plan.md');
    expect(p).toBe(`${REMOTE_SCHEME}${DEV}/notes/2026/plan.md`);
    expect(parseRemotePath(p)).toEqual({ deviceId: DEV, rel: 'notes/2026/plan.md' });
  });

  it('共享根：键以裸设备名结尾，rel 是空串', () => {
    expect(makeRemotePath(DEV, '')).toBe(`${REMOTE_SCHEME}${DEV}`);
    expect(parseRemotePath(`${REMOTE_SCHEME}${DEV}`)).toEqual({ deviceId: DEV, rel: '' });
  });

  it('中文与空格往返一致（空格编成 %20 而不是 +）', () => {
    const rel = '我的笔记/设备 互联 计划.md';
    const p = makeRemotePath(DEV, rel);
    expect(p).toContain('%E6%88%91%E7%9A%84%E7%AC%94%E8%AE%B0');
    expect(p).toContain('%20');
    expect(parseRemotePath(p)?.rel).toBe(rel);
  });

  it('段内的 / 只能以 %2F 的形态出现，不会被当成目录分隔符', () => {
    // 逐段编码意味着 `/` 就是段的边界：名字里的斜杠必须先过 encodeRemoteSegment 才进得了键。
    // 键里它是一个段，解出来的显示名也就是一个文件名；rel 是协议层的形状，
    // 桌面 `roots::check_rel` 同样按 `/` 切段，带斜杠的名字本来就没法寻址。
    expect(encodeRemoteSegment('2026/01')).toBe('2026%2F01');
    const p = `${REMOTE_SCHEME}${DEV}/notes/${encodeRemoteSegment('2026/01')}`;
    // 斜杠没有多出第三个段来，显示名因此是「一个文件名」而不是「两级目录」
    expect(p.slice(REMOTE_SCHEME.length).split('/')).toEqual([DEV, 'notes', '2026%2F01']);
    expect(displayNameFromPath(p)).toBe('2026/01');
    expect(parseRemotePath(p)?.rel).toBe('notes/2026/01');
  });

  it('URI 特殊字符逐段编码后原样回来', () => {
    expect(makeRemotePath(DEV, 'dir/100%.md')).toBe(`${REMOTE_SCHEME}${DEV}/dir/100%25.md`);
    for (const rel of ['100%.md', 'a&b=c.md', '#锚点.md', 'a?b=c.md', 'a+b.md', '100%2F.md']) {
      expect(parseRemotePath(makeRemotePath(DEV, rel))?.rel).toBe(rel);
    }
  });

  it('反斜杠编成 %5C，解回来还是一个文件名里的字符', () => {
    const rel = 'win\\path.md';
    expect(makeRemotePath(DEV, rel)).toBe(`${REMOTE_SCHEME}${DEV}/win%5Cpath.md`);
    expect(parseRemotePath(makeRemotePath(DEV, `sub\\a\\${rel}`))?.rel).toBe(`sub\\a\\${rel}`);
  });

  it('多余的点段不剥掉：rel 就是相对路径本身，判定交给桌面', () => {
    expect(parseRemotePath(makeRemotePath(DEV, './a/./b.md'))?.rel).toBe('./a/./b.md');
  });
});

describe('parseRemotePath 的拒绝形态', () => {
  it.each([
    ['非远程前缀', '/etc/passwd'],
    ['SAF 路径', 'content://com.android.documents/tree/primary%3ADownload'],
    ['桌面绝对路径', 'D:\\projects\\notes\\a.md'],
    ['只有 scheme', REMOTE_SCHEME],
    ['scheme 后为空', `${REMOTE_SCHEME}/`],
    ['缺 deviceId', `${REMOTE_SCHEME}/a.md`],
    ['解码后含上级段', `${REMOTE_SCHEME}${DEV}/a/../../outside/x.md`],
    ['编码过的上级段（大小写不敏感）', `${REMOTE_SCHEME}${DEV}/%2e%2e/outside/x.md`],
    ['混合编码的上级段', `${REMOTE_SCHEME}${DEV}/.%2E/outside/x.md`],
    ['跨段的上级（..%2F）', `${REMOTE_SCHEME}${DEV}/..%2Foutside`],
    ['前导斜杠的绝对写法', `${REMOTE_SCHEME}${DEV}//etc/passwd`],
    ['段内编码的前导斜杠', `${REMOTE_SCHEME}${DEV}/%2Fetc%2Fpasswd`],
    ['段内编码的反斜杠 UNC', `${REMOTE_SCHEME}${DEV}/%5C%5Cserver%5Cshare`],
    ['盘符', `${REMOTE_SCHEME}${DEV}/C:%5CWindows`],
    ['编码过的盘符', `${REMOTE_SCHEME}${DEV}/C%3AWindows`],
  ])('%s 返回 null', (_label, p) => {
    expect(parseRemotePath(p)).toBeNull();
  });

  it('编码异常的段不抛出去，按原文保留该段', () => {
    expect(() => parseRemotePath(`${REMOTE_SCHEME}${DEV}/100%.md`)).not.toThrow();
    expect(parseRemotePath(`${REMOTE_SCHEME}${DEV}/100%.md`)).toEqual({ deviceId: DEV, rel: '100%.md' });
    expect(parseRemotePath(`${REMOTE_SCHEME}${DEV}/%E4%B8%AD%zz`)).toEqual({ deviceId: DEV, rel: '%E4%B8%AD%zz' });
  });
});

describe('isRemotePath', () => {
  it('只对远程前缀为真', () => {
    expect(isRemotePath(`${REMOTE_SCHEME}${DEV}/a.md`)).toBe(true);
    expect(isRemotePath(`${REMOTE_SCHEME}${DEV}`)).toBe(true);
  });

  it('空值、SAF 与本地绝对路径都不是远程键', () => {
    expect(isRemotePath(null)).toBe(false);
    expect(isRemotePath(undefined)).toBe(false);
    expect(isRemotePath('')).toBe(false);
    expect(isRemotePath('content://com.android/tree/primary%3ADownload')).toBe(false);
    expect(isRemotePath('D:\\projects\\notes\\a.md')).toBe(false);
    expect(isRemotePath('/home/misaki/notes/a.md')).toBe(false);
  });
});

describe('parseRemoteError', () => {
  it('按第一个分隔符切出稳定码，原因单独留着出文案', () => {
    const e = parseRemoteError('badpath: 路径必须是共享根内的相对路径');
    expect(e).toBeInstanceOf(RemoteError);
    expect(e.code).toBe('badpath');
    expect(e.message).toBe('路径必须是共享根内的相对路径');
  });

  it('原因里的全角冒号不参与分码', () => {
    const e = parseRemoteError('io: 读取失败：带全角冒号的中文');
    expect(e.code).toBe('io');
    expect(e.message).toBe('读取失败：带全角冒号的中文');
  });

  it.each([
    ['noroot', '桌面还没设置共享的文件夹'],
    ['outside', '该路径经符号链接指向了共享范围之外，已拒绝'],
    ['notfound', '共享根内没有这个文件'],
    ['toobig', '这个文件 12 MB，超过远程打开上限 6 MB'],
    ['badparams', '缺少内容基线（read 返回的 hash）'],
    ['absolute', '路径必须是共享根内的相对路径'],
    ['unknown', '桌面不支持的命令 delete'],
  ])('Rust 的 %s 码原样取到', (code, reason) => {
    const e = parseRemoteError(`${code}: ${reason}`);
    expect(e.code).toBe(code);
    expect(e.message).toBe(reason);
  });

  it('不符合形状的裸串整串当消息、码记 unknown（不抛裸字符串）', () => {
    for (const raw of ['突然断了', '手机上还没有连着桌面，请先完成配对', 'C:\\tmp: 打不开']) {
      const e = parseRemoteError(raw);
      expect(e.code).toBe('unknown');
      expect(e.message).toBe(raw);
    }
  });

  it('裹成 Error 时取其 message', () => {
    expect(parseRemoteError(new Error('io: 磁盘掉了')).code).toBe('io');
  });

  it('isRemoteError 只认真正的实例', () => {
    expect(isRemoteError(new RemoteError('io', 'x'))).toBe(true);
    expect(isRemoteError(new Error('io: x'))).toBe(false);
    expect(isRemoteError('io: x')).toBe(false);
  });
});

/* 下面几段把 Rust 侧的结果 JSON 原文钉在这里（字段名与顺序即 fsrv.rs 里
   #[serde(rename_all = "camelCase")] 的结果，哈希是对应内容的 SHA-256），
   走的是生产代码同一道 parseRemoteResponse：改字段名的人一定会撞到这里。 */

describe('parseRemoteResponse 与 Rust 侧字段逐字一致', () => {
  it('list：目录条目按 name / isDir / size / mtimeMs 出，目录的 size 恒为 0', () => {
    const raw = '{"entries":[{"name":"sub","isDir":true,"size":0,"mtimeMs":1750000000000},'
      + '{"name":"a.md","isDir":false,"size":1,"mtimeMs":1750000001000},'
      + '{"name":"readme.md","isDir":false,"size":4,"mtimeMs":1750000002000}],"truncated":false}';
    const r = parseRemoteResponse<RemoteListResult>('list', raw);
    expect(Object.keys(r)).toEqual(['entries', 'truncated']);
    expect(Object.keys(r.entries[0])).toEqual(['name', 'isDir', 'size', 'mtimeMs']);
    expect(r.entries[0]).toEqual({ name: 'sub', isDir: true, size: 0, mtimeMs: 1750000000000 });
    expect(r.entries[2].name).toBe('readme.md');
    expect(r.truncated).toBe(false);
  });

  it('stat：size / mtimeMs / isDir / hash，目录的 hash 是空串', () => {
    const raw = '{"size":4,"mtimeMs":1750000002000,"isDir":false,'
      + '"hash":"8a5d8b28d66ae90b5876fe0337b963d9f66ab1047f8c866ff4646b73a8a3aa41"}';
    const r = parseRemoteResponse<RemoteStatResult>('stat', raw);
    expect(Object.keys(r)).toEqual(['size', 'mtimeMs', 'isDir', 'hash']);
    expect(r.size).toBe(4);
    expect(r.isDir).toBe(false);
    expect(r.hash).toBe('8a5d8b28d66ae90b5876fe0337b963d9f66ab1047f8c866ff4646b73a8a3aa41');
    expect(parseRemoteResponse<RemoteStatResult>('stat', '{"size":0,"mtimeMs":0,"isDir":true,"hash":""}').hash).toBe('');
  });

  it('read：前五个字段可直接喂给桌面既有的解码结果类型', () => {
    const raw = '{"text":"# hi\\r\\n","encoding":"utf-8","bom":false,"lossy":false,"binary":false,'
      + '"hash":"8a5d8b28d66ae90b5876fe0337b963d9f66ab1047f8c866ff4646b73a8a3aa41",'
      + '"size":6,"mtimeMs":1750000002000}';
    const r = parseRemoteResponse<RemoteReadResult>('read', raw);
    expect(Object.keys(r)).toEqual(['text', 'encoding', 'bom', 'lossy', 'binary', 'hash', 'size', 'mtimeMs']);
    expect(r.text).toBe('# hi\r\n');
    expect(r.encoding).toBe('utf-8');
    expect(r.lossy).toBe(false);
    expect(r.binary).toBe(false);
    expect(r.size).toBe(6);
    // 编译期就把「同形」钉住：远程读的返回必须能进桌面那个 openedFromDecoded
    const asDecoded: Parameters<typeof import('./fileIO').openedFromDecoded>[0] = r;
    expect(asDecoded.text).toBe('# hi\r\n');
  });

  it('write 落盘成功：三个 server* 字段根本不存在', () => {
    const raw = '{"conflict":false,"hash":"6d33a6d026c3a7d2b93c115d1fc2ee837de2eb6eb2c63787ed4dc6fdb532cc16",'
      + '"size":15,"mtimeMs":1750000003000,"serverBom":false,"serverBinary":false}';
    const r = parseRemoteResponse<RemoteWriteResult>('write', raw);
    expect(Object.keys(r)).toEqual(['conflict', 'hash', 'size', 'mtimeMs', 'serverBom', 'serverBinary']);
    expect(r.conflict).toBe(false);
    expect(r.hash).toBe('6d33a6d026c3a7d2b93c115d1fc2ee837de2eb6eb2c63787ed4dc6fdb532cc16');
    expect('serverText' in r).toBe(false);
    expect('serverHash' in r).toBe(false);
    expect('serverEncoding' in r).toBe(false);
  });

  it('write 撞上冲突：这是成功应答，server* 带的是桌面那一份最新内容', () => {
    const raw = '{"conflict":true,"hash":"ec09e4733eafa92bfe53cb596eef6b2a4a755b9a0ad5d86a87e99455f9784f6c",'
      + '"size":18,"mtimeMs":1750000004000,'
      + '"serverHash":"ec09e4733eafa92bfe53cb596eef6b2a4a755b9a0ad5d86a87e99455f9784f6c",'
      + '"serverText":"# 桌面上改过","serverEncoding":"utf-8","serverBom":false,"serverBinary":false}';
    const r = parseRemoteResponse<RemoteWriteResult>('write', raw);
    expect(Object.keys(r)).toEqual([
      'conflict', 'hash', 'size', 'mtimeMs', 'serverHash', 'serverText', 'serverEncoding',
      'serverBom', 'serverBinary',
    ]);
    expect(r.conflict).toBe(true);
    expect(r.serverText).toBe('# 桌面上改过');
    expect(r.serverEncoding).toBe('utf-8');
    expect(r.serverHash).toBe(r.hash);
  });

  it('结果不是一段合法 JSON 时归到 unknown，而不是返回空对象', () => {
    const e = parseRemoteError(caught(() => parseRemoteResponse<RemoteListResult>('list', '{ not json')));
    expect(e.code).toBe('unknown');
    expect(e.message).toContain('list');
  });
});

describe('命令封装在非 Tauri 环境', () => {
  /* 静默返回空值会让人以为「桌面上没这个文件」，所以必须抛 */
  const calls: [string, () => Promise<unknown>][] = [
    ['remoteList', () => remoteList('')],
    ['remoteStat', () => remoteStat('a.md')],
    ['remoteRead', () => remoteRead('a.md')],
    ['remoteRead 指定编码', () => remoteRead('a.md', 'gbk')],
    ['remoteWrite', () => remoteWrite({
      relPath: 'a.md', text: 'x', encoding: 'utf-8', bom: false, baseHash: 'deadbeef',
    })],
  ];
  it.each(calls)('%s 抛 unavailable', async (_label, fn) => {
    const e = await fn().then(() => null, (err: unknown) => err);
    expect(isRemoteError(e)).toBe(true);
    expect((e as RemoteError).code).toBe('unavailable');
    expect((e as RemoteError).message).toBeTruthy();
  });
});

/* ------------------------------------------------- 阶段 3：根外白名单引用 */

describe('白名单引用 @w/<id>/<名字>', () => {
  const ID = '0a1b2c3d4e5f';

  it('只认严格三段形态', () => {
    expect(isOpenRel(`@w/${ID}/todo.md`)).toBe(true);
    expect(openRelId(`@w/${ID}/todo.md`)).toBe(ID);
    for (const bad of ['notes/todo.md', `@w/${ID}`, `@w/${ID}x/x.md`, `@W/${ID}/x.md`,
      `@w/${ID.toUpperCase()}/x.md`, '@w//x.md', `@w/短/x.md`, `sub/@w/${ID}/x.md`]) {
      expect(isOpenRel(bad)).toBe(false);
      expect(openRelId(bad)).toBeNull();
    }
  });

  it('身份键往返：编进 hide-remote:// 再解回来还是同一条引用', () => {
    const rel = `@w/${ID}/待办 1.md`;
    const p = makeRemotePath(DEV, rel);
    // 三段各自编码（`@` 也编，成 %40），但分隔符仍是裸斜杠 —— 远程树的懒加载按它切段
    expect(p).toBe(`${REMOTE_SCHEME}${DEV}/%40w/${ID}/%E5%BE%85%E5%8A%9E%201.md`);
    const ref = parseRemotePath(p);
    expect(ref).not.toBeNull();
    expect(ref!.deviceId).toBe(DEV);
    expect(ref!.rel).toBe(rel);
    expect(isOpenRel(ref!.rel)).toBe(true);
  });

  it('显示名取真文件名：手机上那行标题要好看，而不是整条引用', () => {
    expect(displayNameFromPath(`${REMOTE_SCHEME}${DEV}/@w/${ID}/todo.md`)).toBe('todo.md');
  });

  it('tabs 命令在没有链路时如实抛 unavailable（不是返回空列表）', async () => {
    const e = await remoteTabs().then(() => null, (err: unknown) => err);
    expect(isRemoteError(e)).toBe(true);
    expect((e as RemoteError).code).toBe('unavailable');
  });
});

function caught(fn: () => unknown): unknown {
  try {
    fn();
    return '没有抛错';
  } catch (e) {
    return e;
  }
}
