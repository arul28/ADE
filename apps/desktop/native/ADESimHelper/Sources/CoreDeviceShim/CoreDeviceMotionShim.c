#include "CoreDeviceShim.h"
#include <dispatch/dispatch.h>
#include <dlfcn.h>
#include <stdint.h>

static void *motionTarget, *supportsTarget, *metadataTarget, *errorTarget;
extern int32_t SSCDMotionManagerDescriptor[2];

bool SSCoreDeviceMotionAvailable(void) {
    static dispatch_once_t once;
    static bool available;
    dispatch_once(&once, ^{
        if (!SSCoreDeviceInitialize()) return;
        motionTarget = SSCoreDeviceSymbol("$s10CoreDevice21MonitorMotionProtocolP13motionManagerAA0bdG0VyYaAA0aB5ErrorVYKFTj");
        int32_t *descriptor = SSCoreDeviceSymbol("$s10CoreDevice21MonitorMotionProtocolP13motionManagerAA0bdG0VyYaAA0aB5ErrorVYKFTjTu");
        supportsTarget = SSCoreDeviceSymbol("$s10CoreDevice0B13MotionManagerV18supportsHingeAngleSbvg");
        metadataTarget = SSCoreDeviceSymbol("$s10CoreDevice0B13MotionManagerVMa");
        errorTarget = SSCoreDeviceSymbol("$s10CoreDevice0aB5ErrorVMa");
        if (!motionTarget || !descriptor || !supportsTarget || !metadataTarget || !errorTarget) return;
        SSCDMotionManagerDescriptor[1] = descriptor[1];
        available = true;
    });
    return available;
}

typedef void (*Motion)(void *, void *, void *, void *, void * __attribute__((swift_context)), void * __attribute__((swift_async_context))) __attribute__((swiftasynccall));
void __attribute__((swiftasynccall)) SSCDMotionManager(void *out, void *error, void *metadata, void *witness, void *object, void * __attribute__((swift_async_context))context) {
    // Tail forwarding preserves Swift's async task allocation/continuation.
    __attribute__((musttail)) return ((Motion)motionTarget)(out, error, metadata, witness, object, context);
}

void *SSCoreDeviceMotionManagerPointer(void) { return SSCDMotionManagerDescriptor; }
struct MotionMetadataResponse { void *metadata; uintptr_t state; };
typedef struct MotionMetadataResponse (*Metadata)(uintptr_t) __attribute__((swiftcall));
void *SSCoreDeviceMotionManagerMetadata(void) { return ((Metadata)metadataTarget)(0).metadata; }
void *SSCoreDeviceErrorMetadata(void) { return ((Metadata)errorTarget)(0).metadata; }
typedef bool (*Supports)(void * __attribute__((swift_context))) __attribute__((swiftcall));
bool SSCoreDeviceMotionSupportsHinge(void *manager) { return ((Supports)supportsTarget)(manager); }
