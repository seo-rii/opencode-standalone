/* Development-only independent Xlib selection peer. Never bundled into the runtime. */
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <sys/select.h>

static Display *display;
static Window window;
static Atom targets, incr, utf8, property, timestamp;
static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
struct Offer { Atom type; unsigned char *bytes; size_t length; };
static struct Offer offers[32];
static int offer_count, stalled, incremental;
static Atom selection;
static Time acquired;
struct Transfer { Window requestor; Atom property, type; unsigned char *bytes; size_t length, offset; };
static struct Transfer outgoing[32];
static unsigned char *incoming;
static size_t incoming_length;
static int receiving;

static unsigned char *decode(const char *source, size_t *length) {
  size_t size = strlen(source), used = 0;
  unsigned char *result = malloc(size * 3 / 4 + 4);
  uint32_t value = 0; int bits = 0;
  for (size_t index = 0; index < size; index++) {
    const char *match = strchr(alphabet, source[index]);
    if (!match) continue;
    value = (value << 6) | (uint32_t)(match - alphabet); bits += 6;
    if (bits >= 8) { bits -= 8; result[used++] = (value >> bits) & 255; }
  }
  *length = used; return result;
}
static void output_data(unsigned char *bytes, size_t length) {
  fputs("DATA\t", stdout);
  for (size_t index = 0; index < length; index += 3) {
    uint32_t value = ((uint32_t)bytes[index]) << 16;
    if (index + 1 < length) value |= ((uint32_t)bytes[index + 1]) << 8;
    if (index + 2 < length) value |= bytes[index + 2];
    fputc(alphabet[(value >> 18) & 63], stdout); fputc(alphabet[(value >> 12) & 63], stdout);
    fputc(index + 1 < length ? alphabet[(value >> 6) & 63] : '=', stdout);
    fputc(index + 2 < length ? alphabet[value & 63] : '=', stdout);
  }
  fputc('\n', stdout); fflush(stdout);
}
static void reply(XSelectionRequestEvent *request) {
  XSelectionEvent response = {0};
  response.type = SelectionNotify; response.display = display; response.requestor = request->requestor;
  response.selection = request->selection; response.target = request->target; response.time = request->time;
  Atom destination = request->property ? request->property : request->target;
  if (request->selection != selection) goto notify;
  if (request->target == targets) {
    Atom types[36] = { targets, timestamp }; int count = 2;
    for (int index = 0; index < offer_count; index++) types[count++] = offers[index].type;
    for (int index = 0; index < offer_count; index++) if (offers[index].type == utf8) {
      types[count++] = XInternAtom(display, "TEXT", False); types[count++] = XA_STRING; break;
    }
    XChangeProperty(display, request->requestor, destination, XA_ATOM, 32, PropModeReplace, (unsigned char *)types, count);
    response.property = destination; goto notify;
  }
  if (request->target == timestamp) {
    unsigned long value = acquired;
    XChangeProperty(display, request->requestor, destination, XA_INTEGER, 32, PropModeReplace, (unsigned char *)&value, 1);
    response.property = destination; goto notify;
  }
  fputs("REQUEST\n", stderr); fflush(stderr);
  if (stalled) return;
  for (int index = 0; index < offer_count; index++) {
    struct Offer *offer = &offers[index];
    Atom type = request->target == XInternAtom(display, "TEXT", False) ? utf8 : request->target;
    if (offer->type != type && !(type == XA_STRING && offer->type == utf8)) continue;
    if (incremental || offer->length > 65536) {
      int slot;
      for (slot = 0; slot < 32 && outgoing[slot].requestor; slot++);
      if (slot == 32) break;
      outgoing[slot] = (struct Transfer){ request->requestor, destination, type, offer->bytes, offer->length, 0 };
      XSelectInput(display, request->requestor, PropertyChangeMask | StructureNotifyMask);
      unsigned long length = offer->length;
      XChangeProperty(display, request->requestor, destination, incr, 32, PropModeReplace, (unsigned char *)&length, incremental == 2 ? 0 : 1);
    } else XChangeProperty(display, request->requestor, destination, type, 8, PropModeReplace, offer->bytes, offer->length);
    response.property = destination; break;
  }
notify:
  XSendEvent(display, request->requestor, False, 0, (XEvent *)&response); XFlush(display);
}

static void read_property(int initial) {
  Atom type; int format; unsigned long count, after; unsigned char *bytes = NULL;
  if (XGetWindowProperty(display, window, property, 0, 16 * 1024 * 1024, False, AnyPropertyType, &type, &format, &count, &after, &bytes) != Success || after) exit(4);
  if (initial && type == incr) { receiving = 1; XFree(bytes); XDeleteProperty(display, window, property); XFlush(display); return; }
  size_t length = count * (format / 8);
  unsigned char *packed = bytes;
  if (format == 32) {
    packed = malloc(length);
    for (size_t index = 0; index < count; index++) {
      uint32_t value = ((unsigned long *)bytes)[index];
      for (int shift = 0; shift < 4; shift++) packed[index * 4 + shift] = value >> (8 * shift);
    }
  }
  if (incoming_length + length > 64 * 1024 * 1024) exit(5);
  incoming = realloc(incoming, incoming_length + length + 1);
  memcpy(incoming + incoming_length, packed, length); incoming_length += length;
  if (packed != bytes) free(packed);
  XFree(bytes); XDeleteProperty(display, window, property); XFlush(display);
  if (!receiving || !length) { output_data(incoming, incoming_length); free(incoming); incoming = NULL; incoming_length = 0; receiving = 0; }
}

