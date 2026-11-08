// @vitest-environment jsdom
/**
 * 恢复通知的文案（纯函数）：数量、文件名、以及**这份草稿最后一次是什么时候**。
 * 最后那一项是这条通知存在的理由——标签上只有一个小脏点，看不出这份内容是
 * 上次没保存的，还是磁盘后来又被外部改过的；草稿一直记着时刻，只是从没读过。
 */
import { describe, expect, it } from 'vitest';
import { draftRestoreNotice } from './useSessionPersistence';

const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')}` : key;

const NOW = 1_800_000_000_000; // 2026-11-15T00:00:00Z 附近的一个固定时刻

const notice = (drafted: { title: string; at: number }[]) => draftRestoreNotice(drafted, t as never, NOW);

describe('draftRestoreNotice', () => {
  it('报数量与文件名，三个以上省略', () => {
    expect(notice([{ title: 'a.md', at: NOW }]).title).toBe('draft.restoredTitle:n=1');
    expect(notice([{ title: 'a.md', at: NOW }, { title: 'b.md', at: NOW }]).message)
      .toContain('names=a.md / b.md');
    const many = ['a.md', 'b.md', 'c.md', 'd.md'].map(title => ({ title, at: NOW }));
    expect(notice(many).message).toContain('names=a.md / b.md / c.md …');
    expect(notice(many).title).toBe('draft.restoredTitle:n=4');
  });

  it('时刻取最新那份草稿，按距今时长分档', () => {
    const min = 60_000;
    expect(notice([{ title: 'a.md', at: NOW - 30_000 }]).message).toContain('age=draft.ageNow');
    expect(notice([{ title: 'a.md', at: NOW - 5 * min }]).message).toContain('age=draft.ageMin:n=5');
    expect(notice([{ title: 'a.md', at: NOW - 3 * 60 * min }]).message).toContain('age=draft.ageHour:n=3');
    /* 混合新旧：说的是「最近一次记录」，不是最旧那份 */
    expect(notice([{ title: 'a.md', at: NOW - 10 * min }, { title: 'b.md', at: NOW - 2 * min }]).message)
      .toContain('age=draft.ageMin:n=2');
  });

  it('超过一天退回具体日期，不报「25 小时前」', () => {
    const at = NOW - 26 * 60 * 60_000;
    expect(notice([{ title: 'a.md', at }]).message).toContain(`age=${new Date(at).toLocaleDateString()}`);
  });

  it('时刻缺失（历史草稿 at=0）当作刚刚，不报「57 年前」', () => {
    expect(notice([{ title: 'a.md', at: 0 }]).message).toContain('age=draft.ageNow');
  });
});
