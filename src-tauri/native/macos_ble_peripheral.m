#import <CoreBluetooth/CoreBluetooth.h>
#import <Foundation/Foundation.h>

static NSString *const MeshServiceUUID = @"0000FEED-0000-1000-8000-00805F9B34FB";
static NSString *const MeshCharacteristicUUID = @"0000FEE1-0000-1000-8000-00805F9B34FB";

static NSString *HexEncode(NSData *data) {
    const unsigned char *bytes = data.bytes;
    NSMutableString *hex = [NSMutableString stringWithCapacity:data.length * 2];
    for (NSUInteger i = 0; i < data.length; i++) {
        [hex appendFormat:@"%02x", bytes[i]];
    }
    return hex;
}

static NSData *HexDecode(NSString *text) {
    NSString *trimmed = [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (trimmed.length % 2 != 0) {
        return nil;
    }

    NSMutableData *data = [NSMutableData dataWithCapacity:trimmed.length / 2];
    for (NSUInteger i = 0; i < trimmed.length; i += 2) {
        NSString *pair = [trimmed substringWithRange:NSMakeRange(i, 2)];
        unsigned int byte = 0;
        NSScanner *scanner = [NSScanner scannerWithString:pair];
        if (![scanner scanHexInt:&byte] || !scanner.isAtEnd || byte > 0xff) {
            return nil;
        }
        unsigned char value = (unsigned char)byte;
        [data appendBytes:&value length:1];
    }
    return data;
}

static void Emit(NSString *line) {
    printf("%s\n", line.UTF8String);
    fflush(stdout);
}

@interface MeshPeripheral : NSObject <CBPeripheralManagerDelegate>
@property(nonatomic, strong) CBPeripheralManager *manager;
@property(nonatomic, strong) CBMutableCharacteristic *characteristic;
@property(nonatomic, strong) NSMutableArray<NSData *> *sendQueue;
@property(nonatomic, assign) BOOL started;
@end

@implementation MeshPeripheral

- (void)start {
    if (self.manager == nil) {
        self.manager = [[CBPeripheralManager alloc] initWithDelegate:self queue:dispatch_get_main_queue()];
    } else {
        [self startAdvertisingIfReady];
    }
}

- (void)stop {
    [self.manager stopAdvertising];
    [self.manager removeAllServices];
    self.characteristic = nil;
    self.started = NO;
    Emit(@"STATE stopped");
}

- (void)send:(NSData *)data {
    if (self.characteristic == nil) {
        Emit(@"ERROR no-characteristic");
        return;
    }

    if (self.sendQueue == nil) {
        self.sendQueue = [NSMutableArray array];
    }
    [self.sendQueue addObject:[data copy]];
    [self flushSendQueue];
}

- (void)flushSendQueue {
    if (self.characteristic == nil || self.sendQueue.count == 0) {
        return;
    }

    while (self.sendQueue.count > 0) {
        NSData *next = self.sendQueue.firstObject;
        BOOL ok = [self.manager updateValue:next forCharacteristic:self.characteristic onSubscribedCentrals:nil];
        if (!ok) {
            Emit([NSString stringWithFormat:@"BACKPRESSURE queued=%lu", (unsigned long)self.sendQueue.count]);
            return;
        }

        Emit([NSString stringWithFormat:@"SENT %lu", (unsigned long)next.length]);
        [self.sendQueue removeObjectAtIndex:0];
    }
}

- (void)peripheralManagerDidUpdateState:(CBPeripheralManager *)peripheral {
    switch (peripheral.state) {
        case CBManagerStatePoweredOn:
            Emit(@"STATE poweredOn");
            [self startAdvertisingIfReady];
            break;
        case CBManagerStatePoweredOff:
            Emit(@"STATE poweredOff");
            break;
        case CBManagerStateUnauthorized:
            Emit(@"STATE unauthorized");
            break;
        case CBManagerStateUnsupported:
            Emit(@"STATE unsupported");
            break;
        case CBManagerStateResetting:
            Emit(@"STATE resetting");
            break;
        case CBManagerStateUnknown:
        default:
            Emit(@"STATE unknown");
            break;
    }
}

- (void)peripheralManager:(CBPeripheralManager *)peripheral
                  central:(CBCentral *)central
 didSubscribeToCharacteristic:(CBCharacteristic *)characteristic {
    Emit([NSString stringWithFormat:@"SUBSCRIBE %@", central.identifier.UUIDString]);
    [self flushSendQueue];
}

- (void)peripheralManager:(CBPeripheralManager *)peripheral
                  central:(CBCentral *)central
didUnsubscribeFromCharacteristic:(CBCharacteristic *)characteristic {
    Emit([NSString stringWithFormat:@"UNSUBSCRIBE %@", central.identifier.UUIDString]);
}

- (void)peripheralManager:(CBPeripheralManager *)peripheral didAddService:(CBService *)service error:(NSError *)error {
    if (error != nil) {
        Emit([NSString stringWithFormat:@"ERROR add-service %@", error.localizedDescription]);
        return;
    }

    [peripheral startAdvertising:@{
        CBAdvertisementDataServiceUUIDsKey: @[[CBUUID UUIDWithString:MeshServiceUUID]],
        CBAdvertisementDataLocalNameKey: @"app-ble-mesh",
    }];
    Emit(@"STATE advertising");
}

- (void)peripheralManagerDidStartAdvertising:(CBPeripheralManager *)peripheral error:(NSError *)error {
    if (error != nil) {
        Emit([NSString stringWithFormat:@"ERROR advertise %@", error.localizedDescription]);
    } else {
        Emit(@"STATE advertising-started");
    }
}

- (void)peripheralManagerIsReadyToUpdateSubscribers:(CBPeripheralManager *)peripheral {
    [self flushSendQueue];
}

- (void)peripheralManager:(CBPeripheralManager *)peripheral didReceiveWriteRequests:(NSArray<CBATTRequest *> *)requests {
    for (CBATTRequest *request in requests) {
        if ([request.characteristic.UUID isEqual:[CBUUID UUIDWithString:MeshCharacteristicUUID]]) {
            if (request.value != nil) {
                Emit([NSString stringWithFormat:@"WRITE %@", HexEncode(request.value)]);
            }
            [peripheral respondToRequest:request withResult:CBATTErrorSuccess];
        }
    }
}

- (void)peripheralManager:(CBPeripheralManager *)peripheral didReceiveReadRequest:(CBATTRequest *)request {
    if ([request.characteristic.UUID isEqual:[CBUUID UUIDWithString:MeshCharacteristicUUID]]) {
        request.value = [NSData data];
        [peripheral respondToRequest:request withResult:CBATTErrorSuccess];
    }
}

- (void)startAdvertisingIfReady {
    if (self.manager == nil || self.manager.state != CBManagerStatePoweredOn || self.started) {
        return;
    }
    self.started = YES;

    CBUUID *characteristicUUID = [CBUUID UUIDWithString:MeshCharacteristicUUID];
    self.characteristic = [[CBMutableCharacteristic alloc]
        initWithType:characteristicUUID
          properties:CBCharacteristicPropertyRead | CBCharacteristicPropertyWrite | CBCharacteristicPropertyWriteWithoutResponse | CBCharacteristicPropertyNotify
               value:nil
         permissions:CBAttributePermissionsReadable | CBAttributePermissionsWriteable];

    CBMutableService *service = [[CBMutableService alloc] initWithType:[CBUUID UUIDWithString:MeshServiceUUID] primary:YES];
    service.characteristics = @[self.characteristic];
    [self.manager removeAllServices];
    [self.manager addService:service];
}

@end

int main(void) {
    @autoreleasepool {
        MeshPeripheral *peripheral = [[MeshPeripheral alloc] init];
        [peripheral start];

        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            char buffer[8192];
            while (fgets(buffer, sizeof(buffer), stdin) != NULL) {
                NSString *rawLine = [[NSString alloc] initWithUTF8String:buffer];
                NSString *line = [rawLine stringByTrimmingCharactersInSet:NSCharacterSet.newlineCharacterSet];

                dispatch_async(dispatch_get_main_queue(), ^{
                    if ([line isEqualToString:@"START"]) {
                        [peripheral start];
                    } else if ([line isEqualToString:@"STOP"]) {
                        [peripheral stop];
                    } else if ([line hasPrefix:@"SEND "]) {
                        NSData *data = HexDecode([line substringFromIndex:5]);
                        if (data != nil) {
                            [peripheral send:data];
                        } else {
                            Emit(@"ERROR bad-hex");
                        }
                    }
                });
            }
        });

        [[NSRunLoop mainRunLoop] run];
    }
    return 0;
}
