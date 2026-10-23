const imageStatuses = ["OT_OK", "OT_STALE_HANDLE", "OT_IMAGE_UNSUPPORTED_FORMAT", "OT_IMAGE_UNSUPPORTED_COLOR_SPACE", "OT_IMAGE_MALFORMED_DATA", "OT_IMAGE_DIMENSION_LIMIT", "OT_IMAGE_MEMORY_LIMIT", "OT_INVALID_ARGUMENT", "OT_OUT_OF_MEMORY", "OT_IMAGE_OUTPUT_TOO_SMALL", "OT_INTERNAL_ERROR", "OT_IMAGE_UNSUPPORTED_FEATURE", "OT_IMAGE_BUSY"]
const pixelPointers = new WeakMap()
const emptyInfo = { width: 0, height: 0, sourceWidth: 0, sourceHeight: 0, format: 0, colorStatus: 0, orientation: 0, hasAlpha: 0 }

/** Host seam for the published NativeImage.takeRaw() memory constructor. */
export function createStandaloneImageMemoryView(pointer, byteLength) {
  const value = pixelPointers.get(pointer)
  if (!value || !value.active || value.owner.closed) throw new Error("WASM image pixel lease has ended")
  if (!Number.isInteger(byteLength) || byteLength < 0 || byteLength > value.length) throw new RangeError("WASM image view exceeds its checked pixel lease")
  return new Uint8Array(value.owner.transport.buffer, value.offset, byteLength)
}

