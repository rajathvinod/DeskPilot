/**
 * A viewfinder for the pairing QR.
 *
 * Deliberately hook-free around the camera: `useCameraPermissions` lives inside `expo-camera`'s
 * own module, so calling it here would mean importing that module at the top of this file — the
 * one thing `lib/camera.ts` exists to avoid. Permission is requested in an effect instead, and
 * the camera only mounts once it is granted.
 *
 * `onScanned` fires for every decoded frame. The parent is responsible for acting once; a
 * viewfinder that keeps firing while the shutter is open would pair the same device repeatedly.
 */

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { loadCamera } from '@/lib/camera';

type BarcodeResult = { data: string };

export function QrScanner({
  onScanned,
  onCancel,
}: {
  onScanned: (raw: string) => void;
  onCancel: () => void;
}) {
  const camera = loadCamera();
  const [granted, setGranted] = useState<boolean | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (camera === null) return;
      try {
        // SDK 58 keeps the permission calls under `Camera`, not as top-level exports.
        const current = await camera.Camera.getCameraPermissionsAsync();
        const decided = current.granted ? current : await camera.Camera.requestCameraPermissionsAsync();
        if (!alive) return;
        setGranted(decided.granted);
        if (!decided.granted) setNote('Camera permission was refused. Type the code instead.');
      } catch {
        if (alive) setNote('This build cannot open the camera. Type the code instead.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [camera]);

  if (camera === null || granted !== true) {
    return (
      <View style={styles.pending}>
        <Text style={styles.hint}>
          {note ?? (granted === null ? 'asking for the camera…' : 'camera unavailable')}
        </Text>
        <Pressable onPress={onCancel} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
          <Text style={styles.cancelText}>Close</Text>
        </Pressable>
      </View>
    );
  }

  const CameraView = camera.CameraView;

  return (
    <View style={styles.frame}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }: BarcodeResult) => onScanned(data)}
      />
      <View style={styles.overlay} pointerEvents="box-none">
        <Text style={styles.overlayText}>Point at the QR on the laptop</Text>
        <Pressable onPress={onCancel} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
          <Text style={styles.cancelText}>Close</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { height: 260, borderRadius: 16, overflow: 'hidden', backgroundColor: '#0B111C' },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
    alignItems: 'center',
    padding: 12,
    gap: 8,
  },
  overlayText: { color: '#DCE7F7', fontSize: 13 },
  pending: { paddingVertical: 18, gap: 10, alignItems: 'flex-start' },
  hint: { color: '#8FA0B8', fontSize: 13 },
  cancel: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, backgroundColor: '#1B2536' },
  cancelText: { color: '#DCE7F7', fontSize: 13 },
  pressed: { opacity: 0.6 },
});
