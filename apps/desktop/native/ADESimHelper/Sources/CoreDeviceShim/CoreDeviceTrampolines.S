// Forward the Swift ABI unchanged, including swiftself and indirect results.
// All targets are checked by SSCoreDeviceInitialize before these are called.
#if defined(__aarch64__)
.macro FORWARD name, target
.text
.p2align 2
.globl _\name
_\name:
    adrp x16, _\target@PAGE
    ldr x16, [x16, _\target@PAGEOFF]
    br x16
.endmacro
#elif defined(__x86_64__)
.macro FORWARD name, target
.text
.globl _\name
_\name:
    jmp *_\target(%rip)
.endmacro
#endif

FORWARD SSCDShared, SSCDSharedTarget
FORWARD SSCDConnection, SSCDConnectionTarget
FORWARD SSCDCreateManager, SSCDCreateManagerTarget
FORWARD SSCDAllDevices, SSCDAllDevicesTarget
FORWARD SSCDInitialized, SSCDInitializedTarget
FORWARD SSCDIdentifier, SSCDIdentifierTarget
FORWARD SSCDVisibilityAllCases, SSCDVisibilityAllCasesTarget
FORWARD SSCDImplementation, SSCDImplementationTarget
FORWARD SSCDDisplayInfo, SSCDDisplayInfoTarget

.data
.p2align 2
.globl _SSCDImplementationTu
_SSCDImplementationTu:
.long _SSCDImplementation - _SSCDImplementationTu
.long 0
.globl _SSCDDisplayInfoTu
_SSCDDisplayInfoTu:
.long _SSCDDisplayInfo - _SSCDDisplayInfoTu
.long 0
.globl _SSCDMotionManagerDescriptor
_SSCDMotionManagerDescriptor:
.long _SSCDMotionManager - _SSCDMotionManagerDescriptor
.long 0
.globl _SSCDHingeReadbackDescriptor
_SSCDHingeReadbackDescriptor:
.long _SSCDHingeReadback - _SSCDHingeReadbackDescriptor
.long 0
.globl _SSCDDeviceStateReadbackDescriptor
_SSCDDeviceStateReadbackDescriptor:
.long _SSCDDeviceStateReadback - _SSCDDeviceStateReadbackDescriptor
.long 0
.globl _SSCDOrientationReadbackDescriptor
_SSCDOrientationReadbackDescriptor:
.long _SSCDOrientationReadback - _SSCDOrientationReadbackDescriptor
.long 0
