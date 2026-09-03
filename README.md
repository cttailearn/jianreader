# 简阅 📝

一款安装到 **Windows** 的轻量文本编辑器，主打「打开快、目录实时同步、Markdown 所见即所得、小说阅读、双主题」。

比记事本强，比 VS Code 轻 —— 面向开发者 / 写作者日常浏览代码、编辑 Markdown、阅读与修改 txt 小说的中间态工具。

> 技术方案设计文档见 [design.md](design.md)

---

## ✨ 功能特性

### 📁 文件浏览
- 目录树浏览（万级文件虚拟滚动，懒加载子树）
- 目录实时双向同步：外部修改 → 软件自动更新；软件保存 → 外部立刻可见（notify 监听 + 回环抑制）
- 编码自动检测（UTF-8 / UTF-8 BOM / GBK / Big5 / UTF-16 等）+ **原编码写回**（GBK 存回 GBK）
- 默认隐藏噪音目录（.git / node_modules / dist），可在设置中显示
- 右键菜单：打开 / 以阅读模式打开 / 复制路径 / 新建文件 / 新建文件夹 / 重命名 / 删除 / 在资源管理器中显示
- **拖拽文件夹或文件到窗口直接打开**（已有目录时新开窗口加载，不关闭旧工作区）

### ⌨️ 多标签编辑
- CodeMirror 6 内核，30+ 语言语法高亮（按需加载，>3MB 大文件自动免高亮快速打开）
- 多标签：关闭确认（保存/不保存/取消）、未保存圆点、Ctrl+Tab 切换
- 换行符保留（CRLF/LF 原样写回）、磁盘只读属性保护
- 会话恢复：重启回到上次目录 / 标签 / 窗口位置（多显示器校验）

### 📖 Markdown 所见即所得（Milkdown Crepe）
- 单界面编辑即预览：标题 / 表格 / 任务列表 / 代码块（高亮）/ 图片 / 公式 (KaTeX) / Mermaid
- 本地相对路径图片直接渲染（asset 协议）
- 右侧大纲：实时生成、点击跳转、滚动跟随高亮
- 表格智能修复：无表头分隔行 / `\|` 转义表格自动规范化渲染
- 正文可选中复制，粘贴 Markdown 自动转富文本

### 📚 小说模式
- 打开 txt 自动扫描章节（≥3 章进入），智能识别：`第一章` / `第12章` / `（一）` / `上卷` / `一、` / `3102 标题` / `Chapter One` 等
- **阅读设置可自定义章节正则**与文件编码（乱码时切换即时重载）
- 米黄护眼阅读背景（与主题解耦）+ 字号 / 行距 / 字间距 / 段间距 / 正文宽度调节（每本书独立记忆）
- 几十 MB 大 txt 分页懒加载，50MB 章节扫描 <30ms
- 章内直接编辑 + 按章节偏移回写保存
- 章内查找替换（可展开全书）+ 书签续读（上次章节 + 滚动位置）
- 无章节标题的 txt 也可整本单章阅读

### 🖼️ 图片查看
- png / jpg / gif / webp / svg / bmp / ico 等直接以图片查看器打开
- 滚轮缩放、拖拽平移、双击适应、Ctrl+=/-/0 缩放

### 🎨 界面
- macOS 风格：无边框窗口 + 交通灯（红黄绿）+ 毛玻璃（顶栏/状态栏/菜单/对话框）+ 圆角
- 浅色 / 暗色双主题三联动（应用 UI + 编辑器 + Markdown）
- 左右栏宽度可拖动调整（记忆）
- 顶栏显式窗口控制按钮（最小化 / 最大化 / 关闭）

### ⚙️ 设置与快捷键
- 设置面板：主题 / 自动保存（2s 防抖）/ 显示隐藏文件 / 大文件语法高亮
- **快捷键全部可自定义**：保存 / 打开目录 / 关闭标签 / 切换主题 / 下一个标签 / 阅读查找（点击录制 + 冲突检测）

### 🔄 软件更新
- **启动自动检查 + 设置面板手动检查**：通过 **GitHub Releases API**（`releases/latest`）检测新版本（可关闭自动检查）
- 发现新版本 → 右下角横幅/设置面板提示「前往下载」，点击用系统默认浏览器打开 **GitHub Release 页**手动下载安装
- **数字签名验签（R-06）**：发布时把 `sig: <base64>` 写入 Release 备注；应用先用内置公钥验签（版本 + 安装包 SHA-256），通过后才信任该版本信息并提示更新。**无需 latest.json**
- 实现在 `src/utils/updater.ts`（API 获取/验签）+ `src/utils/updateVerify.ts`（WebCrypto 验签）+ `src-tauri/src/updater.rs`（`download_text` 无 CORS 拉取 API），零新增依赖

---

## 🚀 安装使用

| 方式 | 说明 |
| --- | --- |
| **安装包** | 运行 `简阅_0.1.0_x64-setup.exe`（NSIS 安装向导，简体中文） |
| **绿色版** | 解压 `简阅-绿色版-*.zip` 直接双击 `简阅.exe`，可拷入 U 盘随身携带 |

**运行环境**：Windows 10 1809+ / Windows 11，需 Microsoft Edge WebView2 Runtime（Win10/11 一般已自带）。

> 绿色版遇到启动异常时：删除 `%LOCALAPPDATA%\com.jianreader.app\EBWebView` 后重试；仍有问题请把 `%LOCALAPPDATA%\com.jianreader.app\jianyue-crash.log` 反馈给开发者。

