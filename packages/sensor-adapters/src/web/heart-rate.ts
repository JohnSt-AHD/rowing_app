import type { HrSample } from '@rowing/telemetry-types';
import type {
  ConnectHeartRateOptions,
  HeartRateMonitor,
  HrReading,
} from '../types';

const HR_SERVICE = 0x180d;
const HR_MEASUREMENT = 0x2a37;

function parseHrMeasurement(value: DataView): HrSample {
  const flags = value.getUint8(0);
  const rate16 = (flags & 0x1) === 0x1;
  const contact = (flags & 0x2) === 0x2;
  const contactSupported = (flags & 0x4) === 0x4;
  const bpm = rate16 ? value.getUint16(1, true) : value.getUint8(1);
  return {
    bpm,
    contact: contactSupported ? contact : undefined,
  };
}

async function bindNotifications(
  device: BluetoothDevice,
  onReading: (r: HrReading) => void,
  onError?: (msg: string) => void,
): Promise<HeartRateMonitor> {
  const server = await device.gatt?.connect();
  if (!server) throw new Error('GATT connect failed');

  const service = await server.getPrimaryService(HR_SERVICE);
  const characteristic = await service.getCharacteristic(HR_MEASUREMENT);

  characteristic.addEventListener('characteristicvaluechanged', (ev) => {
    const target = ev.target as BluetoothRemoteGATTCharacteristic;
    const value = target.value;
    if (!value) return;
    onReading({ ...parseHrMeasurement(value), t: Date.now() });
  });

  await characteristic.startNotifications();

  device.addEventListener('gattserverdisconnected', () => {
    onError?.('Heart rate monitor disconnected');
  });

  return {
    name: device.name || 'HR monitor',
    deviceId: device.id,
    disconnect: async () => {
      try {
        await characteristic.stopNotifications();
      } catch {
        /* ignore */
      }
      if (device.gatt?.connected) device.gatt.disconnect();
    },
  };
}

export async function connectHeartRate(
  onReading: (r: HrReading) => void,
  onError?: (msg: string) => void,
  options?: ConnectHeartRateOptions,
): Promise<HeartRateMonitor | null> {
  if (!navigator.bluetooth) {
    onError?.(
      'Web Bluetooth not available. Use Chrome on Android or enable BLE on iOS.',
    );
    return null;
  }

  try {
    const preferId = options?.deviceId?.trim() || '';
    if (preferId && typeof navigator.bluetooth.getDevices === 'function') {
      try {
        const known = await navigator.bluetooth.getDevices();
        const match = known.find((d) => d.id === preferId);
        if (match) {
          return await bindNotifications(match, onReading, onError);
        }
      } catch {
        /* fall through to picker */
      }
    }

    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: ['heart_rate'] }],
      optionalServices: ['heart_rate'],
    });

    return await bindNotifications(device, onReading, onError);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.toLowerCase().includes('cancel')) onError?.(msg);
    return null;
  }
}

export type { HeartRateMonitor, HrReading };
