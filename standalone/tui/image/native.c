#include <stdint.h>
#include <stdio.h>
#include <string.h>

extern unsigned char *imageInputPointer(void);
extern uint32_t imageInputCapacity(void);
extern const unsigned char *imageOutputPointer(void);
extern uint32_t imageOutputLength(void);
extern uint32_t imageCall(uint32_t length);

int main(void) {
    static char request[1024 * 1024 + 2];
    while (fgets(request, sizeof request, stdin) != NULL) {
        size_t length = strlen(request);
        if (length && request[length - 1] == '\n') --length;
        if (length > imageInputCapacity()) return 2;
        memcpy(imageInputPointer(), request, length);
        uint32_t status = imageCall((uint32_t)length);
        if (printf("{\"status\":%u,\"response\":", status) < 0 ||
            fwrite(imageOutputPointer(), 1, imageOutputLength(), stdout) != imageOutputLength() ||
            fputs("}\n", stdout) == EOF) return 3;
    }
    return ferror(stdin) || fflush(stdout) == EOF ? 3 : 0;
}
