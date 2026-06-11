import CoreBluetooth
import Foundation

private let serviceUUID = CBUUID(string: "0000FEED-0000-1000-8000-00805F9B34FB")
private let characteristicUUID = CBUUID(string: "0000FEE1-0000-1000-8000-00805F9B34FB")

private func hexEncode(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
}

private func hexDecode(_ text: String) -> Data? {
    let chars = Array(text.trimmingCharacters(in: .whitespacesAndNewlines))
    guard chars.count % 2 == 0 else { return nil }

    var data = Data()
    var index = 0
    while index < chars.count {
        let pair = String(chars[index]) + String(chars[index + 1])
        guard let byte = UInt8(pair, radix: 16) else { return nil }
        data.append(byte)
        index += 2
    }
    return data
}

private func emit(_ line: String) {
    print(line)
    fflush(stdout)
}

final class MeshPeripheral: NSObject, CBPeripheralManagerDelegate {
    private var manager: CBPeripheralManager?
    private var characteristic: CBMutableCharacteristic?
    private var started = false

    func start() {
        if manager == nil {
            manager = CBPeripheralManager(delegate: self, queue: DispatchQueue.main)
        } else {
            startAdvertisingIfReady()
        }
    }

    func stop() {
        manager?.stopAdvertising()
        manager?.removeAllServices()
        characteristic = nil
        started = false
        emit("STATE stopped")
    }

    func send(_ data: Data) {
        guard let characteristic else {
            emit("ERROR no-characteristic")
            return
        }

        let ok = manager?.updateValue(data, for: characteristic, onSubscribedCentrals: nil) ?? false
        emit(ok ? "SENT \(data.count)" : "BACKPRESSURE \(data.count)")
    }

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        switch peripheral.state {
        case .poweredOn:
            emit("STATE poweredOn")
            startAdvertisingIfReady()
        case .poweredOff:
            emit("STATE poweredOff")
        case .unauthorized:
            emit("STATE unauthorized")
        case .unsupported:
            emit("STATE unsupported")
        case .resetting:
            emit("STATE resetting")
        case .unknown:
            emit("STATE unknown")
        @unknown default:
            emit("STATE unknown")
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        emit("SUBSCRIBE \(central.identifier.uuidString)")
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        emit("UNSUBSCRIBE \(central.identifier.uuidString)")
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error = error {
            emit("ERROR add-service \(error.localizedDescription)")
            return
        }
        peripheral.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [serviceUUID],
            CBAdvertisementDataLocalNameKey: "app-ble-mesh",
        ])
        emit("STATE advertising")
    }

    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        if let error = error {
            emit("ERROR advertise \(error.localizedDescription)")
        } else {
            emit("STATE advertising-started")
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        for request in requests where request.characteristic.uuid == characteristicUUID {
            if let value = request.value {
                emit("WRITE \(hexEncode(value))")
            }
            peripheral.respond(to: request, withResult: .success)
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        if request.characteristic.uuid == characteristicUUID {
            request.value = Data()
            peripheral.respond(to: request, withResult: .success)
        }
    }

    private func startAdvertisingIfReady() {
        guard let manager, manager.state == .poweredOn, !started else { return }
        started = true

        let characteristic = CBMutableCharacteristic(
            type: characteristicUUID,
            properties: [.read, .write, .writeWithoutResponse, .notify],
            value: nil,
            permissions: [.readable, .writeable]
        )
        let service = CBMutableService(type: serviceUUID, primary: true)
        service.characteristics = [characteristic]
        self.characteristic = characteristic
        manager.removeAllServices()
        manager.add(service)
    }
}

let peripheral = MeshPeripheral()
peripheral.start()

DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        if line == "START" {
            DispatchQueue.main.async { peripheral.start() }
        } else if line == "STOP" {
            DispatchQueue.main.async { peripheral.stop() }
        } else if line.hasPrefix("SEND ") {
            let hex = String(line.dropFirst(5))
            if let data = hexDecode(hex) {
                DispatchQueue.main.async { peripheral.send(data) }
            } else {
                emit("ERROR bad-hex")
            }
        }
    }
}

RunLoop.main.run()
