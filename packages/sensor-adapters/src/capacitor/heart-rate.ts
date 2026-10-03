import type {
  ConnectHeartRateOptions,
  HeartRateMonitor,
  HrReading,
} from '../types';

function parseHr(data: DataView): HrReading {
  const flags = data.getUint8(0);
  const rate16 = (flags & 0x1) === 0x1;
  const contact = (flags & 0x2) === 0x2;
  const contactSupported = (flags & 0x4) === 0x4;
  const bpm = rate16 ? data.getUint16(1, true) : data.getUint8(1);
  return {
    bpm,
    contact: contactSupported ? contact : undefined,
    t: Date.now(),
  };
}

let bleInitialized = false;

async function ensureBle(): Promise<
  typeof import('@capacitor-community/bluetooth-le')
> {
  const mod = await import('@capacitor-community/bluetooth-le');
  if (!bleInitialized) {
    await mod.BleClient.initialize({ androidNeverForLocation: false });
    bleInitialized = true;
  }
  return mod;
}

export async function connectHeartRate(
  onReading: (r: HrReading) => void,
  onError?: (msg: string) => void,
  options?: ConnectHeartRateOptions,
): Promise<HeartRateMonitor | null> {
  try {
    const { BleClient, numberToUUID } = await ensureBle();
    const HR_SERVICE = numberToUUID(0x180d);
    const HR_MEASUREMENT = numberToUUID(0x2a37);

    let deviceId = options?.deviceId?.trim() || '';
    let name = options?.name?.trim() || 'HR monitor';
    let usedPicker = false;

    if (deviceId) {
      try {
        await BleClient.connect(deviceId, () => {
          onError?.('Heart rate monitor disconnected');
        });
      } catch {
        deviceId = '';
      }
    }

    if (!deviceId) {
      const device = await BleClient.requestDevice({
        services: [HR_SERVICE],
        optionalServices: [HR_SERVICE],
      });
      deviceId = device.deviceId;
      name = device.name || 'HR monitor';
      usedPicker = true;
      await BleClient.connect(deviceId, () => {
        onError?.('Heart rate monitor disconnected');
      });
    }

    await BleClient.startNotifications(
      deviceId,
      HR_SERVICE,
      HR_MEASUREMENT,
      (value) => {
        onReading(parseHr(value));
      },
    );

    if (!usedPicker && options?.deviceId) {
      // Reconnected silently to a remembered strap.
    }

    return {
      name,
      deviceId,
      disconnect: async () => {
        try {
          await BleClient.stopNotifications(deviceId, HR_SERVICE, HR_MEASUREMENT);
        } catch {
          /* ignore */
        }
        try {
          await BleClient.disconnect(deviceId);
        } catch {
          /* ignore */
        }
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.toLowerCase().includes('cancel')) onError?.(msg);
    return null;
  }
}
