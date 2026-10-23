#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

extern uint32_t convertClipboardImage(const unsigned char *, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, unsigned char **, uint32_t *);
extern void freeClipboardImage(unsigned char *, uint32_t);

int main(void) {
    uint32_t header[5];
    while (fread(header, 1, sizeof header, stdin) == sizeof header) {
        if (header[0] > 8 * 1024 * 1024) return 2;
        unsigned char *input = malloc(header[0] ? header[0] : 1);
        if (!input || fread(input, 1, header[0], stdin) != header[0]) return 2;
        unsigned char *output = NULL;
        uint32_t output_length = 0;
        uint32_t result[2];
        result[0] = convertClipboardImage(input, header[0], header[1], header[2], header[3], header[4], &output, &output_length);
        result[1] = output_length;
        free(input);
        if (fwrite(result, 1, sizeof result, stdout) != sizeof result ||
            (output_length && fwrite(output, 1, output_length, stdout) != output_length)) return 3;
        if (output) freeClipboardImage(output, output_length);
    }
    return ferror(stdin) || fflush(stdout) == EOF ? 3 : 0;
}
