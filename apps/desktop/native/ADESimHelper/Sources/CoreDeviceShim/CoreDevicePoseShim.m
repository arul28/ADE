#import "CoreDeviceShim.h"
#import <Foundation/Foundation.h>
#import <dlfcn.h>

struct PoseDataWords { uint64_t first, second; };
struct PoseMetadataResponse { void *metadata; uintptr_t state; };
typedef struct PoseMetadataResponse (*PoseMetadata)(uintptr_t) __attribute__((swiftcall));
typedef void (*CustomButtonInit)(void * __attribute__((swift_indirect_result)), uint32_t, bool) __attribute__((swiftcall));
typedef struct PoseDataWords (*CustomButtonReport)(void * __attribute__((swift_context))) __attribute__((swiftcall));
typedef void (*CustomService)(void * __attribute__((swift_indirect_result))) __attribute__((swiftcall));
typedef void (*PoseSend)(uint64_t, uint64_t, void *, void *, void *, void *, void * __attribute__((swift_context)), void ** __attribute__((swift_error_result))) __attribute__((swiftcall));
typedef void (*PoseBarrier)(void *, void *, void * __attribute__((swift_context))) __attribute__((swiftcall));

static CustomButtonInit initButton;
static CustomButtonReport buttonReport;
static CustomService customService;
static PoseSend sendReport;
static PoseBarrier sendBarrier;
static void *buttonMetadata, *serviceMetadata, *reportMetadata, *usageMetadata, *errorMetadata;

static void *poseSymbol(void *utilities, const char *name) {
    void *symbol = SSCoreDeviceSymbol(name);
    return symbol ?: (utilities ? dlsym(utilities, name) : NULL);
}

bool SSCoreDeviceTableModeAvailable(void) {
    static dispatch_once_t once;
    static bool available;
    dispatch_once(&once, ^{
        if (!SSCoreDeviceInitialize()) return;
        // SimulatorKit can load these dependencies locally, outside RTLD_DEFAULT.
        // Retain the handle for the lifetime of the cached Swift function pointers.
        void *utilities = dlopen("/Library/Developer/PrivateFrameworks/CoreDeviceUtilities.framework/CoreDeviceUtilities", RTLD_NOW | RTLD_LOCAL);
        bool found = true;
#define RESOLVE(variable, symbol) do { variable = (typeof(variable))poseSymbol(utilities, symbol); found &= variable != NULL; } while (0)
        RESOLVE(initButton, "$s19CoreDeviceUtilities18CustomButtonReportV5usage4downAC12UniversalHID8HIDUsageV_SbtcfC");
        RESOLVE(buttonReport, "$s19CoreDeviceUtilities18CustomButtonReportV6report12UniversalHID9HIDReportVvg");
        RESOLVE(customService, "$s10CoreDevice12HIDServiceIDV0aB9UtilitiesE9avpCustomACvgZ");
        RESOLVE(sendReport, "$s10CoreDevice19UniversalHIDServiceP4send6report2toy0C3HID9HIDReportV_AA0D2IDVtAA0aB5ErrorVYKFTj");
        RESOLVE(sendBarrier, "$s10CoreDevice19UniversalHIDServiceP11sendBarrieryyFTj");
        RESOLVE(reportMetadata, "$s12UniversalHID9HIDReportVN");
        RESOLVE(usageMetadata, "$s12UniversalHID8HIDUsageVN");
        PoseMetadata buttonType, serviceType, errorType;
        RESOLVE(buttonType, "$s19CoreDeviceUtilities18CustomButtonReportVMa");
        RESOLVE(serviceType, "$s10CoreDevice12HIDServiceIDVMa");
        RESOLVE(errorType, "$s10CoreDevice0aB5ErrorVMa");
#undef RESOLVE
        if (!found) return;
        buttonMetadata = buttonType(0).metadata;
        serviceMetadata = serviceType(0).metadata;
        errorMetadata = errorType(0).metadata;
        available = buttonMetadata && serviceMetadata && errorMetadata &&
            SSCoreDeviceValueSize(usageMetadata) == sizeof(uint32_t) &&
            SSCoreDeviceValueSize(reportMetadata) == sizeof(struct PoseDataWords);
    });
    return available;
}

bool SSCoreDeviceSendTableMode(void *capability, bool enabled) {
    if (!capability || !SSCoreDeviceTableModeAvailable()) return false;
    void *metadata = ((void **)capability)[3], *witness = ((void **)capability)[4];
    if (!metadata || !witness) return false;
    void *button = calloc(1, SSCoreDeviceValueSize(buttonMetadata));
    void *service = calloc(1, SSCoreDeviceValueSize(serviceMetadata));
    void *error = calloc(1, SSCoreDeviceValueSize(errorMetadata));
    if (!button || !service || !error) {
        free(button); free(service); free(error);
        return false;
    }

    // Device Hub holds this custom button down for Table Mode and releases it
    // when leaving the mode. It is a state, not a down/up click. HIDUsage packs
    // its 16-bit page and usage into one word; the target is Apple's avpCustom
    // service, independent of which of the two screens is currently active.
    initButton(button, 0x005bff61, enabled);
    struct PoseDataWords report = buttonReport(button);
    customService(service);
    void *errorFlag = NULL;
    sendReport(report.first, report.second, service, error, metadata, witness, capability, &errorFlag);
    if (errorFlag) SSCoreDeviceDestroyValue(error, errorMetadata);
    else sendBarrier(metadata, witness, capability);
    SSCoreDeviceDestroyValue(&report, reportMetadata);
    SSCoreDeviceDestroyValue(service, serviceMetadata);
    SSCoreDeviceDestroyValue(button, buttonMetadata);
    free(error); free(service); free(button);
    return errorFlag == NULL;
}
