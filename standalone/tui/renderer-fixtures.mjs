/** Build actual upstream scene nodes; shared by WASM tests and native parity. */
export function sceneFixture(renderer, width) {
  const session = renderer.createSession(width, 8)
  const root = renderer.createNode(session, "root", 1)
  const box = renderer.createNode(session, "box", 2)
  const peer = renderer.createNode(session, "box", 3)
  const text = renderer.createNode(session, "text", 4)
  renderer.setStyle(root, { group: 0, kind: 1, value: 2 }) // Row flex direction.
  renderer.move(box, root)
  renderer.move(peer, root, 1)
  renderer.move(text, box)
  renderer.setStyle(box, { group: 4, kind: 0, unit: 2, value: 50, flags: 1 })
  renderer.setStyle(box, { group: 4, kind: 1, unit: 1, value: 6, flags: 1 })
  renderer.setStyle(peer, { group: 1, kind: 1, value: 1 }) // Remaining flex space.
  renderer.setPaint(box, { borderSides: 15, borderColor: [0, 170, 255, 255], background: [16, 24, 32, 255] })
  renderer.setPaint(peer, { background: [24, 32, 48, 255] })
  renderer.setBoxDetails(box, { title: " Yoga " })
  renderer.setTextOptions(text, { attributes: 1, foreground: [240, 230, 220, 255] })
  renderer.setText(text, "한국어 é 👩🏽‍💻 OpenTUI renderer")
  return { session, root, box, peer, text }
}

/** Include resize, invalidation, wrapping, and fresh native object generation. */
export function rendererTrace(create, width) {
  const renderer = create()
  try {
    const nodes = sceneFixture(renderer, width)
    renderer.measure(nodes.session, nodes.root)
    const measured = [nodes.root, nodes.box, nodes.peer, nodes.text].map((node) => renderer.layout(node, true))
    const first = renderer.capture(nodes.session, { use_mouse: true })
    const info = renderer.textInfo(nodes.text)
    renderer.setText(nodes.text, "replaced\n日本語 / 中文 / 🇰🇷\né and 👨‍👩‍👧‍👦")
    const changed = renderer.capture(nodes.session)
    renderer.resize(nodes.session, width === 44 ? 100 : 44, 8)
    const resized = renderer.capture(nodes.session)
    const resizedLayout = renderer.layout(nodes.text)
    renderer.destroyNode(nodes.text)
    const replacement = renderer.createNode(nodes.session, "text", 5)
    renderer.move(replacement, nodes.box)
    renderer.setText(replacement, "new generation")
    const recreated = renderer.capture(nodes.session)
    return { measured, first, info, changed, resized, resizedLayout, recreated, exceptions: [0, 1, 2, 3, 4].map((kind) => renderer.request({ exception_probe: kind })) }
  } finally {
    renderer.close()
  }
}
