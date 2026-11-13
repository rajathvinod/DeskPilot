import Constants from 'expo-constants';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Fonts, Spacing } from '@/constants/theme';
import {
  deriveLink,
  fetchAgents,
  humanClock,
  humanDuration,
  type AgentSummary,
  type FetchOutcome,
  type Link,
} from '@/lib/agents';
import { ExpandedScreen } from '@/components/ExpandedScreen';
import {
  askAgent,
  decideApproval,
  fetchRun,
  waitForRun,
  type AiOutcome,
  type Pending,
} from '@/lib/ai';
import {
  alertsEnabled,
  disableAlerts,
  enableAlerts,
  notifyAlert,
  onAcknowledge,
  probeNotifications,
} from '@/lib/notifications';
import { probeVoice, startVoice, stopVoice, type VoiceSupport } from '@/lib/voice';
import { acknowledgeAlerts, fetchAudit, setAway, type AuditSnapshot } from '@/lib/audit';
import { forgetDevice, getToken, pairDevice } from '@/lib/auth';
import { engageKillSwitch, lockLaptop } from '@/lib/control';
import { fetchFrame } from '@/lib/screen';
import {
  clickAt,
  normalizeTap,
  pressKey,
  scrollBy,
  sendText,
  type ActionOutcome,
  type KeyName,
} from '@/lib/input';

/**
 * Milestone 2 status screen.
 *
 * It answers one question honestly: can this phone reach the laptop, and is the laptop
 * actually listening? The answer comes from the backend's `/agents`, which knows what the
 * agent reported a moment ago.
 *
 * Why poll instead of one button press: a connection status you have to ask for is a status
 * that is wrong most of the time. Polling every few seconds means the screen reflects
 * reality within one interval of it changing.
 *
 * The URL comes from `EXPO_PUBLIC_API_URL` in `.env`. The `EXPO_PUBLIC_` prefix means Expo
 * inlines the value into the JS bundle, so it must never contain a secret.
 */

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://127.0.0.1:8787';

/** 3s: fast enough to feel live, slow enough that a phone on mobile data is not chattering. */
const POLL_INTERVAL_MS = 3000;

