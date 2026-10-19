; ============================================================================
; H.I.D.E 外壳集成补充注册（Tauri NSIS 安装钩子）
; ----------------------------------------------------------------------------
; 背景：Tauri 的 bundle.fileAssociations 会为每个关联写入 ProgID、
; 「.ext 默认值」和 DefaultIcon，但存在两点不足：
;   1. DefaultIcon 一律指向 exe 主图标 —— 所有格式共用同一个图标；
;   2. 不写 OpenWithProgids，因此 H.I.D.E 不会出现在「打开方式」候选列表里，
;      也不会出现在「设置 → 默认应用」中（该列表读 RegisteredApplications）。
;
; 本文件在安装完成后补齐 Tauri 未覆盖的部分：
;
;   1. 每个格式的 DefaultIcon → 覆写为随包分发的独立 .ico
;      （icons/filetypes/*.ico，由 scripts/generate-filetype-icons.mjs 生成），
;      使 .md / .txt / .log / 各代码文件在资源管理器中图标互不相同
;   2. .<ext>\OpenWithProgids        → 出现在「打开方式 / 更多应用」候选列表
;   3. Applications\<exe>            → 系统按可执行文件识别为可选编辑器
;   4. App Paths\<exe>               → 允许按 exe 名定位与启动（ShellExecute / 运行）
;   5. RegisteredApplications +
;      Capabilities\FileAssociations → 出现在「设置 → 默认应用」，
;                                      可一键把 H.I.D.E 设为 .md/.ts 等的默认程序
;   6. 资源管理器右键「用 H.I.D.E 打开」→ 任意文件类型可快速打开
;
; ProgID 规约：
;   · 每个格式组一个 ProgID：com.nexus.editor.<组名>，
;     与 tauri.conf.json bundle.fileAssociations[].name 一一对应，
;     由 Tauri 模板负责创建与卸载清理；本文件只覆写其 DefaultIcon。
;   · 1.5.x 及更早版本使用单一 ProgID「H.I.D.E Document」，此处完成迁移：
;     安装时清理旧的 OpenWithProgids 引用（ProgID 键本身保留，
;     以免已通过「设置→默认应用」选择旧 ProgID 的用户关联失效）；
;     卸载时一并删除旧 ProgID 键。
;
; 约束与注意事项：
;   · 扩展名清单必须与 src-tauri/tauri.conf.json 的 bundle.fileAssociations 保持一致
;   · 图标名（组名）必须与 scripts/generate-filetype-icons.mjs 的 TYPES 表一致
;   · SHCTX 由 Tauri 模板按 installMode 决定：默认 currentUser → HKCU，无需管理员权限
;   · 卸载时由 NSIS_HOOK_PREUNINSTALL 精确清理本文件写入的项，不触碰 Tauri 自己的键
; ============================================================================

!define HEID_PID_BASE "com.nexus.editor"
!define HEID_LEGACY_PROGID "H.I.D.E Document"
!define HEID_APPNAME "H.I.D.E"
!define HEID_CAPKEY "Software\H.I.D.E\Capabilities"
!define HEID_VERB "HIDEOpen"

; 单个扩展名：登记打开方式候选 / 按 exe 的可选编辑器 / 默认应用清单，
; 并清掉 1.5.x 遗留的单一 ProgID 引用（迁移到按格式的 ProgID）
!macro HEID_ASSOC_ADD EXT PROGID
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${HEID_LEGACY_PROGID}"
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".${EXT}" ""
  WriteRegStr SHCTX "${HEID_CAPKEY}\FileAssociations" ".${EXT}" "${PROGID}"
!macroend

; 单个扩展名：清理上述三处（仅删本程序写入的值，保留其他程序注册）
!macro HEID_ASSOC_DEL EXT PROGID
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${HEID_LEGACY_PROGID}"
  DeleteRegValue SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".${EXT}"
  DeleteRegValue SHCTX "${HEID_CAPKEY}\FileAssociations" ".${EXT}"
!macroend

; 单个格式组：把 ProgID 的图标覆写为随包分发的独立 .ico
; （Tauri 模板已写 DefaultIcon 指向 exe，此处在其之后覆盖执行）
!macro HEID_ICON PROGID ICON
  WriteRegStr SHCTX "Software\Classes\${PROGID}\DefaultIcon" "" "$INSTDIR\icons\filetypes\${ICON}.ico"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "注册 H.I.D.E 为可选/默认编辑器..."

  ; ---- 1. 打开方式候选（每个扩展名的 OpenWithProgids）----
  !insertmacro HEID_ASSOC_ADD "txt"     "${HEID_PID_BASE}.txt"
  !insertmacro HEID_ASSOC_ADD "log"     "${HEID_PID_BASE}.log"
  !insertmacro HEID_ASSOC_ADD "md"      "${HEID_PID_BASE}.md"
  !insertmacro HEID_ASSOC_ADD "markdown" "${HEID_PID_BASE}.md"
  !insertmacro HEID_ASSOC_ADD "json"    "${HEID_PID_BASE}.json"
  !insertmacro HEID_ASSOC_ADD "yaml"    "${HEID_PID_BASE}.yaml"
  !insertmacro HEID_ASSOC_ADD "yml"     "${HEID_PID_BASE}.yaml"
  !insertmacro HEID_ASSOC_ADD "toml"    "${HEID_PID_BASE}.toml"
  !insertmacro HEID_ASSOC_ADD "ini"     "${HEID_PID_BASE}.ini"
  !insertmacro HEID_ASSOC_ADD "xml"     "${HEID_PID_BASE}.xml"
  !insertmacro HEID_ASSOC_ADD "svg"     "${HEID_PID_BASE}.svg"
  !insertmacro HEID_ASSOC_ADD "ts"      "${HEID_PID_BASE}.ts"
  !insertmacro HEID_ASSOC_ADD "tsx"     "${HEID_PID_BASE}.ts"
  !insertmacro HEID_ASSOC_ADD "js"      "${HEID_PID_BASE}.js"
  !insertmacro HEID_ASSOC_ADD "jsx"     "${HEID_PID_BASE}.js"
  !insertmacro HEID_ASSOC_ADD "py"      "${HEID_PID_BASE}.py"
  !insertmacro HEID_ASSOC_ADD "rs"      "${HEID_PID_BASE}.rs"
  !insertmacro HEID_ASSOC_ADD "go"      "${HEID_PID_BASE}.go"
  !insertmacro HEID_ASSOC_ADD "java"    "${HEID_PID_BASE}.java"
  !insertmacro HEID_ASSOC_ADD "c"       "${HEID_PID_BASE}.c"
  !insertmacro HEID_ASSOC_ADD "h"       "${HEID_PID_BASE}.c"
  !insertmacro HEID_ASSOC_ADD "cpp"     "${HEID_PID_BASE}.cpp"
  !insertmacro HEID_ASSOC_ADD "cc"      "${HEID_PID_BASE}.cpp"
  !insertmacro HEID_ASSOC_ADD "cxx"     "${HEID_PID_BASE}.cpp"
  !insertmacro HEID_ASSOC_ADD "hpp"     "${HEID_PID_BASE}.cpp"
  !insertmacro HEID_ASSOC_ADD "cs"      "${HEID_PID_BASE}.cs"
  !insertmacro HEID_ASSOC_ADD "rb"      "${HEID_PID_BASE}.rb"
  !insertmacro HEID_ASSOC_ADD "php"     "${HEID_PID_BASE}.php"
  !insertmacro HEID_ASSOC_ADD "html"    "${HEID_PID_BASE}.html"
  !insertmacro HEID_ASSOC_ADD "htm"     "${HEID_PID_BASE}.html"
  !insertmacro HEID_ASSOC_ADD "css"     "${HEID_PID_BASE}.css"
  !insertmacro HEID_ASSOC_ADD "scss"    "${HEID_PID_BASE}.scss"
  !insertmacro HEID_ASSOC_ADD "less"    "${HEID_PID_BASE}.less"
  !insertmacro HEID_ASSOC_ADD "sh"      "${HEID_PID_BASE}.sh"
  !insertmacro HEID_ASSOC_ADD "bash"    "${HEID_PID_BASE}.sh"
  !insertmacro HEID_ASSOC_ADD "sql"     "${HEID_PID_BASE}.sql"
  !insertmacro HEID_ASSOC_ADD "swift"   "${HEID_PID_BASE}.swift"
  !insertmacro HEID_ASSOC_ADD "kt"      "${HEID_PID_BASE}.kt"
  !insertmacro HEID_ASSOC_ADD "kts"     "${HEID_PID_BASE}.kt"
  !insertmacro HEID_ASSOC_ADD "scala"   "${HEID_PID_BASE}.scala"
  !insertmacro HEID_ASSOC_ADD "vue"     "${HEID_PID_BASE}.vue"
  !insertmacro HEID_ASSOC_ADD "svelte"  "${HEID_PID_BASE}.svelte"
  !insertmacro HEID_ASSOC_ADD "csv"     "${HEID_PID_BASE}.csv"

  ; ---- 2. 每个格式组的独立图标（覆盖 Tauri 模板写入的 exe 图标）----
  !insertmacro HEID_ICON "${HEID_PID_BASE}.txt"    "txt"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.log"    "log"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.md"     "md"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.json"   "json"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.yaml"   "yaml"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.toml"   "toml"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.ini"    "ini"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.xml"    "xml"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.svg"    "svg"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.ts"     "ts"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.js"     "js"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.py"     "py"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.rs"     "rs"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.go"     "go"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.java"   "java"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.c"      "c"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.cpp"    "cpp"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.cs"     "cs"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.rb"     "rb"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.php"    "php"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.html"   "html"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.css"    "css"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.scss"   "scss"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.less"   "less"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.sh"     "sh"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.sql"    "sql"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.swift"  "swift"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.kt"     "kt"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.scala"  "scala"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.vue"    "vue"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.svelte" "svelte"
  !insertmacro HEID_ICON "${HEID_PID_BASE}.csv"    "csv"

  ; ---- 3. 按可执行文件注册：让系统把 H.I.D.E 视为可选编辑器 ----
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${HEID_APPNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open" "" "Open with ${HEID_APPNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  ; ---- 4. App Paths：支持按 exe 名启动与定位 ----
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\${MAINBINARYNAME}.exe" "Path" "$INSTDIR"

  ; ---- 5. 注册应用能力：出现在「设置 → 默认应用」并可按类型设为默认 ----
  WriteRegStr SHCTX "Software\RegisteredApplications" "${HEID_APPNAME}" "${HEID_CAPKEY}"
  WriteRegStr SHCTX "${HEID_CAPKEY}" "ApplicationName" "${HEID_APPNAME}"
  WriteRegStr SHCTX "${HEID_CAPKEY}" "ApplicationDescription" "秒开的轻量代码 / 文档编辑器"
  WriteRegStr SHCTX "${HEID_CAPKEY}" "ApplicationIcon" "$INSTDIR\${MAINBINARYNAME}.exe,0"

  ; ---- 6. 资源管理器右键「用 H.I.D.E 打开」（所有文件类型）----
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
  !insertmacro HEID_ASSOC_DEL "txt"     "${HEID_PID_BASE}.txt"
  !insertmacro HEID_ASSOC_DEL "log"     "${HEID_PID_BASE}.log"
  !insertmacro HEID_ASSOC_DEL "md"      "${HEID_PID_BASE}.md"
  !insertmacro HEID_ASSOC_DEL "markdown" "${HEID_PID_BASE}.md"
  !insertmacro HEID_ASSOC_DEL "json"    "${HEID_PID_BASE}.json"
  !insertmacro HEID_ASSOC_DEL "yaml"    "${HEID_PID_BASE}.yaml"
  !insertmacro HEID_ASSOC_DEL "yml"     "${HEID_PID_BASE}.yaml"
  !insertmacro HEID_ASSOC_DEL "toml"    "${HEID_PID_BASE}.toml"
  !insertmacro HEID_ASSOC_DEL "ini"     "${HEID_PID_BASE}.ini"
  !insertmacro HEID_ASSOC_DEL "xml"     "${HEID_PID_BASE}.xml"
  !insertmacro HEID_ASSOC_DEL "svg"     "${HEID_PID_BASE}.svg"
  !insertmacro HEID_ASSOC_DEL "ts"      "${HEID_PID_BASE}.ts"
  !insertmacro HEID_ASSOC_DEL "tsx"     "${HEID_PID_BASE}.ts"
  !insertmacro HEID_ASSOC_DEL "js"      "${HEID_PID_BASE}.js"
  !insertmacro HEID_ASSOC_DEL "jsx"     "${HEID_PID_BASE}.js"
  !insertmacro HEID_ASSOC_DEL "py"      "${HEID_PID_BASE}.py"
  !insertmacro HEID_ASSOC_DEL "rs"      "${HEID_PID_BASE}.rs"
  !insertmacro HEID_ASSOC_DEL "go"      "${HEID_PID_BASE}.go"
  !insertmacro HEID_ASSOC_DEL "java"    "${HEID_PID_BASE}.java"
  !insertmacro HEID_ASSOC_DEL "c"       "${HEID_PID_BASE}.c"
  !insertmacro HEID_ASSOC_DEL "h"       "${HEID_PID_BASE}.c"
  !insertmacro HEID_ASSOC_DEL "cpp"     "${HEID_PID_BASE}.cpp"
  !insertmacro HEID_ASSOC_DEL "cc"      "${HEID_PID_BASE}.cpp"
  !insertmacro HEID_ASSOC_DEL "cxx"     "${HEID_PID_BASE}.cpp"
  !insertmacro HEID_ASSOC_DEL "hpp"     "${HEID_PID_BASE}.cpp"
  !insertmacro HEID_ASSOC_DEL "cs"      "${HEID_PID_BASE}.cs"
  !insertmacro HEID_ASSOC_DEL "rb"      "${HEID_PID_BASE}.rb"
  !insertmacro HEID_ASSOC_DEL "php"     "${HEID_PID_BASE}.php"
  !insertmacro HEID_ASSOC_DEL "html"    "${HEID_PID_BASE}.html"
  !insertmacro HEID_ASSOC_DEL "htm"     "${HEID_PID_BASE}.html"
  !insertmacro HEID_ASSOC_DEL "css"     "${HEID_PID_BASE}.css"
  !insertmacro HEID_ASSOC_DEL "scss"    "${HEID_PID_BASE}.scss"
  !insertmacro HEID_ASSOC_DEL "less"    "${HEID_PID_BASE}.less"
  !insertmacro HEID_ASSOC_DEL "sh"      "${HEID_PID_BASE}.sh"
  !insertmacro HEID_ASSOC_DEL "bash"    "${HEID_PID_BASE}.sh"
  !insertmacro HEID_ASSOC_DEL "sql"     "${HEID_PID_BASE}.sql"
  !insertmacro HEID_ASSOC_DEL "swift"   "${HEID_PID_BASE}.swift"
  !insertmacro HEID_ASSOC_DEL "kt"      "${HEID_PID_BASE}.kt"
  !insertmacro HEID_ASSOC_DEL "kts"     "${HEID_PID_BASE}.kt"
  !insertmacro HEID_ASSOC_DEL "scala"   "${HEID_PID_BASE}.scala"
  !insertmacro HEID_ASSOC_DEL "vue"     "${HEID_PID_BASE}.vue"
  !insertmacro HEID_ASSOC_DEL "svelte"  "${HEID_PID_BASE}.svelte"
  !insertmacro HEID_ASSOC_DEL "csv"     "${HEID_PID_BASE}.csv"

  ; 1.5.x 遗留的单一 ProgID 键：卸载时一并删除
  DeleteRegKey SHCTX "Software\Classes\${HEID_LEGACY_PROGID}"

  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\${MAINBINARYNAME}.exe"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "${HEID_APPNAME}"
  DeleteRegKey SHCTX "${HEID_CAPKEY}"
  ; 仅在空目录时移除，避免误删其他/未来数据
  DeleteRegKey /ifempty SHCTX "Software\H.I.D.E"
  DeleteRegKey SHCTX "Software\Classes\*\shell\${HEID_VERB}"

  !insertmacro UPDATEFILEASSOC
!macroend
