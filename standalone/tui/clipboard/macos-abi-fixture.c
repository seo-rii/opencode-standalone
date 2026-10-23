/* Development-only C ABI oracle. This is not AppKit and is never bundled. */
#include <stdint.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

typedef struct object object;
struct object {
    int kind, references;
    uint8_t *bytes;
    size_t length;
    uint64_t number;
    object *keys[16], *values[16], *next;
    void *context;
    size_t (*put)(void *, const void *, size_t);
};

static uint64_t counters[16];
static _Thread_local object *autoreleased;
static object pasteboard = {.kind = 1, .references = -1};
static object array_class = {.kind = 2, .references = -1};
static object string_type = {.kind = 3, .references = -1};
static object png_type = {.kind = 4, .references = -1};
static object tiff_type = {.kind = 5, .references = -1};
static object true_value = {.kind = 6, .references = -1, .number = 1};
static object false_value = {.kind = 6, .references = -1, .number = 0};

#define GLOBAL(name) static object value_##name = {.references = -1}; object *name = &value_##name
GLOBAL(kCGImageSourceShouldCache);
GLOBAL(kCGImageSourceShouldAllowFloat);
GLOBAL(kCGImageSourceShouldCacheImmediately);
GLOBAL(kCGImagePropertyPixelWidth);
GLOBAL(kCGImagePropertyPixelHeight);
GLOBAL(kCGImagePropertyDepth);
GLOBAL(kCGImagePropertyColorModel);
GLOBAL(kCGImagePropertyColorModelGray);
GLOBAL(kCGImagePropertyColorModelRGB);
GLOBAL(kCGImagePropertyColorModelLab);
GLOBAL(kCGImagePropertyHasAlpha);
GLOBAL(kCGImagePropertyOrientation);
object *NSPasteboardTypeString = &string_type;
object *NSPasteboardTypePNG = &png_type;
object *NSPasteboardTypeTIFF = &tiff_type;
object *kCFBooleanTrue = &true_value;
object *kCFBooleanFalse = &false_value;
uint8_t kCFTypeDictionaryKeyCallBacks[48];
uint8_t kCFTypeDictionaryValueCallBacks[40];

static object *text, *png, *tiff, *output;
static uint32_t failures;
static int text_present, png_present, tiff_present, text_fail, png_fail, tiff_fail;
static object width_value = {.references = -1}, height_value = {.references = -1};
static object depth_value = {.references = -1}, orientation_value = {.references = -1};
static uint64_t row_bytes, decoded_width, decoded_height;
static object *color_model;
static int has_alpha;

static object *make(int kind) {
    object *value = calloc(1, sizeof(*value));
    if (!value) abort();
    value->kind = kind;
    value->references = 1;
    counters[5]++;
    return value;
}

static object *make_bytes(const uint8_t *bytes, uint64_t length) {
    object *value = make(10);
    value->bytes = malloc((size_t)length + 1);
    if (!value->bytes) abort();
    if (length) memcpy(value->bytes, bytes, (size_t)length);
    value->bytes[length] = 0;
    value->length = (size_t)length;
    return value;
}

void CFRelease(object *value) {
    if (!value || value->references < 0 || --value->references) return;
    if (value->kind == 11) for (size_t index = 0; index < value->length; index++) {
        CFRelease(value->keys[index]);
        CFRelease(value->values[index]);
    }
    if (value->kind == 14) counters[9]++;
    counters[5]--;
    free(value->bytes);
    free(value);
}

static void retain(object *value) { if (value && value->references >= 0) value->references++; }

void FixtureReset(void) {
    CFRelease(text); CFRelease(png); CFRelease(tiff); CFRelease(output);
    text = png = tiff = output = NULL;
    text_present = png_present = tiff_present = text_fail = png_fail = tiff_fail = 0;
    failures = 0;
    memset(counters, 0, sizeof(counters));
    width_value.number = height_value.number = decoded_width = decoded_height = 1;
    depth_value.number = 8;
    row_bytes = 4;
    color_model = kCGImagePropertyColorModelRGB;
    has_alpha = 1;
    orientation_value.number = 0;
}

