/**
 * Full-screen, direct-manipulation view of the desktop.
 *
 * Deliberately built from React Native's own `PanResponder` and `Animated`, with no gesture
 * library: those need native code that matches the build on the phone, and a mismatch is
 * exactly the kind of failure where nothing happens and the cause is invisible. PanResponder
 * is plain JavaScript over the touch events every build already delivers.
 *
 * Pinch zooms (1x-8x), one finger drags the view while zoomed, and a tap clicks the point under
 * your finger. Only the click travels to the laptop.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Image,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Fonts, Spacing } from '@/constants/theme';
import type { AgentSummary } from '@/lib/agents';
import { clickAt, tapToDesktop } from '@/lib/input';

const MIN_SCALE = 1;
const MAX_SCALE = 8;

/** How far a finger may wander before the touch stops being a tap. */
const TAP_SLOP = 14;
/** How long a tap may last. Long presses are not clicks. */
const TAP_MS = 320;

type Size = { width: number; height: number };
type Transform = { scale: number; tx: number; ty: number };

type Props = {
  visible: boolean;
  uri: string;
  baseUrl: string;
  agent: AgentSummary;
  onClose: () => void;
};

export function ExpandedScreen({ visible, uri, baseUrl, agent, onClose }: Props) {
  const [stage, setStage] = useState<Size | null>(null);
  const [frameSize, setFrameSize] = useState<Size | null>(null);
  const [status, setStatus] = useState('Pinch to zoom · drag to pan · tap to click');
  const [busy, setBusy] = useState(false);

  // What is drawn. Animated.Values keep the transform off the render path: moving a finger
  // updates three numbers and a native transform, not the component tree.
  const scale = useRef(new Animated.Value(1)).current;
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;

  // The same numbers, readable synchronously. A tap needs all three at once, and the mapping
  // is useless if it reads a value from a frame ago.
  const transform = useRef<Transform>({ scale: 1, tx: 0, ty: 0 });
  const stageSize = useRef<Size>({ width: 0, height: 0 });

  const image =
    frameSize ??
    (agent.screenWidth !== null && agent.screenHeight !== null
      ? { width: agent.screenWidth, height: agent.screenHeight }
      : null);

  const imageRef = useRef(image);
  imageRef.current = image;

  const setScale = useCallback(
    (value: number) => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
      transform.current.scale = next;
      scale.setValue(next);
      // At 1x there is nothing to pan to, and leaving an offset behind looks like drift.
      if (next === MIN_SCALE) {
        transform.current.tx = 0;
        transform.current.ty = 0;
        tx.setValue(0);
        ty.setValue(0);
      }
    },
    [scale, tx, ty],
  );

  const setPan = useCallback(
    (x: number, y: number) => {
      const { width, height } = stageSize.current;
      // Only the area the zoom created is reachable; dragging the picture into empty space is
      // never what someone wanted, and it makes "where did it go" a real question.
      const maxX = Math.max(0, (width * (transform.current.scale - 1)) / 2);
      const maxY = Math.max(0, (height * (transform.current.scale - 1)) / 2);
      transform.current.tx = Math.min(maxX, Math.max(-maxX, x));
      transform.current.ty = Math.min(maxY, Math.max(-maxY, y));
      tx.setValue(transform.current.tx);
      ty.setValue(transform.current.ty);
    },
    [tx, ty],
  );

  const handleTap = useCallback(
    (x: number, y: number) => {
      const size = stageSize.current;
      const target = imageRef.current;
      if (size.width <= 0 || target === null) return;

      // Undo the zoom and pan first: at 4x a finger 40 pt from the centre means 10 pt into the
      // picture, so clicking the raw point would be off by most of the screen.
      const point = tapToDesktop({ x, y }, size, target, transform.current);
      if (point === null) return;

      setBusy(true);
      void clickAt(baseUrl, agent.agentId, point.x, point.y).then((outcome) => {
        setBusy(false);
        setStatus(
          outcome.ok
            ? `clicked ${outcome.screenX}, ${outcome.screenY} · ${outcome.latencyMs} ms`
            : `failed — ${outcome.detail}`,
        );
      });
    },
    [agent.agentId, baseUrl],
  );

  /** Distance between the first two fingers, in page coordinates. */
  const spread = (event: GestureResponderEvent): number => {
    const touches = event.nativeEvent.touches;
    if (touches.length < 2) return 0;
    const dx = touches[0].pageX - touches[1].pageX;
    const dy = touches[0].pageY - touches[1].pageY;
    return Math.hypot(dx, dy);
  };

  const gesture = useRef({
    startX: 0,
    startY: 0,
    startScale: 1,
    startSpread: 0,
    pinching: false,
    moved: false,
    startedAt: 0,
  });

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,

        onPanResponderGrant: (event) => {
          const g = gesture.current;
          g.startX = transform.current.tx;
          g.startY = transform.current.ty;
          g.startScale = transform.current.scale;
          g.startSpread = spread(event);
          g.pinching = event.nativeEvent.touches.length > 1;
          g.moved = false;
          g.startedAt = Date.now();
        },

        onPanResponderMove: (event, state) => {
          const g = gesture.current;
          const fingers = event.nativeEvent.touches.length;

          if (fingers > 1 || g.pinching) {
            const distance = spread(event);
            if (!g.pinching) {
              // The second finger arrived mid-drag. Re-baseline, or the picture jumps to catch up.
              g.pinching = true;
              g.startSpread = distance;
              g.startScale = transform.current.scale;
            }
            g.moved = true;
            if (g.startSpread > 0) setScale(g.startScale * (distance / g.startSpread));
            return;
          }

          if (Math.abs(state.dx) > TAP_SLOP || Math.abs(state.dy) > TAP_SLOP) g.moved = true;
          if (g.moved && transform.current.scale > MIN_SCALE) {
            setPan(g.startX + state.dx, g.startY + state.dy);
          }
        },

        onPanResponderRelease: (event) => {
          const g = gesture.current;
          const isTap = !g.moved && !g.pinching && Date.now() - g.startedAt < TAP_MS;
          g.pinching = false;
          g.moved = false;

          // Pinching can leave the picture over an edge; settle it before anything else.
          setPan(transform.current.tx, transform.current.ty);
          if (!isTap) return;
          handleTap(event.nativeEvent.locationX, event.nativeEvent.locationY);
        },

        onPanResponderTerminate: () => {
          gesture.current.pinching = false;
          gesture.current.moved = false;
          setPan(transform.current.tx, transform.current.ty);
        },
      }),
    [handleTap, setPan, setScale],
  );

  const reset = useCallback(() => {
    transform.current = { scale: 1, tx: 0, ty: 0 };
    Animated.parallel([
      Animated.timing(scale, { toValue: 1, duration: 160, useNativeDriver: false }),
      Animated.timing(tx, { toValue: 0, duration: 160, useNativeDriver: false }),
      Animated.timing(ty, { toValue: 0, duration: 160, useNativeDriver: false }),
    ]).start();
    setStatus('reset to fit');
  }, [scale, tx, ty]);

  return (
    <Modal
      visible={visible}
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      supportedOrientations={['portrait', 'landscape']}
    >
      <SafeAreaView style={styles.root}>
        <View style={styles.header}>
          <Text style={styles.label}>SCREEN · PINCH / PAN / TAP</Text>
          <View style={styles.headerActions}>
            <Pressable onPress={reset} style={({ pressed }) => pressed && styles.pressed}>
              <Text style={styles.action}>Fit</Text>
            </Pressable>
            <Pressable onPress={onClose} style={({ pressed }) => pressed && styles.pressed}>
              <Text style={styles.done}>Done</Text>
            </Pressable>
          </View>
        </View>

        <View
          style={styles.stage}
          {...responder.panHandlers}
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            stageSize.current = { width, height };
            setStage({ width, height });
          }}
        >
          <Animated.View
            style={[styles.layer, { transform: [{ translateX: tx }, { translateY: ty }, { scale }] }]}
          >
            <Image
              source={{ uri }}
              style={styles.image}
              resizeMode="contain"
              onLoad={(event) => {
                const size = event.nativeEvent.source;
                if (size) setFrameSize({ width: size.width, height: size.height });
              }}
            />
          </Animated.View>
        </View>

        <Text style={styles.status}>{busy ? 'clicking…' : status}</Text>
        <Text style={styles.hint}>
          {stage === null || image === null
            ? 'Waiting for the picture…'
            : 'Rotate the phone sideways for a bigger picture. Drag only pans while you are zoomed in.'}
        </Text>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0B0F14', padding: Spacing.three, gap: Spacing.two },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerActions: { flexDirection: 'row', gap: Spacing.three, alignItems: 'center' },
  label: { color: '#6F7D91', fontSize: 11, letterSpacing: 1.5, fontWeight: '700' },
  action: { color: '#5B8DEF', fontSize: 13, fontWeight: '700' },
  done: { color: '#3DDC97', fontSize: 13, fontWeight: '700' },
  pressed: { opacity: 0.6 },
  stage: { flex: 1, borderRadius: 10, overflow: 'hidden', backgroundColor: '#05080C' },
  layer: { flex: 1 },
  image: { width: '100%', height: '100%' },
  status: { color: '#D7DEE8', fontSize: 12, fontFamily: Fonts?.mono },
  hint: { color: '#6F7D91', fontSize: 12, lineHeight: 17 },
});