static int ignore_error(Display *unused, XErrorEvent *error) { (void)unused; (void)error; return 0; }

int main(void) {
  display = XOpenDisplay(NULL); if (!display) return 2;
  XSetErrorHandler(ignore_error);
  window = XCreateSimpleWindow(display, DefaultRootWindow(display), 0, 0, 1, 1, 0, 0, 0);
  XSelectInput(display, window, PropertyChangeMask);
  targets = XInternAtom(display, "TARGETS", False); incr = XInternAtom(display, "INCR", False);
  utf8 = XInternAtom(display, "UTF8_STRING", False); timestamp = XInternAtom(display, "TIMESTAMP", False);
  property = XInternAtom(display, "_STANDALONE_NATIVE_PEER", False);
  XFlush(display); puts("READY"); fflush(stdout);
  while (1) {
    while (XPending(display)) {
      XEvent event; XNextEvent(display, &event);
      if (event.type == SelectionRequest) reply(&event.xselectionrequest);
      if (event.type == SelectionNotify) {
        if (!event.xselection.property) { puts("NONE"); fflush(stdout); }
        else read_property(1);
      }
      if (event.type == PropertyNotify && event.xproperty.window == window && event.xproperty.atom == property && event.xproperty.state == PropertyNewValue && receiving) read_property(0);
      if (event.type == PropertyNotify && event.xproperty.state == PropertyDelete) {
        for (int index = 0; index < 32; index++) {
          struct Transfer *transfer = &outgoing[index];
          if (transfer->requestor != event.xproperty.window || transfer->property != event.xproperty.atom) continue;
          size_t length = transfer->length - transfer->offset; if (length > 32768) length = 32768;
          XChangeProperty(display, transfer->requestor, transfer->property, transfer->type, 8, PropModeReplace, transfer->bytes + transfer->offset, length);
          XFlush(display); transfer->offset += length;
          if (!length) transfer->requestor = 0;
        }
      }
      if (event.type == DestroyNotify) for (int index = 0; index < 32; index++) if (outgoing[index].requestor == event.xdestroywindow.window) outgoing[index].requestor = 0;
    }
    fd_set reads; FD_ZERO(&reads); FD_SET(0, &reads); FD_SET(ConnectionNumber(display), &reads);
    if (select(ConnectionNumber(display) + 1, &reads, NULL, NULL, NULL) < 0) return 3;
    if (!FD_ISSET(0, &reads)) continue;
    char *line = NULL; size_t capacity = 0; ssize_t length = getline(&line, &capacity, stdin);
    if (length < 0) break;
    if (length && line[length - 1] == '\n') line[length - 1] = 0;
    char *save; char *command = strtok_r(line, "\t", &save);
    if (!command) { free(line); continue; }
    if (!strcmp(command, "QUIT")) { free(line); break; }
    if (!strcmp(command, "OWN")) {
      selection = XInternAtom(display, strtok_r(NULL, "\t", &save), False);
      stalled = atoi(strtok_r(NULL, "\t", &save)); incremental = atoi(strtok_r(NULL, "\t", &save));
      for (int index = 0; index < offer_count; index++) free(offers[index].bytes);
      offer_count = 0;
      char *mime;
      while ((mime = strtok_r(NULL, "\t", &save)) && offer_count < 32) {
        char *encoded = strtok_r(NULL, "\t", &save); if (!encoded) break;
        struct Offer *offer = &offers[offer_count++]; offer->type = XInternAtom(display, mime, False); offer->bytes = decode(encoded, &offer->length);
      }
      XChangeProperty(display, window, timestamp, XA_INTEGER, 8, PropModeReplace, NULL, 0); XFlush(display);
      XEvent clock; XWindowEvent(display, window, PropertyChangeMask, &clock); acquired = clock.xproperty.time;
      XSetSelectionOwner(display, selection, window, acquired); XSync(display, False);
      puts(XGetSelectionOwner(display, selection) == window ? "OK" : "ERROR"); fflush(stdout);
    }
    if (!strcmp(command, "READ")) {
      Atom selected = XInternAtom(display, strtok_r(NULL, "\t", &save), False);
      Atom target = XInternAtom(display, strtok_r(NULL, "\t", &save), False);
      XDeleteProperty(display, window, property); XConvertSelection(display, selected, target, property, window, CurrentTime); XFlush(display);
    }
    if (!strcmp(command, "OWNER")) {
      Atom selected = XInternAtom(display, strtok_r(NULL, "\t", &save), False);
      printf("OWNER\t%lu\n", XGetSelectionOwner(display, selected)); fflush(stdout);
    }
    free(line);
  }
  XDestroyWindow(display, window); XCloseDisplay(display); return 0;
}
