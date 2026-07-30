import { LocalNotifications } from '@capacitor/local-notifications';

const IS_NATIVE = import.meta.env.VITE_PLATFORM === 'native';
const CREW_CHANNEL_ID = 'rnz-crew-messages';
const ZONE_CHANNEL_ID = 'rnz-zone-warnings';
const NOTIF_ID_CREW = 9002;
const NOTIF_ID_ZONE = 9003;

let channelsReady = false;

function isBackgrounded(): boolean {
  if (typeof document === 'undefined') return true;
  return document.hidden || document.visibilityState === 'hidden';
}

async function ensureChannels(): Promise<boolean> {
  if (!IS_NATIVE) return false;
  try {
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') {
      const req = await LocalNotifications.requestPermissions();
      if (req.display !== 'granted') return false;
    }
    if (!channelsReady) {
      await LocalNotifications.createChannel({
        id: CREW_CHANNEL_ID,
        name: 'Coach messages',
        description: 'Regatta control messages from the dashboard',
        importance: 4,
        visibility: 1,
        vibration: true,
        sound: 'default',
      });
      await LocalNotifications.createChannel({
        id: ZONE_CHANNEL_ID,
        name: 'Course warnings',
        description: 'Geofence entry alerts while recording',
        importance: 4,
        visibility: 1,
        vibration: true,
        sound: 'default',
      });
      channelsReady = true;
    }
    return true;
  } catch {
    return false;
  }
}

/** Notify when a new coach/regatta message arrives and the app is backgrounded. */
export async function maybeNotifyRegattaMessage(
  msg: { id: number; text: string } | null,
  prevId: number | null,
): Promise<void> {
  if (!IS_NATIVE || !msg || msg.id === prevId || !isBackgrounded()) return;
  const ready = await ensureChannels();
  if (!ready) return;
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: NOTIF_ID_CREW,
          title: 'Coach message',
          body: msg.text.trim() || 'New message from regatta control',
          channelId: CREW_CHANNEL_ID,
          sound: 'default',
          smallIcon: 'ic_stat_rowing_shell',
          iconColor: '#2563EB',
          priority: 3,
          autoCancel: true,
          extra: { type: 'regatta_message', messageId: msg.id },
        },
      ],
    });
  } catch (e) {
    console.warn('Regatta message notification failed', e);
  }
}

/** Notify when entering a geofence warning zone while backgrounded. */
export async function maybeNotifyGeofenceEntry(
  zoneKey: string,
  prevZoneKey: string,
  message: string,
): Promise<void> {
  if (!IS_NATIVE || !zoneKey || zoneKey === prevZoneKey || !isBackgrounded()) return;
  const ready = await ensureChannels();
  if (!ready) return;
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: NOTIF_ID_ZONE,
          title: 'Course warning',
          body: message.trim() || 'Check course ahead',
          channelId: ZONE_CHANNEL_ID,
          sound: 'default',
          smallIcon: 'ic_stat_rowing_shell',
          iconColor: '#D97706',
          priority: 3,
          autoCancel: true,
          extra: { type: 'geofence_entry', zoneKey },
        },
      ],
    });
  } catch (e) {
    console.warn('Geofence entry notification failed', e);
  }
}