void FixtureSetText(const uint8_t *bytes, uint64_t length, uint32_t state) {
    CFRelease(text); text = make_bytes(bytes, length); text_present = state != 0; text_fail = state == 2;
}
void FixtureSetPNG(const uint8_t *bytes, uint64_t length, uint32_t state) {
    CFRelease(png); png = make_bytes(bytes, length); png_present = state != 0; png_fail = state == 2;
}
void FixtureSetTIFF(const uint8_t *bytes, uint64_t length, uint32_t state) {
    CFRelease(tiff); tiff = make_bytes(bytes, length); tiff_present = state != 0; tiff_fail = state == 2;
}
void FixtureSetOutput(const uint8_t *bytes, uint64_t length) {
    CFRelease(output); output = make_bytes(bytes, length);
}
void FixtureSetImage(uint64_t width, uint64_t height, uint64_t depth, uint32_t model, uint32_t alpha, uint64_t stride) {
    width_value.number = decoded_width = width;
    height_value.number = decoded_height = height;
    depth_value.number = depth;
    row_bytes = stride;
    has_alpha = alpha;
    color_model = model == 1 ? kCGImagePropertyColorModelGray : model == 2 ? kCGImagePropertyColorModelRGB : model == 3 ? kCGImagePropertyColorModelLab : &pasteboard;
}
void FixtureSetDecodedSize(uint64_t width, uint64_t height) { decoded_width = width; decoded_height = height; }
void FixtureSetOrientation(uint64_t value) { orientation_value.number = value; }
void FixtureSetFailure(uint32_t value) { failures = value; }
uint64_t FixtureCounter(uint32_t index) { return index < 16 ? counters[index] : 0; }
uint64_t FixtureTextLength(void) { return text ? text->length : 0; }
const uint8_t *FixtureTextBytes(void) { return text ? text->bytes : NULL; }

void *objc_getClass(const char *name) {
    if (!strcmp(name, "NSPasteboard")) return &pasteboard;
    if (!strcmp(name, "NSArray")) return &array_class;
    return NULL;
}
void *sel_registerName(const char *name) {
    static char *selectors[64];
    static size_t count;
    for (size_t index = 0; index < count; index++) if (!strcmp(selectors[index], name)) return selectors[index];
    if (count == 64) abort();
    selectors[count] = strdup(name);
    return selectors[count++];
}
void *objc_autoreleasePoolPush(void) {
    object *previous = autoreleased;
    autoreleased = NULL;
    counters[6]++;
    return previous;
}
void objc_autoreleasePoolPop(object *previous) {
    while (autoreleased) { object *next = autoreleased->next; CFRelease(autoreleased); autoreleased = next; }
    autoreleased = previous;
    counters[6]--;
}

uintptr_t objc_msgSend(object *receiver, const char *selector, ...) {
    va_list arguments;
    va_start(arguments, selector);
    uintptr_t result = 0;
    if (!strcmp(selector, "generalPasteboard") || !strcmp(selector, "pasteboardWithName:")) result = (uintptr_t)&pasteboard;
    else if (!strcmp(selector, "arrayWithObject:")) {
        object *array = make(12);
        array->values[0] = va_arg(arguments, object *);
        array->next = autoreleased;
        autoreleased = array;
        result = (uintptr_t)array;
    } else if (!strcmp(selector, "availableTypeFromArray:")) {
        object *type = va_arg(arguments, object *)->values[0];
        result = (uintptr_t)(type == &string_type ? text_present ? type : NULL : type == &png_type ? png_present ? type : NULL : tiff_present ? type : NULL);
    } else if (!strcmp(selector, "stringForType:")) result = text_fail ? 0 : (uintptr_t)text;
    else if (!strcmp(selector, "dataForType:")) {
        object *type = va_arg(arguments, object *);
        result = type == &png_type ? png_fail ? 0 : (uintptr_t)png : tiff_fail ? 0 : (uintptr_t)tiff;
    } else if (!strcmp(selector, "lengthOfBytesUsingEncoding:")) {
        if (va_arg(arguments, uint64_t) != 4) counters[7]++;
        result = receiver->length;
    } else if (!strcmp(selector, "length")) result = receiver->length;
    else if (!strcmp(selector, "UTF8String") || !strcmp(selector, "bytes")) result = (uintptr_t)receiver->bytes;
    else if (!strcmp(selector, "clearContents")) {
        counters[1]++;
        text_present = png_present = tiff_present = 0;
        result = counters[1];
    } else if (!strcmp(selector, "setString:forType:")) {
        object *value = va_arg(arguments, object *);
        object *type = va_arg(arguments, object *);
        counters[2]++;
        if (type == &string_type && !(failures & 64)) {
            CFRelease(text); text = make_bytes(value->bytes, value->length); text_present = 1; text_fail = 0; result = 1;
        }
    } else abort();
    va_end(arguments);
    return result;
}

