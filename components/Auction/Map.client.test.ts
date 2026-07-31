import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { describe, expect, it } from 'vitest'

const componentPath = fileURLToPath(new URL('./Map.client.vue', import.meta.url))

// A setup binding whose name matches a tag's camelized form wins over
// resolveComponent(), so `const olMap = ...` silently turned `<ol-map>` into
// `createVNode(olMap)` — a ref, not a component. Vue then renders a comment
// node instead, and since every layer is a child of that tag, the whole map
// (base layer, markers, popup) disappeared without any console error.
describe('AuctionMap template', () => {
  it('compiles every ol-* tag to a resolved component, not a setup binding', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const { descriptor } = parse(source, { filename: componentPath })
    const script = compileScript(descriptor, { id: 'auction-map' })
    const { code } = compileTemplate({
      source: descriptor.template!.content,
      filename: componentPath,
      id: 'auction-map',
      compilerOptions: { bindingMetadata: script.bindings, prefixIdentifiers: true, mode: 'module' },
    })

    const tags = [...new Set(
      [...descriptor.template!.content.matchAll(/<(ol-[a-z-]+)/g)].map(match => match[1]!),
    )]
    expect(tags).toContain('ol-map')
    for (const tag of tags) {
      expect(code, `<${tag}> must compile to resolveComponent("${tag}")`).toContain(`_resolveComponent("${tag}")`)
    }
  })
})
