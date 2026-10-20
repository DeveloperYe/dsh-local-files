// Client-half smoke test: run lib/client.js under a stubbed module loader and
// verify it registers the three Sidebar slots and renders working anchors.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() }
  },
}

const registrations = []
const ctx = {
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

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
