/* Development-only Win32 clipboard ABI oracle. Never bundled into the CLI. */
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct Memory {
  uint64_t size;
  uint32_t locks;
  uint32_t owned;
  struct Memory *next;
  unsigned char bytes[];
} Memory;

typedef struct { Memory *memory; uint32_t format; } Offer;
static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t condition = PTHREAD_COND_INITIALIZER;
static Memory *allocations;
static Offer offers[16];
static uint64_t stats[16];
static uint32_t fail_stage;
static uint32_t held;
static uint32_t blocked;
static uint32_t mutation_blocked;
static uint32_t opened;
static _Thread_local uint32_t last_error;

static Memory *allocate(uint64_t size) {
  Memory *memory = calloc(1, sizeof(Memory) + size);
  if (!memory) { last_error = 14; return NULL; }
  memory->size = size;
  memory->next = allocations;
  allocations = memory;
  stats[0]++;
  stats[7]++;
  return memory;
}

static void release(Memory *memory) {
  Memory **item = &allocations;
  while (*item && *item != memory) item = &(*item)->next;
  if (!*item || memory->locks) { stats[9]++; return; }
  *item = memory->next;
  stats[1]++;
  stats[7]--;
  free(memory);
}

static void empty(void) {
  for (unsigned index = 0; index < 16; index++) {
    if (offers[index].memory) release(offers[index].memory);
    offers[index] = (Offer){0};
  }
}

void FixtureReset(void) {
  pthread_mutex_lock(&mutex);
  empty();
  while (allocations) release(allocations);
  memset(stats, 0, sizeof(stats));
  fail_stage = held = blocked = mutation_blocked = opened = 0;
  pthread_mutex_unlock(&mutex);
}

void FixtureFail(uint32_t stage) { pthread_mutex_lock(&mutex); fail_stage = stage; pthread_mutex_unlock(&mutex); }
void FixtureHold(uint32_t value) { pthread_mutex_lock(&mutex); held = value; pthread_mutex_unlock(&mutex); }
void FixtureBlock(uint32_t value) { pthread_mutex_lock(&mutex); blocked = value; pthread_cond_broadcast(&condition); pthread_mutex_unlock(&mutex); }
void FixtureBlockMutation(uint32_t value) { pthread_mutex_lock(&mutex); mutation_blocked = value; pthread_cond_broadcast(&condition); pthread_mutex_unlock(&mutex); }
uint64_t FixtureStat(uint32_t index) { pthread_mutex_lock(&mutex); uint64_t value = stats[index]; pthread_mutex_unlock(&mutex); return value; }
uint64_t FixtureCopy(uint32_t format, void *destination, uint64_t capacity) {
  pthread_mutex_lock(&mutex);
  uint64_t size = 0;
  for (unsigned index = 0; index < 16; index++) if (offers[index].format == format && offers[index].memory) {
    size = offers[index].memory->size;
    if (capacity >= size) memcpy(destination, offers[index].memory->bytes, size);
    break;
  }
  pthread_mutex_unlock(&mutex);
  return size;
}
void FixtureOffer(uint32_t format, const void *bytes, uint64_t size) {
  pthread_mutex_lock(&mutex);
  for (unsigned index = 0; index < 16; index++) if (!offers[index].memory || offers[index].format == format) {
    if (offers[index].memory) release(offers[index].memory);
    Memory *memory = allocate(size);
    memcpy(memory->bytes, bytes, size);
    memory->owned = 1;
    offers[index] = (Offer){ memory, format };
    break;
  }
  pthread_mutex_unlock(&mutex);
}

uint32_t GetLastError(void) { return last_error; }
void *GlobalAlloc(uint32_t flags, uint64_t size) {
  pthread_mutex_lock(&mutex);
  Memory *memory = flags == 2 && fail_stage != 1 ? allocate(size) : NULL;
  if (!memory) last_error = 14;
  pthread_mutex_unlock(&mutex);
  return memory;
}
void *GlobalFree(Memory *memory) {
  pthread_mutex_lock(&mutex);
  if (memory && memory->owned) { stats[9]++; pthread_mutex_unlock(&mutex); return memory; }
  if (memory) release(memory);
  pthread_mutex_unlock(&mutex);
  return NULL;
}
void *GlobalLock(Memory *memory) {
  pthread_mutex_lock(&mutex);
  void *pointer = NULL;
  if (memory && fail_stage != 2) { memory->locks++; stats[5]++; pointer = memory->bytes; }
  else last_error = 14;
  pthread_mutex_unlock(&mutex);
  return pointer;
}
uint64_t GlobalSize(Memory *memory) { return memory ? memory->size : 0; }
int32_t GlobalUnlock(Memory *memory) {
  pthread_mutex_lock(&mutex);
  if (memory && memory->locks) { memory->locks--; stats[5]--; }
  else stats[9]++;
  pthread_mutex_unlock(&mutex);
  return 0;
}

