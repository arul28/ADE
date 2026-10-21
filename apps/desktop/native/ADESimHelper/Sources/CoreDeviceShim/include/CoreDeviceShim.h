#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "CoreDeviceDisplayShim.h"
#include "CoreDeviceMotionShim.h"
#include "CoreDeviceDigitizerShim.h"

// The private framework has no public Swift module. These entry points isolate
// its calling convention, and resolve every symbol before exposing the bridge.
bool SSCoreDeviceInitialize(void);
void *SSCoreDeviceSymbol(const char *name);
void SSCoreDeviceRetainBridgeObject(void *object);
void *SSCoreDeviceHingeData(double angle);
void *SSCoreDeviceOrientationData(const char *value);
bool SSCoreDeviceSendControl(void *capability, uint64_t data0, uint64_t data1);
bool SSCoreDeviceTableModeAvailable(void);
bool SSCoreDeviceSendTableMode(void *capability, bool enabled);
bool SSCoreDeviceKeyboardAvailable(void);
bool SSCoreDeviceSendKey(void *capability, uint32_t usage, bool down);
