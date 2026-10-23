# Changelog

## Unreleased

### Fixed

- **Linux 下面包屑与「跳转」输入框把 `/` 拼成了 `\`。** 旧代码在拼子路径时无条件使用
  `\`，Linux 上会得到 `/root\.local` 这类并不存在的路径，点击面包屑中间层级报
  「打开目录失败：路径不存在」。现在按平台选择分隔符（POSIX `/`，Windows 盘符与 UNC
  路径 `\`），并抽出 `joinPath()` 复用；Windows 盘符 / UNC 的面包屑目标也一并修正。
- 新增 `test/page-crumbs.mjs`：覆盖 POSIX、Windows 盘符、UNC 三类路径的面包屑点击目标与
  `joinPath()` 拼接结果。

## 0.2.0 — 2026-10-21

### Added

- **聊天里带 `..` 的文件链接现在能点了。** 点击消息里的相对路径链接时，前端会把它拼成
  `dsh-resource://file/session/<session>/<原样相对路径>`；右侧栏用 glob
  `dsh-resource://file/**` 判断谁来打开这个地址，而 picomatch 的 `**` 不匹配 `..` 段，
  于是没有任何标签类型认领 → `sidebarRight: no registered tab type claims "..."`。
  本版本在 client 半边包住 `sidebarRight.openResource` / `openResourceIn`，开之前先归一化：
  仍在工作区内就变成工作区相对路径（链接直接打开目标文件），走出工作区就变成绝对路径
  （依旧可被认领，预览会正常提示读不到，而不是让标签注册表抛错）。
  插件停用/重载时通过 `ctx.effect` 自动还原原方法。

### Changed

- `test/client-smoke.mjs` 从 15 项扩到 31 项：新增 `..` 归一化、越界转绝对、query 后缀保留、
  `absolute/` scope 折叠、外部地址不动、包装后调用参数、options 透传、dispose 还原等。

## 0.1.0 — 2026-10-20

首个版本：整盘浏览、下载（Range）、目录/多选流式 ZIP、拖拽上传、复制/移动、文本在线编辑
（mtime+size 冲突检测 + 原子写）、新建/重命名/删除（默认进回收目录）、docx 客户端快预览 +
LibreOffice 精排、xlsx 交互表格与「编辑单元格 → 另存为副本」。