uint32_t RegisterClipboardFormatW(const uint16_t *name) {
  if (fail_stage == 5 || name[0] != 'P' || name[1] != 'N' || name[2] != 'G' || name[3] != 0) { last_error = 13; return 0; }
  return 0xc000;
}
void *CreateWindowExW(uint32_t extended, const uint16_t *class_name, const uint16_t *name, uint32_t style,
                     int32_t x, int32_t y, int32_t width, int32_t height, void *parent, void *menu, void *instance, void *parameter) {
  pthread_mutex_lock(&mutex);
  int valid = !extended && class_name[0] == 'S' && class_name[5] == 'C' && !class_name[6] && name[0] == 'O' && !style && !x && !y && !width && !height && !parent && !menu && !instance && !parameter;
  if (valid) stats[14]++;
  if (!valid || fail_stage == 6) { last_error = 13; pthread_mutex_unlock(&mutex); return NULL; }
  stats[2]++;
  pthread_mutex_unlock(&mutex);
  return (void *)(uintptr_t)0x1000;
}
int32_t DestroyWindow(void *window) { pthread_mutex_lock(&mutex); if (window == (void *)(uintptr_t)0x1000) stats[2]--; pthread_mutex_unlock(&mutex); return 1; }
int32_t PeekMessageW(void *message, void *window, uint32_t minimum, uint32_t maximum, uint32_t remove) { (void)message; (void)window; (void)minimum; (void)maximum; (void)remove; return 0; }
int32_t TranslateMessage(const void *message) { (void)message; return 1; }
int64_t DispatchMessageW(const void *message) { (void)message; return 0; }
int32_t OpenClipboard(void *owner) {
  pthread_mutex_lock(&mutex);
  stats[3]++;
  if (held || opened || owner != (void *)(uintptr_t)0x1000) { last_error = 5; pthread_mutex_unlock(&mutex); return 0; }
  opened = 1;
  stats[6] = 1;
  pthread_mutex_unlock(&mutex);
  return 1;
}
int32_t CloseClipboard(void) { pthread_mutex_lock(&mutex); opened = 0; stats[6] = 0; stats[4]++; pthread_mutex_unlock(&mutex); return 1; }
int32_t EmptyClipboard(void) {
  pthread_mutex_lock(&mutex);
  stats[10]++;
  while (mutation_blocked) pthread_cond_wait(&condition, &mutex);
  if (!opened || fail_stage == 3) { last_error = 5; pthread_mutex_unlock(&mutex); return 0; }
  empty();
  pthread_mutex_unlock(&mutex);
  return 1;
}
int32_t IsClipboardFormatAvailable(uint32_t format) {
  pthread_mutex_lock(&mutex);
  int found = 0;
  for (unsigned index = 0; index < 16; index++) if (offers[index].format == format && offers[index].memory) found = 1;
  pthread_mutex_unlock(&mutex);
  return found;
}
void *GetClipboardData(uint32_t format) {
  pthread_mutex_lock(&mutex);
  stats[12]++;
  while (blocked) pthread_cond_wait(&condition, &mutex);
  Memory *memory = NULL;
  if (opened && fail_stage != 7) for (unsigned index = 0; index < 16; index++) if (offers[index].format == format) { memory = offers[index].memory; break; }
  if (!memory) last_error = 13;
  pthread_mutex_unlock(&mutex);
  return memory;
}
void *SetClipboardData(uint32_t format, Memory *memory) {
  pthread_mutex_lock(&mutex);
  stats[11]++;
  if (!opened || !memory || memory->locks || fail_stage == 4) { last_error = 5; pthread_mutex_unlock(&mutex); return NULL; }
  for (unsigned index = 0; index < 16; index++) if (!offers[index].memory) { offers[index] = (Offer){ memory, format }; memory->owned = 1; stats[8]++; break; }
  pthread_mutex_unlock(&mutex);
  return memory;
}
