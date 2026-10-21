#pragma once
#include <stdbool.h>
#include <stdint.h>

struct SSCoreDeviceTouch { double x, y; };
bool SSCoreDeviceDigitizerAvailable(void);
// Coordinates are normalized in the panel's native orientation. Contacts retain
// their identity across reports, including the final report with touching=false.
bool SSCoreDeviceSendTouches(void *capability, uint32_t serviceID,
                             const struct SSCoreDeviceTouch *contacts,
                             uint8_t count, bool touching, uint32_t edge);
