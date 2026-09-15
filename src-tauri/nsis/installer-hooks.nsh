; ============================================================================
; H.I.D.E 外壳集成补充注册（Tauri NSIS 安装钩子）
; ----------------------------------------------------------------------------
; 背景：Tauri 的 bundle.fileAssociations 只写入 ProgID 与「.ext 默认值」，
; 不写 OpenWithProgids，因此 H.I.D.E 不会出现在「打开方式」候选列表里，
; 也不会出现在「设置 → 默认应用」中（该列表读 RegisteredApplications）。
; 本文件在安装完成后补齐 Tauri 未覆盖的注册项：
;
;   1. .<ext>\OpenWithProgids        → 出现在「打开方式 / 更多应用」候选列表
;   2. Applications\<exe>            → 系统按可执行文件识别为可选编辑器
;   3. App Paths\<exe>               → 允许按 exe 名定位与启动（ShellExecute / 运行）
;   4. RegisteredApplications +
;      Capabilities\FileAssociations → 出现在「设置 → 默认应用」，
;                                      可一键把 H.I.D.E 设为 .md/.ts 等的默认程序
;   5. 资源管理器右键「用 H.I.D.E 打开」→ 任意文件类型可快速打开
;
; 约束与注意事项：
;   · 扩展名清单必须与 src-tauri/tauri.conf.json 的 bundle.fileAssociations 保持一致
;   · ProgID 必须与 fileAssociations.name 完全一致（含空格）
;   · SHCTX 由 Tauri 模板按 installMode 决定：默认 currentUser → HKCU，无需管理员权限
;   · 卸载时由 NSIS_HOOK_PREUNINSTALL 精确清理本文件写入的项，不触碰 Tauri 自己的键
; ============================================================================

!define HEID_PROGID "H.I.D.E Document"
!define HEID_APPNAME "H.I.D.E"
!define HEID_CAPKEY "Software\H.I.D.E\Capabilities"
!define HEID_VERB "HIDEOpen"

; 单个扩展名：写入三处关联（打开方式候选 / 按 exe 的可选编辑器 / 默认应用清单）
!macro HEID_ASSOC_ADD EXT
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${HEID_PROGID}" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".${EXT}" ""
  WriteRegStr SHCTX "${HEID_CAPKEY}\FileAssociations" ".${EXT}" "${HEID_PROGID}"
!macroend

