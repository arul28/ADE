#include "CoreDeviceShim.h"
#include <dispatch/dispatch.h>
#include <dlfcn.h>
#include <stdint.h>

static void *monitorTarget, *snapshotMetadata, *configMetadata;
extern int32_t SSCDHingeReadbackDescriptor[2];

// Optional readback must not become a prerequisite for existing HID controls.
bool SSCoreDeviceHingeReadbackAvailable(void) {
    static dispatch_once_t once;
    static bool available;
    dispatch_once(&once, ^{
        if (!SSCoreDeviceMotionAvailable()) return;
        monitorTarget = SSCoreDeviceSymbol("$s10CoreDevice0B13MotionManagerV17monitorHingeAngle6configScsySay0aB9Utilities0bfG8SnapshotVGs5Error_pGAF0fG12StreamConfigV_tYaAA0abK0VYKF");
        int32_t *descriptor = SSCoreDeviceSymbol("$s10CoreDevice0B13MotionManagerV17monitorHingeAngle6configScsySay0aB9Utilities0bfG8SnapshotVGs5Error_pGAF0fG12StreamConfigV_tYaAA0abK0VYKFTu");
        void *utilities = dlopen("/Library/Developer/PrivateFrameworks/CoreDeviceUtilities.framework/CoreDeviceUtilities", RTLD_NOW | RTLD_LOCAL);
        if (!utilities) return;
        snapshotMetadata = dlsym(utilities, "$s19CoreDeviceUtilities0B18HingeAngleSnapshotVMa");
        configMetadata = dlsym(utilities, "$s19CoreDeviceUtilities22HingeAngleStreamConfigVMa");
        if (!monitorTarget || !descriptor || !snapshotMetadata || !configMetadata) return;
        SSCDHingeReadbackDescriptor[1] = descriptor[1];
        available = true;
    });
    return available;
}

typedef void (*Monitor)(void *, void *, void *, void * __attribute__((swift_context)), void * __attribute__((swift_async_context))) __attribute__((swiftasynccall));
void __attribute__((swiftasynccall)) SSCDHingeReadback(void *out, void *error, void *config, void *manager, void * __attribute__((swift_async_context)) context) {
    // Typed-throws storage follows the method's explicit config argument.
    __attribute__((musttail)) return ((Monitor)monitorTarget)(out, config, error, manager, context);
}

void *SSCoreDeviceHingeReadbackPointer(void) { return SSCDHingeReadbackDescriptor; }
struct HingeReadbackMetadataResponse { void *metadata; uintptr_t state; };
typedef struct HingeReadbackMetadataResponse (*Metadata)(uintptr_t) __attribute__((swiftcall));
void *SSCoreDeviceHingeReadbackMetadata(void) { return ((Metadata)snapshotMetadata)(0).metadata; }

void *SSCoreDeviceHingeConfigMetadata(void) { return ((Metadata)configMetadata)(0).metadata; }
