// Standalone smoke test for dsh-local-files host half, without touching the live DSH.
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, promises as fsp, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

const fixture = mkdtempSync(path.join(tmpdir(), 'dsh-local-files-test-'))
const sourceDir = path.join(fixture, 'src')
const targetDir = path.join(fixture, 'dst')
const nestedDir = path.join(sourceDir, 'nested')
const moveDir = path.join(fixture, 'moved')
mkdirSync(sourceDir, { recursive: true })
mkdirSync(targetDir, { recursive: true })
mkdirSync(nestedDir, { recursive: true })
mkdirSync(moveDir, { recursive: true })
writeFileSync(path.join(sourceDir, 'alpha.txt'), 'alpha content')
writeFileSync(path.join(nestedDir, 'beta.txt'), 'beta content')
writeFileSync(path.join(sourceDir, 'dummy.docx'), 'not a real docx')
writeFileSync(path.join(fixture, 'readme.md'), '# dsh-local-files smoke fixture\n' + '内容 '.repeat(400))
writeFileSync(path.join(fixture, 'big.html'), 'x'.repeat(4090) + '中文'.repeat(30))

const exact = new Map()
const prefixes = new Map()

const ctx = {
  webServer: {
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      table.set(route.path, route)
      return () => table.delete(route.path)
    },
  },
  effect(fn) {
    fn()
    return () => {}
  },
  // The standalone harness has no officeToPdf service: the binding is called
  // with a context whose service is undefined so /api/office answers 501.
  inject(_deps, cb) { cb(ctx) },
  logger: { info() {}, warn() {} },
}

apply(ctx, {
  home: fixture,
  roots: [],
  maxTextBytes: 4096,
  maxPreviewBytes: 1024 * 1024,
  maxUploadBytes: 4 * 1024 * 1024,
  maxCopyEntries: 100,
  trashDir: path.join(fixture, 'trash'),
})

