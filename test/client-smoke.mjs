// Client-half smoke test: run lib/client.js under a stubbed module loader,
// verify the three Sidebar slots render working anchors, and verify the
// `..`-repair wrapper installed on sidebarRight.openResource / openResourceIn.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() }
  },
}

const registrations = []
const CWD = 'C:\\Users\\tester\\workspace'

const ctx = {
  effects: [],
  effect(dispose, label) {
    this.effects.push({ dispose, label })
    return () => {}
  },
  inject(deps, run) {
    if (!Array.isArray(deps)) throw new Error(`inject expects an array, got ${typeof deps}`)
    run(this)
  },
  slots: {
    inject(name, run) {
      if (!run) throw new Error(`missing slot injection for ${name}`)
      run()
    },
    register(options, component) {
      if (!options || options.name === undefined) throw new Error('slot register requires a name')
      if (options.id === undefined) throw new Error('list slot register requires an id')
      registrations.push({ options, component })
      return () => {}
    },
  },
  sessions: {
    list: {
      getSnapshot() {
        return { byId: { 'session-1': { cwd: CWD } } }
      },
    },
  },
  sidebarRight: {
    opened: [],
    openResource(address, options) {
      this.opened.push({ method: 'openResource', address, options })
    },
    openResourceIn(sessionId, address, options) {
      this.opened.push({ method: 'openResourceIn', sessionId, address, options })
    },
  },
}

const requireStub = (id) => {
  if (id === 'react') return fakeReact
  throw new Error(`unexpected require: ${id}`)
}

const loaded = []
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded.push(entry)
    },
  },
}

const previousWindow = globalThis.window

new Function('window', source)(previousWindow)

const checks = []
const check = (label, ok, detail = '') => {
  checks.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
}

check('one module registered', loaded.length === 1, loaded.length)
const entry = loaded[0]
check('module id', entry.id === 'dsh-local-files', entry.id)

const mod = entry.factory(requireStub)
check('exports apply', typeof mod.apply === 'function')
check('exports inject', Array.isArray(mod.inject) && mod.inject.includes('slots'), JSON.stringify(mod.inject))
check('exports internals', typeof mod.__internals?.normalizeFileAddress === 'function')

mod.apply(ctx)
const names = registrations.map((item) => item.options.name)
check('three slots registered', registrations.length === 3, names.join(', '))
check('document.actions slot', names.includes('sidebar.right.tab.document.actions'))
check('document.unpreviewable slot', names.includes('sidebar.right.tab.document.unpreviewable'))
check('files.actions slot', names.includes('sidebar.right.tab.files.actions'))

const byName = new Map(registrations.map((item) => [item.options.name, item.component]))
const path = 'D:\\work\\a b\\x.docx'

function render(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (typeof node.type === 'function') return render(node.type(node.props))
  return { ...node, children: (node.children ?? []).map(render) }
}

const download = render(byName.get('sidebar.right.tab.document.actions')({ absolutePath: path }))
check('download renders anchor', download !== null && download.type === 'span')
const link = download.children[0]
check('download href encoded', link.props.href === '/-/files/api/download?path=' + encodeURIComponent(path), link.props.href)
check('download has download attr', link.props.download === '')

const empty = byName.get('sidebar.right.tab.document.actions')({})
check('download hidden without path', empty === null)

const unpreviewable = render(byName.get('sidebar.right.tab.document.unpreviewable')({ absolutePath: path }))
check('unpreviewable has 2 actions', unpreviewable.children.length === 2, String(unpreviewable.children.length))
check('unpreviewable browser link', unpreviewable.children[1].props.href === '/-/files?path=' + encodeURIComponent(path))

const files = byName.get('sidebar.right.tab.files.actions')({ absolutePath: 'C:\\' })
check('files tab link', files.props.href === '/-/files?path=' + encodeURIComponent('C:\\'), files.props.href)

// ── .. repair ────────────────────────────────────────────────────────────
const { normalizeFileAddress, sessionIdOf } = mod.__internals
const SID = 'session-1'
const addr = (tail) => `dsh-resource://file/session/${SID}/${tail}`

check('sessionIdOf', sessionIdOf(addr('a/b.md')) === SID, sessionIdOf(addr('a/b.md')))
check('plain address untouched', normalizeFileAddress(addr('notes/a.md'), CWD) === addr('notes/a.md'))
check(
  'dot-segment address repaired',
  normalizeFileAddress(addr('sub/../notes/a.md'), CWD) === addr('notes/a.md'),
  normalizeFileAddress(addr('sub/../notes/a.md'), CWD),
)
check(
  'inner parent collapsed',
  normalizeFileAddress(addr('docs/../README.md'), CWD) === addr('README.md'),
  normalizeFileAddress(addr('docs/../README.md'), CWD),
)
const escaped = normalizeFileAddress(addr('../sibling/a.md'), CWD)
check(
  'escaping the workspace becomes absolute',
  escaped === addr('C:/Users/tester/sibling/a.md'),
  escaped,
)
check('escaped address has no ..', !escaped.includes('..'))
check(
  'query suffix preserved',
  normalizeFileAddress(addr('docs/../a.md?line=3'), CWD) === addr('README.md').replace('README.md', 'a.md?line=3'),
  normalizeFileAddress(addr('docs/../a.md?line=3'), CWD),
)
check(
  'absolute scope collapsed',
  normalizeFileAddress('dsh-resource://file/absolute/C:/work/../work/a.md', '') === 'dsh-resource://file/absolute/C:/work/a.md',
  normalizeFileAddress('dsh-resource://file/absolute/C:/work/../work/a.md', ''),
)
check('foreign address untouched', normalizeFileAddress('dsh-resource://session/x', CWD) === 'dsh-resource://session/x')

// The wrapper must repair the address before the real implementation sees it.
ctx.sidebarRight.openResource(addr('sub/../notes/a.md'), { params: { line: 2 } })
const opened = ctx.sidebarRight.opened.at(-1)
check('wrapper repairs openResource', opened.address === addr('notes/a.md'), opened.address)
check('wrapper keeps options', opened.options?.params?.line === 2)

ctx.sidebarRight.openResourceIn(SID, addr('sub/../notes/b.md'))
const openedIn = ctx.sidebarRight.opened.at(-1)
check('wrapper repairs openResourceIn', openedIn.address === addr('notes/b.md'), openedIn.address)

ctx.sidebarRight.openResource('dsh-resource://session/x')
check('wrapper leaves foreign addresses alone', ctx.sidebarRight.opened.at(-1).address === 'dsh-resource://session/x')

const effect = ctx.effects.find((item) => String(item.label).includes('repair'))
check('wrapper registered an effect', effect !== undefined, effect?.label ?? 'none')
if (effect) {
  effect.dispose()
  const before = ctx.sidebarRight.opened.length
  ctx.sidebarRight.openResource(addr('../notes/a.md'))
  const afterDispose = ctx.sidebarRight.opened.at(-1)
  check('dispose restores original behaviour', ctx.sidebarRight.opened.length === before + 1 && afterDispose.address.includes('..'), afterDispose.address)
}

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