export default function StatusScreen() {
  const [outcome, setOutcome] = useState<FetchOutcome | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** null = still reading the keystore, true/false = known. */
  const [paired, setPaired] = useState<boolean | null>(null);

  // A ref, not state: this must not trigger a re-render, and the interval callback closes
  // over the first render's value if it lived in state.
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    // The request can take up to 5s, the poll fires every 3s. Overlap would queue
    // pointless requests behind a slow one and let answers arrive out of order.
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await fetchAgents(API_URL);
      setOutcome(next);
      setCheckedAt(Date.now());
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void getToken().then((token) => setPaired(token !== null));
  }, []);

  /**
   * After the kill switch, this phone's token is dead on the server. Forgetting it locally is
   * not cleanup, it is the other half of the action: keeping it would mean the app goes on
   * presenting a credential that is guaranteed to be refused.
   */
  const handleKilled = useCallback(async () => {
    await forgetDevice();
    setPaired(false);
  }, []);

  useEffect(() => {
    void refresh();

    // A phone that was asleep, or moved from Wi-Fi to mobile data, must not wait out a poll
    // interval before it knows the truth again — so returning to the foreground refreshes
    // immediately. In the background it does not poll at all: a pocketed phone asking every
    // three seconds spends battery to produce answers nobody is looking at.
    const poll = setInterval(() => {
      if (AppState.currentState === 'active') void refresh();
    }, POLL_INTERVAL_MS);
    const foregrounded = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });

    // Separate 1s ticker purely so "seen 4s ago" counts up between polls.
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      foregrounded.remove();
    };
  }, [refresh]);

  const link = outcome ? deriveLink(outcome) : null;
  const secondsAgo = checkedAt === null ? null : Math.max(0, Math.round((now - checkedAt) / 1000));

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>DESKPILOT</Text>
        <Text style={styles.title}>Remote desktop,{'\n'}under your control.</Text>
        <Text style={styles.subtitle}>
          Phase 6 · Milestone 13 — pairing, live view, mouse and keyboard, an AI loop, an audit
          trail, and a voice screen that needs the development build.
        </Text>

        {paired === null ? null : (
          <PairCard baseUrl={API_URL} paired={paired} onChanged={setPaired} />
        )}

        <StatusCard link={link} outcome={outcome} secondsAgo={secondsAgo} onRefresh={refresh} />

        <ActivityCard baseUrl={API_URL} />

        <ControlCard
          baseUrl={API_URL}
          agentId={link !== null && 'agent' in link ? link.agent.agentId : null}
          onKilled={handleKilled}
        />

        {link?.state === 'connected' || link?.state === 'unstable' ? (
          <>
            <ScreenCard baseUrl={API_URL} agent={link.agent} />
            <KeyboardCard baseUrl={API_URL} agent={link.agent} />
            <VoiceCard baseUrl={API_URL} agent={link.agent} />
            <AskCard baseUrl={API_URL} agent={link.agent} />
          </>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.cardLabel}>BACKEND URL</Text>
          <Text style={styles.mono}>{API_URL}</Text>
          <Text style={styles.hint}>
            Set via EXPO_PUBLIC_API_URL in mobile/.env. On a real phone, 127.0.0.1 is the phone
            itself — use your laptop's LAN or Tailscale IP.
          </Text>
        </View>

        {outcome?.ok ? (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>LINK DETAILS</Text>
            <Row label="Protocol" value={`v${outcome.snapshot.protocolVersion}`} />
            <Row label="Heartbeat" value={`every ${humanDuration(outcome.snapshot.heartbeatIntervalMs)}`} />
            <Row label="Request" value={`${outcome.latencyMs} ms`} />
            {/* Amber for the first minute: "these are not my old numbers" reads instantly. */}
            <Row
              label="Backend up"
              value={
                outcome.snapshot.uptimeSeconds === null
                  ? 'unknown'
                  : humanDuration(outcome.snapshot.uptimeSeconds * 1000)
              }
              tone={
                outcome.snapshot.uptimeSeconds !== null && outcome.snapshot.uptimeSeconds < 60
                  ? 'accent'
                  : 'normal'
              }
            />
            <Row label="Backend started" value={humanClock(outcome.snapshot.startedAt)} />
          </View>
        ) : null}

        <Text style={styles.footer}>Expo SDK {Constants.expoConfig?.sdkVersion ?? 'unknown'}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function StatusCard({
  link,
  outcome,
  secondsAgo,
  onRefresh,
}: {
  link: Link | null;
  outcome: FetchOutcome | null;
  secondsAgo: number | null;
  onRefresh: () => void;
}) {
  const view = presentation(link);

  return (
    <View style={[styles.card, styles.statusCard, { borderColor: view.border }]}>
      <View style={styles.statusHeader}>
        <View style={[styles.dot, { backgroundColor: view.color }]} />
        <Text style={[styles.statusLabel, { color: view.color }]}>{view.label}</Text>
      </View>

      <Text style={styles.statusHeadline}>{view.headline}</Text>
      <Text style={styles.statusExplanation}>{view.explanation}</Text>

      {link?.state === 'connected' || link?.state === 'unstable' ? (
        <View style={styles.rows}>
          <Row label="Machine" value={link.agent.hostname} />
          <Row label="Platform" value={link.agent.platform} />
          <Row label="Connected for" value={humanDuration(link.agent.connectedForMs)} />
          <Row
            label="Last seen"
            value={
              link.agent.lastSeenAgoMs > 60000
                ? humanDuration(link.agent.lastSeenAgoMs)
                : `${Math.round(link.agent.lastSeenAgoMs)} ms`
            }
          />
          <Row
            label="Round trip"
            value={link.agent.lastRttMs === null ? '—' : `${link.agent.lastRttMs} ms`}
          />
        </View>
      ) : null}

      <View style={styles.statusFooter}>
        <Text style={styles.timestamp}>
          {secondsAgo === null ? 'contacting…' : `updated ${secondsAgo}s ago`}
        </Text>
        <Pressable onPress={onRefresh} style={({ pressed }) => pressed && styles.buttonPressed}>
          <Text style={styles.refresh}>Refresh</Text>
        </Pressable>
      </View>

      {/* The raw error is a debugging aid, not a message to the user. */}
      {outcome && !outcome.ok ? <Text style={styles.rawError}>{outcome.detail}</Text> : null}
    </View>
  );
}

/**
 * The screen: one frame on demand, or a live loop.
 *
 * Milestone 4 is Milestone 3's request repeated — nothing new travels the wire. What makes it
 * work is avoiding the two mistakes a naive `setInterval` makes:
 *
 *   1. **It queues.** The timer fires on schedule whether or not the last frame arrived, so on
 *      a slow link requests pile up and the view drifts further behind reality while looking
 *      perfectly smooth. Here the next request is scheduled only after the current one settles
 *      (`setTimeout` chained), so the view is never more than one capture behind. The cost is a
 *      cadence slower than the chosen interval — which is why the screen reports the cadence it
 *      actually achieved.
 *   2. **It flickers.** Swapping an image's source blanks the view while the new frame decodes.
 *      Until Milestone 11 the fix was `Image.prefetch`, which warmed the cache behind the swap —
 *      but a prefetch only understands remote URLs, and frames now arrive as local `data:` URIs.
 *      There is no download left to hide, so the warm-up is gone. If flicker comes back, the
 *      answer is two mounted frames and a cross-fade, not a prefetch that silently fails.
 *
 * The honest stats are not decoration: a smooth view that is six seconds old is worse than an
 * obviously slow one.
 */
type FrameStats = {
  frames: number;
  failures: number;
  lastMs: number | null;
  /** Measured time between delivered frames — the cadence actually achieved. */
  lastGapMs: number | null;
};

const INTERVALS = [1000, 2000, 5000] as const;

function ScreenCard({ baseUrl, agent }: { baseUrl: string; agent: AgentSummary }) {
  const { agentId } = agent;
  const [live, setLive] = useState(false);
  const [intervalMs, setIntervalMs] = useState<number>(2000);
  const [uri, setUri] = useState<string | null>(null);
  const [stats, setStats] = useState<FrameStats>({
    frames: 0,
    failures: 0,
    lastMs: null,
    lastGapMs: null,
  });
  const [error, setError] = useState<string | null>(null);
  // Where the picture was actually drawn on screen, and the size of the frame inside it.
  // Both are needed to turn a finger position into a fraction of the desktop.
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [lastClick, setLastClick] = useState<string | null>(null);
  const [clicking, setClicking] = useState(false);
  const [expanded, setExpanded] = useState(false);
  /** Which display the picture is of. 1 is the primary one. */
  const [monitor, setMonitor] = useState(1);
  /**
   * `handleTap` was written before monitors existed, and its dependency list does not mention
   * one. A stale closure here would send a tap on screen 2 to screen 1 — a coordinate bug that
   * looks like anything but a stale closure. A ref cannot go stale, so the click path reads it.
   */
  const monitorRef = useRef(1);
  useEffect(() => {
    monitorRef.current = monitor;
  }, [monitor]);

  // Refs, not state: the loop must survive re-renders (every /agents poll and every stat
  // update re-renders this card) without restarting or leaving a second timer alive.
  const liveRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDeliveredRef = useRef<number | null>(null);
  const failuresRef = useRef(0);

  const grabOnce = useCallback(async () => {
    const startedAt = Date.now();
    // Download, not `<Image source>`: frames are token-protected now and the platform's image
    // loader cannot send a header. The frame arrives as a data: URI instead — see `lib/screen.ts`
    // for why that beat putting the token in the URL.
    const frame = await fetchFrame(baseUrl, agentId, monitor);

    if (!frame.ok) {
      failuresRef.current += 1;
      setStats((current) => ({ ...current, failures: current.failures + 1 }));
      setError(frame.detail);
      // Three in a row means the link is not momentarily slow, it is broken. Stop rather than
      // spin on a dead connection burning battery.
      if (failuresRef.current >= 3) {
        setLive(false);
        setError('stopped after 3 failed captures');
      }
      return false;
    }

    // No prefetch here. `Image.prefetch` only understands remote URLs: handed a `data:` URI it
    // reports failure even though the bytes are already in memory — which is precisely how
    // "the frame arrived but the phone could not decode it" appeared. There is nothing to warm
    // up for a local URI; there is no request whose latency the swap could hide behind.
    const finishedAt = Date.now();
    failuresRef.current = 0;
    const gap = lastDeliveredRef.current === null ? null : finishedAt - lastDeliveredRef.current;
    lastDeliveredRef.current = finishedAt;
    setUri(frame.uri);
    setError(null);
    setStats((current) => ({
      ...current,
      frames: current.frames + 1,
      lastMs: finishedAt - startedAt,
      lastGapMs: gap,
    }));
    return true;
    // `monitor` belongs here: switching displays must restart the loop with the new one, and a
    // live view that kept streaming the old screen would look like the switch did nothing.
  }, [baseUrl, agentId, monitor]);

  useEffect(() => {
    liveRef.current = live;
    if (!live) {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
      return;
    }

    let cancelled = false;
    const tick = async () => {
      if (cancelled || !liveRef.current) return;
      await grabOnce();
      if (cancelled || !liveRef.current) return;
      timerRef.current = setTimeout(() => void tick(), intervalMs);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [live, intervalMs, grabOnce]);

  /** A tap on the picture becomes a request to click that fraction of the desktop. */
  const handleTap = useCallback(
    async (locationX: number, locationY: number) => {
      // Prefer the frame's real size (it is what was drawn); fall back to the agent's report of
      // the desktop, which has the same aspect ratio because the capture never distorts.
      const image =
        frameSize ??
        (agent.screenWidth !== null && agent.screenHeight !== null
          ? { width: agent.screenWidth, height: agent.screenHeight }
          : null);
      if (box === null || image === null || clicking) return;

      const point = normalizeTap({ x: locationX, y: locationY }, box, image);
      // A tap in the letterbox bar is a tap on nothing. Ignoring it is the honest behaviour.
      if (point === null) return;

      setClicking(true);
      const outcome = await clickAt(
        baseUrl,
        agentId,
        point.x,
        point.y,
        'left',
        undefined,
        monitorRef.current,
      );
      setClicking(false);
      setLastClick(
        outcome.ok
          ? `clicked ${outcome.screenX}, ${outcome.screenY} · ${outcome.latencyMs} ms`
          : `click failed — ${outcome.detail}`,
      );
    },
    [agent.screenHeight, agent.screenWidth, agentId, baseUrl, box, clicking, frameSize],
  );

  const fps =
    stats.lastGapMs !== null && stats.lastGapMs > 0 ? (1000 / stats.lastGapMs).toFixed(1) : null;

  return (
    <View style={styles.card}>
      {agent.monitors.length > 1 ? (
        <Pressable
          onPress={() => {
            const index = agent.monitors.findIndex((option) => option.index === monitor);
            const next = agent.monitors[(index + 1) % agent.monitors.length];
            if (next === undefined) return;
            setMonitor(next.index);
            // Drop the old picture rather than leaving a frame of another screen under a label
            // that now says this one. One blank moment beats a picture that lies.
            setUri(null);
            setFrameSize(null);
          }}
          style={({ pressed }) => pressed && styles.buttonPressed}
        >
          <Text style={styles.refresh}>
            Showing{' '}
            {agent.monitors.find((option) => option.index === monitor)?.primary === true
              ? 'the main screen'
              : `screen ${monitor}`}{' '}
            of {agent.monitors.length} — tap to switch
          </Text>
        </Pressable>
      ) : null}

      <View style={styles.screenHeader}>
        <Text style={styles.cardLabel}>SCREEN</Text>
        <View style={styles.screenActions}>
          {uri !== null ? (
            <Pressable
              onPress={() => setExpanded(true)}
              style={({ pressed }) => pressed && styles.buttonPressed}
            >
              <Text style={styles.refresh}>Expand</Text>
            </Pressable>
          ) : null}
          {live ? (
            <Pressable
              onPress={() => setLive(false)}
              style={({ pressed }) => pressed && styles.buttonPressed}
            >
              <Text style={styles.refreshLive}>Pause</Text>
            </Pressable>
          ) : (
            <>
              <Pressable
                onPress={() => void grabOnce()}
                style={({ pressed }) => pressed && styles.buttonPressed}
              >
                <Text style={styles.refresh}>One frame</Text>
              </Pressable>
              <Pressable
                onPress={() => setLive(true)}
                style={({ pressed }) => pressed && styles.buttonPressed}
              >
                <Text style={styles.refreshLive}>Live</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>

      {live ? (
        <View style={styles.chips}>
          {INTERVALS.map((ms) => (
            <Pressable
              key={ms}
              onPress={() => setIntervalMs(ms)}
              style={[styles.chip, intervalMs === ms && styles.chipActive]}
            >
              <Text style={[styles.chipText, intervalMs === ms && styles.chipTextActive]}>
                {ms / 1000}s
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {uri === null ? (
        <Text style={styles.hint}>
          Nothing captured yet. “One frame” asks once; “Live” repeats the request so the view
          follows the desktop.
        </Text>
      ) : (
        // The box is measured, not assumed: `contain` centres the picture inside it, and only
        // the measured box plus the frame's own size can say where the picture really sits.
        <View
          style={styles.frameBox}
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            setBox({ width, height });
          }}
        >
          <Pressable style={styles.framePress} onPress={(event) => void handleTap(event.nativeEvent.locationX, event.nativeEvent.locationY)}>
            <Image
              source={{ uri }}
              style={styles.frame}
              resizeMode="contain"
              onLoad={(event) => {
                const size = event.nativeEvent.source;
                if (size) setFrameSize({ width: size.width, height: size.height });
              }}
            />
          </Pressable>
        </View>
      )}

      {stats.frames > 0 ? (
        <Text style={styles.frameMeta}>
          {stats.frames} frame{stats.frames === 1 ? '' : 's'} · last {stats.lastMs ?? 0} ms
          {fps === null ? '' : ` · ${fps} fps`}
          {stats.failures > 0 ? ` · ${stats.failures} failed` : ''}
        </Text>
      ) : null}
      {uri !== null ? (
        <Text style={styles.hint}>
          Tap the picture to click there. {clicking ? 'clicking…' : ''}
        </Text>
      ) : null}
      {lastClick !== null ? <Text style={styles.frameMeta}>{lastClick}</Text> : null}
      {error !== null ? <Text style={styles.rawError}>{error}</Text> : null}

      {uri !== null ? (
        <ExpandedScreen
          visible={expanded}
          uri={uri}
          baseUrl={baseUrl}
          agent={agent}
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </View>
  );
}

/**
 * Milestone 6: typing and scrolling.
 *
 * Two decisions worth knowing about:
 *
 *   * **Characters, not key codes.** The phone sends the text itself; the agent never has to
 *     know the laptop's keyboard layout or language. Windows turns a Unicode character into the
 *     right keystroke, so `é` works whether the layout is US, French or something else.
 *   * **The box clears only after confirmation.** A failed send keeps what you typed, because
 *     silently losing a message is worse than showing it twice.
 *
 * Text goes wherever focus is on the laptop, so click the target field there first — there is no
 * "focus the app for me" shortcut that would not also be a way to type into the wrong window.
 */
const QUICK_KEYS: { label: string; key: KeyName }[] = [
  { label: 'Enter', key: 'enter' },
  { label: 'Tab', key: 'tab' },
  { label: 'Esc', key: 'escape' },
  { label: '⌫', key: 'backspace' },
  { label: 'Space', key: 'space' },
];

const SCROLL_STEPS = [-3, 3] as const;

function KeyboardCard({ baseUrl, agent }: { baseUrl: string; agent: AgentSummary }) {
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (label: string, action: () => Promise<ActionOutcome>): Promise<ActionOutcome | null> => {
      if (busy) return null;
      setBusy(true);
      const outcome = await action();
      setBusy(false);
      setStatus(
        outcome.ok ? `${label} · ${outcome.latencyMs} ms` : `${label} failed — ${outcome.detail}`,
      );
      return outcome;
    },
    [busy],
  );

  const submit = useCallback(async () => {
    const text = draft;
    if (text === '') return;
    const outcome = await run(`typed ${text.length}`, () => sendText(baseUrl, agent.agentId, text));
    if (outcome?.ok) setDraft('');
  }, [agent.agentId, baseUrl, draft, run]);

  return (
    <View style={styles.card}>
      <Text style={styles.cardLabel}>KEYBOARD</Text>
      <Text style={styles.hint}>
        Text goes to whichever window has focus on the laptop — tap the field there first.
      </Text>

      <TextInput
        style={styles.textField}
        value={draft}
        onChangeText={setDraft}
        placeholder="Type here, then Send"
        placeholderTextColor="#4A566B"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="send"
        onSubmitEditing={() => void submit()}
      />

      <View style={styles.keyRow}>
        <Pressable
          onPress={() => void submit()}
          disabled={draft === '' || busy}
          style={({ pressed }) => [
            styles.sendButton,
            (pressed || draft === '' || busy) && styles.buttonPressed,
          ]}
        >
          <Text style={styles.sendText}>{busy ? '…' : 'Send'}</Text>
        </Pressable>

        {QUICK_KEYS.map((item) => (
          <Pressable
            key={item.key}
            disabled={busy}
            onPress={() =>
              void run(item.label.toLowerCase(), () =>
                pressKey(baseUrl, agent.agentId, item.key),
              )
            }
            style={({ pressed }) => [styles.key, pressed && styles.buttonPressed]}
          >
            <Text style={styles.keyText}>{item.label}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.keyRow}>
        <Text style={styles.rowLabel}>Scroll</Text>
        {SCROLL_STEPS.map((delta) => (
          <Pressable
            key={delta}
            disabled={busy}
            onPress={() =>
              void run(delta > 0 ? 'scrolled up' : 'scrolled down', () =>
                scrollBy(baseUrl, agent.agentId, delta),
              )
            }
            style={({ pressed }) => [styles.key, pressed && styles.buttonPressed]}
          >
            <Text style={styles.keyText}>{delta > 0 ? '▲ up' : '▼ down'}</Text>
          </Pressable>
        ))}
      </View>

      {status !== null ? <Text style={styles.frameMeta}>{status}</Text> : null}
    </View>
  );
}

/**
 * The approval question, in exactly one place.
 *
 * It used to live inside ASK, which worked only while ASK was the only card that could start a
 * run. The moment VOICE could start one, a voice run printed "needs approval" and put the
 * Approve button in a different card that was watching a different result — a question with no
 * answer, until the backend's two-minute window closed and refused the step on its own.
 *
 * So it takes the run it belongs to as a prop and reports the settled outcome back to whoever
 * asked. "Which card started this?" stops mattering, which is the point.
 *
 * Approving is not the end of the story either: the backend verifies afterwards, in the
 * background, so this polls the run to turn "approved" into "and here is whether it worked".
 */
function ApprovalPrompt({
  baseUrl,
  agent,
  runId,
  pending,
  onSettled,
}: {
  baseUrl: string;
  agent: AgentSummary;
  runId: string;
  pending: Pending;
  onSettled: (outcome: AiOutcome) => void;
}) {
  const [answering, setAnswering] = useState(false);

  /**
   * Watch for the question going away on its own.
   *
   * The backend stops waiting after about two minutes and refuses the step. Without this, the
   * card kept showing "needs your OK" with an Approve button that could no longer approve
   * anything — the run was already dead and the screen had not been told. Expiry is a result,
   * so it is rendered as one.
   */
  useEffect(() => {
    if (answering) return;
    const timer = setInterval(async () => {
      const fresh = await fetchRun(baseUrl, agent.agentId, runId);
      if (!fresh.ok) return;
      if (fresh.pending === null && fresh.state !== 'awaiting-approval') onSettled(fresh);
    }, 5000);
    return () => clearInterval(timer);
  }, [agent.agentId, answering, baseUrl, onSettled, runId]);

  const answer = useCallback(
    async (decision: 'approve' | 'deny') => {
      if (answering) return;
      setAnswering(true);

      const sent = await decideApproval(
        baseUrl,
        agent.agentId,
        pending.taskId,
        pending.stepIndex,
        decision,
      );
      if (!sent.ok) {
        onSettled({ ok: false, reason: 'http', detail: sent.detail });
        setAnswering(false);
        return;
      }

      onSettled(await waitForRun(baseUrl, agent.agentId, runId, { afterStep: pending.stepIndex }));
      setAnswering(false);
    },
    [agent.agentId, answering, baseUrl, onSettled, pending.stepIndex, pending.taskId, runId],
  );

  return (
    <View style={styles.card}>
      <Text style={styles.cardLabel}>NEEDS YOUR OK</Text>
      <Text style={styles.rowValue}>{pending.summary}</Text>
      <Text style={styles.hint}>{pending.because}</Text>
      <View style={styles.keyRow}>
        <Pressable
          onPress={() => void answer('approve')}
          disabled={answering}
          style={({ pressed }) => [
            styles.sendButton,
            (pressed || answering) && styles.buttonPressed,
          ]}
        >
          <Text style={styles.sendText}>{answering ? '…' : 'Approve'}</Text>
        </Pressable>

        <Pressable
          onPress={() => void answer('deny')}
          disabled={answering}
          style={({ pressed }) => [styles.key, (pressed || answering) && styles.buttonPressed]}
        >
          <Text style={styles.keyText}>Deny</Text>
        </Pressable>
      </View>
      <Text style={styles.hint}>
        Nothing after this step runs unless you say yes. Silence counts as no, and the backend
        stops waiting after about two minutes.
      </Text>
    </View>
  );
}

/**
 * Milestone 9: a spoken sentence in, the same executed and verified run out.
 *
 * Two paths in one card, because the honest answer to "can this build listen?" depends on the
 * binary, not the JavaScript. In a development build the microphone works and the transcript is
 * editable before it runs — speech recognition mishears things, and a task that runs a misheard
 * sentence moves a real mouse. In Expo Go the same card is a text field, which is also the
 * faster path for a one-word task.
 *
 * The run itself is not re-implemented: it is `askAgent`, the Milestone 8 loop, so voice adds a
 * way to *produce* a goal and nothing else. A run that stops for approval asks here — the
 * prompt was lifted into `ApprovalPrompt` precisely because a question only one card could
 * answer is a question the other card asks into the void.
 */
function VoiceCard({ baseUrl, agent }: { baseUrl: string; agent: AgentSummary }) {
  const [support, setSupport] = useState<VoiceSupport | null>(null);
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AiOutcome | null>(null);

  useEffect(() => {
    void probeVoice().then(setSupport);
    // Leaving the screen must not leave the microphone open.
    return () => stopVoice();
  }, []);

  const listen = useCallback(async () => {
    if (listening) {
      stopVoice();
      return;
    }
    setVoiceError(null);
    const started = await startVoice({
      onTranscript: setText,
      onEnd: () => setListening(false),
      onError: (message) => {
        setVoiceError(message);
        setListening(false);
      },
    });
    if (started) setListening(true);
  }, [listening]);

  const run = useCallback(async () => {
    const goal = text.trim();
    if (goal.length < 3 || busy) return;
    setBusy(true);
    setResult(await askAgent(baseUrl, agent.agentId, goal));
    setBusy(false);
  }, [agent.agentId, baseUrl, busy, text]);

  const available = support?.available === true;

  return (
    <View style={styles.card}>
      <Text style={styles.cardLabel}>VOICE</Text>
      <Text style={styles.hint}>
        {support === null
          ? 'checking whether this build can listen…'
          : available
            ? 'Tap to talk, tap Stop when you are done. The sentence becomes a task; edit it before running if it misheard.'
            : 'The text field below works everywhere, including Expo Go. Voice needs the development build — why, in docs/development-build.md.'}
      </Text>

      {available ? (
        <>
          <Pressable
            onPress={() => void listen()}
            style={({ pressed }) => [styles.sendButton, pressed && styles.buttonPressed]}
          >
            <Text style={styles.sendText}>{listening ? 'Stop listening' : 'Talk'}</Text>
          </Pressable>
          <TextInput
            style={styles.textField}
            value={text}
            onChangeText={setText}
            placeholder="your sentence appears here"
            placeholderTextColor="#4A566B"
            multiline
          />
        </>
      ) : (
        <TextInput
          style={styles.textField}
          value={text}
          onChangeText={setText}
          placeholder="e.g. open the browser and search for today's weather"
          placeholderTextColor="#4A566B"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          onSubmitEditing={() => void run()}
        />
      )}

      {support === null || available ? null : <Text style={styles.hint}>{support.reason}</Text>}
      {voiceError === null ? null : <Text style={styles.rawError}>{voiceError}</Text>}

      <View style={styles.keyRow}>
        <Pressable
          onPress={() => void run()}
          disabled={text.trim().length < 3 || busy}
          style={({ pressed }) => [
            styles.sendButton,
            (pressed || text.trim().length < 3 || busy) && styles.buttonPressed,
          ]}
        >
          <Text style={styles.sendText}>{busy ? 'working…' : 'Run'}</Text>
        </Pressable>

        <Pressable
          onPress={() => setText('')}
          disabled={text === ''}
          style={({ pressed }) => [styles.key, (pressed || text === '') && styles.buttonPressed]}
        >
          <Text style={styles.keyText}>Clear</Text>
        </Pressable>
      </View>

      {result === null ? null : result.ok ? (
        <View style={styles.rows}>
          <Row
            label="Plan"
            value={`${result.steps} step${result.steps === 1 ? '' : 's'} · ${result.state}`}
          />
          <Row
            label="Verified"
            value={
              result.done === null ? 'not run' : result.done ? 'looks done' : 'not done'
            }
            tone={result.done === false ? 'accent' : 'normal'}
          />
          {result.reason === null ? null : <Row label="Because" value={result.reason} />}
          <Row label="Took" value={`${(result.latencyMs / 1000).toFixed(1)} s`} />
          {result.pending === null ? null : (
            <ApprovalPrompt
              baseUrl={baseUrl}
              agent={agent}
              runId={result.runId}
              pending={result.pending}
              onSettled={setResult}
            />
          )}
          {result.error === null ? null : <Text style={styles.rawError}>{result.error}</Text>}
        </View>
      ) : (
        <Text style={styles.rawError}>{result.detail}</Text>
      )}
    </View>
  );
}

/**
 * Milestone 8: one sentence in, an executed and verified run out.
 *
 * The phone is a thin client here on purpose. It sends the goal and renders the outcome — the
 * plan, whether it ran, and what the model said after looking at the screen afterwards. No key,
 * no prompt and no provider detail ever reaches this file, which is the whole reason the loop
 * lives in the backend.
 *
 * "Preview" is the honest button: it asks for a plan without running it, so a wrong model or a
 * missing key costs one cheap call instead of moving the mouse.
 */
function AskCard({ baseUrl, agent }: { baseUrl: string; agent: AgentSummary }) {
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AiOutcome | null>(null);

  const ask = useCallback(
    async (dryRun: boolean) => {
      const text = goal.trim();
      if (text.length < 3 || busy) return;
      setBusy(true);
      setResult(await askAgent(baseUrl, agent.agentId, text, { dryRun }));
      setBusy(false);
    },
    [agent.agentId, baseUrl, busy, goal],
  );

  return (
    <View style={styles.card}>
      <Text style={styles.cardLabel}>ASK</Text>
      <Text style={styles.hint}>
        A sentence, not a script. The backend plans steps, runs them once each, then screenshots the
        desktop to check whether it actually worked.
      </Text>

      <TextInput
        style={styles.textField}
        value={goal}
        onChangeText={setGoal}
        placeholder="e.g. scroll down and tell me what changed"
        placeholderTextColor="#4A566B"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="go"
        onSubmitEditing={() => void ask(false)}
      />

      <View style={styles.keyRow}>
        <Pressable
          onPress={() => void ask(false)}
          disabled={goal.trim().length < 3 || busy}
          style={({ pressed }) => [
            styles.sendButton,
            (pressed || goal.trim().length < 3 || busy) && styles.buttonPressed,
          ]}
        >
          <Text style={styles.sendText}>{busy ? 'working…' : 'Run'}</Text>
        </Pressable>

        <Pressable
          onPress={() => void ask(true)}
          disabled={goal.trim().length < 3 || busy}
          style={({ pressed }) => [
            styles.key,
            (pressed || goal.trim().length < 3 || busy) && styles.buttonPressed,
          ]}
        >
          <Text style={styles.keyText}>Preview</Text>
        </Pressable>
      </View>

      {result === null ? null : result.ok ? (
        <View style={styles.rows}>
          <Row
            label="Plan"
            value={`${result.steps} step${result.steps === 1 ? '' : 's'} · ${result.state}`}
          />
          {result.note === '' ? null : <Row label="Reasoning" value={result.note} />}
          <Row
            label="Verified"
            value={
              result.state === 'awaiting-approval'
                ? 'waiting for you'
                : result.done === null
                  ? 'not run (preview)'
                  : result.done
                    ? 'looks done'
                    : 'not done'
            }
            tone={result.done === false ? 'accent' : 'normal'}
          />
          {result.reason === null ? null : <Row label="Because" value={result.reason} />}
          <Row label="Took" value={`${(result.latencyMs / 1000).toFixed(1)} s`} />
          {result.error === null ? null : <Text style={styles.rawError}>{result.error}</Text>}

          {result.pending === null ? null : (
            <ApprovalPrompt
              baseUrl={baseUrl}
              agent={agent}
              runId={result.runId}
              pending={result.pending}
              onSettled={setResult}
            />
          )}
        </View>
      ) : (
        <Text style={styles.rawError}>{result.detail}</Text>
      )}
    </View>
  );
}

/**
 * Milestone 11: this phone holds a token, or it does not.
 *
 * Pairing is deliberately manual — six characters typed from the laptop, not a QR yet. That
 * keeps the first version of the trust boundary easy to read: the code is minted on the
 * laptop's own loopback interface, so holding one proves you were at the machine.
 */
function PairCard({
  baseUrl,
  paired,
  onChanged,
}: {
  baseUrl: string;
  paired: boolean;
  onChanged: (paired: boolean) => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('my phone');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (code.trim().length < 4 || busy) return;
    setBusy(true);
    const result = await pairDevice(baseUrl, code.trim(), name.trim());
    setBusy(false);

    if (result.ok) {
      setCode('');
      setMessage(`Paired as ${result.name}.`);
      onChanged(true);
      return;
    }

    setMessage(
      result.reason === 'bad_code'
        ? 'That code was not accepted. Check the six characters against the laptop.'
        : result.reason === 'expired'
          ? 'That code expired. Run ./scripts/dev.sh pair for a fresh one (codes last 30 minutes).'
          : result.reason === 'no_code'
            ? 'No code is waiting. Run ./scripts/dev.sh pair, then type the six characters it prints.'
            : result.detail,
    );
  }, [baseUrl, busy, code, name, onChanged]);

  const forget = useCallback(async () => {
    await forgetDevice();
    setMessage('Forgotten. This phone can no longer control the laptop.');
    onChanged(false);
  }, [onChanged]);

  return (
    <View style={styles.card}>
      <Text style={styles.cardLabel}>{paired ? 'PAIRED' : 'PAIR THIS PHONE'}</Text>

      {paired ? (
        <>
          <Text style={styles.hint}>
            Requests are signed with this device's token. Revoke it from the laptop with
            DELETE /devices/:id, or forget it here.
          </Text>
          <View style={styles.keyRow}>
            <Pressable
              onPress={() => void forget()}
              style={({ pressed }) => [styles.key, pressed && styles.buttonPressed]}
            >
              <Text style={styles.keyText}>Forget this device</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <>
          <Text style={styles.hint}>
            Run ./scripts/dev.sh pair on the laptop, then type the six characters it prints. The
            code is single use and lasts 30 minutes by default.
          </Text>
          <TextInput
            style={styles.textField}
            value={code}
            onChangeText={setCode}
            placeholder="ABC123"
            placeholderTextColor="#4A566B"
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={8}
          />
          <TextInput
            style={styles.textField}
            value={name}
            onChangeText={setName}
            placeholder="device name"
            placeholderTextColor="#4A566B"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={40}
          />
          <View style={styles.keyRow}>
            <Pressable
              onPress={() => void submit()}
              disabled={code.trim().length < 4 || busy}
              style={({ pressed }) => [
                styles.sendButton,
                (pressed || code.trim().length < 4 || busy) && styles.buttonPressed,
              ]}
            >
              <Text style={styles.sendText}>{busy ? 'pairing…' : 'Pair'}</Text>
            </Pressable>
          </View>
        </>
      )}

      {message === null ? null : <Text style={styles.frameMeta}>{message}</Text>}
    </View>
  );
}

/**
 * Milestone 12: what the laptop did while you were not looking.
 *
 * The trail is a feed, so it is read like one: newest first, a handful of lines, and colour only
 * where away mode made an event an alert. Your own afternoon of window titles stays quiet — an
 * alert you see every minute is not an alert.
 */
type NotifyState = 'checking' | 'on' | 'off' | 'unsupported';

function ActivityCard({ baseUrl }: { baseUrl: string }) {
  const [snapshot, setSnapshot] = useState<AuditSnapshot | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notify, setNotify] = useState<NotifyState>('checking');

  /** Event ids already turned into notifications, so a poll every 5s does not fire the same one. */
  const seenAlerts = useRef<Set<string>>(new Set());
  /** The first successful load seeds the set instead of notifying about yesterday. */
  const seeded = useRef(false);

  useEffect(() => {
    void (async () => {
      const support = await probeNotifications();
      if (!support.available) {
        setNotify('unsupported');
        return;
      }
      setNotify((await alertsEnabled()) ? 'on' : 'off');
    })();
  }, []);

  const load = useCallback(async () => {
    const result = await fetchAudit(baseUrl, 12);
    if (result.ok) {
      setSnapshot(result.snapshot);
      setProblem(null);

      // Alert -> notification. Opening the app is not "a new alert arrived", so the first load
      // seeds the seen set and stays quiet; after that, each unseen unacknowledged alert that
      // the laptop marked as an alert becomes one banner.
      const fresh = result.snapshot.events.filter((event) => event.alert && !event.acknowledged);
      if (!seeded.current) {
        seeded.current = true;
        for (const event of fresh) seenAlerts.current.add(event.eventId);
        return;
      }
      for (const event of fresh) {
        if (seenAlerts.current.has(event.eventId)) continue;
        seenAlerts.current.add(event.eventId);
        void notifyAlert({ app: event.app, title: event.title });
      }
    } else {
      setProblem(result.detail);
    }
  }, [baseUrl]);

  useEffect(() => {
    void load();
    // Slower than the agent poll: this feed changes when a window changes, not every 3 seconds.
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  /**
   * The banner's Acknowledge button, wired to the same watermark write as the card's button.
   * `load()` afterwards is what makes the count on screen agree with what was just dismissed.
   */
  useEffect(
    () =>
      onAcknowledge(() => {
        void acknowledgeAlerts(baseUrl).then(() => load());
      }),
    [baseUrl, load],
  );

  const toggleNotify = useCallback(async () => {
    if (notify === 'checking' || notify === 'unsupported' || busy) return;
    if (notify === 'on') {
      await disableAlerts();
      setNotify('off');
      return;
    }
    const result = await enableAlerts();
    if (result.ok) setNotify('on');
    else setProblem(result.detail);
  }, [busy, notify]);

  const toggleAway = useCallback(async () => {
    if (snapshot === null || busy) return;
    setBusy(true);
    const result = await setAway(baseUrl, !snapshot.away.enabled);
    setBusy(false);
    if (!result.ok) {
      setProblem(result.detail);
      return;
    }
    await load();
  }, [baseUrl, busy, load, snapshot]);

  const acknowledge = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const result = await acknowledgeAlerts(baseUrl);
    setBusy(false);
    if (!result.ok) {
      setProblem(result.detail);
      return;
    }
    await load();
  }, [baseUrl, busy, load]);

  const events = snapshot?.events ?? [];
  const alerts = snapshot?.alerts ?? 0;

  return (
    <View style={styles.card}>
      <View style={styles.screenHeader}>
        <Text style={styles.cardLabel}>ACTIVITY</Text>
        <Pressable
          onPress={() => void toggleAway()}
          disabled={busy || snapshot === null}
          style={({ pressed }) => pressed && styles.buttonPressed}
        >
          <Text style={styles.refresh}>
            {snapshot === null
              ? '…'
              : snapshot.away.enabled
                ? 'Away mode ON — turn off'
                : 'Turn on away mode'}
          </Text>
        </Pressable>
      </View>

      <Text style={styles.hint}>
        The laptop reports the window in front when it changes, and once a minute when it does not.
        Away mode turns each change into an alert.
      </Text>

      <View style={styles.keyRow}>
        <Text style={styles.rowLabel}>Phone notifications</Text>
        <Pressable
          onPress={() => void toggleNotify()}
          disabled={notify === 'checking' || notify === 'unsupported' || busy}
          style={({ pressed }) => pressed && styles.buttonPressed}
        >
          <Text style={styles.refresh}>
            {notify === 'checking'
              ? '…'
              : notify === 'on'
                ? 'On — turn off'
                : notify === 'off'
                  ? 'Turn on'
                  : 'needs the dev build'}
          </Text>
        </Pressable>
      </View>

      {alerts > 0 ? (
        <View style={styles.keyRow}>
          <Text style={styles.rowAccent}>{alerts} unacknowledged</Text>
          <Pressable
            onPress={() => void acknowledge()}
            disabled={busy}
            style={({ pressed }) => pressed && styles.buttonPressed}
          >
            <Text style={styles.refresh}>{busy ? '…' : 'Acknowledge'}</Text>
          </Pressable>
        </View>
      ) : null}

      {events.length === 0 ? (
        <Text style={styles.hint}>Nothing reported yet.</Text>
      ) : (
        events.map((event) => (
          <View key={event.eventId} style={styles.row}>
            <Text
              style={[styles.rowValue, event.alert && !event.acknowledged && styles.rowAccent]}
              numberOfLines={1}
            >
              {event.app === '' ? event.title : `${event.app} — ${event.title}`}
            </Text>
            <Text style={styles.rowLabel}>{clockOf(event.at)}</Text>
          </View>
        ))
      )}

      {problem === null ? null : <Text style={styles.rawError}>{problem}</Text>}
    </View>
  );
}

/** `21:04` — a wall clock. Two events a minute apart need no date beside them. */
function clockOf(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '—';
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Milestone 12, second half: taking control away.
 *
 * Locking is reversible and asks once. The kill switch asks twice, because it revokes every
 * device — this phone included — and only the laptop's own keyboard can undo it. The confirm
 * step is not ceremony: the alternative is a single mis-tap that locks you out of your desk.
 */
function ControlCard({
  baseUrl,
  agentId,
  onKilled,
}: {
  baseUrl: string;
  agentId: string | null;
  onKilled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const lock = useCallback(async () => {
    if (agentId === null || busy) return;
    setBusy(true);
    const result = await lockLaptop(baseUrl, agentId);
    setBusy(false);
    setMessage(result.ok ? 'Locked. Win+L would have done the same.' : `lock failed — ${result.detail}`);
  }, [agentId, baseUrl, busy]);

  const kill = useCallback(async () => {
    if (busy) return;

    if (!armed) {
      setArmed(true);
      setMessage('Tap again to revoke every device, including this phone.');
      return;
    }

    setBusy(true);
    const result = await engageKillSwitch(baseUrl);
    setBusy(false);
    setArmed(false);

    if (!result.ok) {
      setMessage(`kill switch failed — ${result.detail}`);
      return;
    }

    onKilled();
    setMessage(`Killed: ${result.detail}. Re-arm at the laptop's keyboard.`);
  }, [armed, baseUrl, busy, onKilled]);

  return (
    <View style={styles.card}>
      <Text style={styles.cardLabel}>CONTROL</Text>

      <Text style={styles.hint}>
        Locking needs the laptop awake and connected. The kill switch revokes every device token —
        including this phone's — and stops the agents until someone re-arms it at the laptop.
      </Text>

      <View style={styles.keyRow}>
        <Pressable
          onPress={() => void lock()}
          disabled={agentId === null || busy}
          style={({ pressed }) => [
            styles.key,
            (pressed || agentId === null) && styles.buttonPressed,
          ]}
        >
          <Text style={styles.keyText}>{busy ? '…' : 'Lock laptop'}</Text>
        </Pressable>

        <Pressable
          onPress={() => void kill()}
          disabled={busy}
          style={({ pressed }) => [styles.key, pressed && styles.buttonPressed]}
        >
          <Text style={[styles.keyText, styles.dangerText]}>
            {armed ? 'Tap again to kill' : 'Kill switch'}
          </Text>
        </Pressable>
      </View>

      {message === null ? null : <Text style={styles.frameMeta}>{message}</Text>}
    </View>
  );
}

type Presentation = {
  label: string;
  color: string;
  border: string;
  headline: string;
  explanation: string;
};

/**
 * Four situations, four sentences. The distinction that matters most to a user is between
 * "we cannot see the laptop" and "the laptop is not answering us" — the fix is different
 * for each, so the screen must not blur them.
 */
function presentation(link: Link | null): Presentation {
  if (!link) {
    return {
      label: 'CHECKING',
      color: '#6F7D91',
      border: '#1F2A37',
      headline: 'Asking the backend…',
      explanation: 'First request is in flight.',
    };
  }

  switch (link.state) {
    case 'unreachable':
      return {
        label: 'UNREACHABLE',
        color: '#FF6B6B',
        border: '#3A1F24',
        headline: 'Cannot reach the backend',
        explanation:
          link.reason === 'timeout'
            ? 'The request timed out. The network path is blocked, the laptop is asleep, or Tailscale is down.'
            : link.reason === 'http'
              ? 'The backend answered, but refused this request. It is running, so check its version.'
              : 'The request failed outright — nothing is listening at that address, or the network refuses it.',
      };

    case 'no-agent':
      return {
        label: 'NO AGENT',
        color: '#FFB86B',
        border: '#3A3220',
        headline: 'Backend is up, but no laptop is connected',
        explanation:
          'The backend answered, so the path from this phone works. The agent on the laptop is not running, or is still dialling.',
      };

    case 'unstable':
      return {
        label: 'UNSTABLE',
        color: '#FFB86B',
        border: '#3A3220',
        headline: `${link.agent.hostname} has gone quiet`,
        explanation: `The socket is open but no heartbeat has arrived for ${humanDuration(
          link.sinceMs,
        )}. The backend will drop this connection soon — do not trust taps right now.`,
      };

    case 'connected':
      return {
        label: 'CONNECTED',
        color: '#3DDC97',
        border: '#1E3A31',
        headline: link.agent.hostname,
        explanation: 'The laptop is reachable and answering heartbeats. Live screen and control arrive in the next milestone.',
      };
  }
}

function Row({
  label,
  value,
  tone = 'normal',
}: {
  label: string;
  value: string;
  tone?: 'normal' | 'accent';
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, tone === 'accent' && styles.rowAccent]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0B0F14' },
  content: { padding: Spacing.four, gap: Spacing.three },
  eyebrow: {
    color: '#5B8DEF',
    fontSize: 12,
    letterSpacing: 2,
    fontWeight: '700',
    marginTop: Spacing.four,
  },
  title: { color: '#F5F7FA', fontSize: 32, fontWeight: '700', lineHeight: 38 },
  subtitle: { color: '#93A0B4', fontSize: 14, lineHeight: 20 },
  card: {
    backgroundColor: '#141A22',
    borderRadius: 12,
    padding: Spacing.three,
    gap: Spacing.two,
    borderWidth: 1,
    borderColor: '#1F2A37',
  },
  statusCard: { gap: Spacing.two, paddingVertical: Spacing.four },
  statusHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  dot: { width: 10, height: 10, borderRadius: 5 },
  statusLabel: { fontSize: 12, letterSpacing: 1.5, fontWeight: '700' },
  statusHeadline: { color: '#F5F7FA', fontSize: 20, fontWeight: '700', marginTop: Spacing.one },
  statusExplanation: { color: '#93A0B4', fontSize: 13, lineHeight: 19 },
  statusFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.two,
    borderTopWidth: 1,
    borderTopColor: '#1F2A37',
    paddingTop: Spacing.two,
  },
  timestamp: { color: '#6F7D91', fontSize: 12 },
  screenHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  screenActions: { flexDirection: 'row', gap: Spacing.three, alignItems: 'center' },
  refreshLive: { color: '#3DDC97', fontSize: 13, fontWeight: '700' },
  chips: { flexDirection: 'row', gap: Spacing.two },
  chip: { paddingHorizontal: Spacing.two, paddingVertical: 4, borderRadius: 6, backgroundColor: '#1B2430' },
  chipActive: { backgroundColor: '#25364A' },
  chipText: { color: '#6F7D91', fontSize: 12, fontFamily: Fonts?.mono },
  chipTextActive: { color: '#D7DEE8' },
  frameBox: { width: '100%', height: 220, borderRadius: 8, overflow: 'hidden', backgroundColor: '#070A0E' },
  framePress: { flex: 1 },
  frame: { width: '100%', height: '100%' },
  frameMeta: { color: '#6F7D91', fontSize: 12, fontFamily: Fonts?.mono },
  refresh: { color: '#5B8DEF', fontSize: 13, fontWeight: '700' },
  buttonPressed: { opacity: 0.6 },
  dangerText: { color: '#FF6B6B' },
  rawError: { color: '#8A6A6A', fontSize: 11, fontFamily: Fonts?.mono },
  rows: { gap: Spacing.one, marginTop: Spacing.two },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: Spacing.three },
  rowLabel: { color: '#6F7D91', fontSize: 13 },
  rowValue: { color: '#D7DEE8', fontSize: 13, fontFamily: Fonts?.mono, flexShrink: 1 },
  rowAccent: { color: '#FFB86B' },
  cardLabel: { color: '#6F7D91', fontSize: 11, letterSpacing: 1.5, fontWeight: '700' },
  mono: { color: '#D7DEE8', fontSize: 13, fontFamily: Fonts?.mono },
  hint: { color: '#6F7D91', fontSize: 12, lineHeight: 17 },
  textField: {
    backgroundColor: '#070A0E',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1F2A37',
    color: '#F5F7FA',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 14,
  },
  keyRow: { flexDirection: 'row', gap: Spacing.two, flexWrap: 'wrap', alignItems: 'center' },
  key: { backgroundColor: '#1B2430', borderRadius: 8, paddingHorizontal: Spacing.three, paddingVertical: 6 },
  keyText: { color: '#D7DEE8', fontSize: 12, fontWeight: '700' },
  sendButton: {
    backgroundColor: '#1E3A31',
    borderRadius: 8,
    paddingHorizontal: Spacing.three,
    paddingVertical: 6,
  },
  sendText: { color: '#3DDC97', fontSize: 12, fontWeight: '700' },
  footer: { color: '#4A566B', fontSize: 11, textAlign: 'center', marginTop: Spacing.two },
});
