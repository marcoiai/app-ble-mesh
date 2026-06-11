package com.auser.app_ble_mesh

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import android.util.Log
import java.util.UUID

@SuppressLint("MissingPermission")
object BleMeshPeripheral {
    private const val TAG = "BleMeshPeripheral"

    private val SERVICE_UUID: UUID = UUID.fromString("0000FEED-0000-1000-8000-00805F9B34FB")
    private val CHAR_UUID: UUID = UUID.fromString("0000FEE1-0000-1000-8000-00805F9B34FB")
    private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805F9B34FB")

    private var appContext: Context? = null
    private var gattServer: BluetoothGattServer? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private var characteristic: BluetoothGattCharacteristic? = null
    private val connected = mutableSetOf<BluetoothDevice>()
    private val subscribed = mutableSetOf<BluetoothDevice>()

    @JvmStatic external fun nativeRegister()
    @JvmStatic external fun nativeOnFrame(data: ByteArray)

    fun init(context: Context) {
        appContext = context.applicationContext
        try {
            nativeRegister()
        } catch (t: Throwable) {
            Log.e(TAG, "nativeRegister failed", t)
        }
    }

    @JvmStatic
    fun start() {
        val ctx = appContext ?: run {
            Log.w(TAG, "start: no context")
            return
        }
        if (gattServer != null) return
        if (!hasPermissions(ctx)) {
            Log.w(TAG, "start: BLE permissions missing")
            return
        }

        val manager = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            ?: run {
                Log.w(TAG, "start: no BluetoothManager")
                return
            }
        val adapter = manager.adapter ?: run {
            Log.w(TAG, "start: no Bluetooth adapter")
            return
        }
        if (!adapter.isEnabled) {
            Log.w(TAG, "start: bluetooth disabled")
            return
        }

        val server = manager.openGattServer(ctx, gattCallback) ?: run {
            Log.w(TAG, "start: openGattServer returned null")
            return
        }
        val ch = BluetoothGattCharacteristic(
            CHAR_UUID,
            BluetoothGattCharacteristic.PROPERTY_READ or
                BluetoothGattCharacteristic.PROPERTY_NOTIFY or
                BluetoothGattCharacteristic.PROPERTY_WRITE or
                BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            BluetoothGattCharacteristic.PERMISSION_READ or BluetoothGattCharacteristic.PERMISSION_WRITE,
        )
        ch.addDescriptor(
            BluetoothGattDescriptor(
                CCCD_UUID,
                BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
            )
        )
        val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        service.addCharacteristic(ch)
        server.addService(service)
        gattServer = server
        characteristic = ch

        val leAdvertiser = adapter.bluetoothLeAdvertiser ?: run {
            Log.w(TAG, "start: LE advertiser unavailable")
            return
        }
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(true)
            .setTimeout(0)
            .build()
        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceUuid(ParcelUuid(SERVICE_UUID))
            .build()
        leAdvertiser.startAdvertising(settings, data, advertiseCallback)
        advertiser = leAdvertiser
        Log.i(TAG, "advertising $SERVICE_UUID")
    }

    @JvmStatic
    fun send(data: ByteArray) {
        val server = gattServer ?: return
        val ch = characteristic ?: return
        val devices = synchronized(subscribed) { subscribed.toList() }
        for (device in devices) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    server.notifyCharacteristicChanged(device, ch, false, data)
                } else {
                    @Suppress("DEPRECATION")
                    ch.value = data
                    @Suppress("DEPRECATION")
                    server.notifyCharacteristicChanged(device, ch, false)
                }
            } catch (t: Throwable) {
                Log.e(TAG, "notify failed", t)
            }
        }
    }

    @JvmStatic
    fun stop() {
        try { advertiser?.stopAdvertising(advertiseCallback) } catch (_: Throwable) {}
        try { gattServer?.close() } catch (_: Throwable) {}
        advertiser = null
        gattServer = null
        characteristic = null
        synchronized(connected) { connected.clear() }
        synchronized(subscribed) { subscribed.clear() }
        Log.i(TAG, "stopped")
    }

    fun hasPermissions(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return context.checkSelfPermission(android.Manifest.permission.BLUETOOTH_ADVERTISE) ==
                PackageManager.PERMISSION_GRANTED &&
                context.checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT) ==
                PackageManager.PERMISSION_GRANTED &&
                context.checkSelfPermission(android.Manifest.permission.BLUETOOTH_SCAN) ==
                PackageManager.PERMISSION_GRANTED
        }
        return context.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
            Log.i(TAG, "advertise started")
        }

        override fun onStartFailure(errorCode: Int) {
            Log.e(TAG, "advertise failed: $errorCode")
        }
    }

    private val gattCallback = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            synchronized(connected) {
                if (newState == BluetoothProfile.STATE_CONNECTED) connected.add(device)
                else connected.remove(device)
            }
            if (newState != BluetoothProfile.STATE_CONNECTED) {
                synchronized(subscribed) { subscribed.remove(device) }
            }
            Log.i(TAG, "connection ${device.address} -> $newState")
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray,
        ) {
            if (characteristic.uuid == CHAR_UUID && value.isNotEmpty()) {
                try {
                    nativeOnFrame(value)
                } catch (t: Throwable) {
                    Log.e(TAG, "nativeOnFrame failed", t)
                }
            }
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
            }
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray,
        ) {
            if (descriptor.uuid == CCCD_UUID && value.isNotEmpty()) {
                val enableNotify = value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
                synchronized(subscribed) {
                    if (enableNotify) subscribed.add(device) else subscribed.remove(device)
                }
            }
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
            }
        }

        override fun onCharacteristicReadRequest(
            device: BluetoothDevice,
            requestId: Int,
            offset: Int,
            characteristic: BluetoothGattCharacteristic,
        ) {
            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, ByteArray(0))
        }
    }
}
