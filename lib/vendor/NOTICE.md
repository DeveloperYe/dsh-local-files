# Vendored browser libraries

本目录的两个文件是从上游分发的**原始浏览器构建**（未修改），由本插件在需要时
懒加载，不打包进页面本体、不参与构建。

| 文件 | 上游 | 版本 | 许可 | 用途 |
|---|---|---|---|---|
| `mammoth.browser.min.js` | https://www.npmjs.com/package/mammoth | 1.13.0 | BSD-2-Clause（见 `MAMMOTH-LICENSE.txt`） | 把 `.docx` 转成 HTML，做「快速预览」 |
| `xlsx.full.min.js` | https://cdn.sheetjs.com/ （SheetJS CE） | 0.20.3 | Apache-2.0（`(C) 2013-present SheetJS -- http://sheetjs.com`，构建头部保留） | 把 `.xlsx` / `.xls` / `.xlsm` 解析成表格 |

## 为什么用 0.20.3 而不是 npm 上的 0.18.5

npm registry 上的 `xlsx` 停在 0.18.5，其中存在已知安全公告（如原型污染 /
ReDoS 类问题在 0.19.x 起修复）。0.20.3 只从 SheetJS 官方 CDN 分发，所以这里
直接从 `https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js`
下载并本地托管（不依赖运行时外网，也不给页面开外部请求）。

## 加载策略

- 只有真正打开对应类型文件时才 `fetch` 一次，浏览器按 `immutable` 缓存；
- 超过 `maxPreviewBytes`（默认 64 MiB）的文件不会走客户端解析，直接给下载；
- xlsx 解析前还有单元格/行列上限，避免超大工作簿把页面卡死。