; 单个扩展名：清理上述三处（仅删本程序写入的值，保留其他程序注册）
!macro HEID_ASSOC_DEL EXT
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${HEID_PROGID}"
  DeleteRegValue SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".${EXT}"
  DeleteRegValue SHCTX "${HEID_CAPKEY}\FileAssociations" ".${EXT}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "注册 H.I.D.E 为可选/默认编辑器..."

  ; ---- 1. 打开方式候选（每个扩展名的 OpenWithProgids）----
  !insertmacro HEID_ASSOC_ADD "txt"
  !insertmacro HEID_ASSOC_ADD "log"
  !insertmacro HEID_ASSOC_ADD "md"
  !insertmacro HEID_ASSOC_ADD "markdown"
  !insertmacro HEID_ASSOC_ADD "json"
  !insertmacro HEID_ASSOC_ADD "yaml"
  !insertmacro HEID_ASSOC_ADD "yml"
  !insertmacro HEID_ASSOC_ADD "toml"
  !insertmacro HEID_ASSOC_ADD "ini"
  !insertmacro HEID_ASSOC_ADD "xml"
  !insertmacro HEID_ASSOC_ADD "svg"
  !insertmacro HEID_ASSOC_ADD "ts"
  !insertmacro HEID_ASSOC_ADD "tsx"
  !insertmacro HEID_ASSOC_ADD "js"
  !insertmacro HEID_ASSOC_ADD "jsx"
  !insertmacro HEID_ASSOC_ADD "py"
  !insertmacro HEID_ASSOC_ADD "rs"
  !insertmacro HEID_ASSOC_ADD "go"
  !insertmacro HEID_ASSOC_ADD "java"
  !insertmacro HEID_ASSOC_ADD "c"
  !insertmacro HEID_ASSOC_ADD "cpp"
  !insertmacro HEID_ASSOC_ADD "cc"
  !insertmacro HEID_ASSOC_ADD "cxx"
  !insertmacro HEID_ASSOC_ADD "h"
  !insertmacro HEID_ASSOC_ADD "hpp"
  !insertmacro HEID_ASSOC_ADD "cs"
  !insertmacro HEID_ASSOC_ADD "rb"
  !insertmacro HEID_ASSOC_ADD "php"
  !insertmacro HEID_ASSOC_ADD "html"
  !insertmacro HEID_ASSOC_ADD "htm"
  !insertmacro HEID_ASSOC_ADD "css"
  !insertmacro HEID_ASSOC_ADD "scss"
  !insertmacro HEID_ASSOC_ADD "less"
  !insertmacro HEID_ASSOC_ADD "sh"
  !insertmacro HEID_ASSOC_ADD "bash"
  !insertmacro HEID_ASSOC_ADD "sql"
  !insertmacro HEID_ASSOC_ADD "swift"
  !insertmacro HEID_ASSOC_ADD "kt"
  !insertmacro HEID_ASSOC_ADD "kts"
  !insertmacro HEID_ASSOC_ADD "scala"
  !insertmacro HEID_ASSOC_ADD "vue"
  !insertmacro HEID_ASSOC_ADD "svelte"

  ; ---- 2. 按可执行文件注册：让系统把 H.I.D.E 视为可选编辑器 ----
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${HEID_APPNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open" "" "Open with ${HEID_APPNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  ; ---- 3. App Paths：支持按 exe 名启动与定位 ----
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\${MAINBINARYNAME}.exe" "Path" "$INSTDIR"

  ; ---- 4. 注册应用能力：出现在「设置 → 默认应用」并可按类型设为默认 ----
  WriteRegStr SHCTX "Software\RegisteredApplications" "${HEID_APPNAME}" "${HEID_CAPKEY}"
  WriteRegStr SHCTX "${HEID_CAPKEY}" "ApplicationName" "${HEID_APPNAME}"
  WriteRegStr SHCTX "${HEID_CAPKEY}" "ApplicationDescription" "秒开的轻量代码 / 文档编辑器"
  WriteRegStr SHCTX "${HEID_CAPKEY}" "ApplicationIcon" "$INSTDIR\${MAINBINARYNAME}.exe,0"

  ; ---- 5. 资源管理器右键「用 H.I.D.E 打开」（所有文件类型）----
  WriteRegStr SHCTX "Software\Classes\*\shell\${HEID_VERB}" "" "用 ${HEID_APPNAME} 打开"
  WriteRegStr SHCTX "Software\Classes\*\shell\${HEID_VERB}" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  ; 单文件命令：显式声明单选，避免多选时只传入首个文件造成误判
  WriteRegStr SHCTX "Software\Classes\*\shell\${HEID_VERB}" "MultiSelectModel" "Single"
  WriteRegStr SHCTX "Software\Classes\*\shell\${HEID_VERB}\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  ; 通知外壳刷新关联缓存，免去重启资源管理器
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 仅清理本文件写入的项；Tauri 自己的 ProgID / .ext 默认值由模板的 APP_UNASSOCIATE 处理
  !insertmacro HEID_ASSOC_DEL "txt"
  !insertmacro HEID_ASSOC_DEL "log"
  !insertmacro HEID_ASSOC_DEL "md"
  !insertmacro HEID_ASSOC_DEL "markdown"
  !insertmacro HEID_ASSOC_DEL "json"
  !insertmacro HEID_ASSOC_DEL "yaml"
  !insertmacro HEID_ASSOC_DEL "yml"
  !insertmacro HEID_ASSOC_DEL "toml"
  !insertmacro HEID_ASSOC_DEL "ini"
  !insertmacro HEID_ASSOC_DEL "xml"
  !insertmacro HEID_ASSOC_DEL "svg"
  !insertmacro HEID_ASSOC_DEL "ts"
  !insertmacro HEID_ASSOC_DEL "tsx"
  !insertmacro HEID_ASSOC_DEL "js"
  !insertmacro HEID_ASSOC_DEL "jsx"
  !insertmacro HEID_ASSOC_DEL "py"
  !insertmacro HEID_ASSOC_DEL "rs"
  !insertmacro HEID_ASSOC_DEL "go"
  !insertmacro HEID_ASSOC_DEL "java"
  !insertmacro HEID_ASSOC_DEL "c"
  !insertmacro HEID_ASSOC_DEL "cpp"
  !insertmacro HEID_ASSOC_DEL "cc"
  !insertmacro HEID_ASSOC_DEL "cxx"
  !insertmacro HEID_ASSOC_DEL "h"
  !insertmacro HEID_ASSOC_DEL "hpp"
  !insertmacro HEID_ASSOC_DEL "cs"
  !insertmacro HEID_ASSOC_DEL "rb"
  !insertmacro HEID_ASSOC_DEL "php"
  !insertmacro HEID_ASSOC_DEL "html"
  !insertmacro HEID_ASSOC_DEL "htm"
  !insertmacro HEID_ASSOC_DEL "css"
  !insertmacro HEID_ASSOC_DEL "scss"
  !insertmacro HEID_ASSOC_DEL "less"
  !insertmacro HEID_ASSOC_DEL "sh"
  !insertmacro HEID_ASSOC_DEL "bash"
  !insertmacro HEID_ASSOC_DEL "sql"
  !insertmacro HEID_ASSOC_DEL "swift"
  !insertmacro HEID_ASSOC_DEL "kt"
  !insertmacro HEID_ASSOC_DEL "kts"
  !insertmacro HEID_ASSOC_DEL "scala"
  !insertmacro HEID_ASSOC_DEL "vue"
  !insertmacro HEID_ASSOC_DEL "svelte"

  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\${MAINBINARYNAME}.exe"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "${HEID_APPNAME}"
  DeleteRegKey SHCTX "${HEID_CAPKEY}"
  ; 仅在空目录时移除，避免误删其他/未来数据
  DeleteRegKey /ifempty SHCTX "Software\H.I.D.E"
  DeleteRegKey SHCTX "Software\Classes\*\shell\${HEID_VERB}"

  !insertmacro UPDATEFILEASSOC
!macroend
