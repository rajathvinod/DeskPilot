/**
 * The camera, loaded the same careful way as speech (see `voice.ts`).
 *
 * `expo-camera` is a native module. Its JavaScript is always in `node_modules` and Metro bundles
 * whatever is imported, but the native half only exists in a build that included it — and the
 * development build on the phone right now does not. A top-level `import { CameraView }` can die
 * on a binary without the module, so this file requires it lazily and then asks expo-modules-core
 * whether the native side actually registered.
 *
 * `requireOptionalNativeModule` is the honest probe: it returns `null` instead of throwing, which
 * is exactly the question being asked. Rendering a camera to find out would be a crash test, not
 * a check.
 */

type CameraPackage = typeof import('expo-camera');
type ModulesCore = {
  requireOptionalNativeModule: (name: string) => unknown;
};

let cached: CameraPackage | null | undefined;

export function loadCamera(): CameraPackage | null {
  if (cached !== undefined) return cached;
  try {
    cached = require('expo-camera') as CameraPackage;
  } catch {
    cached = null;
  }
  return cached;
}

export type CameraSupport = { available: true } | { available: false; reason: string };

export async function probeCamera(): Promise<CameraSupport> {
  if (loadCamera() === null) {
    return { available: false, reason: 'the camera module is not part of this build' };
  }
  try {
    const core = require('expo-modules-core') as ModulesCore;
    const native = core.requireOptionalNativeModule('ExpoCamera');
    if (native === null || native === undefined) {
      return {
        available: false,
        reason: 'this build has no camera — rebuild to scan QR codes (docs/development-build.md)',
      };
    }
    return { available: true };
  } catch {
    return { available: false, reason: 'the camera module could not be loaded in this build' };
  }
}
