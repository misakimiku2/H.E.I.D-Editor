/* app 命令显式登记进 ACL：为每条命令自动生成 allow 与 deny 权限。
   主窗口经 capabilities/default.json 授权本地调用；隐藏抓取窗口经
   capabilities/scraper.json 仅远程授予 allow-render-result。

   新增一条 #[tauri::command] 要同时改三处，漏掉任何一处都不会有编译错误：
   ① lib.rs 的 generate_handler!、② 下面的清单、③ capabilities/default.json 的 allow-<命令名>。
   只漏 ② 时 build.rs 会 panic 并列出全部已知权限（很长，别以为是 ACL 语法错了）。 */
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
            "search_in_dir_cancel",
            "search_in_dir_progress",
            "create_document_window",
            "take_window_bootstrap",
            "begin_tab_drag",
            "consume_pending_drag",
            "finish_tab_drag",
            "send_to_window",
            "window_count",
            // 设备互联（v1.5）：两端共用，不按平台裁剪
            "link_status",
            "link_ticket",
            "link_server_start",
            "link_server_stop",
            "link_client_connect",
            "link_client_disconnect",
        ])),
    )
    .expect("failed to run tauri-build");
}
