import { describe, it, expect } from 'vitest';
import {
  compareVersions, consumeStartupReleaseNotes, downloadPageFor, fetchLatestJson,
  getIgnoredVersion, isNewerVersion, LATEST_JSON_URLS, loadReleaseNotesList,
  maybeSeedCurrentVersionNotes, MAX_RELEASE_NOTES, MIRROR_RELEASES_PAGE, parseLatestJson,
  RELEASES_PAGE, saveReleaseNotes, setIgnoredVersion, shouldNotifyUpdate,
  summarizeNotes, UpdateSourceUnavailableError,
} from './update';

function fakeStorage(): { store: Map<string, string>; getItem(k: string): string | null; setItem(k: string, v: string): void } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: k => (store.has(k) ? store.get(k)! : null),
    setItem: (k, v) => void store.set(k, v),
  };
}
const asStorage = (s: ReturnType<typeof fakeStorage>) => s as unknown as Storage;

describe('compareVersions', () => {
  it('主.次.修订 逐段比较', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.4', '1.2.3')).toBeGreaterThan(0);
    expect(compareVersions('1.3.0', '1.2.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0);
  });

  it('忽略 v 前缀与首尾空白', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions(' V2.0.0 ', '2.0.0')).toBe(0);
  });

  it('段数不齐按 0 补齐', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.1', '1.2')).toBeGreaterThan(0);
  });

  it('预发布版小于同号正式版', () => {
    expect(compareVersions('1.0.0-alpha.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-beta')).toBeGreaterThan(0);
    expect(isNewerVersion('1.0.0-rc.1', '1.0.0')).toBe(false);
  });
});

