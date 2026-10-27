# dsh-local-files

给 DeepSeek Harness Web 补上「本机文件管理」的本地小插件。零第三方依赖，只用 `ctx.webServer` 注册同源路由（同一个 3080 端口，复用 `dsh-access-gate` 的密码门），不引入新端口、不新起服务。

## 它解决什么

DSH 自带右侧预览能看文本/代码/图片/PDF/docx/xlsx，但：

1. 全产品没有「下载到本机」的动作（`/api/file` 只有内联，且有字节上限）；
2. 文件树与预览只认会话工作区（`workspaceFiles.list` 限定 workspace root）；
3. zip 这类二进制容器没有渲染器，只显示「不支持预览」，也没有出口；
4. 没有任何上传 / 复制粘贴 / 打包下载的入口。

本插件补上这些洞。

## 功能

**整盘浏览**：默认首页取配置里的 `home`（未配置时落到第一个盘符），顶部「🏠 首页」+ 盘符按钮 + 面包屑 + 绝对路径跳转。

**预览**（右侧面板）：

| 类型 | 行为 |
|---|---|
| 图片（png/jpg/gif/webp/bmp/ico/avif/svg） | 内联显示 |
| PDF | 浏览器内嵌 PDF 阅读器 |
| 视频 / 音频 | `<video>` / `<audio>` 播放器，支持 Range 拖动 |
| 文本 / 代码 | 等宽预览（默认 512 KiB 上限，超出提示截断） |
| Markdown | 客户端安全渲染（标题/列表/代码块/引用/链接，HTML 先转义） |
| JSON | 解析后缩进美化，非法 JSON 回退原文 |
| CSV / TSV | 表格渲染（引号、转义引号、多行字段都支持，最多 300×60） |
| HTML | 默认在 `sandbox=""` 的 iframe 里渲染（**禁用脚本**，CSP 限制外部资源），可切「源码」 |
| docx | **客户端快速预览**：懒加载 mammoth（`lib/vendor`）+ DOMPurify 式白名单清洗后渲染 HTML，秒开；工具条另有「**LibreOffice 精排**」按钮，点击后走 Host `officeToPdf` 转 PDF（带进度/等待秒数提示） |
| xlsx / xls / xlsm / ods | **客户端交互表格**：懒加载 SheetJS，多工作表标签、行列上限保护（见下） |
| doc / ppt / pptx | 直接调用 Host 的 `officeToPdf` 服务转成 PDF 内嵌预览（宿主没挂载该服务时给 501 并提示下载），转换结果按「路径+mtime+大小」缓存 |
| 其它（zip/7z/exe…） | 给「下载到本机」大按钮 |

**下载**：文件行「下载」、目录行「Zip」（打包下载）、工具栏「打包下载」（打包勾选项，或整个当前目录）。ZIP 是 Host 侧流式生成（store 方法 + data descriptor，单次读取、不重压缩），支持中文文件名，大目录不占内存。

**上传**：工具栏「上传」选择文件，或直接把文件**拖进列表**；带进度条，同名自动改名 `name (2).ext`，流式落盘（临时 `.part` → 原子 rename），默认单文件上限 4 GiB。

**复制 / 粘贴**：勾选（或 `Ctrl+A`）→「复制」（`Ctrl+C`）→ 进入目标目录 →「粘贴」（`Ctrl+V`）。目录递归复制，目标同名默认拒绝覆盖，不允许复制到自身子目录。

**在线编辑（文本/代码/Markdown/JSON/CSV…）**：预览工具条「编辑」→ 等宽编辑框 → 「保存」或 `Ctrl+S`。保存走 `POST /api/write`：

- **版本冲突检测**：带上读取时的 `mtimeMs + size`，文件被别人改过就返回 409 并提示重新加载，不覆盖；
- **原子写**：同目录临时文件 + rename，不会写出半个文件；
- 单次保存上限默认 5 MiB（可配 `maxWriteBytes`）。

**新建 / 重命名 / 删除**：工具栏「新建文件」「新建文件夹」「重命名」（选中 1 项时可用）「删除」（选中后可用）。

