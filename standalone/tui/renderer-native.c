#include <stdint.h>
#include <stdio.h>
#include <string.h>

extern unsigned char* rendererInputPointer(void);
extern uint32_t rendererInputCapacity(void);
extern const unsigned char* rendererOutputPointer(void);
extern uint32_t rendererOutputLength(void);
extern uint32_t rendererCall(uint32_t length);

// One bounded JSON request per line, with the bridge's checked status and JSON
// response per output line. The actual Context and C++ runtime stay in this
// process for the complete trace, including all allocation failures.
int main(void) {
  char request[64 * 1024 + 2];
  while (fgets(request, sizeof request, stdin) != NULL) {
    size_t length = strlen(request);
    if (length != 0 && request[length - 1] == '\n') --length;
    if (length > rendererInputCapacity()) {
      fputs("Renderer oracle request exceeds the 64 KiB input window\n", stderr);
      return 2;
    }
    memcpy(rendererInputPointer(), request, length);
    uint32_t status = rendererCall((uint32_t)length);
    uint32_t output_length = rendererOutputLength();
    if (printf("{\"status\":%u,\"response\":", (unsigned)status) < 0 ||
        fwrite(rendererOutputPointer(), 1, output_length, stdout) != output_length ||
        fputs("}\n", stdout) == EOF) return 3;
  }
  return ferror(stdin) || fflush(stdout) == EOF ? 3 : 0;
}
