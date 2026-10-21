#import "CoreDeviceShim.h"
#import <Foundation/Foundation.h>
#import <IOKit/IOCFSerialize.h>
#import <dlfcn.h>
#import <ptrauth.h>

// Targets for the register-preserving trampolines in CoreDeviceTrampolines.S.
void *SSCDSharedTarget, *SSCDConnectionTarget, *SSCDCreateManagerTarget;
void *SSCDAllDevicesTarget, *SSCDInitializedTarget, *SSCDIdentifierTarget;
void *SSCDImplementationTarget, *SSCDDisplayInfoTarget;
void *SSCDVisibilityAllCasesTarget;
extern int32_t SSCDImplementationTu[2], SSCDDisplayInfoTu[2];
static void *framework, *sendTarget, *barrierTarget, *errorMetadataTarget;

static bool resolve(void **destination, const char *symbol) {
    *destination = dlsym(framework, symbol);
    return *destination != NULL;
}

bool SSCoreDeviceInitialize(void) {
    static dispatch_once_t once;
    static bool available;
    dispatch_once(&once, ^{
        framework = dlopen("/Library/Developer/PrivateFrameworks/CoreDevice.framework/CoreDevice", RTLD_NOW | RTLD_GLOBAL);
        if (!framework) return;
        bool found = true;
        found &= resolve(&SSCDSharedTarget, "$s10CoreDevice0B7ManagerC6sharedACvgZ");
        found &= resolve(&SSCDConnectionTarget, "$s10CoreDevice0aB7ServiceV16sharedConnectionAA0abcE0_pvgZ");
        found &= resolve(&SSCDCreateManagerTarget, "$s10CoreDevice0B7ManagerC17serviceConnection07allowedB17VisibilityClassesAcA0ab7ServiceE0_p_ShyAA0bG5ClassOGtcfC");
        found &= resolve(&SSCDAllDevicesTarget, "$s10CoreDevice0B7ManagerC10allDevicesSayAA06RemoteB0CGyF");
        found &= resolve(&SSCDInitializedTarget, "$s10CoreDevice0B7ManagerC16fullyInitializedSbvgTj");
        found &= resolve(&SSCDIdentifierTarget, "$s10CoreDevice06RemoteB0C16deviceIdentifier10Foundation4UUIDVvgTj");
        found &= resolve(&SSCDVisibilityAllCasesTarget, "$s10CoreDevice0B15VisibilityClassO8allCasesSayACGvgZ");
        found &= resolve(&SSCDImplementationTarget, "$s10CoreDevice06RemoteB0C17getImplementation3for12ProtocolTypeQzAA22CapabilityStaticMemberVyxG_tYaKAA0bI0RzlFTj");
        found &= resolve(&SSCDDisplayInfoTarget, "$s10CoreDevice06RemoteB0C11displayInfoAA07DisplayE0Vvg");
        found &= resolve(&sendTarget, "$s10CoreDevice16HIDVendorDefinedP4send9usagePage0F07version4datays6UInt16V_AJs6UInt32V10Foundation4DataVtAA0aB5ErrorVYKFTj");
        found &= resolve(&barrierTarget, "$s10CoreDevice16HIDVendorDefinedP11sendBarrieryyFTj");
        found &= resolve(&errorMetadataTarget, "$s10CoreDevice0aB5ErrorVMa");
        int32_t *implementation = dlsym(framework, "$s10CoreDevice06RemoteB0C17getImplementation3for12ProtocolTypeQzAA22CapabilityStaticMemberVyxG_tYaKAA0bI0RzlFTjTu");
        int32_t *displayInfo = dlsym(framework, "$s10CoreDevice06RemoteB0C11displayInfoAA07DisplayE0VvgTu");
        if (!found || !implementation || !displayInfo) return;
        // Swift allocates the callee's async context using this descriptor.
        // Forwarding with a guessed size corrupts the task's allocation stack.
        SSCDImplementationTu[1] = implementation[1];
        SSCDDisplayInfoTu[1] = displayInfo[1];
        available = true;
    });
    return available;
}

void *SSCoreDeviceSymbol(const char *name) {
    return SSCoreDeviceInitialize() ? dlsym(framework, name) : NULL;
}

void SSCoreDeviceRetainBridgeObject(void *object) {
    typedef void *(*Retain)(void *);
    ((Retain)dlsym(RTLD_DEFAULT, "swift_bridgeObjectRetain"))(object);
}

static void **witnesses(void *metadata) {
    return ptrauth_strip(((void **)metadata)[-1], ptrauth_key_process_independent_data);
}

typedef void (*DestroyValue)(void *, void *) __attribute__((swiftcall));
static void destroy(void *value, void *metadata) {
    void *function = ptrauth_strip(witnesses(metadata)[1], ptrauth_key_function_pointer);
    ((DestroyValue)function)(value, metadata);
}

void *SSCoreDeviceHingeData(double angle) {
    // Device Hub's HingeController uses IOKit's binary serializer, not a plist.
    NSDictionary *command = @{
        @"provider": @"com.apple.Virtualization.VirtualMachines",
        @"source": @"hinge-slider-control",
        @"type": @"range",
        @"value": @(angle)
    };
    return (void *)IOCFSerialize((__bridge CFDictionaryRef)command, 1);
}

void *SSCoreDeviceOrientationData(const char *value) {
    if (!value) return NULL;
    NSString *orientation = [NSString stringWithUTF8String:value];
    if (!orientation) return NULL;
    NSDictionary *command = @{
        @"provider": @"com.apple.Virtualization.VirtualMachines",
        @"source": @"orientation-picker-control",
        @"type": @"enum",
        @"value": orientation
    };
    return (void *)IOCFSerialize((__bridge CFDictionaryRef)command, 1);
}

struct MetadataResponse { void *metadata; uintptr_t state; };
typedef struct MetadataResponse (*Metadata)(uintptr_t) __attribute__((swiftcall));
typedef void (*Send)(uint16_t, uint16_t, uint32_t, uint64_t, uint64_t, void *, void *, void *, void * __attribute__((swift_context)), void ** __attribute__((swift_error_result))) __attribute__((swiftcall));
typedef void (*Barrier)(void *, void *, void * __attribute__((swift_context))) __attribute__((swiftcall));

bool SSCoreDeviceSendControl(void *capability, uint64_t data0, uint64_t data1) {
    if (!SSCoreDeviceInitialize()) return false;
    void *metadata = ((void **)capability)[3], *witness = ((void **)capability)[4];
    if (!metadata || !witness) return false;
    void *errorMetadata = ((Metadata)errorMetadataTarget)(0).metadata;
    size_t errorSize = (size_t)witnesses(errorMetadata)[8];
    void *error = calloc(1, errorSize);
    if (!error) return false;
    void *errorFlag = NULL;
    ((Send)sendTarget)(0xff61, 0x5b, 0, data0, data1, error, metadata, witness, capability, &errorFlag);
    if (errorFlag) destroy(error, errorMetadata);
    else ((Barrier)barrierTarget)(metadata, witness, capability);
    free(error);
    return errorFlag == NULL;
}
