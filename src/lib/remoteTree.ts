/**
 * 远程设备的目录提供者（v1.5 阶段 2）：`DirLister` 的第三个实现 + 按根选路。
 *
 * 单独成文件而不并进 `fileTree.ts`：那边至今是一个零依赖的纯模块，
 * 而这里要吃 `remote.ts`（→ fileIO → codemirror），混在一起就把纯模块拖进了依赖环。
 *
 * 路径形态与 SAF 同构：目录与文件都用同一个前缀串当身份键
 * `hide-remote://<deviceId>/<相对共享根的路径>`，所以树的懒加载、脏点、
 * `isUnderRoot` / `relativePathUnderRoot` 等既有逻辑一律不用改。
 */
import type { DirLister } from './fileTree';
import { makeRemotePath, parseRemotePath, remoteList, REMOTE_SCHEME } from './remote';
import { loadPrefs } from './link';

/** 相对路径拼一段（远程协议里分隔符恒为 `/`，段内的 `/` 已在编码时变成 %2F） */
function joinRel(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** 桌面那次 `list` 顺手带回来的共享根名字，按设备记一份（重新配对就换了一个 keyId）。
    只在这里缓存、不写进 prefs：换根时桌面会推 `rootChanged`，手机重列一次根，
    这一份跟着刷新即可 —— 存到 prefs 里就多一个会过期的地方。 */
const rootNames = new Map<string, string>();

export const remoteDirLister: DirLister = {
  async chooseRoot() {
    /* 手机不"选"目录：共享范围就是桌面文件树当前的那个根（设计稿 §2.3）。
       没连着桌面时返回 null，等同于用户取消了选择器。 */
    const { fetchStatus } = await import('./link');
    const s = await fetchStatus();
    return s.connected && s.peerKeyId ? makeRemotePath(s.peerKeyId, '') : null;
  },
  async list(dirPath) {
    const ref = parseRemotePath(dirPath);
    if (!ref) throw new Error('远程路径不合法');
    const r = await remoteList(ref.rel);
    // 只有列根那一次桌面才给得出"那层文件夹叫什么"，顺手记下来给根节点用
    if (!ref.rel && r.rootName) rootNames.set(ref.deviceId, r.rootName);
    return r.entries.map(e => ({
      name: e.name,
      isDir: e.isDir,
      path: makeRemotePath(ref.deviceId, joinRel(ref.rel, e.name)),
    }));
  },
  displayName(rootPath) {
    const ref = parseRemotePath(rootPath);
    if (!ref) return rootPath;
    /* 树头显示「设备名 · 根目录名」：只写目录名会让人分不清这棵树在谁那里 */
    const tail = ref.rel.split('/').filter(Boolean).pop() ?? '';
    const peer = loadPrefs()?.peerName || ref.deviceId.slice(0, 8);
    const atRoot = tail || rootNames.get(ref.deviceId) || '';
    return atRoot ? `${peer} · ${atRoot}` : peer;
  },
  /* 根节点**那一行**：裸远程根的尾段是 keyId（`c21de657af9121b0`），那不是一个名字。
     列过一次根就有桌面给的真名字，在那之前退一步显示设备名，总之不给人看十六进制。 */
  rootName(rootPath) {
    const ref = parseRemotePath(rootPath);
    if (!ref) return rootPath;
    const tail = ref.rel.split('/').filter(Boolean).pop() ?? '';
    return tail || rootNames.get(ref.deviceId) || loadPrefs()?.peerName || '';
  },
  /* 没有 watch：实时更新走阶段 4 的推送通道， SAF 那侧的先例是不实现即退化为手动刷新 */
};

/** 按根目录的形态选提供者——远程根的判据就是它自己的前缀，不看运行平台 */
export function pickLister(rootPath: string | null, base: DirLister | null): DirLister | null {
  if (rootPath?.startsWith(REMOTE_SCHEME)) return remoteDirLister;
  return base;
}
