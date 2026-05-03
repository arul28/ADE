#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <math.h>
#import <mach/mach_time.h>
#import <objc/message.h>
#import <objc/runtime.h>

#pragma pack(push, 4)
typedef struct {
  unsigned int msgh_bits;
  unsigned int msgh_size;
  unsigned int msgh_remote_port;
  unsigned int msgh_local_port;
  unsigned int msgh_voucher_port;
  unsigned int msgh_id;
} IndigoMachHeader;

typedef struct {
  unsigned int field1;
  unsigned int field2;
  unsigned int field3;
  double xRatio;
  double yRatio;
  double field6;
  double field7;
  double field8;
  unsigned int field9;
  unsigned int field10;
  unsigned int field11;
  unsigned int field12;
  unsigned int field13;
  double field14;
  double field15;
  double field16;
  double field17;
  double field18;
} IndigoTouch;

typedef struct {
  unsigned int eventSource;
  unsigned int eventType;
  unsigned int eventTarget;
  unsigned int keyCode;
  unsigned int field5;
} IndigoButton;

typedef union {
  IndigoTouch touch;
  IndigoButton button;
  unsigned char raw[144];
} IndigoEvent;

typedef struct {
  unsigned int field1;
  unsigned long long timestamp;
  unsigned int field3;
  IndigoEvent event;
} IndigoPayload;

typedef struct {
  IndigoMachHeader header;
  unsigned int innerSize;
  unsigned char eventType;
  IndigoPayload payload;
} IndigoMessage;
#pragma pack(pop)

#define IndigoEventTypeButton 1
#define IndigoEventTypeTouch 2
#define ButtonEventSourceHomeButton 0x0
#define ButtonEventSourceLock 0x1
#define ButtonEventSourceSideButton 0xbb8
#define ButtonEventSourceSiri 0x400002
#define ButtonEventSourceApplePay 0x1f4
#define ButtonEventTargetHardware 0x33
#define ButtonEventTypeDown 0x1
#define ButtonEventTypeUp 0x2
#define TouchDigitizerTarget 0x32
#define MouseEventDown 0x1
#define MouseEventUp 0x2
#define MouseEventDragged 0x6
#define MouseDirectionDown 0x1
#define MouseDirectionMove 0x0
#define MouseDirectionUp 0x2

typedef IndigoMessage *(*IndigoButtonFn)(int keyCode, int op, int target);
typedef IndigoMessage *(*IndigoMouse5Fn)(CGPoint *point0, CGPoint *point1, int target, int eventType, BOOL extra);
typedef IndigoMessage *(*IndigoMouse9Fn)(
  CGPoint *point0,
  CGPoint *point1,
  unsigned int target,
  unsigned int eventType,
  unsigned int direction,
  double unused1,
  double unused2,
  double widthPoints,
  double heightPoints
);
typedef IndigoMessage *(*IndigoServiceFn)(void);

static NSString *gDeviceUdid = nil;
static id gHidClient = nil;
static IndigoButtonFn gButtonFn = NULL;
static IndigoMouse5Fn gMouse5Fn = NULL;
static IndigoMouse9Fn gMouse9Fn = NULL;
static IndigoServiceFn gCreatePointerServiceFn = NULL;
static IndigoServiceFn gCreateMouseServiceFn = NULL;
static BOOL gUseModernMousePath = NO;
static dispatch_queue_t gSendQueue;

static BOOL sendIndigo(IndigoMessage *message, NSString **errorOut);

