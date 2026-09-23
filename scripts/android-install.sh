#!/usr/bin/env bash
# 出签名 release 包并装到所有连着的安卓设备。
#
#   ./scripts/android-install.sh              构建 + 安装（约 5-10 分钟）
#   ./scripts/android-install.sh install-only 跳过构建，只装现成的 APK（几秒）
#
# 为什么是 release 而不是 debug：真机上装的是 release 签名，debug 包要先卸载才能装、
# 会清掉应用数据（SAF 授权、会话、记住的镜头）。release 走本地 keystore，`install -r` 原地升级不丢数据。
# 装完脚本会 force-stop：不重启进程的话跑的还是旧代码（这个坑白查过一轮）。
set -euo pipefail
cd "$(dirname "$0")/.."

APK=src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk

if [ "${1:-}" != "install-only" ]; then
  echo "== 构建 aarch64 签名 release 包（Rust 编译占大头，耐心等）"
  TAURI_SIGNING_PRIVATE_KEY="$(cat src-tauri/keys/heid.key)" \
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
    npm run tauri android build -- --apk --target aarch64
fi

if [ ! -f "$APK" ]; then
  echo "找不到 $APK，先跑一次不带参数的构建" >&2
  exit 1
fi

echo "== 安装到所有在线设备"
found=0
while read -r serial state; do
  [ "$state" = "device" ] || continue
  found=1
  echo "-- $serial"
  adb -s "$serial" install -r "$APK"
  adb -s "$serial" shell am force-stop com.nexus.editor
done < <(adb devices | awk 'NR>1 {print $1, $2}')

if [ "$found" = "0" ]; then
  echo "没有在线的安卓设备（adb devices 看一眼）" >&2
  exit 1
fi
echo "== 完成。重新点开 App 就是新代码。"
echo "   扫码诊断：进扫一扫后点底部那行调试字，展开的日志截图即可回传。"
