// @vitest-environment jsdom
/**
 * 状态卡顶上那条「接线轨道」：五档形状必须各不相同。
 *
 * 这块面板重做的全部理由就是"四种状态长得一样"，所以这里钉住形状差异本身，
 * 而不是钉 class 字符串怎么写 —— 以后谁把它改回一个通用绿点，这条会红。
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeviceLinkRail, type RailPhase } from './DeviceLinkRail';

const PHASES: RailPhase[] = ['off', 'waiting', 'connecting', 'connected', 'broken'];
const html = (phase: RailPhase, asClient = true) => renderToStaticMarkup(
  <DeviceLinkRail phase={phase} dark asClient={asClient} label={`状态：${phase}`} />,
);

describe('接线轨道的五档形状', () => {
  it('每一档的标记都不重样（五种状态五种样子）', () => {
    expect(new Set(PHASES.map((p) => html(p))).size).toBe(PHASES.length);
  });

  it('只有「正在接回」这一档在动 —— 连上之后还留着走动的光点，会让人以为这条链路没稳', () => {
    expect(html('connecting')).toContain('heid-rail-run');
    for (const p of PHASES.filter(x => x !== 'connecting')) {
      expect(html(p), `${p} 这一档不该有走动的光点`).not.toContain('heid-rail-run');
    }
  });

  it('只有「等待设备来连」让对端那颗呼吸；断口与没开都不呼吸', () => {
    expect(html('waiting')).toContain('heid-rail-pulse');
    for (const p of ['off', 'connected', 'broken', 'connecting'] as RailPhase[]) {
      expect(html(p), `${p} 这一档不该有呼吸`).not.toContain('heid-rail-pulse');
    }
  });

  /* 「已连接」和「接不上」以前只差 6px 的一道缝，等于没分开。断口只许属于断在半路那一档 */
  it('只有断在半路那一档中间留空，其余四档线是连续的', () => {
    expect(html('broken')).toContain('w-3');
    for (const p of ['off', 'waiting', 'connecting', 'connected'] as RailPhase[]) {
      expect(html(p), `${p} 那一档线不该有断口`).not.toContain('w-3');
    }
  });

  /* 这条钉的是刚踩过的那个坑：实心线拆成两段各跑一遍 indigo→emerald 渐变，
     中间必然颜色回跳，一条"已连接"的线看着还是断的 */
  it('已连接那条渐变线只跑一遍（拆成两段就会在中间回跳成"看着像断的"）', () => {
    const runs = (html('connected').match(/from-indigo-500 to-emerald-500/g) || []).length;
    expect(runs).toBe(1);
    expect(html('off')).not.toContain('from-indigo-500');
  });

  /* 这条就是"四种状态长得一样"那个毛病的守卫：没接上必须是虚线，
     接上了才是实心 —— 全是实线的话「没开」和「断在半路」分不开 */
  it('没接上的三档画虚线，接上与断在半路画实心', () => {
    for (const p of ['off', 'waiting', 'connecting'] as RailPhase[]) {
      expect(html(p), `${p} 该是虚线`).toContain('heid-rail-dash');
    }
    for (const p of ['connected', 'broken'] as RailPhase[]) {
      expect(html(p), `${p} 该是实心`).not.toContain('heid-rail-dash');
    }
  });

  /* 断在半路多半是服务端自己的防火墙拦的，把对面那颗涂成警告色是冤枉它 */
  it('断在半路那一档两端节点仍是中性的，只有线是警告色', () => {
    const nodes = (p: RailPhase) => [...html(p).matchAll(/rounded-\[9px\][^"]*/g)].map(m => m[0]);
    expect(nodes('broken')).toEqual(nodes('off'));
    expect(html('broken')).toContain('amber');
    expect(html('off')).not.toContain('amber');
  });

  it('两端的图标随角色对调：桌面这边画显示器，安卓那边画手机', () => {
    expect(html('off', false)).not.toBe(html('off', true));
  });

  it('读屏拿得到状态那句话，图形自己不参与语义', () => {
    const mark = html('connected');
    expect(mark).toContain('role="img"');
    expect(mark).toContain('aria-label="状态：connected"');
  });
});
