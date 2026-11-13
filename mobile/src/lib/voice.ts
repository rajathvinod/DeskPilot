/**
 * Milestone 9, phone half: a sentence spoken instead of typed.
 *
 * The interesting part is not speech, it is the build. `expo-speech-recognition` is a native
 * module: the JavaScript is always present (it is in `node_modules` and Metro bundles what is
 * imported), but the native half only exists in a development build. So an `import` test would
 * happily report "available" in Expo Go and then throw on the first tap — the check has to be a
 * *native call*, not a successful import.
 *
 * The rest of the file is deliberately small: start, stop, and three callbacks. Recognition
 * errors arrive as events rather than exceptions, because a recogniser can fail long after
 * `start()` returned (no speech, network, service missing).
 */

type SpeechPackage = typeof import('expo-speech-recognition');

let cached: SpeechPackage | null | undefined;

function loadPackage(): SpeechPackage | null {
  if (cached !== undefined) return cached;
  try {
    cached = require('expo-speech-recognition') as SpeechPackage;
  } catch {
    cached = null;
  }
  return cached;
}

export type VoiceSupport = { available: true } | { available: false; reason: string };

/**
 * Can this build listen at all?
 *
 * `getPermissionsAsync` is the cheapest native call that also has to succeed before listening
 * can work: if it throws, the module is not in this binary and there is nothing to offer.
 */
export async function probeVoice(): Promise<VoiceSupport> {
  const speech = loadPackage();
  if (speech === null) {
    return { available: false, reason: 'the speech module is not part of this build' };
  }
  try {
    await speech.ExpoSpeechRecognitionModule.getPermissionsAsync();
    return { available: true };
  } catch {
    return {
      available: false,
      reason: 'Expo Go has no speech module — the development build does (see docs/development-build.md)',
    };
  }
}

export type VoiceHandlers = {
  /** Every partial result, so the text can be read while it is still being refined. */
  onTranscript: (text: string) => void;
  onEnd: () => void;
  onError: (message: string) => void;
};

type Subscription = { remove: () => void };
let subscriptions: Subscription[] = [];

function detach(): void {
  for (const subscription of subscriptions.splice(0)) subscription.remove();
}

/** A recogniser error code is not a sentence; translate the ones a person can act on. */
function describe(error: string, message?: string): string {
  switch (error) {
    case 'no-speech':
      return 'no speech heard — try again, a little closer to the microphone';
    case 'speech-timeout':
      return 'listening timed out before you started talking';
    case 'network':
      return 'the recogniser wanted a network it could not use — type the task instead';
    case 'busy':
      return 'the recogniser is busy — wait a second and tap again';
    case 'not-allowed':
    case 'service-not-allowed':
      return 'this phone refused speech recognition (permission denied, or no speech service installed)';
    default:
      return message ?? `speech failed (${error})`;
  }
}

/**
 * Ask for the microphone and start listening. Returns whether listening actually began; every
 * other outcome arrives through `onError`, so the caller has one place to render failures.
 */
export async function startVoice(handlers: VoiceHandlers): Promise<boolean> {
  const speech = loadPackage();
  if (speech === null) {
    handlers.onError('speech is not available in this build');
    return false;
  }

  const recognizer = speech.ExpoSpeechRecognitionModule;

  try {
    const permission = await recognizer.requestPermissionsAsync();
    if (!permission.granted) {
      handlers.onError(
        permission.canAskAgain
          ? 'microphone permission was not granted'
          : 'microphone permission is blocked — allow it in Android settings, then come back',
      );
      return false;
    }

    detach();
    subscriptions = [
      recognizer.addListener('result', (event) => {
        // Partials are useful: the transcript updates while you speak, which makes a misheard
        // first word visible before the whole sentence lands.
        const text = event.results?.[0]?.transcript ?? '';
        if (text !== '') handlers.onTranscript(text);
      }),
      recognizer.addListener('end', () => {
        detach();
        handlers.onEnd();
      }),
      recognizer.addListener('error', (event) => {
        detach();
        handlers.onError(describe(event.error, event.message));
      }),
    ];

    recognizer.start({
      lang: 'en-US',
      interimResults: true,
      continuous: false,
      // Off-device recognition is the default and the reason a mic needs a network at all.
      // Left off deliberately: the phone's own recogniser is better than a half-supported
      // on-device model, and a failure here is visible and explainable.
      requiresOnDeviceRecognition: false,
    });
    return true;
  } catch (error) {
    detach();
    handlers.onError(error instanceof Error ? error.message : 'could not start listening');
    return false;
  }
}

/** Stop and let the recogniser deliver its final result. Safe to call when not listening. */
export function stopVoice(): void {
  const speech = loadPackage();
  if (speech === null) return;
  try {
    speech.ExpoSpeechRecognitionModule.stop();
  } catch {
    // Already stopped, or no native module: nothing to report, and nothing to break.
  }
}
