#import "CoreDeviceShim.h"
#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <math.h>
#import <mach/mach_time.h>

// UniversalHID's frozen report/contact wrappers each contain Foundation.Data.
// Let Apple's constructors/setters encode the descriptor, rather than building
// an abbreviated legacy Indigo report (which targets a disconnected service).
struct DataWords { uint64_t first, second; };
struct MetadataResponse { void *metadata; uintptr_t state; };
typedef struct MetadataResponse (*Metadata)(uintptr_t) __attribute__((swiftcall));
typedef void (*DefaultInit)(void * __attribute__((swift_indirect_result)), void *, void *, void *) __attribute__((swiftcall));
typedef struct DataWords (*ContactInit)(void) __attribute__((swiftcall));
typedef void (*SetDouble)(double, void * __attribute__((swift_context))) __attribute__((swiftcall));
typedef void (*SetInt)(intptr_t, void * __attribute__((swift_context))) __attribute__((swiftcall));
typedef void (*SetByte)(uint8_t, void * __attribute__((swift_context))) __attribute__((swiftcall));
typedef void (*SetBool)(bool, void * __attribute__((swift_context))) __attribute__((swiftcall));
typedef void (*SetIdentity)(uint8_t, intptr_t, void * __attribute__((swift_context))) __attribute__((swiftcall));
typedef void (*SetSwipe)(bool, intptr_t, void * __attribute__((swift_context))) __attribute__((swiftcall));
typedef void (*SetTime)(uint64_t, bool, void * __attribute__((swift_context))) __attribute__((swiftcall));
typedef void (*SetContact)(uint64_t, uint64_t, intptr_t, void * __attribute__((swift_context))) __attribute__((swiftcall));
typedef void (*Send)(uint64_t, uint64_t, void *, void *, void *, void *, void * __attribute__((swift_context)), void ** __attribute__((swift_error_result))) __attribute__((swiftcall));

static void *reportMetadata, *contactMetadata, *descriptorWitness, *reportWitness;
static DefaultInit initReport;
static ContactInit initContact;
static SetInt setIndex;
static SetByte setCount;
static SetDouble setX, setY;
static SetBool setTouch, setRange;
static SetContact setContact;
static SetIdentity setIdentity;
static SetTime setTime;
static SetSwipe setSwipe[5];
static SetSwipe setSwipeLocked;
static Send sendReport;
static void *coreDeviceErrorMetadata;