- 名称只接受单段名（含 `\` `/` 直接拒绝），同名冲突 409；
- **删除默认进回收目录**（默认 `~/.dsh-local-files-trash/<时间戳>/`，可配 `trashDir`），确认框里点「取消」后才会再问一次「彻底删除」；根目录本身拒绝删除。

**xlsx 单元格编辑（另存为副本）**：表格工具条「编辑单元格」→ 点格子改值（Enter 提交 / Esc 取消）→「另存为副本」→ 弹出文件名 → 生成**新的 xlsx**（原文件不动）。

- 公式、数字格式、合并单元格、列宽会保留；**图表、透视表、条件格式、VBA 宏会丢失**，界面里也有这句提示；
- 因为不会覆盖原文件，风险可控；需要改原文件就下载后本地处理。

**docx 不支持编辑**：LibreOffice 只做单向转换，客户端改文本必丢版式，所以只提供「快速预览 / 精排 / 下载」。

**点什么都打得开（0.2.0 起，0.3.0 补齐）**：聊天里的文件链接在交给右侧栏之前先过一遍
`planFileOpen(address, cwd)`——工作区内的文件 → 归一化地址交给文档标签渲染（`..`、`.`、反斜杠
`\` 都会被消掉）；**工作区外 / 绝对路径 / 目录**（渲染器会吞掉尾斜杠，所以「最后一段没有扩展名」
也算目录）→ 新标签打开本地文件管理页 `/-/files?path=…`，它本来就能读任何位置。补丁通过
`ctx.effect` 挂在插件作用域上，插件停用时自动还原。运行中的页面可以用
`window.__dshLocalFiles` 查看当前状态（`patchedCount` / `lastPlan`）。

**Office 预览不再卡在超时（0.3.0）**：转换超时会自动重试一次（面板显示「自动重试（第 2/2 次）」），
仍失败且是 docx 时直接回落到客户端 mammoth 渲染并在工具条注明原因；非 docx 给带「重试 / 下载到本机」
的失败页。Host 侧把转换器的错误原样透出（超时 504、其它 502），不再统一成 `内部错误`。

**修好了「带 `..` 的聊天文件链接」（0.2.0）**：点击消息里的相对路径链接时，前端会把它拼成
`dsh-resource://file/session/<session>/<原样相对路径>`，而右侧栏用 glob `dsh-resource://file/**`
判断谁来打开——picomatch 的 `**` 不匹配 `..` 段，于是没人认领、报
`sidebarRight: no registered tab type claims "…"`。本插件在 client 半边包住
`sidebarRight.openResource` / `openResourceIn`，打开前先归一化路径：仍在会话工作区内 → 工作区
相对路径（链接直接跳到目标文件）；走出工作区 → 绝对路径（仍可被认领，预览会正常提示读不到，
而不是让标签注册表抛错）。插件停用/热重载时经 `ctx.effect` 自动还原，不残留副作用。
详见 [CHANGELOG.md](CHANGELOG.md)。

## 浏览器端渲染器（懒加载，本地托管）

| 文件 | 版本 | 体积 | 许可 | 用途 |
|---|---|---|---|---|
| `lib/vendor/mammoth.browser.min.js` | 1.13.0 | 405 KB | BSD-2-Clause | docx → HTML |
| `lib/vendor/xlsx.full.min.js` | 0.20.3（SheetJS CE 官方 CDN） | 952 KB | Apache-2.0 | xlsx/xls/xlsm/ods → 表格 |

- 只有打开对应类型时才 `fetch` 一次（走 `/-/files/vendor/*`，同源、`immutable` 缓存、gzip），不拖慢首屏；
- **兼容性保护**：文件超过内联预览上限（默认 64 MiB）不走客户端解析，直接提示下载；xlsx 渲染上限 **2000 行 × 120 列 / 12 万单元格 / 50 个工作表**，超出截断并在页脚注明；密码保护或损坏的工作簿解析失败会给出提示并保留下载入口；`.xls`（BIFF）、`.xlsm`、`.ods` 由完整版 SheetJS 支持；`.doc`（二进制 Word）不支持客户端解析，自动走 PDF 精排；
- 为什么不取 npm 的 `xlsx@0.18.5`：该版本有已知安全公告，0.20.3 只在 SheetJS 官方 CDN 分发，已下载后本地托管（运行时不访问外网），许可与来源见 `lib/vendor/NOTICE.md`。
- docx 快速预览的 HTML 会先做白名单清洗：删掉 `script/style/iframe/object/embed/link/meta/base/form`、所有 `on*` 事件属性，`href/src` 只允许 `http(s)/mailto/data:image/#`，链接强制 `target=_blank rel=noreferrer`。

## 路由表

Host 半边（`lib/index.js`，路由随插件 fiber 释放）：

