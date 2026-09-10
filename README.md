# H.E.I.D

**H.E.I.D**（Highlighting Intelligent Document Editor）—— 从 `nexus-ai-assistant`（已废弃项目）中提取出来的独立代码编辑器，基于 CodeMirror 6 + React + Vite + Tailwind CSS，通过 Tauri 2 打包为 Windows 桌面应用。

## 功能特性

- **桌面应用**：Tauri 2 打包，无边框窗口 + 自定义标题栏控制按钮（最小化 / 最大化 / 关闭），支持拖拽移动、双击最大化，关闭前确认未保存内容，安装包约 2.4 MB
- **本地文件读写**：原生打开/保存对话框，任意路径直接保存；把文件拖进窗口即可打开
- **VS Code 风格主题**：深色 / 浅色 / 跟随系统三种模式（默认跟随系统，自动记忆偏好）
- **多语言语法高亮**：TypeScript / JavaScript / JSX / TSX / Python / Rust / Go / Java / C / C++ / C# / Ruby / PHP / Swift / Kotlin / HTML / CSS / JSON / YAML / XML / Markdown / SQL / Shell 等
- **迷你地图（Minimap）**：Canvas 绘制、带语法着色的代码缩略图，支持点击/拖拽快速导航
- **粘性滚动（Sticky Scroll）**：滚动时顶部固定显示当前作用域链（函数/类/接口定义），点击可跳转
- **行号拖选**：点击行号选中单行，按住拖动批量选中多行
- **代码折叠**：折叠/展开代码块
- **括号匹配 / 自动闭合**、**选中高亮匹配**、**自动补全**
- **多标签页**：同时打开多个文件，脏状态标记，关闭前确认
- **快捷键**：`Ctrl+S` 保存、`Ctrl+O` 打开、`Ctrl+N` 新建

> 纯浏览器模式（`npm run dev`）下文件读写自动降级为浏览器 File System Access API / 下载。

## 构建桌面应用

```bash
npm install                 # 安装前端与 Tauri CLI 依赖
npm run tauri:build         # 编译 Rust 并打包（首次约 4-10 分钟）
```

产物位置：

- **独立可执行文件**：`src-tauri/target/release/nexus-editor.exe`（需系统已有 WebView2，Win10/11 默认自带）
- **安装程序**：`src-tauri/target/release/bundle/nsis/H.E.I.D_1.0.0_x64-setup.exe`

## 开发调试

```bash
npm run dev          # 仅前端（浏览器访问 http://localhost:5188）
npm run tauri:dev    # 桌面窗口 + 热更新
```

## 项目结构

```
├── src/                      # 前端（React + Vite + Tailwind v4）
│   ├── main.tsx              # 入口
│   ├── App.tsx               # 主界面：标签页 / 工具栏 / 状态栏 / 文件读写适配
│   ├── index.css             # 全局样式
│   ├── components/
│   │   ├── CodeEditor.tsx    # 核心编辑器（迷你地图 / 粘性滚动 / 行号拖选）
│   │   └── WindowControls.tsx # 自定义窗口控制按钮（最小化 / 最大化 / 关闭）
│   └── lib/
│       ├── codemirror.ts     # VS Code 主题 + 语法高亮 + 语言扩展 + 语言探测
│       └── utils.ts          # cn() 类名工具
└── src-tauri/                # Tauri 桌面壳（Rust）
    ├── tauri.conf.json       # 窗口（无边框）/ 打包配置
    ├── capabilities/         # fs 读写、对话框与窗口控制权限
    ├── icons/                # 应用图标
    └── src/                  # main.rs / lib.rs（注册 fs + dialog 插件）
```
