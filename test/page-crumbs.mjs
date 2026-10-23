// Page-half smoke test: the breadcrumb bar and the "jump" box must build
// platform-correct paths. Regression for the Linux bug where every crumb below
// the root was joined with '\' ("/root\.local") and failed with 路径不存在.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const html = readFileSync(fileURLToPath(new URL('../lib/page.html', import.meta.url)), 'utf8')

/** Extract a top-level `function name(...) { ... }` block by brace matching. */
function extract(name) {
  const start = html.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`function ${name} not found in lib/page.html`)
  let depth = 0
  for (let i = html.indexOf('{', start); i < html.length; i += 1) {
    if (html[i] === '{') depth += 1
    else if (html[i] === '}') {
      depth -= 1
      if (depth === 0) return html.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces after function ${name}`)
}

const source = `${extract('joinPath')}\n${extract('renderCrumbs')}\nreturn { joinPath, renderCrumbs }`

const checks = []
function check(label, ok, detail = '') {
  checks.push({ label, ok })
  if (!ok) console.log(`FAIL ${label}${detail ? ` (${detail})` : ''}`)
}

/** Render crumbs for `dir` and click every crumb, returning the loadDir calls. */
function crumbTargets(dir) {
  const appended = []
  const calls = []
  const el = { crumbs: { textContent: '', appendChild(node) { appended.push(node) } } }
  const document = {
    createElement(tag) {
      const node = {
        tag,
        className: '',
        textContent: '',
        type: '',
        click: null,
        addEventListener(event, run) { if (event === 'click') node.click = run },
      }
      return node
    },
  }
  const loadDir = (target) => calls.push(target)
  const page = new Function('el', 'document', 'loadDir', source)(el, document, loadDir)
  page.renderCrumbs(dir)
  for (const node of appended) if (node.click) node.click()
  return { appended, calls }
}

// ── joinPath ────────────────────────────────────────────────────────────────
{
  const { joinPath } = new Function('el', 'document', 'loadDir', source)({}, {}, () => {})
  const cases = [
    ['/root/.local/share/fcitx5', 'pinyin', '/root/.local/share/fcitx5/pinyin'],
    ['/', 'root', '/root'],
    ['/root', '..', '/root/..'],
    ['C:\\Users\\me', 'docs', 'C:\\Users\\me\\docs'],
    ['C:\\', 'Users', 'C:\\Users'],
    ['\\\\srv\\share', 'a', '\\\\srv\\share\\a'],
  ]
  for (const [base, name, want] of cases) {
    const got = joinPath(base, name)
    check(`joinPath(${JSON.stringify(base)}, ${JSON.stringify(name)})`, got === want, JSON.stringify(got))
  }
}

// ── breadcrumbs: clicking each crumb must request the same directory ────────
{
  const cases = [
    ['/', ['/']],
    ['/root', ['/', '/root']],
    ['/root/.local/share/fcitx5', ['/', '/root', '/root/.local', '/root/.local/share', '/root/.local/share/fcitx5']],
    ['/tmp/中文 目录/x', ['/', '/tmp', '/tmp/中文 目录', '/tmp/中文 目录/x']],
    ['C:\\Users\\me\\a', ['C:\\', 'C:\\Users', 'C:\\Users\\me', 'C:\\Users\\me\\a']],
    ['C:\\', ['C:\\']],
    ['\\\\srv\\share\\a', ['\\\\srv', '\\\\srv\\share', '\\\\srv\\share\\a']],
  ]
  for (const [dir, want] of cases) {
    const { appended, calls } = crumbTargets(dir)
    check(`crumbs ${JSON.stringify(dir)}`, JSON.stringify(calls) === JSON.stringify(want), calls.map((s) => JSON.stringify(s)).join(' '))
    const separators = appended.filter((node) => node.className === 'crumb sep').map((node) => node.textContent)
    const expectedSep = /^[a-zA-Z]:/.test(dir) || /^\\\\/.test(dir) ? '\\' : '/'
    check(`crumb separators ${JSON.stringify(dir)}`, separators.every((s) => s === expectedSep), JSON.stringify(separators))
  }
}

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
