/* app 命令显式登记进 ACL：为每条命令自动生成 allow 与 deny 权限。
   主窗口经 capabilities/default.json 授权本地调用；隐藏抓取窗口经
   capabilities/scraper.json 仅远程授予 allow-render-result。 */
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "read_text_file",
            "write_text_file",
            "http_get",
            "open_external",
            "render_page",
            "render_result",
            "take_launch_paths",
        ])),
    )
    .expect("failed to run tauri-build");
}