/** Preserve the published image status contract around the actual checked ABI. */
export const imageMethods = {
  imageCall(context, operation, request, transfer) {
    try {
      const value = this.getYogaHost().runMutation(() => this.call(context, "image", request, transfer))
      return { status: 0, value }
    } catch (error) {
      if (!(error instanceof this.helpers.NativeError)) throw error
      const status = imageStatuses.findIndex((name) => this.helpers.nativeConstants[name] === error.status)
      if (status < 0) throw Object.assign(new this.helpers.NativeError(operation, error.status), { cause: error })
      return { status, value: undefined }
    }
  },
  imageOutput(context, operation, request, transfer) {
    const result = this.imageCall(context, operation, request, transfer)
    return { status: result.status, handle: result.status === 0 ? this.issued(context, result.value) : null }
  },
  imageInfoOutput(context, operation, request, transfer) {
    const result = this.imageCall(context, operation, request, transfer)
    const info = result.value
    return { status: result.status, info: result.status === 0 ? { width: info.width, height: info.height, sourceWidth: info.source_width, sourceHeight: info.source_height, format: info.format, colorStatus: info.color_status, orientation: info.orientation, hasAlpha: info.has_alpha } : { ...emptyInfo } }
  },
  imageInfo(context, data) { return this.imageInfoOutput(context, "ot_image_inspect", ([bytes]) => ({ inspect: { bytes } }), { input: [bytes(data)] }) },
  imageDecode(context, data) { return this.imageOutput(context, "ot_image_decode", ([bytes]) => ({ decode: { bytes } }), { input: [bytes(data)] }) },
  imageCreateFromRgba(context, pixels, width, height, stride) { return this.imageCreateFromPixels(context, pixels, width, height, stride, 0, 0) },
  imageCreateFromPixels(context, pixels, width, height, stride, format, alpha) {
    const options = { width: u32(width), height: u32(height), stride: u32(stride), format: u32(format), alpha: u32(alpha) }
    return this.imageOutput(context, "ot_image_create_pixels", ([bytes]) => ({ create: { bytes, ...options } }), { input: [bytes(pixels)] })
  },
  imageUpdatePixels(image, pixels, stride, format, alpha) {
    const options = { image: this.handle(image.context, image), stride: u32(stride), format: u32(format), alpha: u32(alpha) }
    return this.imageCall(image.context, "ot_image_update_pixels", ([bytes]) => ({ update: { bytes, ...options } }), { input: [bytes(pixels)] }).status
  },
  destroyContextImage(context, image) { return this.mutate(context, "image", { destroy: { image: this.handle(context, image) } }) },
  imageDestroy(image) { return this.destroyContextImage(image.context, image) },
  imageRetain(image) { return this.imageOutput(image.context, "ot_image_retain", { retain: { image: this.handle(image.context, image) } }) },
  imageGetInfo(image) { return this.imageInfoOutput(image.context, "ot_image_get_info", { info: { image: this.handle(image.context, image) } }) },
  imageClone(image, context = image.context) {
    const handle = this.handle(image.context, image)
    if (context === image.context) return this.imageOutput(context, "ot_image_clone", { clone: { image: handle } })
    // Each public Context has independent linear memory. Copy the real Image
    // snapshot, including source metadata, lazy state and original encoded PNG,
    // through Context.importImage; decoding a new PNG would change its format.
    const result = this.imageCall(image.context, "ot_image_clone", { snapshot: { image: handle } }, {
      read: (snapshot, view) => this.imageOutput(context, "ot_image_clone", ([pixels, png]) => ({ restore: { ...snapshot, pixels, encoded_png: png ?? null } }), {
        input: [view(snapshot.pixels), ...(snapshot.encoded_png === null ? [] : [view(snapshot.encoded_png)])],
      }),
    })
    return result.status === 0 ? result.value : { status: result.status, handle: null }
  },
  imageCopyPixels(image, destination, stride, bgra) {
    bytes(destination)
    u32(stride)
    if (typeof bgra !== "boolean") throw new TypeError("Image BGRA must be a boolean")
    return this.imageCall(image.context, "ot_image_copy_pixels", { copy_pixels: { image: this.handle(image.context, image), capacity: destination.byteLength, stride, format: Number(bgra) } }, {
      read: (result, view) => {
        const output = view(result.bytes)
        // Native copy_pixels writes only each row's pixel bytes. Keep padding
        // and unused capacity unchanged, including the final row's tail.
        for (let row = 0; row < result.height; row++) destination.set(output.subarray(row * result.stride, row * result.stride + result.width * 4), row * stride)
      },
    }).status
  },
  imageEnsureEncodedPng(image) { return this.imageCopyPng(image, new Uint8Array()).status },
  imageCopyPng(image, destination) {
    bytes(destination)
    const handle = this.handle(image.context, image)
    if (destination.byteLength === 0) {
      const result = this.imageCall(image.context, "ot_image_copy_png", { png_size: { image: handle } })
      return { status: result.status, byteCount: result.status === 0 ? result.value : 0 }
    }
    const result = this.imageCall(image.context, "ot_image_copy_png", { copy_png: { image: handle, capacity: destination.byteLength } }, {
      read: (result, view) => {
        const output = view(result)
        destination.set(output)
        return output.length
      },
    })
    if (result.status !== 0) return { status: result.status, byteCount: 0 }
    return { status: 0, byteCount: result.value }
  },
  imageTakePixels(image) {
    const context = image.context
    const result = this.imageCall(context, "ot_image_take_pixels", { take_pixels: { image: this.handle(context, image) } })
    if (result.status !== 0) return { status: result.status, lease: null, pointer: null, byteCount: 0 }
    const value = result.value
    const lease = this.issued(context, value.lease)
    try {
      const owner = this.owner(context)
      if (!Number.isInteger(value.pixels) || value.pixels < 0 || !Number.isInteger(value.byte_count) || value.byte_count < 0 || value.pixels + value.byte_count > owner.transport.buffer.byteLength) throw new RangeError("Native image pixels exceed linear memory")
      const state = { owner, active: true, offset: value.pixels, length: value.byte_count }
      const pointer = Object.freeze({})
      pixelPointers.set(pointer, state)
      this.imagePixelLeases.set(lease, state)
      return { status: 0, lease, pointer, byteCount: value.byte_count }
    } catch (error) {
      this.mutate(context, "image", { release_pixels: { lease: this.handle(context, lease) } })
      throw error
    }
  },
  imageReleasePixels(lease) {
    this.mutate(lease.context, "image", { release_pixels: { lease: this.handle(lease.context, lease) } })
    const state = this.imagePixelLeases?.get(lease)
    if (state) state.active = false
  },
  imageResize(image, width, height, filter) { return this.imageOutput(image.context, "ot_image_resize", { resize: { image: this.handle(image.context, image), width: u32(width), height: u32(height), filter: u32(filter) } }) },
  imageExtract(image, left, top, width, height) { return this.imageOutput(image.context, "ot_image_extract", { extract: { image: this.handle(image.context, image), left: u32(left), top: u32(top), width: u32(width), height: u32(height) } }) },
  imageExtend(image, top, right, bottom, left, background) {
    if (!(background instanceof Uint8Array) || background.byteLength !== 4) return { status: 7, handle: null }
    return this.imageOutput(image.context, "ot_image_extend", { extend: { image: this.handle(image.context, image), top: u32(top), right: u32(right), bottom: u32(bottom), left: u32(left), background: Array.from(background) } })
  },
  imageTransform(image, operation) { return this.imageOutput(image.context, "ot_image_transform", { transform: { image: this.handle(image.context, image), operation: u32(operation) } }) },
  imageComposite(base, overlay, left, top, blend, opacity) {
    if (u32(opacity) > 255) throw new RangeError("Image opacity must be an integer from 0 to 255")
    return this.imageOutput(base.context, "ot_image_composite", { composite: { base: this.handle(base.context, base), overlay: this.handle(base.context, overlay), left: i32(left), top: i32(top), blend: u32(blend), opacity } })
  },
  sceneSetImage(context, node, image, fit, protocol, buffer) {
    const fitId = ["fit", "cover", "fill"].indexOf(fit)
    const protocolId = ["auto", "kitty", "sixel", "blocks"].indexOf(protocol)
    if (fitId < 0 || protocolId < 0) throw new TypeError("Unknown image fit or protocol")
    return this.mutate(context, "image", { scene: { node: this.handle(context, node), image: image === null ? null : this.handle(context, image), fit: fitId, protocol: protocolId, buffer: buffer === null ? null : this.handle(context, buffer) } })
  },
  contextDrawImage(drawing, image, options) {
    const record = new Uint32Array(this.helpers.nativeLayouts.ot_image_draw_options.size / 4)
    this.helpers.encodeImageDrawOptions(options, record, new Int32Array(record.buffer), 0)
    return this.mutate(drawing.context, "image", { draw: { target: this.handle(drawing.context, drawing.target), frame: this.frame(drawing.context, drawing.frame ?? null), image: this.handle(drawing.context, image), record: Buffer.from(record.buffer).toString("base64") } })
  },
  imageRetainIccCache() {
    this.getYogaHost().assertMutable()
    this.imageIccClients = (this.imageIccClients ?? 0) + 1
    for (const context of this.contexts.keys()) this.mutate(context, "image", { icc_retain: {} })
  },
  imageReleaseIccCache() {
    this.getYogaHost().assertMutable()
    if (!this.imageIccClients) throw new RangeError("Image ICC cache has no retained client")
    this.imageIccClients--
    for (const context of this.contexts.keys()) this.mutate(context, "image", { icc_release: {} })
  },
}

function bytes(value) {
  if (!(value instanceof Uint8Array)) throw new TypeError("Image bytes must be a Uint8Array")
  return value
}
function u32(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError("Image argument must be a u32 integer")
  return value
}
function i32(value) {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new RangeError("Image argument must be an i32 integer")
  return value
}
