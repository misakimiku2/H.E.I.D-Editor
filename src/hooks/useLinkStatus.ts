/**
 * 状态栏的「手机可访问」标记与菜单栏 / 顶栏的互联入口按钮读的是同一份 link_status。
 * 这里只放一个订阅口：两个组件各自 listen 一次不会出错，但两套归一化时间线会让
 * 「刚断开的那一瞬间这里还绿着」这种问题再也对不清。
 */
import { useEffect, useState } from 'react';
import { EMPTY_STATUS, fetchStatus, subscribeLinkStatus, type LinkStatus } from '../lib/link';

export function useLinkStatus(): LinkStatus {
  const [status, setStatus] = useState<LinkStatus>(EMPTY_STATUS);
  /* 非 Tauri 环境（浏览器预览）由 fetchStatus / subscribeLinkStatus 各自兜住，这里不再判一次 */
  useEffect(() => {
    let alive = true;
    fetchStatus().then((s) => { if (alive) setStatus(s); }).catch(() => {});
    const off = subscribeLinkStatus((s) => { if (alive) setStatus(s); });
    return () => { alive = false; off(); };
  }, []);
  return status;
}