static void elog(NSString *fmt, ...) {
  va_list args;
  va_start(args, fmt);
  NSString *message = [[NSString alloc] initWithFormat:fmt arguments:args];
  va_end(args);
  NSData *data = [[message stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
  [[NSFileHandle fileHandleWithStandardError] writeData:data];
}

static void ack(NSString *eventId, BOOL ok, NSString *error) {
  NSMutableDictionary *payload = [NSMutableDictionary dictionary];
  if (eventId.length) payload[@"id"] = eventId;
  payload[@"ok"] = @(ok);
  if (error.length) payload[@"error"] = error;
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  if (!data) return;
  NSMutableData *line = [data mutableCopy];
  [line appendData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
  [[NSFileHandle fileHandleWithStandardOutput] writeData:line];
}

static NSString *developerDir(void) {
  NSTask *task = [NSTask new];
  task.launchPath = @"/usr/bin/xcode-select";
  task.arguments = @[@"-p"];
  NSPipe *pipe = [NSPipe pipe];
  task.standardOutput = pipe;
  @try {
    [task launch];
    [task waitUntilExit];
  } @catch (id ignored) {}
  NSString *raw = [[NSString alloc] initWithData:pipe.fileHandleForReading.readDataToEndOfFile encoding:NSUTF8StringEncoding];
  raw = [raw stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  return raw.length ? raw : @"/Applications/Xcode.app/Contents/Developer";
}

static NSString *simulatorKitPath(void) {
  NSString *developer = developerDir();
  NSArray<NSString *> *candidates = @[
    [developer stringByAppendingPathComponent:@"Platforms/iPhoneSimulator.platform/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"],
    [developer stringByAppendingPathComponent:@"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"],
  ];
  for (NSString *candidate in candidates) {
    if ([[NSFileManager defaultManager] fileExistsAtPath:candidate]) return candidate;
  }
  return candidates.firstObject;
}

static id sharedServiceContext(void) {
  Class cls = NSClassFromString(@"SimServiceContext");
  if (!cls) {
    elog(@"[sim-input] SimServiceContext missing");
    return nil;
  }
  SEL selector = @selector(sharedServiceContextForDeveloperDir:error:);
  NSError *error = nil;
  id (*fn)(Class, SEL, NSString *, NSError **) = (id (*)(Class, SEL, NSString *, NSError **))objc_msgSend;
  id context = fn(cls, selector, developerDir(), &error);
  if (!context) elog(@"[sim-input] sharedServiceContext err: %@", error);
  return context;
}

static id defaultDeviceSet(id context) {
  SEL selector = @selector(defaultDeviceSetWithError:);
  NSError *error = nil;
  id (*fn)(id, SEL, NSError **) = (id (*)(id, SEL, NSError **))objc_msgSend;
  id deviceSet = fn(context, selector, &error);
  if (!deviceSet) elog(@"[sim-input] defaultDeviceSet err: %@", error);
  return deviceSet;
}

static NSString *deviceUDID(id device) {
  id raw = [device valueForKey:@"UDID"];
  if ([raw isKindOfClass:NSUUID.class]) return [raw UUIDString];
  if ([raw isKindOfClass:NSString.class]) return raw;
  return @"?";
}

static id bootedDevice(id deviceSet) {
  NSArray *devices = [deviceSet valueForKey:@"devices"];
  for (id device in devices) {
    NSNumber *state = [device valueForKey:@"state"];
    if (state.intValue != 3) continue;
    if (gDeviceUdid.length && [deviceUDID(device) caseInsensitiveCompare:gDeviceUdid] != NSOrderedSame) continue;
    return device;
  }
  return nil;
}

static NSInteger selectedXcodeMajor(void) {
  NSTask *task = [NSTask new];
  task.launchPath = @"/usr/bin/xcodebuild";
  task.arguments = @[@"-version"];
  NSPipe *pipe = [NSPipe pipe];
  task.standardOutput = pipe;
  @try {
    [task launch];
    [task waitUntilExit];
  } @catch (id ignored) {
    return 0;
  }
  NSString *raw = [[NSString alloc] initWithData:pipe.fileHandleForReading.readDataToEndOfFile encoding:NSUTF8StringEncoding];
  NSArray<NSString *> *parts = [raw componentsSeparatedByCharactersInSet:[[NSCharacterSet decimalDigitCharacterSet] invertedSet]];
  for (NSString *part in parts) {
    if (part.length > 0) return part.integerValue;
  }
  return 0;
}

static BOOL loadIndigoSymbolsOnly(void) {
  if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)) {
    elog(@"[sim-input] FAIL dlopen CoreSimulator: %s", dlerror());
    return NO;
  }
  NSString *kitPath = simulatorKitPath();
  void *kit = dlopen(kitPath.fileSystemRepresentation, RTLD_NOW);
  if (!kit) {
    elog(@"[sim-input] FAIL dlopen SimulatorKit (%@): %s", kitPath, dlerror());
    return NO;
  }
  gButtonFn = (IndigoButtonFn)dlsym(kit, "IndigoHIDMessageForButton");
  void *mouseSymbol = dlsym(kit, "IndigoHIDMessageForMouseNSEvent");
  gMouse5Fn = (IndigoMouse5Fn)mouseSymbol;
  gMouse9Fn = (IndigoMouse9Fn)mouseSymbol;
  gCreatePointerServiceFn = (IndigoServiceFn)dlsym(kit, "IndigoHIDMessageToCreatePointerService");
  gCreateMouseServiceFn = (IndigoServiceFn)dlsym(kit, "IndigoHIDMessageToCreateMouseService");
  gUseModernMousePath = selectedXcodeMajor() >= 26;
  if (!gButtonFn || !mouseSymbol) {
    elog(@"[sim-input] FAIL Indigo dlsym button=%p mouse=%p", gButtonFn, mouseSymbol);
    return NO;
  }
  return YES;
}

static void warmIndigoService(IndigoServiceFn serviceFn, NSString *name) {
  if (!serviceFn) return;
  NSString *error = nil;
  IndigoMessage *message = serviceFn();
  if (!message) {
    elog(@"[sim-input] %@ warmup returned NULL", name);
    return;
  }
  if (!sendIndigo(message, &error)) {
    elog(@"[sim-input] %@ warmup failed: %@", name, error ?: @"unknown error");
    return;
  }
  usleep(20000);
}

static BOOL ensureHID(void) {
  if (gHidClient) return YES;
  if (!loadIndigoSymbolsOnly()) return NO;
  id context = sharedServiceContext();
  if (!context) return NO;
  id deviceSet = defaultDeviceSet(context);
  if (!deviceSet) return NO;
  id device = bootedDevice(deviceSet);
  if (!device) {
    elog(@"[sim-input] no booted device for %@", gDeviceUdid ?: @"requested UDID");
    return NO;
  }
  Class clientClass = objc_lookUpClass("_TtC12SimulatorKit24SimDeviceLegacyHIDClient");
  if (!clientClass) clientClass = NSClassFromString(@"SimulatorKit.SimDeviceLegacyHIDClient");
  if (!clientClass) {
    elog(@"[sim-input] FAIL no SimDeviceLegacyHIDClient class");
    return NO;
  }
  NSError *error = nil;
  id allocated = [clientClass alloc];
  SEL selector = @selector(initWithDevice:error:);
  id (*initFn)(id, SEL, id, NSError **) = (id (*)(id, SEL, id, NSError **))objc_msgSend;
  id client = initFn(allocated, selector, device, &error);
  if (!client) {
    elog(@"[sim-input] FAIL init HID client: %@", error);
    return NO;
  }
  gHidClient = client;
  gSendQueue = dispatch_queue_create("app.ade.ios-sim.input", DISPATCH_QUEUE_SERIAL);
  warmIndigoService(gCreatePointerServiceFn, @"pointer service");
  warmIndigoService(gCreateMouseServiceFn, @"mouse service");
  elog(@"[sim-input] HID client ready dev=%@ udid=%@", [device valueForKey:@"name"], deviceUDID(device));
  return YES;
}

static BOOL sendIndigo(IndigoMessage *message, NSString **errorOut) {
  if (!gHidClient || !message) {
    if (errorOut) *errorOut = @"Indigo HID client is not available.";
    if (message) free(message);
    return NO;
  }
  SEL selector = @selector(sendWithMessage:freeWhenDone:completionQueue:completion:);
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block NSError *sendError = nil;
  void (^completion)(NSError *) = ^(NSError *error) {
    sendError = error;
    if (error) elog(@"[sim-input] send err: %@", error);
    dispatch_semaphore_signal(done);
  };
  void (*sendFn)(id, SEL, IndigoMessage *, BOOL, dispatch_queue_t, void(^)(NSError *)) =
    (void (*)(id, SEL, IndigoMessage *, BOOL, dispatch_queue_t, void(^)(NSError *)))objc_msgSend;
  sendFn(gHidClient, selector, message, YES, gSendQueue, completion);
  long wait = dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
  if (wait != 0) {
    if (errorOut) *errorOut = @"Timed out waiting for Indigo HID send completion.";
    return NO;
  }
  if (sendError) {
    if (errorOut) *errorOut = sendError.localizedDescription ?: @"Indigo HID send failed.";
    return NO;
  }
  return YES;
}

static double positiveOrDefault(id value, double fallback) {
  double parsed = [value respondsToSelector:@selector(doubleValue)] ? [value doubleValue] : fallback;
  return isfinite(parsed) && parsed > 0 ? parsed : fallback;
}

static double clampUnit(double value) {
  if (!isfinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

static BOOL sendModernTouch(double x, double y, double width, double height, unsigned int eventType, unsigned int direction, NSString **errorOut) {
  if (!gMouse9Fn) {
    if (errorOut) *errorOut = @"Modern Indigo mouse event builder is not available.";
    return NO;
  }
  CGPoint point = CGPointMake(clampUnit(x / width), clampUnit(y / height));
  IndigoMessage *message = gMouse9Fn(&point, NULL, TouchDigitizerTarget, eventType, direction, 1.0, 1.0, width, height);
  if (!message) {
    if (errorOut) *errorOut = @"Indigo mouse event builder returned NULL.";
    elog(@"[sim-input] %@", errorOut ? *errorOut : @"MouseFn returned NULL");
    return NO;
  }
  return sendIndigo(message, errorOut);
}

static BOOL sendLegacyTouch(double x, double y, double width, double height, unsigned int eventType, NSString **errorOut) {
  if (!gMouse5Fn) {
    if (errorOut) *errorOut = @"Legacy Indigo mouse event builder is not available.";
    return NO;
  }
  double xRatio = clampUnit(x / width);
  double yRatio = clampUnit(y / height);
  CGPoint point = CGPointMake(xRatio, yRatio);
  int legacyEventType = eventType == MouseEventUp ? ButtonEventTypeUp : ButtonEventTypeDown;
  IndigoMessage *seed = gMouse5Fn(&point, NULL, TouchDigitizerTarget, legacyEventType, NO);
  if (!seed) {
    if (errorOut) *errorOut = @"Indigo mouse event builder returned NULL.";
    elog(@"[sim-input] %@", errorOut ? *errorOut : @"MouseFn returned NULL");
    return NO;
  }
  size_t messageSize = sizeof(IndigoMessage) + sizeof(IndigoPayload);
  size_t stride = sizeof(IndigoPayload);
  IndigoMessage *message = calloc(1, messageSize);
  message->innerSize = (unsigned int)sizeof(IndigoPayload);
  message->eventType = IndigoEventTypeTouch;
  message->payload.field1 = 0x0000000b;
  message->payload.timestamp = mach_absolute_time();
  memcpy(&message->payload.event.touch, &seed->payload.event.touch, sizeof(IndigoTouch));
  message->payload.event.touch.xRatio = xRatio;
  message->payload.event.touch.yRatio = yRatio;
  void *first = &message->payload;
  void *second = (void *)((uintptr_t)first + stride);
  memcpy(second, first, stride);
  IndigoPayload *secondPayload = (IndigoPayload *)second;
  secondPayload->event.touch.field1 = 0x00000001;
  secondPayload->event.touch.field2 = 0x00000002;
  free(seed);
  return sendIndigo(message, errorOut);
}

static BOOL sendTouch(double x, double y, double width, double height, unsigned int eventType, unsigned int direction, NSString **errorOut) {
  if (gUseModernMousePath) {
    return sendModernTouch(x, y, width, height, eventType, direction, errorOut);
  }
  return sendLegacyTouch(x, y, width, height, eventType, errorOut);
}

static BOOL sendButton(NSString *name, BOOL down, NSString **errorOut) {
  int source = ButtonEventSourceHomeButton;
  if ([name isEqualToString:@"home"]) source = ButtonEventSourceHomeButton;
  else if ([name isEqualToString:@"lock"]) source = ButtonEventSourceLock;
  else if ([name isEqualToString:@"side"]) source = ButtonEventSourceSideButton;
  else if ([name isEqualToString:@"siri"]) source = ButtonEventSourceSiri;
  else if ([name isEqualToString:@"applepay"]) source = ButtonEventSourceApplePay;
  else {
    if (errorOut) *errorOut = [NSString stringWithFormat:@"Unknown Indigo button: %@", name ?: @"<missing>"];
    elog(@"[sim-input] unknown button %@", name);
    return NO;
  }
  int operation = down ? ButtonEventTypeDown : ButtonEventTypeUp;
  return sendIndigo(gButtonFn(source, operation, ButtonEventTargetHardware), errorOut);
}

static BOOL processEvent(NSDictionary *event, NSString **errorOut) {
  if (!ensureHID()) {
    if (errorOut) *errorOut = @"Indigo HID client is not available.";
    return NO;
  }
  NSString *type = event[@"type"];
  double width = positiveOrDefault(event[@"width"], 1);
  double height = positiveOrDefault(event[@"height"], 1);
  if ([type isEqualToString:@"touch"]) {
    NSString *phase = event[@"phase"] ?: @"down";
    unsigned int eventType = MouseEventDown;
    unsigned int direction = MouseDirectionDown;
    if ([phase isEqualToString:@"move"]) {
      eventType = MouseEventDragged;
      direction = MouseDirectionMove;
    } else if ([phase isEqualToString:@"up"]) {
      eventType = MouseEventUp;
      direction = MouseDirectionUp;
    }
    return sendTouch([event[@"x"] doubleValue], [event[@"y"] doubleValue], width, height, eventType, direction, errorOut);
  }
  if ([type isEqualToString:@"tap"]) {
    double x = [event[@"x"] doubleValue];
    double y = [event[@"y"] doubleValue];
    int hold = event[@"hold"] ? [event[@"hold"] intValue] : 45;
    if (!sendTouch(x, y, width, height, MouseEventDown, MouseDirectionDown, errorOut)) return NO;
    usleep((useconds_t)(MAX(0, hold) * 1000));
    return sendTouch(x, y, width, height, MouseEventUp, MouseDirectionUp, errorOut);
  }
  if ([type isEqualToString:@"swipe"]) {
    double startX = [event[@"startX"] doubleValue];
    double startY = [event[@"startY"] doubleValue];
    double endX = [event[@"endX"] doubleValue];
    double endY = [event[@"endY"] doubleValue];
    int durationMs = event[@"durationMs"] ? [event[@"durationMs"] intValue] : 180;
    int steps = MAX(4, MIN(30, durationMs / 16));
    if (!sendTouch(startX, startY, width, height, MouseEventDown, MouseDirectionDown, errorOut)) return NO;
    for (int i = 1; i < steps; i++) {
      double progress = (double)i / (double)steps;
      if (!sendTouch(
        startX + ((endX - startX) * progress),
        startY + ((endY - startY) * progress),
        width,
        height,
        MouseEventDragged,
        MouseDirectionMove,
        errorOut
      )) return NO;
      usleep((useconds_t)(MAX(1, durationMs / steps) * 1000));
    }
    return sendTouch(endX, endY, width, height, MouseEventUp, MouseDirectionUp, errorOut);
  }
  if ([type isEqualToString:@"button"]) {
    NSString *phase = event[@"phase"] ?: @"down";
    return sendButton(event[@"name"] ?: @"home", [phase isEqualToString:@"down"], errorOut);
  }
  if ([type isEqualToString:@"button-tap"]) {
    NSString *name = event[@"name"] ?: @"home";
    if (!sendButton(name, YES, errorOut)) return NO;
    usleep(80000);
    return sendButton(name, NO, errorOut);
  }
  if ([type isEqualToString:@"text"] || [type isEqualToString:@"key"]) {
    if (errorOut) *errorOut = @"Indigo text and keyboard events are not supported by this helper yet.";
    return NO;
  }
  if (errorOut) *errorOut = [NSString stringWithFormat:@"Unknown input event type: %@", type ?: @"<missing>"];
  return NO;
}

static NSString *readArgValue(int argc, const char **argv, const char *name) {
  for (int i = 1; i + 1 < argc; i++) {
    if (strcmp(argv[i], name) == 0) return [NSString stringWithUTF8String:argv[i + 1]];
  }
  return nil;
}

static BOOL hasFlag(int argc, const char **argv, const char *name) {
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], name) == 0) return YES;
  }
  return NO;
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    if (hasFlag(argc, argv, "--smoke-test")) {
      BOOL ok = loadIndigoSymbolsOnly();
      if (ok) {
        ack(@"smoke", YES, nil);
        return 0;
      }
      ack(@"smoke", NO, @"Indigo symbols are unavailable.");
      return 2;
    }
    gDeviceUdid = readArgValue(argc, argv, "--udid");
    if (!gDeviceUdid.length) {
      elog(@"[sim-input] --udid is required");
      return 64;
    }
    if (!ensureHID()) {
      elog(@"[sim-input] FAIL ensureHID at startup");
      return 2;
    }
    elog(@"[sim-input] ready");
    NSFileHandle *input = [NSFileHandle fileHandleWithStandardInput];
    NSMutableData *buffer = [NSMutableData data];
    while (true) {
      NSData *chunk;
      @try {
        chunk = [input availableData];
      } @catch (id ignored) {
        break;
      }
      if (chunk.length == 0) break;
      [buffer appendData:chunk];
      while (true) {
        const char *bytes = buffer.bytes;
        NSUInteger length = buffer.length;
        NSUInteger newline = NSNotFound;
        for (NSUInteger i = 0; i < length; i++) {
          if (bytes[i] == '\n') {
            newline = i;
            break;
          }
        }
        if (newline == NSNotFound) break;
        NSData *line = [buffer subdataWithRange:NSMakeRange(0, newline)];
        [buffer replaceBytesInRange:NSMakeRange(0, newline + 1) withBytes:NULL length:0];
        if (line.length == 0) continue;
        NSError *jsonError = nil;
        id object = [NSJSONSerialization JSONObjectWithData:line options:0 error:&jsonError];
        if (![object isKindOfClass:NSDictionary.class]) {
          ack(nil, NO, jsonError.localizedDescription ?: @"Input was not a JSON object.");
          continue;
        }
        NSDictionary *event = object;
        NSString *eventId = [event[@"id"] isKindOfClass:NSString.class] ? event[@"id"] : nil;
        NSString *eventError = nil;
        BOOL ok = processEvent(event, &eventError);
        ack(eventId, ok, eventError);
      }
    }
    elog(@"[sim-input] stdin closed, exiting");
  }
  return 0;
}
