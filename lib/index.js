/**
 * dsh-local-files — host half.
 *
 * Serves a self-contained local file manager on the DSH web server itself (same
 * origin, same port), so remote browsers reaching the GUI through
 * port-forwarding can browse the whole machine, preview files, download,
 * upload, copy/paste, and pack folders as ZIP.
 *
 * Routes (owned by this plugin, released with its fiber):
 *   GET  /-/files                         page (lib/page.html)
 *   GET  /-/files/api/roots               allowed roots + configured home
 *   GET  /-/files/api/list?path=          one directory level
 *   GET  /-/files/api/text?path=          UTF-8 text preview (bounded)
 *   GET  /-/files/api/raw?path=           inline bytes (images/PDF/video), Range-capable
 *   GET  /-/files/api/download?path=      attachment bytes, Range-capable
 *   GET  /-/files/api/zip?path=…          ZIP stream (one or more paths, store method)
 *   GET  /-/files/api/office?path=        Office -> PDF through the Host officeToPdf service
 *   POST /-/files/api/upload?path=<dir>   raw body upload (x-file-name header)
 *   POST /-/files/api/copy                copy/move sources into a target directory
 *
 * Access control: routes only answer when the request's Host authority is a
 * loopback one. dsh-access-gate rewrites Host to 127.0.0.1 after password
 * authentication, so authenticated remote requests pass, while a raw
 * unauthenticated remote request is refused. Every path is resolved through
 * realpath and must stay inside one of the configured roots.
 */

import { createReadStream, createWriteStream, promises as fsp } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-local-files'
export const inject = ['webServer']

const PAGE_PATH = '/-/files'
const API_PREFIX = '/-/files/api'
const VENDOR_PREFIX = '/-/files/vendor'

// Browser libraries shipped with the page, served as same-origin immutable
// assets and only fetched when a matching file type is opened.
const VENDOR_FILES = new Map([
  ['mammoth.browser.min.js', 'text/javascript; charset=utf-8'],
  ['xlsx.full.min.js', 'text/javascript; charset=utf-8'],
])

const MAX_ENTRIES = 3000
const MAX_ZIP_ENTRIES = 20000
const MAX_JSON_BODY = 256 * 1024
const DEFAULT_MAX_TEXT_BYTES = 512 * 1024
const DEFAULT_MAX_PREVIEW_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024
const DEFAULT_MAX_COPY_ENTRIES = 20000
const DEFAULT_MAX_WRITE_BYTES = 5 * 1024 * 1024
const DEFAULT_TRASH_DIR_NAME = '.dsh-local-files-trash'
const OFFICE_CACHE_BYTES = 96 * 1024 * 1024

const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'])

const MIME = {
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonc': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.go': 'text/plain; charset=utf-8',
  '.rs': 'text/plain; charset=utf-8',
  '.java': 'text/plain; charset=utf-8',
  '.c': 'text/plain; charset=utf-8',
  '.h': 'text/plain; charset=utf-8',
  '.cpp': 'text/plain; charset=utf-8',
  '.cs': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
  '.bat': 'text/plain; charset=utf-8',
  '.cmd': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.zip': 'application/zip',
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Whether an HTTP Host authority names the loopback interface. */
function isLoopbackAuthority(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  let h = host.trim().toLowerCase()
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    if (end < 0) return false
    h = h.slice(1, end)
  } else {
    const idx = h.lastIndexOf(':')
    if (idx >= 0) h = h.slice(0, idx)
  }
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true
  return /^127\.\d+\.\d+\.\d+$/.test(h)
}