function match(pathname) {
  const hit = exact.get(pathname)
  if (hit !== undefined) return hit
  let best
  for (const [prefix, route] of prefixes) {
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
    if (best === undefined || prefix.length > best.path.length) best = route
  }
  return best
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  const route = match(pathname)
  if (route === undefined) {
    res.writeHead(404)
    res.end('no route')
    return
  }
  await route.handler(req, res)
})
await new Promise((resolve) => server.listen(3599, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:3599'

async function get(pathname, headers = {}) {
  const res = await fetch(base + pathname, { headers })
  const text = await res.text()
  return { status: res.status, headers: res.headers, text }
}

const checks = []
function check(label, ok, detail = '') {
  checks.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
}

// ── page + read paths ────────────────────────────────────────────────────
const page = await get('/-/files')
check('page 200 html', page.status === 200 && page.text.includes('本地文件'), `${page.status} ${page.text.length}`)

const roots = await get('/-/files/api/roots')
const rootsJson = roots.status === 200 ? JSON.parse(roots.text) : null
check('page has fast docx + sheet renderers', page.text.includes('LibreOffice 精排') && page.text.includes('sheetTabs') && page.text.includes('mammoth.browser.min.js'), 'strings present')

check('roots json', roots.status === 200 && rootsJson.roots.length > 0, roots.text.slice(0, 100))
check('home configured', (await fsp.realpath(rootsJson.home)).toLowerCase() === (await fsp.realpath(fixture)).toLowerCase(), String(rootsJson.home))

const list = await get('/-/files/api/list?path=' + encodeURIComponent('C:\\'))
const listJson = list.status === 200 ? JSON.parse(list.text) : null
check('list C:\\', list.status === 200 && Array.isArray(listJson.entries) && listJson.entries.length > 0, `${list.status} entries=${listJson?.entries?.length}`)

const readme = path.join(fixture, 'readme.md')
const text = await get('/-/files/api/text?path=' + encodeURIComponent(readme))
const textJson = text.status === 200 ? JSON.parse(text.text) : null
check('text readme', text.status === 200 && textJson.text.includes('dsh-local-files'), `${text.status} len=${textJson?.text?.length}`)

const big = path.join(fixture, 'big.html')
const bigText = await get('/-/files/api/text?path=' + encodeURIComponent(big))
const bigJson = bigText.status === 200 ? JSON.parse(bigText.text) : null
check('text truncation', bigText.status === 200 && bigJson.truncated === true && !bigJson.text.includes('\uFFFD'), `${bigText.status} len=${bigJson?.text?.length}`)

const head = await fetch(base + '/-/files/api/download?path=' + encodeURIComponent(readme), { method: 'HEAD' })
check('download HEAD', head.status === 200 && (head.headers.get('content-disposition') ?? '').startsWith('attachment'), String(head.status))

const ranged = await fetch(base + '/-/files/api/raw?path=' + encodeURIComponent(readme), { headers: { range: 'bytes=0-9' } })
const rangedText = await ranged.text()
check('raw range 206', ranged.status === 206 && rangedText.length === 10, `${ranged.status} "${rangedText}"`)

const badRange = await get('/-/files/api/raw?path=' + encodeURIComponent(readme), { range: 'bytes=abc' })
check('bad range 416', badRange.status === 416, String(badRange.status))

// ── vendored browser libraries ───────────────────────────────────────────
async function vendorCheck(name, expectedType) {
  const res = await fetch(base + '/-/files/vendor/' + name)
  const body = await res.text()
  return {
    status: res.status,
    type: res.headers.get('content-type') ?? '',
    cache: res.headers.get('cache-control') ?? '',
    length: body.length,
    expectedType,
  }
}

const mammoth = await vendorCheck('mammoth.browser.min.js', 'javascript')
check('vendor mammoth', mammoth.status === 200 && mammoth.type.includes('javascript') && mammoth.cache.includes('immutable') && mammoth.length > 100000, `${mammoth.status} ${mammoth.type} ${mammoth.length}`)

const sheetjs = await vendorCheck('xlsx.full.min.js', 'javascript')
check('vendor sheetjs', sheetjs.status === 200 && sheetjs.type.includes('javascript') && sheetjs.length > 500000, `${sheetjs.status} ${sheetjs.length}`)

const vendorHead = await fetch(base + '/-/files/vendor/xlsx.full.min.js', { method: 'HEAD' })
check('vendor HEAD', vendorHead.status === 200 && Number(vendorHead.headers.get('content-length')) > 500000, String(vendorHead.status))

const vendorUnknown = await get('/-/files/vendor/nope.js')
check('vendor unknown 404', vendorUnknown.status === 404, String(vendorUnknown.status))

const vendorTraversal = await get('/-/files/vendor/' + encodeURIComponent('..\\..\\package.json'))
check('vendor traversal 404', vendorTraversal.status === 404, String(vendorTraversal.status))

const vendorPost = await fetch(base + '/-/files/vendor/mammoth.browser.min.js', { method: 'POST' })
check('vendor POST 405', vendorPost.status === 405, String(vendorPost.status))

const vendorRemote = await new Promise((resolve) => {
  const request = http.request(
    { host: '127.0.0.1', port: 3599, path: '/-/files/vendor/xlsx.full.min.js', method: 'GET', headers: { host: '203.0.113.9:3080' } },
    (res) => { res.resume(); resolve(res.statusCode) },
  )
  request.on('error', () => resolve(-1))
  request.end()
})
check('vendor non-loopback 403', vendorRemote === 403, String(vendorRemote))

const outside = await get('/-/files/api/text?path=' + encodeURIComponent('Q:\\nope.txt'))
check('missing path 404', outside.status === 404, String(outside.status))

const relative = await get('/-/files/api/list?path=' + encodeURIComponent('relative\\dir'))
check('relative rejected 400', relative.status === 400, String(relative.status))

const remoteHost = await new Promise((resolve) => {
  const request = http.request(
    { host: '127.0.0.1', port: 3599, path: '/-/files/api/roots', method: 'GET', headers: { host: '203.0.113.9:3080' } },
    (res) => { res.resume(); resolve(res.statusCode) },
  )
  request.on('error', () => resolve(-1))
  request.end()
})
check('non-loopback host 403', remoteHost === 403, String(remoteHost))

const unknown = await get('/-/files/api/nope')
check('unknown api 404', unknown.status === 404, String(unknown.status))

// ── upload ───────────────────────────────────────────────────────────────
async function upload(dir, name, body) {
  const res = await fetch(base + '/-/files/api/upload?path=' + encodeURIComponent(dir), {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent(name), 'content-type': 'application/octet-stream' },
    body,
  })
  const text = await res.text()
  return { status: res.status, json: res.status === 200 ? JSON.parse(text) : null, text }
}

const up1 = await upload(targetDir, '上传 测试.txt', 'hello upload')
check('upload ok', up1.status === 200 && up1.json.name === '上传 测试.txt', `${up1.status} ${up1.json?.name}`)
check('upload content', readFileSync(path.join(targetDir, '上传 测试.txt'), 'utf8') === 'hello upload')

const up2 = await upload(targetDir, '上传 测试.txt', 'second')
check('upload unique name', up2.status === 200 && up2.json.name === '上传 测试 (2).txt', String(up2.json?.name))

const traversal = await upload(targetDir, '..\\evil.txt', 'x')
check('upload name sanitized', traversal.status === 200 && !existsSync(path.join(fixture, 'evil.txt')), String(traversal.json?.name))

const postUnknown = await fetch(base + '/-/files/api/roots', { method: 'POST' })
check('POST roots 404', postUnknown.status === 404, String(postUnknown.status))

// ── copy / move ──────────────────────────────────────────────────────────
async function copy(body) {
  const res = await fetch(base + '/-/files/api/copy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: JSON.parse(text) }
}

const copied = await copy({ sources: [path.join(sourceDir, 'alpha.txt'), nestedDir], target: targetDir })
check('copy file+dir', copied.status === 200 && copied.json.results.every((item) => item.ok), JSON.stringify(copied.json.results.map((r) => r.ok)))
check('copy file exists', readFileSync(path.join(targetDir, 'alpha.txt'), 'utf8') === 'alpha content')
check('copy dir recursive', readFileSync(path.join(targetDir, 'nested', 'beta.txt'), 'utf8') === 'beta content')

const dup = await copy({ sources: [path.join(sourceDir, 'alpha.txt')], target: targetDir })
check('copy refuses overwrite', dup.status === 207 && dup.json.results[0].ok === false, String(dup.json.results[0].error))

const intoSelf = await copy({ sources: [sourceDir], target: path.join(sourceDir, 'nested') })
check('copy into own subtree refused', intoSelf.status === 207 && intoSelf.json.results[0].ok === false, String(intoSelf.json.results[0].error))

const moved = await copy({ sources: [path.join(targetDir, 'alpha.txt')], target: moveDir, move: true })
check('move file', moved.status === 200 && moved.json.results[0].ok === true, JSON.stringify(moved.json.results[0]))
check('move removed source', !existsSync(path.join(targetDir, 'alpha.txt')) && existsSync(path.join(moveDir, 'alpha.txt')))

const overwrite = await copy({ sources: [path.join(sourceDir, 'alpha.txt')], target: targetDir, overwrite: true })
check('copy overwrite flag', overwrite.status === 200 && existsSync(path.join(targetDir, 'alpha.txt')), String(overwrite.status))

// ── write / create / rename / delete ─────────────────────────────────────
async function postJsonApi(action, payload) {
  const res = await fetch(base + '/-/files/api/' + action, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  return { status: res.status, json: JSON.parse(text) }
}

const editable = path.join(targetDir, 'editable.txt')
writeFileSync(editable, 'first version', 'utf8')
const before = await get('/-/files/api/text?path=' + encodeURIComponent(editable))
const beforeJson = JSON.parse(before.text)
check('text carries version', typeof beforeJson.mtimeMs === 'number' && beforeJson.size === 13, JSON.stringify({ mtimeMs: beforeJson.mtimeMs, size: beforeJson.size }))

const written = await postJsonApi('write', {
  path: editable,
  text: 'second version',
  expected: { mtimeMs: beforeJson.mtimeMs, size: beforeJson.size },
})
check('write ok', written.status === 200 && written.json.size === 14, JSON.stringify(written.json))
check('write content', readFileSync(editable, 'utf8') === 'second version')

const stale = await postJsonApi('write', {
  path: editable,
  text: 'stale write',
  expected: { mtimeMs: beforeJson.mtimeMs, size: beforeJson.size },
})
check('write conflict 409', stale.status === 409, stale.text ?? String(stale.status))
check('write conflict no damage', readFileSync(editable, 'utf8') === 'second version')

const noExpected = await postJsonApi('write', { path: editable, text: 'forced write' })
check('write without expected', noExpected.status === 200 && readFileSync(editable, 'utf8') === 'forced write')

const mkdir = await postJsonApi('create', { dir: targetDir, name: '新目录', kind: 'dir' })
check('mkdir', mkdir.status === 200 && mkdir.json.isDir === true && existsSync(path.join(targetDir, '新目录')), JSON.stringify(mkdir.json))
const mkdirDup = await postJsonApi('create', { dir: targetDir, name: '新目录', kind: 'dir' })
check('mkdir duplicate 409', mkdirDup.status === 409, String(mkdirDup.status))
const mkfile = await postJsonApi('create', { dir: targetDir, name: '新文件.txt', kind: 'file' })
check('mkfile', mkfile.status === 200 && existsSync(path.join(targetDir, '新文件.txt')), JSON.stringify(mkfile.json))
const badName = await postJsonApi('create', { dir: targetDir, name: '..\\bad.txt', kind: 'file' })
check('create rejects separators', badName.status === 400, String(badName.status))

const renamed = await postJsonApi('rename', { path: path.join(targetDir, '新文件.txt'), name: '改名后.txt' })
check('rename', renamed.status === 200 && existsSync(path.join(targetDir, '改名后.txt')), JSON.stringify(renamed.json))
const renameDup = await postJsonApi('rename', { path: path.join(targetDir, '改名后.txt'), name: 'editable.txt' })
check('rename duplicate 409', renameDup.status === 409, String(renameDup.status))

const trashed = await postJsonApi('delete', { paths: [path.join(targetDir, '改名后.txt')] })
const trashDirReturned = trashed.json.trashDir
check('delete to trash', trashed.status === 200 && trashed.json.results[0].ok === true && !existsSync(path.join(targetDir, '改名后.txt')), String(trashDirReturned))
check('trash keeps file', trashDirReturned !== undefined && existsSync(path.join(trashDirReturned, '改名后.txt')))

const permTarget = path.join(targetDir, 'perm.txt')
writeFileSync(permTarget, 'bye', 'utf8')
const permanent = await postJsonApi('delete', { paths: [permTarget], permanent: true })
check('permanent delete', permanent.status === 200 && !existsSync(permTarget), JSON.stringify(permanent.json.results[0]))

const rootDelete = await postJsonApi('delete', { paths: ['C:\\'] })
check('delete refuses root', rootDelete.status === 207 && rootDelete.json.results[0].ok === false, String(rootDelete.json.results[0].error))
// ── zip ──────────────────────────────────────────────────────────────────
const zipRes = await fetch(base + '/-/files/api/zip?path=' + encodeURIComponent(sourceDir))
const zipBytes = Buffer.from(await zipRes.arrayBuffer())
const zipPath = path.join(fixture, 'pack.zip')
writeFileSync(zipPath, zipBytes)
check('zip status/type', zipRes.status === 200 && (zipRes.headers.get('content-type') ?? '').includes('application/zip'), String(zipRes.status))
check('zip signature', zipBytes.subarray(0, 2).toString('ascii') === 'PK', zipBytes.subarray(0, 4).toString('hex'))
let listing = ''
try {
  listing = execFileSync('tar', ['-tf', zipPath], { encoding: 'utf8' })
} catch (error) {
  listing = `tar failed: ${error.message}`
}
check('zip extracts via tar', listing.includes('src/alpha.txt') && listing.includes('src/nested/beta.txt'), listing.replace(/\r?\n/g, ' | ').slice(0, 160))

const zipMulti = await fetch(base + '/-/files/api/zip?path=' + encodeURIComponent(path.join(sourceDir, 'alpha.txt')) + '&path=' + encodeURIComponent(path.join(targetDir, 'nested')))
const zipMultiPath = path.join(fixture, 'multi.zip')
writeFileSync(zipMultiPath, Buffer.from(await zipMulti.arrayBuffer()))
let multiListing = ''
try {
  multiListing = execFileSync('tar', ['-tf', zipMultiPath], { encoding: 'utf8' })
} catch (error) {
  multiListing = `tar failed: ${error.message}`
}
check('zip multiple roots', multiListing.includes('alpha.txt') && multiListing.includes('nested/beta.txt'), multiListing.replace(/\r?\n/g, ' | ').slice(0, 160))

// ── office fallback (no service in this harness) ─────────────────────────
const officeBad = await get('/-/files/api/office?path=' + encodeURIComponent(path.join(sourceDir, 'alpha.txt')))
check('office rejects non-office', officeBad.status === 400, String(officeBad.status))

const officeMissing = await get('/-/files/api/office?path=' + encodeURIComponent(path.join(sourceDir, 'dummy.docx')))
check('office without service returns 501', officeMissing.status === 501, String(officeMissing.status))

server.close()
rmSync(fixture, { recursive: true, force: true })

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
