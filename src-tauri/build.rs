/* app 命令显式登记进 ACL：为每条命令自动生成 allow 与 deny 权限。
   主窗口经 capabilities/default.json 授权本地调用；隐藏抓取窗口经
   capabilities/scraper.json 仅远程授予 allow-render-result。 */
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "read_text_file",
            "write_text_file",
            "http_get",
            "http_get_binary",
            "open_external",
            "render_page",
            "render_result",
            "take_launch_paths",
            "probe_large_file",
            "read_line_window",
            "read_byte_window",
            "file_size",
            "fs_mkdir",
            "fs_rename",
            "fs_copy",
            "fs_delete",
            "fs_reveal",
            "search_in_dir",
        ])),
    )
    .expect("failed to run tauri-build");
}