describe('isNewerVersion', () => {
  it('仅严格更新返回 true，同版本与回退返回 false', () => {
    expect(isNewerVersion('1.0.1', '1.0.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
    expect(isNewerVersion('0.9.9', '1.0.0')).toBe(false);
  });
});

describe('parseLatestJson', () => {
  it('解析 updater 静态 JSON 格式', () => {
    const info = parseLatestJson(JSON.stringify({
      version: '1.0.1',
      notes: '修复若干问题',
      pub_date: '2026-09-15T00:00:00Z',
      platforms: {
        'windows-x86_64': { signature: 'xxx', url: 'https://example.com/app.nsis.zip' },
      },
    }));
    expect(info).toEqual({ version: '1.0.1', notes: '修复若干问题' });
  });

  it('notes 缺省时为 undefined', () => {
    expect(parseLatestJson('{"version":"2.0.0"}')).toEqual({ version: '2.0.0', notes: undefined });
  });

  it('非法 JSON / 缺 version / 非对象返回 null', () => {
    expect(parseLatestJson('not json')).toBe(null);
    expect(parseLatestJson('{"notes":"no version"}')).toBe(null);
    expect(parseLatestJson('[]')).toBe(null);
    expect(parseLatestJson('null')).toBe(null);
  });
});

describe('fetchLatestJson（多源按序回退）', () => {
  const body = (v: string) => JSON.stringify({ version: v });

  it('第一个源不可达时用第二个源，且带 notes 一起返回', async () => {
    const hit: string[] = [];
    const info = await fetchLatestJson(async url => {
      hit.push(url);
      if (url === 'a') throw new Error('connection refused');
      return body('1.4.2');
    }, ['a', 'b']);
    expect(info.version).toBe('1.4.2');
    expect(hit).toEqual(['a', 'b']);
  });

  it('拿到内容但不合法也算该源不可用，继续下一个', async () => {
    const info = await fetchLatestJson(
      async url => (url === 'a' ? '<html>502 Bad Gateway</html>' : body('1.4.3')),
      ['a', 'b'],
    );
    expect(info.version).toBe('1.4.3');
  });

  it('第一个源成功就不再打下一个（不浪费请求）', async () => {
    let calls = 0;
    await fetchLatestJson(async () => { calls += 1; return body('1.0.0'); }, ['a', 'b']);
    expect(calls).toBe(1);
  });

  it('全部落空抛 UpdateSourceUnavailableError，并逐个记下失败原因', async () => {
    const err = await fetchLatestJson(
      async url => { if (url === 'a') throw new Error('timeout'); return ''; },
      ['a', 'b'],
    ).then(() => null).catch(e => e);
    expect(err).toBeInstanceOf(UpdateSourceUnavailableError);
    expect((err as UpdateSourceUnavailableError).kind).toBe('unreachable');
    expect((err as UpdateSourceUnavailableError).attempts).toEqual([
      { url: 'a', message: 'timeout' },
      { url: 'b', message: 'invalid latest.json' },
    ]);
  });

  it('返回命中的是哪个源（下载页要跟着它走）', async () => {
    const info = await fetchLatestJson(
      async url => (url === 'a' ? 'garbage' : body('1.4.4')),
      ['a', 'b'],
    );
    expect(info.sourceUrl).toBe('b');
  });

  it('默认候选源非空且全是 https（镜像追加时别把明文地址混进来）', () => {
    expect(LATEST_JSON_URLS.length).toBeGreaterThan(0);
    for (const url of LATEST_JSON_URLS) expect(url.startsWith('https://')).toBe(true);
  });
});

describe('downloadPageFor（下载页跟随命中的源）', () => {
  it('命中镜像源就用镜像页', () => {
    expect(downloadPageFor(LATEST_JSON_URLS[1])).toBe(MIRROR_RELEASES_PAGE);
  });

  it('命中 GitHub 或压根没命中就用 GitHub 页', () => {
    expect(downloadPageFor(LATEST_JSON_URLS[0])).toBe(RELEASES_PAGE);
    expect(downloadPageFor(null)).toBe(RELEASES_PAGE);
    expect(downloadPageFor('不是个 URL')).toBe(RELEASES_PAGE);
  });
});

describe('忽略版本持久化', () => {
  it('未忽略返回 null，忽略后可读回', () => {
    const s = fakeStorage();
    expect(getIgnoredVersion(asStorage(s))).toBe(null);
    setIgnoredVersion('1.2.1', asStorage(s));
    expect(getIgnoredVersion(asStorage(s))).toBe('1.2.1');
  });

  it('shouldNotifyUpdate：未忽略弹；同版本不弹；比忽略版本新则弹', () => {
    expect(shouldNotifyUpdate('1.2.1', null)).toBe(true);
    expect(shouldNotifyUpdate('1.2.1', '1.2.1')).toBe(false);
    expect(shouldNotifyUpdate('1.2.2', '1.2.1')).toBe(true);
    expect(shouldNotifyUpdate('1.2.0', '1.2.1')).toBe(false);
  });
});

describe('发行说明历史持久化', () => {
  it('保存后最新在前；notes 缺省存为空串', () => {
    const s = fakeStorage();
    saveReleaseNotes({ version: '1.2.0', notes: '# v1.2.0' }, asStorage(s));
    saveReleaseNotes({ version: '1.3.0', notes: '# v1.3.0' }, asStorage(s));
    expect(loadReleaseNotesList(asStorage(s)).map(n => n.version)).toEqual(['1.3.0', '1.2.0']);
    saveReleaseNotes({ version: '1.4.0' }, asStorage(s));
    expect(loadReleaseNotesList(asStorage(s))[0]).toEqual({ version: '1.4.0', notes: '', shown: false });
  });

  it('同版本重复保存视为替换并重置 shown', () => {
    const s = fakeStorage();
    saveReleaseNotes({ version: '1.3.0', notes: '草稿' }, asStorage(s));
    saveReleaseNotes({ version: '1.3.0', notes: '正式说明' }, asStorage(s));
    const list = loadReleaseNotesList(asStorage(s));
    expect(list).toHaveLength(1);
    expect(list[0].notes).toBe('正式说明');
    expect(list[0].shown).toBe(false);
  });

  it('超出容量上限丢弃最旧', () => {
    const s = fakeStorage();
    for (let i = 0; i <= MAX_RELEASE_NOTES; i++) {
      saveReleaseNotes({ version: `1.0.${i}`, notes: `n${i}` }, asStorage(s));
    }
    const list = loadReleaseNotesList(asStorage(s));
    expect(list).toHaveLength(MAX_RELEASE_NOTES);
    expect(list[0].version).toBe(`1.0.${MAX_RELEASE_NOTES}`);
    expect(list[list.length - 1].version).toBe('1.0.1');
  });

  it('consume：当前版本且未展示 → 返回并标记已展示；再次 consume 返回 null', () => {
    const s = fakeStorage();
    saveReleaseNotes({ version: '1.3.0', notes: 'notes' }, asStorage(s));
    const first = consumeStartupReleaseNotes('1.3.0', asStorage(s));
    expect(first).toEqual({ version: '1.3.0', notes: 'notes', shown: false });
    expect(loadReleaseNotesList(asStorage(s))[0].shown).toBe(true);
    expect(consumeStartupReleaseNotes('1.3.0', asStorage(s))).toBe(null);
  });

  it('consume：版本不匹配 / 无记录 / 损坏 JSON 返回 null 且不改动存储', () => {
    const s = fakeStorage();
    saveReleaseNotes({ version: '1.3.0', notes: 'n' }, asStorage(s));
    expect(consumeStartupReleaseNotes('1.4.0', asStorage(s))).toBe(null);
    expect(loadReleaseNotesList(asStorage(s))[0].shown).toBe(false);

    const empty = fakeStorage();
    expect(consumeStartupReleaseNotes('1.3.0', asStorage(empty))).toBe(null);

    const bad = fakeStorage();
    bad.store.set('heid-update-release-notes', 'garbage');
    expect(loadReleaseNotesList(asStorage(bad))).toEqual([]);
    expect(consumeStartupReleaseNotes('1.3.0', asStorage(bad))).toBe(null);
  });

  it('兼容旧版单对象格式（自动包装为单项列表）', () => {
    const s = fakeStorage();
    s.store.set('heid-update-release-notes', JSON.stringify({ version: '1.2.0', notes: '旧格式', shown: true }));
    expect(loadReleaseNotesList(asStorage(s))).toEqual([
      { version: '1.2.0', notes: '旧格式', shown: true },
    ]);
  });

  it('损坏条目逐个跳过，不拖垮整份列表', () => {
    const s = fakeStorage();
    s.store.set('heid-update-release-notes', JSON.stringify([
      { version: '1.3.0', notes: 'ok', shown: false },
      { notes: 'no version' },
      null,
      'garbage',
    ]));
    expect(loadReleaseNotesList(asStorage(s))).toEqual([
      { version: '1.3.0', notes: 'ok', shown: false },
    ]);
  });
});

describe('自愈补种（maybeSeedCurrentVersionNotes）', () => {
  it('latest.json 版本与当前一致且列表缺失 → 补种为未展示条目并置顶', () => {
    const s = fakeStorage();
    saveReleaseNotes({ version: '1.2.0', notes: '# 旧版' }, asStorage(s));
    const seeded = maybeSeedCurrentVersionNotes(
      '1.3.0', { version: '1.3.0', notes: '# v1.3.0 说明' }, asStorage(s),
    );
    expect(seeded).toBe(true);
    expect(loadReleaseNotesList(asStorage(s))).toEqual([
      { version: '1.3.0', notes: '# v1.3.0 说明', shown: false },
      { version: '1.2.0', notes: '# 旧版', shown: false },
    ]);
  });

  it('latest.json 指向更新版本（有新版可用）→ 不补种', () => {
    const s = fakeStorage();
    const seeded = maybeSeedCurrentVersionNotes(
      '1.3.0', { version: '1.3.1', notes: '新版说明' }, asStorage(s),
    );
    expect(seeded).toBe(false);
    expect(loadReleaseNotesList(asStorage(s))).toEqual([]);
  });

  it('列表已有当前版本条目 → 不补种且不重置既有条目的 shown / notes', () => {
    const s = fakeStorage();
    saveReleaseNotes({ version: '1.3.0', notes: '原有说明' }, asStorage(s));
    const first = consumeStartupReleaseNotes('1.3.0', asStorage(s));
    expect(first).not.toBe(null);
    const seeded = maybeSeedCurrentVersionNotes(
      '1.3.0', { version: '1.3.0', notes: '自愈说明' }, asStorage(s),
    );
    expect(seeded).toBe(false);
    const list = loadReleaseNotesList(asStorage(s));
    expect(list[0]).toEqual({ version: '1.3.0', notes: '原有说明', shown: true });
  });

  it('notes 缺省时以空说明补种（入口可见，文档显示占位文案）', () => {
    const s = fakeStorage();
    const seeded = maybeSeedCurrentVersionNotes('1.3.0', { version: '1.3.0' }, asStorage(s));
    expect(seeded).toBe(true);
    expect(loadReleaseNotesList(asStorage(s))[0]).toEqual({
      version: '1.3.0', notes: '', shown: false,
    });
  });
});

describe('summarizeNotes', () => {
  it('压缩空白为单行', () => {
    expect(summarizeNotes('# 标题\n\n- 甲\n- 乙')).toBe('# 标题 - 甲 - 乙');
  });

  it('超长截断加省略号', () => {
    const out = summarizeNotes('a'.repeat(200), 160);
    expect(out).toHaveLength(161);
    expect(out!.endsWith('…')).toBe(true);
  });

  it('空 / 缺省返回 null', () => {
    expect(summarizeNotes(undefined)).toBe(null);
    expect(summarizeNotes('')).toBe(null);
    expect(summarizeNotes('   \n\t')).toBe(null);
  });
});
