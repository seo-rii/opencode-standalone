import { createRequire } from "node:module"

/** All native pointers belong to this worker; no executable or addon is loaded. */
export function createMacOSNativeClipboard(configuration = {}) {
  const ffi = createRequire(import.meta.url)("node:ffi")
  const paths = {
    objc: "/usr/lib/libobjc.A.dylib",
    appkit: "/System/Library/Frameworks/AppKit.framework/AppKit",
    foundation: "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
    imageio: "/System/Library/Frameworks/ImageIO.framework/ImageIO",
    graphics: "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics",
    ...configuration.libraries,
  }
  const libraries = []
  const load = (path, definitions) => {
    const library = ffi.dlopen(path, definitions)
    libraries.push(library.lib)
    return library
  }
  let disposed = false
  try {
    const appkit = load(paths.appkit, {})
    const objc = load(paths.objc, {
      objc_getClass: { arguments: ["string"], return: "pointer" },
      sel_registerName: { arguments: ["string"], return: "pointer" },
      objc_autoreleasePoolPush: { arguments: [], return: "pointer" },
      objc_autoreleasePoolPop: { arguments: ["pointer"], return: "void" },
    })
    // Node 26.4 binds one signature per symbol and library. Separate handles
    // give objc_msgSend the fixed signatures required by Apple Silicon's ABI.
    const message = (arguments_, result) => load(paths.objc, {
      objc_msgSend: { arguments: ["pointer", "pointer", ...arguments_], return: result },
    }).functions.objc_msgSend
    const pointer0 = message([], "pointer")
    const pointer1 = message(["pointer"], "pointer")
    const unsigned0 = message([], "u64")
    const unsignedEncoding = message(["u64"], "u64")
    const integer0 = message([], "i64")
    const boolean2 = message(["pointer", "pointer"], "u8")
    const cf = load(paths.foundation, {
      CFRelease: { arguments: ["pointer"], return: "void" },
      CFStringCreateWithBytes: { arguments: ["pointer", "pointer", "i64", "u32", "u8"], return: "pointer" },
      CFDictionaryCreate: { arguments: ["pointer", "pointer", "pointer", "i64", "pointer", "pointer"], return: "pointer" },
      CFDictionaryGetValue: { arguments: ["pointer", "pointer"], return: "pointer" },
      CFNumberGetValue: { arguments: ["pointer", "i32", "pointer"], return: "u8" },
      CFBooleanGetValue: { arguments: ["pointer"], return: "u8" },
      CFEqual: { arguments: ["pointer", "pointer"], return: "u8" },
    })
    const io = load(paths.imageio, {
      CGImageSourceCreateWithData: { arguments: ["pointer", "pointer"], return: "pointer" },
      CGImageSourceCopyPropertiesAtIndex: { arguments: ["pointer", "u64", "pointer"], return: "pointer" },
      CGImageSourceCreateImageAtIndex: { arguments: ["pointer", "u64", "pointer"], return: "pointer" },
      CGImageDestinationCreateWithDataConsumer: { arguments: ["pointer", "pointer", "u64", "pointer"], return: "pointer" },
      CGImageDestinationAddImage: { arguments: ["pointer", "pointer", "pointer"], return: "void" },
      CGImageDestinationFinalize: { arguments: ["pointer"], return: "u8" },
    })
    const graphics = load(paths.graphics, {
      CGImageGetWidth: { arguments: ["pointer"], return: "u64" },
      CGImageGetHeight: { arguments: ["pointer"], return: "u64" },
      CGImageGetBytesPerRow: { arguments: ["pointer"], return: "u64" },
      CGDataConsumerCreate: { arguments: ["pointer", "pointer"], return: "pointer" },
    })
    const selectors = Object.fromEntries([
      "generalPasteboard", "pasteboardWithName:", "arrayWithObject:", "availableTypeFromArray:",
      "stringForType:", "dataForType:", "lengthOfBytesUsingEncoding:", "UTF8String", "length", "bytes",
      "clearContents", "setString:forType:",
    ].map((name) => [name, objc.functions.sel_registerName(name)]))
    const pasteboardClass = objc.functions.objc_getClass("NSPasteboard")
    const arrayClass = objc.functions.objc_getClass("NSArray")
    if (!pasteboardClass || !arrayClass) throw new Error("NSPasteboard classes are unavailable")
    const constant = (library, name) => ffi.getUint64(library.lib.getSymbol(name))
    const types = Object.fromEntries(["String", "PNG", "TIFF"].map((name) => [name, constant(appkit, `NSPasteboardType${name}`)]))
    const imageKeys = Object.fromEntries([
      "SourceShouldCache", "SourceShouldAllowFloat", "SourceShouldCacheImmediately",
      "PropertyPixelWidth", "PropertyPixelHeight", "PropertyDepth", "PropertyColorModel",
      "PropertyColorModelGray", "PropertyColorModelRGB", "PropertyColorModelLab", "PropertyHasAlpha", "PropertyOrientation",
    ].map((name) => [name, constant(io, `kCGImage${name}`)]))
    const booleans = { yes: constant(cf, "kCFBooleanTrue"), no: constant(cf, "kCFBooleanFalse") }
    const keyCallbacks = cf.lib.getSymbol("kCFTypeDictionaryKeyCallBacks")
    const valueCallbacks = cf.lib.getSymbol("kCFTypeDictionaryValueCallBacks")
    const maxImagePixels = BigInt(configuration.maxImagePixels ?? 64 * 1024 * 1024)
    const maxConversionBytes = BigInt(configuration.maxConversionBytes ?? 512 * 1024 * 1024)

    function stop(operation) {
      if (operation.signal?.aborted) return { status: "cancelled" }
      if (operation.deadline !== undefined && performance.now() >= operation.deadline) return { status: "timed-out" }
    }

    function withPasteboard(operation, callback) {
      if (disposed) throw new Error("The macOS clipboard is disposed")
      if (operation.selection === "primary") return { status: "unsupported" }
      const stopped = stop(operation)
      if (stopped) return stopped
      const pool = objc.functions.objc_autoreleasePoolPush()
      const owned = []
      const own = (pointer) => {
        if (!pointer) throw new Error("A macOS clipboard object could not be created")
        owned.push(pointer)
        return pointer
      }
      const string = (text) => {
        const bytes = Buffer.from(text)
        return own(cf.functions.CFStringCreateWithBytes(null, bytes, BigInt(bytes.length), 0x08000100, 0))
      }
      try {
        const pasteboard = configuration.pasteboardName === undefined
          ? pointer0(pasteboardClass, selectors.generalPasteboard)
          : pointer1(pasteboardClass, selectors["pasteboardWithName:"], string(configuration.pasteboardName))
        if (!pasteboard) throw new Error("NSPasteboard is unavailable")
        return callback(pasteboard, { own, string })
      } catch (error) {
        return { status: "failed", error: error instanceof Error ? error : new Error(String(error)) }
      } finally {
        for (const pointer of owned.reverse()) cf.functions.CFRelease(pointer)
        objc.functions.objc_autoreleasePoolPop(pool)
      }
    }

    function available(pasteboard, type) {
      const array = pointer1(arrayClass, selectors["arrayWithObject:"], type)
      return Boolean(pointer1(pasteboard, selectors["availableTypeFromArray:"], array))
    }

    function dictionary(entries, own) {
      const keys = Buffer.alloc(entries.length * 8)
      const values = Buffer.alloc(entries.length * 8)
      entries.forEach(([key, value], index) => {
        keys.writeBigUInt64LE(key, index * 8)
        values.writeBigUInt64LE(value, index * 8)
      })
      return own(cf.functions.CFDictionaryCreate(null, keys, values, BigInt(entries.length), keyCallbacks, valueCallbacks))
    }

    function readBytes(object, mimeType, maxBytes, operation) {
      const length = mimeType === "text/plain"
        ? unsignedEncoding(object, selectors["lengthOfBytesUsingEncoding:"], 4n)
        : unsigned0(object, selectors.length)
      const stopped = stop(operation)
      if (stopped) return stopped
      if (length > BigInt(maxBytes) || length > 0xffffffffn) return { status: "limit-exceeded" }
      if (!length) return { status: "read", representation: { mimeType, bytes: Buffer.alloc(0) } }
      const bytes = pointer0(object, mimeType === "text/plain" ? selectors.UTF8String : selectors.bytes)
      if (!bytes) throw new Error("NSPasteboard returned absent bytes for nonempty data")
      return { status: "read", representation: { mimeType, bytes: ffi.toBuffer(bytes, Number(length)) } }
    }

    function readPNG(pasteboard, operation, resources) {
      let pngFailed = false
      if (available(pasteboard, types.PNG)) {
        const png = pointer1(pasteboard, selectors["dataForType:"], types.PNG)
        const stopped = stop(operation)
        if (stopped) return stopped
        if (png && unsigned0(png, selectors.length)) return readBytes(png, "image/png", operation.maxBytes, operation)
        pngFailed = !png
      }
      if (!available(pasteboard, types.TIFF)) return pngFailed ? { status: "failed", error: new Error("NSPasteboard PNG read failed") } : { status: "empty" }
      const tiff = pointer1(pasteboard, selectors["dataForType:"], types.TIFF)
      if (!tiff) throw new Error("NSPasteboard TIFF read failed")
      const stopped = stop(operation)
      if (stopped) return stopped
      const length = unsigned0(tiff, selectors.length)
      if (!length) return pngFailed ? { status: "failed", error: new Error("NSPasteboard PNG read failed") } : { status: "empty" }
      if (length > maxConversionBytes) return { status: "limit-exceeded" }
      const metadataOptions = dictionary([[imageKeys.SourceShouldCache, booleans.no]], resources.own)
      const source = resources.own(io.functions.CGImageSourceCreateWithData(tiff, metadataOptions))
      const properties = resources.own(io.functions.CGImageSourceCopyPropertiesAtIndex(source, 0n, metadataOptions))
      if (stop(operation)) return stop(operation)
      const number = (key) => {
        const value = cf.functions.CFDictionaryGetValue(properties, key)
        const output = Buffer.alloc(8)
        if (!value || !cf.functions.CFNumberGetValue(value, 4, output)) throw new Error("TIFF image metadata is incomplete")
        return output.readBigUInt64LE()
      }
      const width = number(imageKeys.PropertyPixelWidth)
      const height = number(imageKeys.PropertyPixelHeight)
      const depth = number(imageKeys.PropertyDepth)
      if (!width || !height || !depth || depth > 64n) throw new Error("TIFF image dimensions or depth are invalid")
      if (width > maxImagePixels || height > maxImagePixels / width) return { status: "limit-exceeded" }
      const model = cf.functions.CFDictionaryGetValue(properties, imageKeys.PropertyColorModel)
      const components = model && cf.functions.CFEqual(model, imageKeys.PropertyColorModelGray) ? 1n
        : model && (cf.functions.CFEqual(model, imageKeys.PropertyColorModelRGB) || cf.functions.CFEqual(model, imageKeys.PropertyColorModelLab)) ? 3n : 4n
      const alpha = cf.functions.CFDictionaryGetValue(properties, imageKeys.PropertyHasAlpha)
      const bytesPerPixel = (components + (alpha && cf.functions.CFBooleanGetValue(alpha) ? 1n : 0n)) * ((depth + 7n) / 8n)
      if (width * height > maxConversionBytes / bytesPerPixel) return { status: "limit-exceeded" }
      const decodeOptions = dictionary([
        [imageKeys.SourceShouldAllowFloat, booleans.no], [imageKeys.SourceShouldCacheImmediately, booleans.yes],
      ], resources.own)
      const image = resources.own(io.functions.CGImageSourceCreateImageAtIndex(source, 0n, decodeOptions))
      if (stop(operation)) return stop(operation)
      if (graphics.functions.CGImageGetWidth(image) !== width || graphics.functions.CGImageGetHeight(image) !== height) throw new Error("TIFF decoded dimensions changed")
      if (graphics.functions.CGImageGetBytesPerRow(image) > maxConversionBytes / height) return { status: "limit-exceeded" }
      const chunks = []
      let outputLength = 0
      let outputStatus
      let consumer
      let destination
      const callback = graphics.lib.registerCallback({ arguments: ["pointer", "pointer", "u64"], return: "u64" }, (_context, bytes, count) => {
        // ImageIO writes synchronously during destination finalization. Never
        // allow a JS exception to cross the native callback boundary.
        try {
          outputStatus ??= stop(operation)
          if (outputStatus) return 0n
          if (count > BigInt(operation.maxBytes - outputLength)) {
            outputStatus = { status: "limit-exceeded" }
            return 0n
          }
          if (count) chunks.push(ffi.toBuffer(bytes, Number(count)))
          outputLength += Number(count)
          return count
        } catch (error) {
          outputStatus = { status: "failed", error: error instanceof Error ? error : new Error(String(error)) }
          return 0n
        }
      })
      const callbacks = Buffer.alloc(16)
      callbacks.writeBigUInt64LE(callback)
      try {
        consumer = graphics.functions.CGDataConsumerCreate(null, callbacks)
        if (!consumer) throw new Error("TIFF PNG consumer creation failed")
        destination = io.functions.CGImageDestinationCreateWithDataConsumer(consumer, resources.string("public.png"), 1n, null)
        if (!destination) throw new Error("TIFF PNG destination creation failed")
        const orientation = cf.functions.CFDictionaryGetValue(properties, imageKeys.PropertyOrientation)
        const outputProperties = orientation ? dictionary([[imageKeys.PropertyOrientation, orientation]], resources.own) : null
        io.functions.CGImageDestinationAddImage(destination, image, outputProperties)
        const finalized = io.functions.CGImageDestinationFinalize(destination)
        const stopped = stop(operation)
        if (stopped) return stopped
        if (outputStatus) return outputStatus
        if (!finalized || !outputLength) throw new Error("TIFF PNG conversion failed")
        return { status: "read", representation: { mimeType: "image/png", bytes: Buffer.concat(chunks, outputLength) } }
      } finally {
        if (destination) cf.functions.CFRelease(destination)
        if (consumer) cf.functions.CFRelease(consumer)
        // Keep the native callback-table storage alive until its consumer is gone.
        callbacks.fill(0)
        graphics.lib.unregisterCallback(callback)
      }
    }

    return {
      read(operation) {
        return withPasteboard(operation, (pasteboard, resources) => {
          let supported = false
          let firstFailure
          for (const mime of operation.preferredTypes) {
            const stopped = stop(operation)
            if (stopped) return stopped
            if (mime !== "text/plain" && mime !== "image/png") continue
            supported = true
            let result
            try {
              if (mime === "image/png") result = readPNG(pasteboard, operation, resources)
              if (mime === "text/plain") {
                if (!available(pasteboard, types.String)) continue
                const text = pointer1(pasteboard, selectors["stringForType:"], types.String)
                if (!text) throw new Error("NSPasteboard text read failed")
                result = readBytes(text, mime, operation.maxBytes, operation)
              }
            } catch (error) { result = { status: "failed", error: error instanceof Error ? error : new Error(String(error)) } }
            if (result?.status === "failed") { firstFailure ??= result; continue }
            if (result && result.status !== "empty") return result
          }
          return firstFailure ?? { status: supported ? "empty" : "unsupported" }
        })
      },
      writeText(text, operation) {
        return withPasteboard(operation, (pasteboard, resources) => {
          const value = resources.string(text)
          const stopped = stop(operation)
          if (stopped) return stopped
          if (operation.beginMutation && !operation.beginMutation()) return stop(operation) ?? { status: "cancelled" }
          integer0(pasteboard, selectors.clearContents)
          if (!boolean2(pasteboard, selectors["setString:forType:"], value, types.String)) throw new Error("NSPasteboard text write failed")
          return { status: "written" }
        })
      },
      clear(operation) {
        return withPasteboard(operation, (pasteboard) => {
          const stopped = stop(operation)
          if (stopped) return stopped
          if (operation.beginMutation && !operation.beginMutation()) return stop(operation) ?? { status: "cancelled" }
          integer0(pasteboard, selectors.clearContents)
          return { status: "cleared" }
        })
      },
      dispose() {
        if (disposed) return
        disposed = true
        for (const library of libraries.reverse()) library.close()
      },
    }
  } catch (error) {
    for (const library of libraries.reverse()) library.close()
    throw error
  }
}
