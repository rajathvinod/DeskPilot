/**
 * Milestone 13, second half: an alert that reaches you without the app being open.
 *
 * Two things are worth being honest about in code, because they are easy to imply and hard to
 * deliver:
 *
 *   - **These are local notifications, not push.** The laptop produces an alert, the phone's
 *     poll notices it, and the phone raises the notification itself. There is no push server in
 *     this project, and this file does not pretend otherwise: if Android has stopped the app's
 *     JavaScript, nothing fires.
 *   - **The permission is not the same as the channel.** On Android 8+ a notification needs a
 *     channel to appear in the right place with the right importance, and a notification that
 *     was granted permission but has no channel can be silently dropped. Both are set up here,
 *     once, before anything is shown — `configure()` is idempotent for that reason.
 *
 * `expo-notifications` is also a native module, so the same Expo Go problem as speech applies:
 * the import is present, the native half is not. Every entry point therefore guards the load.
 */

import * as SecureStore from 'expo-secure-store';

type NotificationsPackage = typeof import('expo-notifications');

/** Where the "I want notifications on this phone" preference lives. Not a secret, but the app
 * already has exactly one durable local store, and a second one would be a second thing to back
 * up, clear and explain. */
const STORAGE_KEY = 'deskpilot.notify.alerts';

let loaded: NotificationsPackage | null | undefined;
let configured = false;

function load(): NotificationsPackage | null {
  if (loaded !== undefined) return loaded;
  try {
    loaded = require('expo-notifications') as NotificationsPackage;
  } catch {
    loaded = null;
  }
  return loaded;
}

export type NotificationSupport = { available: true } | { available: false; reason: string };

/** Can this build raise a notification at all? Same probe shape as `probeVoice`. */
export async function probeNotifications(): Promise<NotificationSupport> {
  const notifications = load();
  if (notifications === null) {
    return { available: false, reason: 'notifications are not part of this build' };
  }
  try {
    await notifications.getPermissionsAsync();
    return { available: true };
  } catch {
    return {
      available: false,
      reason: 'Expo Go has no notifications module — the development build does',
    };
  }
}

/**
 * Ask permission, create the channel, and make the app show its own alerts while it is open.
 *
 * `setNotificationHandler` is what stops the banner from being suppressed in the foreground. The
 * default is to show nothing when the app is active, which is precisely the case this feature is
 * for: you are looking at the phone, but at a different card.
 */
async function configure(notifications: NotificationsPackage): Promise<void> {
  if (configured) return;

  notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });

  await notifications.setNotificationChannelAsync('default', {
    name: 'DeskPilot alerts',
    // DEFAULT, not HIGH: an away-mode window change is worth noticing, not worth interrupting a
    // phone call for. Importance is also the only setting Android lets the user override later.
    importance: notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#208AEF',
  });

  configured = true;
}

export type EnableOutcome = { ok: true } | { ok: false; detail: string };

export async function enableAlerts(): Promise<EnableOutcome> {
  const notifications = load();
  if (notifications === null) {
    return { ok: false, detail: 'notifications are not part of this build' };
  }

  try {
    let status = await notifications.getPermissionsAsync();
    if (!status.granted) status = await notifications.requestPermissionsAsync();
    if (!status.granted) {
      return {
        ok: false,
        detail: status.canAskAgain
          ? 'notification permission was not granted'
          : 'notifications are blocked for DeskPilot — allow them in Android settings',
      };
    }

    await configure(notifications);
    await SecureStore.setItemAsync(STORAGE_KEY, 'on');
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : 'could not enable notifications',
    };
  }
}

export async function disableAlerts(): Promise<void> {
  await SecureStore.setItemAsync(STORAGE_KEY, 'off');
}

export async function alertsEnabled(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(STORAGE_KEY)) === 'on';
  } catch {
    return false;
  }
}

/**
 * Raise one notification for one audit event.
 *
 * Fire-and-forget by design: the caller is a poll that must not stall because a banner failed to
 * draw. A failure here is not worth a red error in the feed — the audit trail itself is the
 * record, and it already succeeded.
 */
export async function notifyAlert(event: { app: string; title: string }): Promise<void> {
  const notifications = load();
  if (notifications === null) return;
  if (!(await alertsEnabled())) return;

  const where = event.app === '' ? '' : `${event.app} — `;
  const what = event.title === '' ? 'a window changed' : `${where}${event.title}`;

  try {
    await configure(notifications);
    await notifications.scheduleNotificationAsync({
      content: {
        title: 'Something moved on your laptop',
        body: what.slice(0, 160),
        // No deep link yet: the app is a single screen, so opening it *is* the destination.
        data: { screen: 'activity' },
      },
      trigger: null,
    });
  } catch {
    // A missing channel or a revoked permission lands here. Silence is the right behaviour:
    // the ACTIVITY card shows the same event, and the toggle says why nothing appeared.
  }
}
