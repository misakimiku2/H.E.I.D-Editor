/**
 * 跟随选区的浮层总线：安卓返回键要逐层关浮层，但这些浮层的开关状态跟选区一起
 * 住在组件内部（上提状态要牵动选区坐标与 canUndo 链路，不值当），返回键链又住在
 * App——两边用这里的通道对接。每层一个通道：组件打开时上报、关闭/卸载时配对收回，
 * 并登记一个关闭回调；App 只订一个「有没有开着的」布尔，返回键触发时成批关闭。
 *
 * 现有两层：
 *  - 格式菜单（源码编辑器的 mdMenu、预览的 menu / blankMenu）——浮在选区之上，最高一层；
 *  - 选区操作条（预览的 selBar、源码编辑器的 touchFmtBtn，即那颗「复制 / 更多」）——低一层。
 * 返回键先关菜单，再关操作条，两层都收掉才轮到退出确认。
 */
function createOverlayChannel() {
  const closeFns = new Set<() => void>();
  let openCount = 0;
  const openListeners = new Set<(open: boolean) => void>();

  const emit = () => {
    const open = openCount > 0;
    openListeners.forEach((fn) => fn(open));
  };

  return {
    /** 打开。配对的一次关闭（真正关掉或组件卸载）必须调 notifyClosed，计数不能漏 */
    notifyOpen() {
      openCount += 1;
      emit();
    },
    notifyClosed() {
      openCount = Math.max(0, openCount - 1);
      emit();
    },
    /** 订阅「有没有开着的」（open/close 都会推一次）。回调里通常是 setState，身份是
        稳定的；别在 effect 里包成每次渲染新建的闭包再传进来 */
    subscribeOpen(fn: (open: boolean) => void): () => void {
      openListeners.add(fn);
      return () => {
        openListeners.delete(fn);
      };
    },
    /** 组件登记自己的关闭回调（返回键成批关时逐个执行）。卸载时必须调返回的清理函数 */
    registerClose(fn: () => void): () => void {
      closeFns.add(fn);
      return () => {
        closeFns.delete(fn);
      };
    },
    /** 安卓返回键：关掉所有登记在册的这层浮层 */
    closeAll(): void {
      closeFns.forEach((fn) => fn());
    },
  };
}

const fmtMenu = createOverlayChannel();
const selBar = createOverlayChannel();

/* 格式菜单层（保留原有导出名，调用点与测试不用改） */
export const notifyFmtMenuOpen = fmtMenu.notifyOpen;
export const notifyFmtMenuClosed = fmtMenu.notifyClosed;
export const subscribeFmtMenuOpen = fmtMenu.subscribeOpen;
export const registerFmtMenuClose = fmtMenu.registerClose;
export const closeAllFmtMenus = fmtMenu.closeAll;

/* 选区操作条层 */
export const notifySelBarOpen = selBar.notifyOpen;
export const notifySelBarClosed = selBar.notifyClosed;
export const subscribeSelBarOpen = selBar.subscribeOpen;
export const registerSelBarClose = selBar.registerClose;
export const closeAllSelBars = selBar.closeAll;
