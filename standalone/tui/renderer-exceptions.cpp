#include <cstdint>
#include <new>
#include <stdexcept>
#include <limits>

// A diagnostic for the real exception ABI, compiled with the same flags as
// Yoga. This catches failures that successful layout alone cannot detect.
extern "C" std::uint32_t rendererExceptionProbe(std::uint32_t kind) noexcept {
  try {
    if (kind == 1) throw std::bad_alloc();
    if (kind == 2) throw std::logic_error("OpenTUI WASM exception probe");
    if (kind == 3 || kind == 4) {
      // The WASM reactor has a 64 MiB maximum, so 128 MiB fails without
      // reserving real memory. Native malloc rejects a near-SIZE_MAX request.
      const std::size_t bytes = sizeof(std::size_t) == 4
          ? 128 * 1024 * 1024
          : std::numeric_limits<std::size_t>::max() - 1024 * 1024;
      void* allocation = kind == 3 ? ::operator new(bytes)
                                   : ::operator new(bytes, std::nothrow);
      if (allocation == nullptr) return 4;
      ::operator delete(allocation);
      return 5;
    }
    return 0;
  } catch (const std::bad_alloc&) {
    return 1;
  } catch (const std::logic_error&) {
    return 2;
  } catch (...) {
    return 3;
  }
}
