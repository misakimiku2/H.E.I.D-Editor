/**
 * 渲染副本安全化：内联 <svg> 可交互渲染打破了 <img> blob「脚本不执行」的天然隔离，
 * 由本层等价承接——脚本不解析执行、无内联事件、无 javascript: URL、无外部网络请求。
 * 只处理内存中的克隆（渲染用），权威树与源码文本永不触碰。
 * 同时给每个存活元素盖 data-hed-idx（= 权威树先序下标），画布命中后凭它回到权威元素。
 */
import type { SvgParseResult } from './svgParse';

export const HED_IDX_ATTR = 'data-hed-idx';

/** xlink:href 的命名空间（解析带 xlink 前缀文档时 DOM 拆成命名空间属性） */
const XLINK_NS = 'http://www.w3.org/1999/xlink';

const isExternalUrl = (v: string) => /^(https?:|\/\/|file:|ftp:)/i.test(v.trim()) && !v.trim().startsWith('data:');

export function createRenderCopy(res: SvgParseResult): Element {
  const clone = res.dom.documentElement.cloneNode(true) as Element;

  /* 第一遍：先序盖权威树下标（此刻克隆与权威树结构逐位一致） */
  let idx = 0;
  const walk = (el: Element) => {
    el.setAttribute(HED_IDX_ATTR, String(idx));
    idx += 1;
    for (const child of Array.from(el.children)) walk(child);
  };
  walk(clone);

  /* 第二遍：清理（收集后统一删除，避免遍历中修改子节点列表） */
  const toRemove: Element[] = [];
  for (const el of Array.from(clone.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'foreignobject') { toRemove.push(el); continue; }
    if (tag === 'image' || tag === 'use') {
      const ref = el.getAttribute('href') ?? el.getAttributeNS(XLINK_NS, 'href');
      if (ref !== null && ref.trim() !== '' && !ref.trim().startsWith('#') && !ref.trim().startsWith('data:')) {
        toRemove.push(el);
        continue;
      }
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) { el.removeAttribute(attr.name); continue; }
      if ((name === 'href' || name === 'xlink:href') && /^javascript:/i.test(attr.value.trim())) {
        el.removeAttribute(attr.name);
      }
    }
  }
  for (const el of toRemove) el.remove();

  return clone;
}
