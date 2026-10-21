#import "CoreDeviceDisplayShim.h"
#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <ptrauth.h>

// Publicly exported Swift entry points from CoreDeviceUtilities. The Swift
// calling convention carries a resilient value's self address in swift_context.
struct MetadataResponse { void *metadata; uintptr_t state; };
typedef struct MetadataResponse (*MetadataFn)(uintptr_t) __attribute__((swiftcall));
typedef void *(*DisplaysFn)(void * __attribute__((swift_context))) __attribute__((swiftcall));
typedef uint32_t (*DisplayIDFn)(void * __attribute__((swift_context))) __attribute__((swiftcall));
typedef uint8_t (*DisplayActiveFn)(void * __attribute__((swift_context))) __attribute__((swiftcall));
typedef struct SSCoreDeviceSwiftString (*OrientationFn)(void * __attribute__((swift_context))) __attribute__((swiftcall));
typedef void (*DestroyFn)(void *, void *) __attribute__((swiftcall));
typedef unsigned (*SinglePayloadTagFn)(const void *, unsigned, void *) __attribute__((swiftcall));

static MetadataFn displayMetadata;
static MetadataFn infoMetadata;
static DisplaysFn displays;
static DisplayIDFn displayID;
static DisplayActiveFn displayActive;
static OrientationFn displayOrientation;

bool SSCoreDeviceDisplayAvailable(void) {
    static dispatch_once_t once;
    static bool available;
    dispatch_once(&once, ^{
        void *handle = dlopen("/Library/Developer/PrivateFrameworks/CoreDeviceUtilities.framework/CoreDeviceUtilities", RTLD_NOW | RTLD_LOCAL);
        if (!handle) return;
        displayMetadata = (MetadataFn)dlsym(handle, "$s10CoreDevice7DisplayVMa");
        infoMetadata = (MetadataFn)dlsym(handle, "$s10CoreDevice11DisplayInfoVMa");
        displays = (DisplaysFn)dlsym(handle, "$s10CoreDevice11DisplayInfoV8displaysSayAA0C0VGvg");
        displayID = (DisplayIDFn)dlsym(handle, "$s10CoreDevice7DisplayV9displayIds6UInt32Vvg");
        displayActive = (DisplayActiveFn)dlsym(handle, "$s10CoreDevice7DisplayV6activeSbSgvg");
        displayOrientation = (OrientationFn)dlsym(handle, "$s10CoreDevice7DisplayV18currentOrientationSSvg");
        available = displayMetadata && infoMetadata && displays && displayID && displayActive && displayOrientation;
    });
    return available;
}

void *SSCoreDeviceDisplayMetadata(void) { return displayMetadata(0).metadata; }
void *SSCoreDeviceDisplayInfoMetadata(void) { return infoMetadata(0).metadata; }

// These are Swift ABI value-witness entries, not offsets into a private
// framework's object layout. Querying them keeps resilient struct sizes dynamic.
static void **valueWitnesses(void *metadata) {
    return ptrauth_strip(((void **)metadata)[-1], ptrauth_key_process_independent_data);
}

uintptr_t SSCoreDeviceValueSize(void *metadata) { return ((uintptr_t *)valueWitnesses(metadata))[8]; }
void *SSCoreDeviceDisplays(void *info) { return displays(info); }
uint32_t SSCoreDeviceDisplayID(void *display) { return displayID(display); }
uint8_t SSCoreDeviceDisplayActive(void *display) { return displayActive(display); }
struct SSCoreDeviceSwiftString SSCoreDeviceDisplayOrientation(void *display) { return displayOrientation(display); }

void SSCoreDeviceDestroyValue(void *value, void *metadata) {
    void *entry = ptrauth_strip(valueWitnesses(metadata)[1], ptrauth_key_function_pointer);
    DestroyFn destroy = ptrauth_sign_unauthenticated(entry, ptrauth_key_function_pointer, 0);
    destroy(value, metadata);
}

bool SSCoreDeviceOptionalHasValue(const void *value, void *wrappedMetadata) {
    // Swift ABI getEnumTagSinglePayload: one empty case for Optional, tag 0
    // for a payload. The value witness handles both spare bits and extra bytes.
    void *entry = ptrauth_strip(valueWitnesses(wrappedMetadata)[6], ptrauth_key_function_pointer);
    SinglePayloadTagFn getTag = ptrauth_sign_unauthenticated(entry, ptrauth_key_function_pointer, 0);
    return getTag(value, 1, wrappedMetadata) == 0;
}
