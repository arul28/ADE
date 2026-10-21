#include <stdbool.h>
#include <stdint.h>

struct SSCoreDeviceSwiftString {
    uintptr_t first;
    uintptr_t second;
};

bool SSCoreDeviceDisplayAvailable(void);
void *SSCoreDeviceDisplayMetadata(void);
void *SSCoreDeviceDisplayInfoMetadata(void);
uintptr_t SSCoreDeviceValueSize(void *metadata);
void *SSCoreDeviceDisplays(void *info);
uint32_t SSCoreDeviceDisplayID(void *display);
uint8_t SSCoreDeviceDisplayActive(void *display);
struct SSCoreDeviceSwiftString SSCoreDeviceDisplayOrientation(void *display);
void SSCoreDeviceDestroyValue(void *value, void *metadata);
bool SSCoreDeviceOptionalHasValue(const void *value, void *wrappedMetadata);
