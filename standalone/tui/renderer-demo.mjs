import { createComputationalRenderer } from "./renderer.mjs"

const renderer = createComputationalRenderer()
try {
  const session = renderer.createSession(48, 6)
  const root = renderer.createNode(session, "root", 1)
  const box = renderer.createNode(session, "box", 2)
  const text = renderer.createNode(session, "text", 3)
  renderer.move(box, root)
  renderer.move(text, box)
  renderer.setStyle(box, { group: 4, kind: 0, unit: 2, value: 100, flags: 1 })
  renderer.setStyle(box, { group: 4, kind: 1, unit: 1, value: 5, flags: 1 })
  renderer.setPaint(box, { borderSides: 15, borderStyle: 1 })
  renderer.setBoxDetails(box, { title: " OpenTUI WASM / Yoga " })
  renderer.setText(text, "Actual upstream scene painting: 한국어, é, 👩🏽‍💻\nContext → Scene → Box/Text → cell buffer")
  const snapshot = renderer.capture(session)
  process.stdout.write(snapshot.text)
} finally {
  renderer.close()
}
