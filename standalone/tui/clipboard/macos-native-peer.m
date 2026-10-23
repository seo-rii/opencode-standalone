/* Development-only native oracle, compiled together with the pinned upstream
 * macos-shim.m so image bytes are compared against its actual conversion. */
#import <AppKit/AppKit.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static NSPasteboard *native_board(const char *name) {
    return [NSPasteboard pasteboardWithName:[NSString stringWithUTF8String:name]];
}

int32_t NativeSet(const char *name, uint32_t type, const uint8_t *bytes, uint64_t length) {
    @autoreleasepool {
        @try {
            NSPasteboard *board = native_board(name);
            [board clearContents];
            if (type == 1) {
                NSString *text = [[NSString alloc] initWithBytes:bytes length:(NSUInteger)length encoding:NSUTF8StringEncoding];
                return text != nil && [board setString:text forType:NSPasteboardTypeString] ? 0 : 5;
            }
            NSData *data = [NSData dataWithBytes:bytes length:(NSUInteger)length];
            return [board setData:data forType:type == 2 ? NSPasteboardTypePNG : NSPasteboardTypeTIFF] ? 0 : 5;
        } @catch (__unused NSException *exception) { return 5; }
    }
}

int32_t NativeMakeTIFF(const char *name) {
    @autoreleasepool {
        @try {
            NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc]
                initWithBitmapDataPlanes:NULL pixelsWide:3 pixelsHigh:2 bitsPerSample:8
                samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace
                bytesPerRow:12 bitsPerPixel:32];
            if (bitmap == nil) return 5;
            const uint8_t pixels[24] = {255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255,
                                       255, 255, 255, 255, 0, 0, 0, 0, 20, 100, 200, 200};
            memcpy([bitmap bitmapData], pixels, sizeof(pixels));
            NSPasteboard *board = native_board(name);
            [board clearContents];
            return [board setData:[bitmap TIFFRepresentation] forType:NSPasteboardTypeTIFF] ? 0 : 5;
        } @catch (__unused NSException *exception) { return 5; }
    }
}

static int32_t native_copy(NSData *data, uint8_t **bytes, uint32_t *length) {
    if (data == nil || [data length] > UINT32_MAX) return 5;
    *length = (uint32_t)[data length];
    *bytes = malloc(*length == 0 ? 1 : *length);
    if (*bytes == NULL) return 5;
    if (*length > 0) memcpy(*bytes, [data bytes], *length);
    return 0;
}

int32_t NativeText(const char *name, uint8_t **bytes, uint32_t *length) {
    *bytes = NULL; *length = 0;
    @autoreleasepool {
        @try {
            NSString *text = [native_board(name) stringForType:NSPasteboardTypeString];
            return native_copy([text dataUsingEncoding:NSUTF8StringEncoding], bytes, length);
        } @catch (__unused NSException *exception) { return 5; }
    }
}

int32_t NativeOriginalPNG(const char *name, uint32_t max_bytes, uint32_t max_pixels,
                          uint32_t max_conversion, uint8_t **bytes, uint32_t *length) {
    *bytes = NULL; *length = 0;
    @autoreleasepool {
        @try {
            NSData *data = nil;
            int32_t status = ot_clipboard_macos_read_png(native_board(name), max_bytes,
                                                        max_pixels, max_conversion, NULL, NULL, &data);
            return status == 0 ? native_copy(data, bytes, length) : status;
        } @catch (__unused NSException *exception) { return 5; }
    }
}

void NativeFree(void *bytes) { free(bytes); }
void NativeRelease(const char *name) {
    @autoreleasepool { [native_board(name) releaseGlobally]; }
}