| 路由 | 说明 |
|---|---|
| `GET /-/files` | 文件管理页面（`lib/page.html`） |
| `GET /-/files/api/roots` | 允许的根目录 + 配置的首页 |
| `GET /-/files/api/list?path=` | 单层目录列表 |
| `GET /-/files/api/text?path=` | 文本预览（UTF-8，二进制探测，截断时裁掉半个字符） |
| `GET /-/files/api/raw?path=` | 内联字节（图片/PDF/视频），支持 `Range` |
| `GET /-/files/api/download?path=` | 附件下载，支持 `Range` 断点续传 |
| `GET /-/files/api/zip?path=…` | ZIP 流（可重复 `path` 参数打包多项） |
| `GET /-/files/api/office?path=` | Office → PDF（走 Host `officeToPdf`） |
| `POST /-/files/api/upload?path=<dir>` | 原始字节流上传（文件名走 `x-file-name` 头，URL 编码） |
| `POST /-/files/api/copy` | `{sources:[], target, move?, overwrite?}` 复制/移动 |
| `POST /-/files/api/write` | `{path, text, expected?:{mtimeMs,size}}` 原子保存，版本冲突 409 |
| `POST /-/files/api/create` | `{dir, name, kind:'file'\|'dir', text?}` 新建 |
| `POST /-/files/api/rename` | `{path, name}` 同目录改名，同名 409 |
| `POST /-/files/api/delete` | `{paths:[], permanent?}` 默认移入回收目录 |
| `GET /-/files/vendor/<name>` | 内置浏览器库（mammoth / SheetJS），同源、只认白名单文件名、`immutable` 缓存 |

Client 半边（`lib/client.js`）：

- 右侧文档预览头部：加「下载」按钮（`sidebar.right.tab.document.actions`）；
- 不支持预览的空态：加「下载到本机 / 文件管理器」两个入口（`sidebar.right.tab.document.unpreviewable`）；
- 工作区文件树头部：加「文件管理器」入口，直接打开 `/-/files?path=<当前目录>`（`sidebar.right.tab.files.actions`）。

## 安全

- **只认回环 Host**：`dsh-access-gate` 在密码认证通过后会把请求头 `Host` 改写为 `127.0.0.1`，因此已认证的远程请求可用；门禁缺失/未认证的裸远程请求一律 403。这与 DSH 官方 `/api` 的信任模型一致。
- **根目录白名单**：所有路径先 `realpath` 解析（跟随符号链接），再校验必须落在允许的根内，`..` 穿越无效；上传/新建/改名的名字只取单段。
- **写操作**：上传、复制/移动、在线保存、新建、重命名、删除。保存有 mtime+size 冲突检测与原子写；删除默认进回收目录、根目录拒删；同名覆盖默认拒绝。
- 内联预览有字节上限（默认 64 MiB），下载/ZIP 流式无缓存、不做 gzip 转码。

## 配置（`cordis.patch.yml` 里可改）

```yaml
- id: local-files
  config:
    home: 'D:\workspace'      # 打开时的默认目录（留空 = 第一个盘符）
    roots: []                 # 留空 = 自动枚举所有盘符；也可写 ['C:\\', 'D:\\data']
    maxTextBytes: 524288      # 文本预览上限（512 KiB）
    maxPreviewBytes: 67108864 # 内联预览上限（64 MiB）
    maxUploadBytes: 4294967296 # 单文件上传上限（4 GiB）
    maxCopyEntries: 20000     # 一次复制/移动的条目上限
    maxWriteBytes: 5242880    # 在线保存内容上限（5 MiB）
    trashDir: 'C:\Users\<you>\.dsh-local-files-trash'  # 删除回收目录（默认 ~/.dsh-local-files-trash）
```

## 测试

```powershell
cd github\dsh-local-files
node test\smoke.mjs         # Host 路由：56 项（读/写/上传/复制/移动/ZIP/Office 回退/vendor/边界）
node test\client-smoke.mjs  # Client 半边：45 项（slot 渲染 + 文件链接的归一化与落点决策）
```

## 安装 / 卸载

```powershell
# 从 npm 安装（最快，发布产物已预置：dsh-local-files@0.1.0）
dsh plugin --profile web add dsh-local-files

# 从 GitHub 安装（DSH ≥ 0.2.0-rc.2）
dsh plugin --profile web add github:DeveloperYe/dsh-local-files

# 从本地目录安装（开发用：page.html 按 mtime 热读取、Client 改动刷新即可；host/index.js 改动需重载插件/重启 DSH）
dsh plugin --profile web add link:C:/path/to/dsh-local-files

# 卸载
dsh plugin --profile web remove dsh-local-files
```

npm 包：[`dsh-local-files`](https://www.npmjs.com/package/dsh-local-files)（git 安装与 npm 安装内容一致：12 个文件 / 475 KB，含 `cordis.patch.yml` 与 vendored 渲染器）。

安装后打开 `http://<你的入口>/-/files`（`dsh-access-gate` 密码门内），或从右侧预览/文件树的按钮进入。

> 安全提醒：本插件按**回环 Host 已认证**的模型放行（`dsh-access-gate` 在密码校验通过后会把 Host 改写成 `127.0.0.1`），因此部署时请务必同时启用访问密码；没有门禁时它是只读+写全开的，等于把整台机器的文件暴露给能访问端口的人。

## 许可

- 本仓库代码：MIT，见 [LICENSE](LICENSE)
- 内置浏览器构建（mammoth / SheetJS）的许可与来源：见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 与 [`lib/vendor/NOTICE.md`](lib/vendor/NOTICE.md)