bool SSCoreDeviceDigitizerAvailable(void) {
    static dispatch_once_t once;
    static bool available;
    dispatch_once(&once, ^{
        if (!SSCoreDeviceInitialize()) return;
        bool found = true;
#define RESOLVE(variable, symbol) do { variable = (typeof(variable))dlsym(RTLD_DEFAULT, symbol); found &= variable != NULL; } while (0)
        RESOLVE(reportMetadata, "$s12UniversalHID15DigitizerReportVN");
        RESOLVE(contactMetadata, "$s12UniversalHID16DigitizerContactVN");
        RESOLVE(descriptorWitness, "$s12UniversalHID15DigitizerReportVAA05EventD18DescriptorProtocolAAWP");
        RESOLVE(reportWitness, "$s12UniversalHID15DigitizerReportVAA05EventD8ProtocolAAWP");
        RESOLVE(initReport, "$s12UniversalHID19EventReportProtocolPA2A0cd10DescriptorE0RzrlExycfC");
        RESOLVE(initContact, "$s12UniversalHID16DigitizerContactVACycfC");
        RESOLVE(setIndex, "$s12UniversalHID16DigitizerContactV5indexSivs");
        RESOLVE(setX, "$s12UniversalHID16DigitizerContactV1xSdvs");
        RESOLVE(setY, "$s12UniversalHID16DigitizerContactV1ySdvs");
        RESOLVE(setTouch, "$s12UniversalHID16DigitizerContactV5touchSbvs");
        RESOLVE(setRange, "$s12UniversalHID16DigitizerContactV5rangeSbvs");
        RESOLVE(setCount, "$s12UniversalHID15DigitizerReportV12contactCounts5UInt8Vvs");
        RESOLVE(setContact, "$s12UniversalHID15DigitizerReportV10setContact_7atIndexyAA0cF0V_SitF");
        RESOLVE(setIdentity, "$s12UniversalHID15DigitizerReportV18setContactIdentity_7atIndexys5UInt8V_SitF");
        RESOLVE(setTime, "$s12UniversalHID15DigitizerReportV15remoteTimestamps6UInt64VSgvs");
        // Existing edge IDs: left, top, bottom, right. Swipe direction is inward.
        RESOLVE(setSwipe[1], "$s12UniversalHID15DigitizerReportV20setContactSwipeRight_7atIndexySb_SitF");
        RESOLVE(setSwipe[2], "$s12UniversalHID15DigitizerReportV19setContactSwipeDown_7atIndexySb_SitF");
        RESOLVE(setSwipe[3], "$s12UniversalHID15DigitizerReportV17setContactSwipeUp_7atIndexySb_SitF");
        RESOLVE(setSwipe[4], "$s12UniversalHID15DigitizerReportV19setContactSwipeLeft_7atIndexySb_SitF");
        RESOLVE(sendReport, "$s10CoreDevice19UniversalHIDServiceP4send6report2toy0C3HID9HIDReportV_AA0D2IDVtAA0aB5ErrorVYKFTj");
#undef RESOLVE
        // swipeLocked improves system edge gestures on newer runtimes, but
        // its absence must not disable the base digitizer and all touch input.
        setSwipeLocked = (SetSwipe)dlsym(RTLD_DEFAULT, "$s12UniversalHID15DigitizerReportV21setContactSwipeLocked_7atIndexySb_SitF");
        Metadata errorMetadata;
        errorMetadata = (Metadata)SSCoreDeviceSymbol("$s10CoreDevice0aB5ErrorVMa");
        if (errorMetadata) coreDeviceErrorMetadata = errorMetadata(0).metadata;
        // Both the stack buffers and the Swift by-value calls assume two words.
        // Reject a changed layout before any constructor or setter can use it.
        available = found && coreDeviceErrorMetadata &&
            SSCoreDeviceValueSize(reportMetadata) == sizeof(struct DataWords) &&
            SSCoreDeviceValueSize(contactMetadata) == sizeof(struct DataWords);
    });
    return available;
}

bool SSCoreDeviceSendTouches(void *capability, uint32_t serviceID,
                             const struct SSCoreDeviceTouch *contacts,
                             uint8_t count, bool touching, uint32_t edge) {
    if (!capability || !contacts || count < 1 || count > 2 || edge > 4 ||
        !SSCoreDeviceDigitizerAvailable()) return false;
    for (uint8_t i = 0; i < count; i++) {
        if (!isfinite(contacts[i].x) || !isfinite(contacts[i].y)) return false;
    }
    void *metadata = ((void **)capability)[3], *witness = ((void **)capability)[4];
    if (!metadata || !witness) return false;
    void *errorMetadata = coreDeviceErrorMetadata;
    void *error = calloc(1, SSCoreDeviceValueSize(errorMetadata));
    if (!error) return false;

    struct DataWords report;
    initReport(&report, reportMetadata, descriptorWitness, reportWitness);
    setCount(count, &report);
    for (uint8_t i = 0; i < count; i++) {
        struct DataWords contact = initContact();
        setIndex(i + 1, &contact);
        setX(fmin(1, fmax(0, contacts[i].x)), &contact);
        setY(fmin(1, fmax(0, contacts[i].y)), &contact);
        setTouch(touching, &contact);
        setRange(touching, &contact);
        setContact(contact.first, contact.second, i, &report);
        SSCoreDeviceDestroyValue(&contact, contactMetadata);
        setIdentity(i + 1, i, &report);
        if (edge) {
            // Device Hub combines the inward direction with swipeLocked.
            // Direction alone remains an ordinary app drag. Keep both flags
            // on lift as well so SpringBoard can finish Home/app-switcher swipes.
            if (setSwipeLocked) setSwipeLocked(true, i, &report);
            setSwipe[edge](true, i, &report);
        }
    }
    setTime(mach_absolute_time(), false, &report);
    // HIDServiceID is resilient: pass its address, not its integer value.
    uint64_t service = serviceID;
    void *errorFlag = NULL;
    sendReport(report.first, report.second, &service, error, metadata, witness, capability, &errorFlag);
    SSCoreDeviceDestroyValue(&report, reportMetadata);
    if (errorFlag) SSCoreDeviceDestroyValue(error, errorMetadata);
    free(error);
    return errorFlag == NULL;
}
