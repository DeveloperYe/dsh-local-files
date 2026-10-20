# Third-party notices

本仓库自身的代码（`lib/index.js`、`lib/page.html`、`lib/client.js`）以 MIT
许可发布，见 [LICENSE](LICENSE)。

`lib/vendor/` 下是原样分发的第三方浏览器构建，未做修改：

| 文件 | 上游 | 版本 | 许可 | 用途 |
|---|---|---|---|---|
| `mammoth.browser.min.js` | https://www.npmjs.com/package/mammoth | 1.13.0 | BSD-2-Clause | `.docx` → HTML |
| `xlsx.full.min.js` | https://cdn.sheetjs.com/ （SheetJS Community Edition） | 0.20.3 | Apache-2.0 | `.xlsx` / `.xls` / `.xlsm` / `.ods` 解析与写出 |

- mammoth 的完整许可原文见 [`lib/vendor/MAMMOTH-LICENSE.txt`](lib/vendor/MAMMOTH-LICENSE.txt)。
- SheetJS 的构建产物头部保留其版权声明（`xlsx.js (C) 2013-present SheetJS`），
  Apache-2.0 许可原文见 <https://www.apache.org/licenses/LICENSE-2.0>。
- SheetJS 未从 npm registry 获取：那里的 `xlsx` 停在 0.18.5 且含已知安全公告，
  0.20.3 仅在官方 CDN 分发；本仓库直接托管该构建产物，运行时不会请求外网。
