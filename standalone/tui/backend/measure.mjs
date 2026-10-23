/** Custom Yoga measurement callbacks retain the published YogaHost guards. */
export const measureMethods = {
  sceneSetMeasure(context, node, measure) {
    this.getYogaHost().assertMutable()
    const handle = this.handle(context, node)
    this.call(context, "scene_measure", { node: handle, enabled: Boolean(measure) })
    const measures = this.owner(context).measures
    if (measure) measures.set(node.slot, { handle: { ...node }, measure })
    else measures.delete(node.slot)
  },
  invokeSceneMeasure(context, contextId, slot, generation, width, widthMode, height, heightMode, output) {
    this.getYogaHost().invokeCallback(() => {
      const entry = this.owner(context).measures.get(slot)
      if (!entry || entry.handle.contextId !== contextId || entry.handle.generation !== generation) throw new Error("Native scene returned a stale measurement handle")
      const result = entry.measure(width, widthMode, height, heightMode)
      this.helpers.rejectAsyncCallback(result)
      output.set(new Float32Array([result?.width ?? NaN, result?.height ?? NaN]))
    })
  },
}