---

## 🔧 开发构建

```bash
# 依赖
npm install

# 前端开发（vite dev server）
npm run dev

# 桌面开发（tauri dev）
npm run tauri dev

# 前端构建
npm run build

# 打包安装包 + 绿色版
npm run tauri build
powershell -ExecutionPolicy Bypass -File scripts/package-portable.ps1
```

### 发布新版本（更新检查的物料）

> 更新来源是 **GitHub Releases API**（无需上传 latest.json）；发布后由 `release.ps1`/`scripts/sign-release.mjs` 把数字签名写入该 Release 的备注。

```bash
# 1) 同步 bump 版本：package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json 三处 version
#    （release.ps1 会自动校验三处一致）

# 2) 构建安装包（产物：src-tauri/target/release/bundle/nsis/jianreader-setup_<v>_x64-setup.exe）
npm run tauri build

# 3) 生成绿色版便携 zip + 签名密钥就绪（release/update-key.json，gitignore）
powershell -ExecutionPolicy Bypass -File scripts/release.ps1 -Notes "更新说明"

# 4) 发布：脚本创建 Release（exe + 绿色版），签名写入备注（需已登录 gh）
powershell -ExecutionPolicy Bypass -File scripts/release.ps1 -Publish -Notes "..."
#    网页方式：github.com/cttailearn/jianreader/releases/new
#    Tag = vX.Y.Z，上传两个资产：jianreader-setup_<v>_x64-setup.exe、jianreader-portable_<v>_x64.zip
#    发布后：gh api repos/cttailearn/jianreader/releases/tags/vX.Y.Z > info.json
#            node scripts/sign-release.mjs --json info.json --notes "..." --out notes.txt
#            gh release edit vX.Y.Z --notes (Get-Content notes.txt -Raw -Encoding UTF8)
```

### 🔐 更新签名（R-06，ECDSA P-256）

应用对「版本号 + 安装包 SHA-256」做**数字签名验签**，杜绝「同一 GitHub 源被整体替换/仓库账号被接管」的伪造面：

- **机制**：发布时用私钥对 `version\nsha256` 签名（P1363 r||s，base64），把 `sig: <base64>` 追加到 Release 备注；客户端从 `releases/latest` API 读取 `tag_name`、安装包资产 `digest`、备注里的 `sig`，用内置公钥验签通过后才信任该版本信息并提示更新。**安装由用户点击「前往下载」打开 GitHub Release 页手动完成**（不做应用内下载/静默安装）。
- **密钥**：私钥 `release/update-key.json`（gitignore，**务必备份并随机器迁移**）；公钥固化在 `src/utils/updateVerify.ts` 的 `UPGRADE_PUBLIC_JWK`。
- **自动**：`release.ps1 -Publish` 创建 Release 后用 `scripts/sign-release.mjs` 自动签名并写入备注；脚本会校验「所用公钥与内置公钥一致」，不一致会告警（客户端将拒绝更新）。
- **⚠️ 不要删除/重新生成密钥**：否则旧客户端将无法验签新版本。若确需换钥：生成 → 把新公钥粘贴到 `UPGRADE_PUBLIC_JWK` → 发一版带新公钥的 App → 后续才可用新钥发布。
- 手动命令：`node scripts/update-key.mjs`（生成/打印公钥）、`node scripts/sign-release.mjs --json <release.json> --notes "..." --out notes.txt`（单独签名）、`node scripts/verify-manifest.mjs -f <清单>`（验签自检）。

### 技术栈

| 层 | 技术 |
| --- | --- |
| 壳 | Tauri 2.x（Rust），单 exe 静态链接 WebView2Loader |
| 前端 | Vite + React 18 + TypeScript + Zustand |
| 代码编辑 | CodeMirror 6（语言包按需加载） |
| Markdown | Milkdown Crepe（ProseMirror 系，GFM + KaTeX + Mermaid） |
| 目录监听 | Rust `notify`（ReadDirectoryChangesW），300ms 合并 + 回环抑制 |
| 编码 | `chardetng` + `encoding_rs`（GBK/Big5/UTF-16 检测与回写） |

### 项目结构

```
├── src/                  # 前端
│   ├── components/       # 顶栏/目录树/标签页/状态栏/阅读器/图片查看/设置面板...
│   ├── editors/          # CodeMirror / Milkdown 编辑器封装与分发
│   ├── stores/           # zustand：tabs/tree/novel/settings/updater/keymap/theme...
│   ├── styles/           # 语义色 token（双主题）+ 全局样式
│   └── utils/            # 语言映射/章节解析辅助/md 图片与表格规范化/updater 检查与验签
├── src-tauri/            # Rust 壳
│   ├── src/fs.rs         # 读文件(编码检测)/写文件(原编码回写)/目录操作
│   ├── src/novel.rs      # 章节流式扫描/按章懒加载/分页边界对齐
│   ├── src/updater.rs    # 更新：download_text（本机 curl 无 CORS 拉取 Releases API）
│   ├── src/watcher.rs    # notify 目录监听（多根，窗口销毁自清理）
│   └── src/lib.rs        # 命令注册 + WebView2 检测 + panic 诊断
├── scripts/package-portable.ps1  # 绿色版打包脚本
└── scripts/release.ps1           # 发布：构建→绿色版→GitHub Release（签名写备注）
└── test-fixtures/        # UTF-8/GBK 小说测试样本
```

---

## 📜 许可证

[MIT](LICENSE) © 2026 cttailearn