function samePathPlatform(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function withinRoot(target, root) {
  if (samePathPlatform(target, root)) return true
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  return process.platform === 'win32'
    ? target.toLowerCase().startsWith(prefix.toLowerCase())
    : target.startsWith(prefix)
}

async function listDrives() {
  if (process.platform !== 'win32') return ['/']
  const found = []
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`
    try {
      const st = await fsp.stat(root)
      if (st.isDirectory()) found.push(root)
    } catch {
      /* absent drive */
    }
  }
  return found
}

function contentDisposition(kind, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8')
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function parseRange(header, size) {
  if (typeof header !== 'string') return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return undefined
  const startRaw = match[1]
  const endRaw = match[2]
  if (startRaw === '' && endRaw === '') return undefined
  let start
  let end
  if (startRaw === '') {
    const suffix = Number(endRaw)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return undefined
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(startRaw)
    end = endRaw === '' ? size - 1 : Number(endRaw)
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined
  if (start > end || start >= size) return { unsatisfiable: true }
  return { start, end: Math.min(end, size - 1) }
}

async function readJsonBody(req, limit = MAX_JSON_BODY) {
  let total = 0
  const chunks = []
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new HttpError(413, '请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
}

/** Pick a free file name inside dir. */
async function freeName(dir, name) {
  const ext = path.extname(name)
  const base = ext.length > 0 ? name.slice(0, -ext.length) : name
  let candidate = name
  let index = 2
  for (;;) {
    try {
      await fsp.access(path.join(dir, candidate))
    } catch {
      return candidate
    }
    candidate = `${base} (${index})${ext}`
    index += 1
    if (index > 999) throw new HttpError(409, '同名文件过多')
  }
}

function sanitizeUploadName(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new HttpError(400, '缺少文件名')
  let decoded
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    decoded = raw
  }
  const name = path.basename(decoded.replace(/\\/g, '/'))
  if (name.length === 0 || name === '.' || name === '..' || name.includes('\0')) {
    throw new HttpError(400, '非法文件名')
  }
  return name
}

// ── ZIP writer (store method + data descriptors, files stream once) ───────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()

function makeCrc32() {
  let crc = 0xffffffff
  return {
    update(buffer) {
      for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
    },
    digest() {
      return (crc ^ 0xffffffff) >>> 0
    },
  }
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

function writeChunk(res, chunk) {
  return new Promise((resolve) => {
    if (res.write(chunk)) resolve()
    else res.once('drain', resolve)
  })
}

async function collectZipEntries(rootPath, rootName, entries, signal) {
  if (signal?.aborted) throw new HttpError(499, '已取消')
  const st = await fsp.stat(rootPath)
  if (st.isFile()) {
    entries.push({ diskPath: rootPath, name: rootName, stat: st })
    return
  }
  if (!st.isDirectory()) return
  entries.push({ diskPath: null, name: `${rootName}/`, stat: st })
  if (entries.length > MAX_ZIP_ENTRIES) throw new HttpError(413, 'ZIP 条目过多')
  const dirents = await fsp.readdir(rootPath, { withFileTypes: true })
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) continue
    const full = path.join(rootPath, dirent.name)
    const childName = `${rootName}/${dirent.name}`
    if (dirent.isDirectory()) await collectZipEntries(full, childName, entries, signal)
    else if (dirent.isFile()) {
      const info = await fsp.stat(full)
      entries.push({ diskPath: full, name: childName, stat: info })
    }
    if (entries.length > MAX_ZIP_ENTRIES) throw new HttpError(413, 'ZIP 条目过多')
  }
}

async function streamZip(res, sources, signal) {
  const entries = []
  for (const source of sources) {
    await collectZipEntries(source, path.basename(source), entries, signal)
  }
  const central = []
  let offset = 0
  res.writeHead(200, {
    'content-type': 'application/zip',
    'cache-control': 'private, no-store, no-transform',
    'content-disposition': contentDisposition('attachment', `${path.basename(sources[0])}.zip`),
  })
  for (const entry of entries) {
    if (signal?.aborted) return
    const isDir = entry.diskPath === null
    const nameBytes = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8')
    const { time, day } = dosDateTime(entry.stat.mtime)
    const crc = makeCrc32()
    let size = 0
    const localOffset = offset
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0808, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(time, 10)
    header.writeUInt16LE(day, 12)
    header.writeUInt32LE(0, 14)
    header.writeUInt32LE(0, 18)
    header.writeUInt32LE(isDir ? 0 : entry.stat.size, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    header.writeUInt16LE(0, 28)
    await writeChunk(res, header)
    await writeChunk(res, nameBytes)
    offset += header.length + nameBytes.length
    if (!isDir) {
      for await (const chunk of createReadStream(entry.diskPath)) {
        crc.update(chunk)
        size += chunk.length
        await writeChunk(res, chunk)
        offset += chunk.length
      }
    }
    const crcValue = isDir ? 0 : crc.digest()
    const descriptor = Buffer.alloc(16)
    descriptor.writeUInt32LE(0x08074b50, 0)
    descriptor.writeUInt32LE(crcValue, 4)
    descriptor.writeUInt32LE(size, 8)
    descriptor.writeUInt32LE(size, 12)
    await writeChunk(res, descriptor)
    offset += descriptor.length
    central.push({ nameBytes, crc: crcValue, size, localOffset, time, day, isDir })
  }
  const centralStart = offset
  let centralSize = 0
  for (const item of central) {
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x0808, 8)
    record.writeUInt16LE(0, 10)
    record.writeUInt16LE(item.time, 12)
    record.writeUInt16LE(item.day, 14)
    record.writeUInt32LE(item.crc, 16)
    record.writeUInt32LE(item.size, 20)
    record.writeUInt32LE(item.size, 24)
    record.writeUInt16LE(item.nameBytes.length, 28)
    record.writeUInt16LE(0, 30)
    record.writeUInt16LE(0, 32)
    record.writeUInt16LE(0, 34)
    record.writeUInt16LE(0, 36)
    record.writeUInt32LE(item.isDir ? 0x10 : 0, 38)
    record.writeUInt32LE(item.localOffset, 42)
    await writeChunk(res, record)
    await writeChunk(res, item.nameBytes)
    centralSize += record.length + item.nameBytes.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(central.length, 8)
  end.writeUInt16LE(central.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralStart, 16)
  end.writeUInt16LE(0, 20)
  await writeChunk(res, end)
  res.end()
}

export function apply(ctx, config) {
  const settings = { ...(config ?? {}) }
  const positive = (value, fallback) => (Number.isSafeInteger(value) && value > 0 ? value : fallback)
  const maxTextBytes = positive(settings.maxTextBytes, DEFAULT_MAX_TEXT_BYTES)
  const maxPreviewBytes = positive(settings.maxPreviewBytes, DEFAULT_MAX_PREVIEW_BYTES)
  const maxUploadBytes = positive(settings.maxUploadBytes, DEFAULT_MAX_UPLOAD_BYTES)
  const maxCopyEntries = positive(settings.maxCopyEntries, DEFAULT_MAX_COPY_ENTRIES)
  const maxWriteBytes = positive(settings.maxWriteBytes, DEFAULT_MAX_WRITE_BYTES)
  const trashRoot = typeof settings.trashDir === 'string' && settings.trashDir.trim().length > 0
    ? path.resolve(settings.trashDir.trim())
    : path.join(os.homedir(), DEFAULT_TRASH_DIR_NAME)

  let pageHtml = null
  let pageStamp = 0
  const pageFile = fileURLToPath(new URL('./page.html', import.meta.url))
  const vendorDir = fileURLToPath(new URL('./vendor/', import.meta.url))
  const vendorCache = new Map()

  async function handleVendor(req, res) {
    if (!isLoopbackAuthority(req.headers.host)) {
      sendJson(res, 403, { error: '仅允许通过访问认证后的入口使用' })
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('只支持 GET/HEAD')
      return
    }
    let name
    try {
      name = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname
        .slice(VENDOR_PREFIX.length).replace(/^\/+/, ''))
    } catch {
      sendText(res, 400, 'bad name')
      return
    }
    const type = VENDOR_FILES.get(name)
    if (type === undefined) {
      sendText(res, 404, 'not found')
      return
    }
    try {
      let buffer = vendorCache.get(name)
      if (buffer === undefined) {
        buffer = await fsp.readFile(path.join(vendorDir, name))
        vendorCache.set(name, buffer)
      }
      res.writeHead(200, {
        'content-type': type,
        'content-length': String(buffer.length),
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      })
      res.end(req.method === 'HEAD' ? undefined : buffer)
    } catch (error) {
      sendText(res, 500, `vendor asset failed: ${error && error.message ? error.message : String(error)}`)
    }
  }

  async function loadPage() {
    // Re-read when the file changes so local page edits apply without a
    // plugin reload (the HTML is tiny; stat is cheap).
    const info = await fsp.stat(pageFile)
    if (pageHtml === null || info.mtimeMs !== pageStamp) {
      pageHtml = await fsp.readFile(pageFile, 'utf8')
      pageStamp = info.mtimeMs
    }
    return pageHtml
  }

  let rootsCache = null
  let rootsStamp = 0
  const homeSetting = typeof settings.home === 'string' && settings.home.trim().length > 0
    ? settings.home.trim()
    : null
  let homeCache
  async function home() {
    if (homeCache !== undefined) return homeCache
    homeCache = null
    if (homeSetting !== null) {
      try {
        const real = await fsp.realpath(path.resolve(homeSetting))
        const allowed = await roots()
        if (allowed.some((root) => withinRoot(real, root))) homeCache = real
      } catch {
        /* configured home does not exist: fall back to the first root */
      }
    }
    return homeCache
  }

  async function roots() {
    const now = Date.now()
    if (rootsCache !== null && now - rootsStamp < 30_000) return rootsCache
    const configured = Array.isArray(settings.roots)
      ? settings.roots.filter((item) => typeof item === 'string' && item.trim().length > 0)
      : []
    const raw = configured.length > 0 ? configured : await listDrives()
    const resolved = []
    for (const item of raw) {
      try {
        const real = await fsp.realpath(path.resolve(item))
        if (!resolved.some((existing) => samePathPlatform(existing, real))) resolved.push(real)
      } catch {
        /* skip roots that do not exist */
      }
    }
    rootsCache = resolved
    rootsStamp = now
    return resolved
  }

  /** Resolve a requested path through realpath and enforce root containment. */
  async function resolveRequested(raw) {
    if (typeof raw !== 'string' || raw.length === 0) throw new HttpError(400, '缺少 path 参数')
    if (raw.includes('\0')) throw new HttpError(400, '非法路径')
    const absolute = process.platform === 'win32'
      ? /^[a-zA-Z]:[\\/]/.test(raw)
      : raw.startsWith('/')
    if (!absolute) throw new HttpError(400, '需要绝对路径')
    let real
    try {
      real = await fsp.realpath(path.resolve(raw))
    } catch (error) {
      const code = error && error.code
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new HttpError(404, '路径不存在')
      if (code === 'EACCES' || code === 'EPERM') throw new HttpError(403, '没有访问权限')
      throw error
    }
    const allowed = await roots()
    if (!allowed.some((root) => withinRoot(real, root))) {
      throw new HttpError(403, '路径不在允许的根目录内')
    }
    return real
  }

  // ── office conversion through the shared Host converter ────────────────

  let office = null
  ctx.inject(['officeToPdf'], (octx) => {
    office = octx.officeToPdf
    ctx.effect(() => () => { office = null }, 'local-files: office service binding')
  })

  const officeCache = new Map() // key -> { pdf, at }
  let officeCacheBytes = 0

  function rememberPdf(key, pdf) {
    officeCache.set(key, { pdf, at: Date.now() })
    officeCacheBytes += pdf.byteLength
    while (officeCacheBytes > OFFICE_CACHE_BYTES && officeCache.size > 1) {
      const oldest = [...officeCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      officeCache.delete(oldest[0])
      officeCacheBytes -= oldest[1].pdf.byteLength
    }
  }

  async function handleRoots(res) {
    const allowed = await roots()
    sendJson(res, 200, {
      roots: allowed.map((root) => ({ path: root, label: root })),
      home: await home(),
    })
  }

  async function handleList(res, rawPath) {
    const dir = await resolveRequested(rawPath)
    const st = await fsp.stat(dir)
    if (!st.isDirectory()) throw new HttpError(400, '不是目录')
    const dirents = await fsp.readdir(dir, { withFileTypes: true })
    const limited = dirents.slice(0, MAX_ENTRIES)
    const entries = await Promise.all(limited.map(async (dirent) => {
      const full = path.join(dir, dirent.name)
      let size = null
      let mtimeMs = null
      let isDir = dirent.isDirectory()
      // stat (not lstat) so junctions and directory symlinks read as directories
      try {
        const info = await fsp.stat(full)
        isDir = info.isDirectory()
        size = info.isDirectory() ? null : info.size
        mtimeMs = info.mtimeMs
      } catch {
        /* entry vanished between readdir and stat */
      }
      return {
        name: dirent.name,
        path: full,
        isDir,
        isLink: dirent.isSymbolicLink(),
        size,
        mtimeMs,
        hidden: dirent.name.startsWith('.'),
      }
    }))
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-Hans-CN')
    })
    const parent = path.dirname(dir)
    sendJson(res, 200, {
      path: dir,
      parent: samePathPlatform(parent, dir) ? null : parent,
      entries,
      truncated: dirents.length > limited.length,
      total: dirents.length,
    })
  }

  async function handleText(res, rawPath) {
    const file = await resolveRequested(rawPath)
    const st = await fsp.stat(file)
    if (!st.isFile()) throw new HttpError(403, '不是普通文件')
    const version = { mtimeMs: Math.floor(st.mtimeMs), size: st.size }
    if (st.size === 0) {
      sendJson(res, 200, { path: file, ...version, text: '', truncated: false, binary: false })
      return
    }
    const length = Math.min(st.size, maxTextBytes)
    const handle = await fsp.open(file, 'r')
    let buffer
    try {
      buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, 0)
    } finally {
      await handle.close()
    }
    if (buffer.includes(0)) {
      sendJson(res, 200, { path: file, ...version, text: '', truncated: false, binary: true })
      return
    }
    const truncated = st.size > length
    // A byte-bounded slice can cut a multi-byte character in half; drop the
    // replacement characters that decoding leaves at the tail.
    const text = truncated ? buffer.toString('utf8').replace(/\uFFFD+$/, '') : buffer.toString('utf8')
    sendJson(res, 200, { path: file, ...version, text, truncated, binary: false })
  }

  async function streamFile(req, res, rawPath, attachment) {
    const file = await resolveRequested(rawPath)
    const st = await fsp.stat(file)
    if (!st.isFile()) throw new HttpError(403, '不是普通文件')
    const size = st.size
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
    const headers = {
      'content-type': type,
      'cache-control': 'private, no-store, no-transform',
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      'content-disposition': contentDisposition(attachment ? 'attachment' : 'inline', path.basename(file)),
    }
    if (!attachment && size > maxPreviewBytes) {
      throw new HttpError(413, '文件超过内联预览上限，请使用下载')
    }
    const head = req.method === 'HEAD'
    const range = parseRange(req.headers.range, size)
    if (range === undefined || (range !== null && range.unsatisfiable)) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${size}`, 'content-length': '0' })
      res.end()
      return
    }
    if (range !== null) {
      const { start, end } = range
      headers['content-range'] = `bytes ${start}-${end}/${size}`
      headers['content-length'] = String(end - start + 1)
      res.writeHead(206, headers)
      if (head) {
        res.end()
        return
      }
      createReadStream(file, { start, end }).pipe(res)
      return
    }
    headers['content-length'] = String(size)
    res.writeHead(200, headers)
    if (head || size === 0) {
      res.end()
      return
    }
    createReadStream(file).pipe(res)
  }

  function sendPdf(res, pdf) {
    const buffer = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength)
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'cache-control': 'private, no-store',
      'content-length': String(buffer.length),
    })
    res.end(buffer)
  }

  async function handleOffice(req, res, rawPath) {
    const file = await resolveRequested(rawPath)
    const extension = path.extname(file).slice(1).toLowerCase()
    if (!OFFICE_EXTENSIONS.has(extension)) throw new HttpError(400, '不是 Office 文档')
    const st = await fsp.stat(file)
    if (!st.isFile()) throw new HttpError(403, '不是普通文件')
    if (office === null || office === undefined) throw new HttpError(501, 'Host 未提供 Office 转换服务（officeToPdf 未挂载）')
    const version = `${Math.floor(st.mtimeMs)}:${st.size}`
    const key = `${file}|${version}`
    const cached = officeCache.get(key)
    if (cached !== undefined) {
      cached.at = Date.now()
      sendPdf(res, cached.pdf)
      return
    }
    const controller = new AbortController()
    req.on('close', () => controller.abort())
    let result
    try {
      result = await office.convert({
        extension,
        priority: 'foreground',
        source: {
          key: file,
          version,
          bytes: st.size,
          read: async (signal, maxBytes) => {
            const bytes = await fsp.readFile(file)
            if (bytes.byteLength > maxBytes) throw new Error('source exceeds the reserved capacity')
            return { bytes, version }
          },
        },
      }, controller.signal)
    } catch (error) {
      // Keep the converter's own wording: the page retries on a timeout and
      // falls back to its client-side renderer, so a generic "internal error"
      // would hide both paths.
      if (controller.signal.aborted) throw new HttpError(499, '转换已取消')
      const reason = error instanceof Error && error.message ? error.message : '未知错误'
      if (/超时|timeout|timed out/i.test(reason)) throw new HttpError(504, reason)
      throw new HttpError(502, 'Office 转换失败：' + reason)
    }
    const pdf = result.pdf
    rememberPdf(key, pdf)
    sendPdf(res, pdf)
  }

  async function handleUpload(req, res, url) {
    const dir = await resolveRequested(url.searchParams.get('path') ?? '')
    const st = await fsp.stat(dir)
    if (!st.isDirectory()) throw new HttpError(400, '目标不是目录')
    const name = sanitizeUploadName(req.headers['x-file-name'])
    const finalName = await freeName(dir, name)
    const finalPath = path.join(dir, finalName)
    const tempPath = path.join(dir, `.dsh-upload-${randomUUID()}.part`)
    const out = createWriteStream(tempPath, { flags: 'wx' })
    let size = 0
    let failed = null
    try {
      for await (const chunk of req) {
        size += chunk.length
        if (size > maxUploadBytes) throw new HttpError(413, '文件超过上传上限')
        if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve))
      }
    } catch (error) {
      failed = error
    }
    await new Promise((resolve) => out.end(resolve))
    if (failed !== null) {
      await fsp.rm(tempPath, { force: true }).catch(() => {})
      throw failed instanceof HttpError ? failed : new HttpError(500, `写入失败：${failed.message}`)
    }
    await fsp.rename(tempPath, finalPath)
    sendJson(res, 200, { name: finalName, size, path: finalPath })
  }

  async function handleCopy(req, res, url) {
    const body = await readJsonBody(req)
    const sources = Array.isArray(body.sources) ? body.sources : []
    if (sources.length === 0) throw new HttpError(400, '没有要复制的项目')
    if (sources.length > 500) throw new HttpError(400, '一次最多 500 项')
    const move = body.move === true
    const overwrite = body.overwrite === true
    const targetRaw = typeof body.target === 'string' ? body.target : (url.searchParams.get('target') ?? '')
    const targetDir = await resolveRequested(targetRaw)
    const targetStat = await fsp.stat(targetDir)
    if (!targetStat.isDirectory()) throw new HttpError(400, '粘贴目标不是目录')

    const results = []
    for (const raw of sources) {
      const source = await resolveRequested(String(raw))
      const destination = path.join(targetDir, path.basename(source))
      try {
        await fsp.stat(source)
        if (samePathPlatform(path.dirname(source), targetDir)) throw new HttpError(409, '已在目标目录中')
        if (!move && withinRoot(targetDir, source) && !samePathPlatform(targetDir, source)) {
          throw new HttpError(400, '不能复制到自身的子目录')
        }
        if (move && withinRoot(targetDir, source) && !samePathPlatform(targetDir, source)) {
          throw new HttpError(400, '不能移动到自身的子目录')
        }
        if (!overwrite) await assertAbsent(destination)
        if (move) {
          try {
            await fsp.rename(source, destination)
          } catch (error) {
            if (error && error.code === 'EXDEV') {
              await copyTree(source, destination, maxCopyEntries)
              await fsp.rm(source, { recursive: true, force: true })
            } else {
              throw error
            }
          }
        } else {
          await copyTree(source, destination, maxCopyEntries)
        }
        results.push({ source, destination, ok: true })
      } catch (error) {
        results.push({
          source,
          ok: false,
          error: error instanceof HttpError ? error.message : (error && error.message ? error.message : String(error)),
        })
      }
    }
    const failed = results.filter((item) => !item.ok)
    sendJson(res, failed.length === 0 ? 200 : 207, { target: targetDir, results })
  }

  async function assertAbsent(target) {
    try {
      await fsp.lstat(target)
    } catch {
      return
    }
    throw new HttpError(409, '目标已存在同名项')
  }

  async function copyTree(source, destination, remaining) {
    if (remaining <= 0) throw new HttpError(413, '复制项数过多')
    const st = await fsp.stat(source)
    if (st.isDirectory()) {
      await fsp.mkdir(destination, { recursive: false })
      const dirents = await fsp.readdir(source, { withFileTypes: true })
      for (const dirent of dirents) {
        if (dirent.isSymbolicLink()) continue
        await copyTree(path.join(source, dirent.name), path.join(destination, dirent.name), remaining - 1)
      }
      return
    }
    if (!st.isFile()) throw new HttpError(400, '不支持的文件类型')
    await fsp.copyFile(source, destination)
  }

  // ── write operations (edit / create / rename / delete) ─────────────────

  async function writeAtomic(target, buffer) {
    const tmp = path.join(path.dirname(target), `.dsh-write-${randomUUID()}.part`)
    await fsp.writeFile(tmp, buffer, { flag: 'wx', mode: 0o600 })
    try {
      await fsp.rename(tmp, target)
    } catch (error) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  }

  function assertSimpleName(raw) {
    if (typeof raw !== 'string') throw new HttpError(400, '缺少名称')
    const name = raw.trim()
    if (name.length === 0 || name === '.' || name === '..' || name.includes('\0') || /[\\/]/.test(name)) {
      throw new HttpError(400, '名称不能为空或包含路径分隔符')
    }
    return name
  }

  async function resolveParentDir(raw) {
    if (typeof raw !== 'string' || raw.length === 0) throw new HttpError(400, '缺少目录')
    const parent = await resolveRequested(raw)
    const st = await fsp.stat(parent)
    if (!st.isDirectory()) throw new HttpError(400, '不是目录')
    return parent
  }

  async function handleWrite(req, res) {
    const body = await readJsonBody(req, maxWriteBytes + 64 * 1024)
    const file = await resolveRequested(typeof body.path === 'string' ? body.path : '')
    const st = await fsp.stat(file)
    if (!st.isFile()) throw new HttpError(403, '不是普通文件')
    if (body.expected !== undefined && body.expected !== null) {
      const changed = Number(body.expected.mtimeMs) !== Math.floor(st.mtimeMs) ||
        Number(body.expected.size) !== st.size
      if (changed) throw new HttpError(409, '文件已被其他程序修改，请重新加载后再保存')
    }
    const text = typeof body.text === 'string' ? body.text : ''
    const buffer = Buffer.from(text, 'utf8')
    if (buffer.length > maxWriteBytes) throw new HttpError(413, '内容超过写入上限')
    await writeAtomic(file, buffer)
    const after = await fsp.stat(file)
    sendJson(res, 200, { path: file, size: after.size, mtimeMs: Math.floor(after.mtimeMs) })
  }

  async function handleCreate(req, res) {
    const body = await readJsonBody(req)
    const parent = await resolveParentDir(typeof body.dir === 'string' ? body.dir : '')
    const name = assertSimpleName(body.name)
    const target = path.join(parent, name)
    const kind = body.kind === 'dir' ? 'dir' : 'file'
    try {
      if (kind === 'dir') {
        await fsp.mkdir(target)
      } else {
        const text = typeof body.text === 'string' ? body.text : ''
        const buffer = Buffer.from(text, 'utf8')
        if (buffer.length > maxWriteBytes) throw new HttpError(413, '内容超过写入上限')
        await fsp.writeFile(target, buffer, { flag: 'wx' })
      }
    } catch (error) {
      if (error && error.code === 'EEXIST') throw new HttpError(409, '同名项已存在')
      throw error
    }
    const st = await fsp.stat(target)
    sendJson(res, 200, {
      path: target,
      isDir: kind === 'dir',
      size: kind === 'dir' ? null : st.size,
      mtimeMs: Math.floor(st.mtimeMs),
    })
  }

  async function handleRename(req, res) {
    const body = await readJsonBody(req)
    const source = await resolveRequested(typeof body.path === 'string' ? body.path : '')
    const name = assertSimpleName(body.name)
    const target = path.join(path.dirname(source), name)
    if (samePathPlatform(target, source)) {
      sendJson(res, 200, { path: target })
      return
    }
    let exists = false
    try {
      await fsp.lstat(target)
      exists = true
    } catch {
      /* free name */
    }
    if (exists) throw new HttpError(409, '同名项已存在')
    await fsp.rename(source, target)
    sendJson(res, 200, { path: target })
  }

  async function handleDelete(req, res) {
    const body = await readJsonBody(req)
    const paths = Array.isArray(body.paths) ? body.paths : []
    if (paths.length === 0) throw new HttpError(400, '没有要删除的项目')
    if (paths.length > 500) throw new HttpError(400, '一次最多 500 项')
    const permanent = body.permanent === true
    const allowed = await roots()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    let trashDir = null
    const results = []
    for (const raw of paths) {
      let source = null
      try {
        source = await resolveRequested(String(raw))
        if (allowed.some((root) => samePathPlatform(root, source))) throw new HttpError(400, '不能删除允许的根目录')
        const base = path.basename(source)
        if (permanent) {
          await fsp.rm(source, { recursive: true })
          results.push({ source, ok: true, permanent: true })
          continue
        }
        if (trashDir === null) {
          trashDir = path.join(trashRoot, stamp)
          await fsp.mkdir(trashDir, { recursive: true })
        }
        const destination = path.join(trashDir, await freeName(trashDir, base))
        try {
          await fsp.rename(source, destination)
        } catch (error) {
          if (error && error.code === 'EXDEV') {
            await copyTree(source, destination, maxCopyEntries)
            await fsp.rm(source, { recursive: true, force: true })
          } else {
            throw error
          }
        }
        results.push({ source, destination, ok: true })
      } catch (error) {
        results.push({
          source: source ?? String(raw),
          ok: false,
          error: error instanceof HttpError ? error.message : (error && error.message ? error.message : String(error)),
        })
      }
    }
    const failed = results.filter((item) => !item.ok)
    sendJson(res, failed.length === 0 ? 200 : 207, { trashDir, results })
  }

  async function handleApi(req, res) {
    if (!isLoopbackAuthority(req.headers.host)) {
      sendJson(res, 403, { error: '仅允许通过访问认证后的入口使用' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const action = url.pathname.slice(API_PREFIX.length).replace(/^\/+/, '')
    const rawPath = url.searchParams.get('path') ?? ''
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        switch (action) {
          case 'roots':
            await handleRoots(res)
            return
          case 'list':
            await handleList(res, rawPath)
            return
          case 'text':
            await handleText(res, rawPath)
            return
          case 'raw':
            await streamFile(req, res, rawPath, false)
            return
          case 'download':
            await streamFile(req, res, rawPath, true)
            return
          case 'zip': {
            const sources = url.searchParams.getAll('path').filter((item) => item.length > 0)
            if (sources.length === 0) throw new HttpError(400, '缺少 path 参数')
            const resolved = []
            for (const item of sources) resolved.push(await resolveRequested(item))
            const controller = new AbortController()
            req.on('close', () => controller.abort())
            await streamZip(res, resolved, controller.signal)
            return
          }
          case 'office':
            await handleOffice(req, res, rawPath)
            return
          default:
            sendJson(res, 404, { error: '未知接口' })
            return
        }
      }
      if (req.method === 'POST') {
        switch (action) {
          case 'upload':
            await handleUpload(req, res, url)
            return
          case 'copy':
            await handleCopy(req, res, url)
            return
          case 'write':
            await handleWrite(req, res)
            return
          case 'create':
            await handleCreate(req, res)
            return
          case 'rename':
            await handleRename(req, res)
            return
          case 'delete':
            await handleDelete(req, res)
            return
          default:
            sendJson(res, 404, { error: '未知接口' })
            return
        }
      }
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('只支持 GET/HEAD/POST')
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message })
        return
      }
      ctx.logger?.warn?.(`dsh-local-files: ${action} failed: ${error && error.message ? error.message : String(error)}`)
      if (!res.headersSent) sendJson(res, 500, { error: '内部错误' })
      else res.destroy()
    }
  }

  async function handlePage(req, res) {
    try {
      const html = await loadPage()
      const body = Buffer.from(html, 'utf8')
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-store',
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch (error) {
      sendText(res, 500, `页面加载失败：${error && error.message ? error.message : String(error)}`)
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PAGE_PATH,
    handler: (req, res) => handlePage(req, res),
  }), 'local-files: page route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req, res) => handleApi(req, res),
  }), 'local-files: api route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: VENDOR_PREFIX,
    handler: (req, res) => handleVendor(req, res),
  }), 'local-files: vendor route')

  ctx.logger?.info?.('dsh-local-files: /-/files ready')
}