object *CFStringCreateWithBytes(void *allocator, const uint8_t *bytes, int64_t length, uint32_t encoding, uint8_t external) {
    (void)allocator; (void)external;
    if (encoding != 0x08000100) counters[7]++;
    return make_bytes(bytes, (uint64_t)length);
}
object *CFDictionaryCreate(void *allocator, object **keys, object **values, int64_t count, void *key_callbacks, void *value_callbacks) {
    (void)allocator;
    if (key_callbacks != kCFTypeDictionaryKeyCallBacks || value_callbacks != kCFTypeDictionaryValueCallBacks || count > 16) abort();
    object *dictionary = make(11);
    dictionary->length = (size_t)count;
    for (size_t index = 0; index < dictionary->length; index++) {
        dictionary->keys[index] = keys[index]; dictionary->values[index] = values[index];
        retain(keys[index]); retain(values[index]);
    }
    return dictionary;
}
void *CFDictionaryGetValue(object *dictionary, object *key) {
    if (dictionary->kind == 13) {
        if (key == kCGImagePropertyPixelWidth) return &width_value;
        if (key == kCGImagePropertyPixelHeight) return &height_value;
        if (key == kCGImagePropertyDepth) return &depth_value;
        if (key == kCGImagePropertyColorModel) return color_model;
        if (key == kCGImagePropertyHasAlpha) return has_alpha ? kCFBooleanTrue : kCFBooleanFalse;
        if (key == kCGImagePropertyOrientation) return orientation_value.number ? &orientation_value : NULL;
        return NULL;
    }
    for (size_t index = 0; index < dictionary->length; index++) if (dictionary->keys[index] == key) return dictionary->values[index];
    return NULL;
}
uint8_t CFNumberGetValue(object *number, int32_t type, void *out) { if (type != 4) abort(); memcpy(out, &number->number, 8); return 1; }
uint8_t CFBooleanGetValue(object *boolean) { return boolean->number != 0; }
uint8_t CFEqual(object *first, object *second) { return first == second; }

object *CGImageSourceCreateWithData(object *data, object *options) {
    if (data != tiff || CFDictionaryGetValue(options, kCGImageSourceShouldCache) != kCFBooleanFalse) abort();
    counters[11]++;
    return failures & 1 ? NULL : make(15);
}
object *CGImageSourceCopyPropertiesAtIndex(object *source, uint64_t index, object *options) {
    (void)source; (void)options; if (index) abort(); return failures & 2 ? NULL : make(13);
}
object *CGImageSourceCreateImageAtIndex(object *source, uint64_t index, object *options) {
    (void)source; if (index) abort();
    if (CFDictionaryGetValue(options, kCGImageSourceShouldAllowFloat) != kCFBooleanFalse || CFDictionaryGetValue(options, kCGImageSourceShouldCacheImmediately) != kCFBooleanTrue) abort();
    counters[3]++; counters[12]++;
    return failures & 4 ? NULL : make(16);
}
uint64_t CGImageGetWidth(object *image) { (void)image; return decoded_width; }
uint64_t CGImageGetHeight(object *image) { (void)image; return decoded_height; }
uint64_t CGImageGetBytesPerRow(object *image) { (void)image; return row_bytes; }
object *CGDataConsumerCreate(void *context, void **callbacks) {
    object *consumer = make(14);
    consumer->context = context;
    memcpy(&consumer->put, callbacks, sizeof(consumer->put));
    if (callbacks[1]) abort();
    return consumer;
}
object *CGImageDestinationCreateWithDataConsumer(object *consumer, object *type, uint64_t count, void *options) {
    if (strcmp((const char *)type->bytes, "public.png") || count != 1 || options) abort();
    if (failures & 8) return NULL;
    object *destination = make(17); destination->values[0] = consumer; return destination;
}
void CGImageDestinationAddImage(object *destination, object *image, object *properties) {
    (void)destination; (void)image;
    if (properties) {
        object *orientation = CFDictionaryGetValue(properties, kCGImagePropertyOrientation);
        counters[8] = orientation ? orientation->number : 0;
    }
}
uint8_t CGImageDestinationFinalize(object *destination) {
    counters[4]++;
    if (failures & 16 || !output) return 0;
    object *consumer = destination->values[0];
    const size_t first = output->length / 2;
    counters[10]++;
    if (consumer->put(consumer->context, output->bytes, first) != first) return 0;
    counters[10]++;
    if (consumer->put(consumer->context, output->bytes + first, output->length - first) != output->length - first) return 0;
    return 1;
}
