import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// Via the 'vue' export, not '@vue/compiler-sfc' directly: the latter is only a
// transitive dependency, so it is not guaranteed to resolve (CI's install does
// not hoist it and typecheck fails on it).
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc'
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

  it('sets the marker style through VectorLayer#setStyle', () => {
    const source = readFileSync(componentPath, 'utf-8')

    expect(source).toContain('layer?.setStyle(clusterStyle)')
    expect(source).toContain('<ol-vector-layer ref="vectorLayerRef">')
    expect(source).not.toContain('<ol-vector-layer ref="vectorLayerRef" :style="clusterStyle">')
  })
})
