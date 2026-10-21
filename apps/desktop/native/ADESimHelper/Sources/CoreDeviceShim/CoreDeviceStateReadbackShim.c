#include "CoreDeviceShim.h"
#include <dispatch/dispatch.h>
#include <dlfcn.h>
#include <stdint.h>

static void *stateTarget, *stateMetadata, *stateSupport, *orientationTarget, *orientationMetadata;
extern int32_t SSCDDeviceStateReadbackDescriptor[2], SSCDOrientationReadbackDescriptor[2];

bool SSCoreDeviceStateReadbackAvailable(void) {
    static dispatch_once_t once;
    static bool available;
    dispatch_once(&once, ^{
        if (!SSCoreDeviceMotionAvailable()) return;
        stateTarget = SSCoreDeviceSymbol("$s10CoreDevice0B13MotionManagerV07monitorbC5StateScsySay0aB9Utilities0bcF8SnapshotVGs5Error_pGyYaAA0abI0VYKF");
        int32_t *descriptor = SSCoreDeviceSymbol("$s10CoreDevice0B13MotionManagerV07monitorbC5StateScsySay0aB9Utilities0bcF8SnapshotVGs5Error_pGyYaAA0abI0VYKFTu");
        stateSupport = SSCoreDeviceSymbol("$s10CoreDevice0B13MotionManagerV08supportsbC5StateSbvg");
        void *utilities = dlopen("/Library/Developer/PrivateFrameworks/CoreDeviceUtilities.framework/CoreDeviceUtilities", RTLD_NOW | RTLD_LOCAL);
        if (!utilities) return;
        stateMetadata = dlsym(utilities, "$s19CoreDeviceUtilities0B19MotionStateSnapshotVMa");
        if (!stateTarget || !descriptor || !stateSupport || !stateMetadata) return;
        SSCDDeviceStateReadbackDescriptor[1] = descriptor[1];
        available = true;
    });
    return available;
}

bool SSCoreDeviceOrientationReadbackAvailable(void) {
    static dispatch_once_t once;
    static bool available;
    dispatch_once(&once, ^{
        if (!SSCoreDeviceInitialize()) return;
        orientationTarget = SSCoreDeviceSymbol("$s10CoreDevice18OrientationControlP07currentbC0AA0C4InfoVyYaKFTj");
        int32_t *descriptor = SSCoreDeviceSymbol("$s10CoreDevice18OrientationControlP07currentbC0AA0C4InfoVyYaKFTjTu");
        void *utilities = dlopen("/Library/Developer/PrivateFrameworks/CoreDeviceUtilities.framework/CoreDeviceUtilities", RTLD_NOW | RTLD_LOCAL);
        if (!utilities) return;
        orientationMetadata = dlsym(utilities, "$s10CoreDevice15OrientationInfoVMa");
        if (!orientationTarget || !descriptor || !orientationMetadata) return;
        SSCDOrientationReadbackDescriptor[1] = descriptor[1];
        available = true;
    });
    return available;
}

typedef void (*State)(void *, void *, void * __attribute__((swift_context)), void * __attribute__((swift_async_context))) __attribute__((swiftasynccall));
void __attribute__((swiftasynccall)) SSCDDeviceStateReadback(void *out, void *error, void *manager,
                                                          void * __attribute__((swift_async_context)) context) {
    __attribute__((musttail)) return ((State)stateTarget)(out, error, manager, context);
}

typedef void (*Orientation)(void *, void *, void *, void * __attribute__((swift_context)), void * __attribute__((swift_async_context))) __attribute__((swiftasynccall));
void __attribute__((swiftasynccall)) SSCDOrientationReadback(void *out, void *metadata, void *witness, void *object,
                                                         void * __attribute__((swift_async_context)) context) {
    __attribute__((musttail)) return ((Orientation)orientationTarget)(out, metadata, witness, object, context);
}

struct MetadataResponse { void *metadata; uintptr_t state; };
typedef struct MetadataResponse (*Metadata)(uintptr_t) __attribute__((swiftcall));
typedef bool (*Supports)(void * __attribute__((swift_context))) __attribute__((swiftcall));
bool SSCoreDeviceMotionSupportsState(void *manager) { return ((Supports)stateSupport)(manager); }
void *SSCoreDeviceStateReadbackPointer(void) { return SSCDDeviceStateReadbackDescriptor; }
void *SSCoreDeviceStateReadbackMetadata(void) { return ((Metadata)stateMetadata)(0).metadata; }
void *SSCoreDeviceOrientationReadbackPointer(void) { return SSCDOrientationReadbackDescriptor; }
void *SSCoreDeviceOrientationReadbackMetadata(void) { return ((Metadata)orientationMetadata)(0).metadata; }
