#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern unsigned char *factoryInputPointer(void);
extern uint32_t factoryInputCapacity(void);
extern const unsigned char *factoryOutputPointer(void);
extern uint32_t factoryOutputLength(void);
extern uint32_t factoryCall(uint32_t length);
extern int32_t factoryBinaryReserve(uint32_t length);
extern uintptr_t factoryBinaryPointer(void);
extern uint32_t factoryBinaryGeneration(void);
extern int32_t factoryBinaryRelease(uint32_t generation);
extern const unsigned char *terminalOracleBinaryPointer(void);
extern uint32_t terminalOracleBinaryLength(void);

static int print_hex(const unsigned char *bytes, size_t length) {
    for (size_t i = 0; i < length; ++i) {
        if (printf("%02x", bytes[i]) < 0) return 0;
    }
    return 1;
}

// Terminal traces never install a host measurement provider. Keep an accidental
// callback explicit through NaN, matching the production provider failure lane.
void scene_measure(uint64_t context, uint32_t slot, uint32_t generation,
                   float width, uint32_t width_mode, float height,
                   uint32_t height_mode, float *output) {
    (void)context; (void)slot; (void)generation; (void)width; (void)width_mode;
    (void)height; (void)height_mode;
    output[0] = NAN;
    output[1] = NAN;
}

// Frames contain a decimal header and exact raw bytes: transfer/input/json
// lengths, then the input bytes and JSON request. No native pointer enters the
// request: the same relative spans and generations used by WASM are replayed.
int main(void) {
    char header[128];
    while (fgets(header, sizeof header, stdin)) {
        unsigned transfer, input_length, request_length;
        if (sscanf(header, "%u %u %u", &transfer, &input_length, &request_length) != 3 ||
            transfer > 1 || input_length > 256u * 1024u * 1024u ||
            request_length > factoryInputCapacity()) return 2;
        uint32_t generation = 0;
        if (transfer) {
            if (factoryBinaryReserve(input_length) != 0) return 3;
            generation = factoryBinaryGeneration();
            if (fread((void *)factoryBinaryPointer(), 1, input_length, stdin) != input_length) return 4;
        } else if (input_length) return 5;
        if (fread(factoryInputPointer(), 1, request_length, stdin) != request_length) return 6;
        uint32_t status = factoryCall(request_length);
        if (printf("{\"status\":%u,\"response\":", status) < 0 ||
            fwrite(factoryOutputPointer(), 1, factoryOutputLength(), stdout) != factoryOutputLength() ||
            fputs(",\"binary\":\"", stdout) == EOF) return 7;
        const unsigned char *binary = terminalOracleBinaryPointer();
        uint32_t binary_length = terminalOracleBinaryLength();
        if (!print_hex(binary, binary_length)) return 8;
        if (fputs("\",\"cells\":", stdout) == EOF) return 9;
        static char response[8 * 1024 * 1024 + 1];
        size_t response_length = factoryOutputLength();
        if (response_length >= sizeof response) return 12;
        memcpy(response, factoryOutputPointer(), response_length);
        response[response_length] = 0;
        const char *lanes[] = {"\"char\":", "\"fg\":", "\"bg\":", "\"attributes\":"};
        const char *width = strstr(response, "\"width\":");
        const char *height = strstr(response, "\"height\":");
        if (status == 0 && width && height && strstr(response, lanes[0]) && strstr(response, lanes[3])) {
            size_t cells = strtoul(width + 8, NULL, 10) * strtoul(height + 9, NULL, 10);
            if (cells > 1000000 || fputs("{", stdout) == EOF) return 13;
            const char *names[] = {"char", "fg", "bg", "attributes"};
            const size_t sizes[] = {4, 8, 8, 4};
            for (unsigned i = 0; i < 4; ++i) {
                const char *field = strstr(response, lanes[i]);
                if (!field) return 14;
                const unsigned char *bytes = (const unsigned char *)(uintptr_t)strtoull(field + strlen(lanes[i]), NULL, 10);
                if (printf("%s\"%s\":\"", i ? "," : "", names[i]) < 0 ||
                    !print_hex(bytes, cells * sizes[i]) || fputs("\"", stdout) == EOF) return 15;
            }
            if (fputs("}", stdout) == EOF) return 16;
        } else if (fputs("null", stdout) == EOF) return 17;
        if (fputs("}\n", stdout) == EOF) return 18;
        if (transfer && factoryBinaryRelease(generation) != 0) return 10;
    }
    return ferror(stdin) || fflush(stdout) == EOF ? 11 : 0;
}
