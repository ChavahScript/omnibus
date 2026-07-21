import {
  isReplayableBridgeEvent,
  type BridgeEvent,
  type DeviceEventReplaySnapshot,
  type ReplayableBridgeEvent,
} from "./contracts.js";

/**
 * A resumed phone has no WebSocket delivery receipt to tell the bridge which
 * final frames reached iOS before a Wi-Fi handoff. Keep a very small tail in
 * addition to events emitted while the socket was known to be absent. Those
 * events are display-only and idempotent from the bridge's point of view;
 * commands never enter this journal and are never replayed.
 */
export const DEVICE_EVENT_REPLAY_UNCERTAINTY_TAIL = 2;
export const DEFAULT_DEVICE_EVENT_REPLAY_MAX_EVENTS = 64;
export const DEFAULT_DEVICE_EVENT_REPLAY_MAX_DEVICES = 8;
export const DEFAULT_DEVICE_EVENT_REPLAY_TTL_MS = 12 * 60 * 60_000;

export type DeviceEventDelivery = (event: BridgeEvent) => void;

export type DeviceEventReplayOptions = {
  /** Number of recent display events kept per authenticated device. */
  maxEventsPerDevice?: number;
  /** Limits transient RAM even if a bridge receives many valid pairings. */
  maxDevices?: number;
  /** In-memory replay lifetime; never persisted alongside commands or memory. */
  ttlMs?: number;
  /** Injectable clock makes expiry and gap behaviour deterministic in tests. */
  now?: () => number;
};

export type DeviceEventBinding = {
  /** Bounded catch-up events to send immediately after the new `hello`. */
  replay: DeviceEventReplaySnapshot;
  /** Lets the gateway reject commands from a socket superseded by a resume. */
  isCurrent: () => boolean;
  /** Idempotent; an older socket can never detach its replacement. */
  detach: () => void;
};

type ReplayEntry = {
  sequence: number;
  event: ReplayableBridgeEvent;
};

type ActiveBinding = {
  id: symbol;
  deliver: DeviceEventDelivery;
};

type DeviceStream = {
  nextSequence: number;
  entries: ReplayEntry[];
  /** First sequence that may not have reached iOS after a known socket close. */
  replayFromSequence: number | undefined;
  binding: ActiveBinding | undefined;
  touchedAt: number;
};

/**
 * Ephemeral, device-scoped display-event journal.
 *
 * It has deliberately no filesystem dependency: a bridge restart invalidates
 * the in-memory resumption token too, so carrying result data across that
 * security boundary would be both misleading and unnecessarily persistent.
 * The durable command queue remains authoritative for execution; this class
 * only restores progress/report frames for the same authenticated device.
 */
export class DeviceEventReplay {
  private readonly streams = new Map<string, DeviceStream>();
  private readonly now: () => number;
  private readonly maxEventsPerDevice: number;
  private readonly maxDevices: number;
  private readonly ttlMs: number;

  public constructor(options: DeviceEventReplayOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxEventsPerDevice = boundedInteger(options.maxEventsPerDevice, DEFAULT_DEVICE_EVENT_REPLAY_MAX_EVENTS, 1, 128);
    this.maxDevices = boundedInteger(options.maxDevices, DEFAULT_DEVICE_EVENT_REPLAY_MAX_DEVICES, 1, 32);
    this.ttlMs = boundedInteger(options.ttlMs, DEFAULT_DEVICE_EVENT_REPLAY_TTL_MS, 1_000, 24 * 60 * 60_000);
  }

  /**
   * Makes this authenticated socket the one live delivery target for a device.
   * A resume receives only its own bounded display history. A fresh QR pairing
   * never receives an old stream, even if a caller accidentally reuses an ID.
   */
  public bind(deviceId: string, deliver: DeviceEventDelivery, resumed: boolean): DeviceEventBinding {
    const now = this.now();
    this.prune(now);
    const stream = this.getOrCreate(deviceId, now);
    const priorBinding = stream.binding;
    const recoveryStart = stream.replayFromSequence
      ?? (priorBinding ? Math.max(1, stream.nextSequence - DEVICE_EVENT_REPLAY_UNCERTAINTY_TAIL) : undefined);
    const recovered = Boolean(resumed && recoveryStart !== undefined);
    const replay: DeviceEventReplaySnapshot = {
      recovered,
      events: recovered
        ? stream.entries
          .filter(entry => entry.sequence >= recoveryStart!)
          .map(entry => cloneEvent(entry.event))
        : [],
    };

    const binding: ActiveBinding = { id: Symbol("omnibus-device-delivery"), deliver };
    stream.binding = binding;
    stream.replayFromSequence = undefined;
    stream.touchedAt = now;

    return {
      replay,
      isCurrent: () => this.streams.get(deviceId)?.binding?.id === binding.id,
      detach: () => this.detach(deviceId, binding.id),
    };
  }

  /**
   * Records a display-only bridge event before best-effort live delivery.
   * The dynamic binding means an orchestrator callback created before a
   * disconnect automatically starts delivering to the resumed socket.
   */
  public emit(deviceId: string, event: BridgeEvent): void {
    const now = this.now();
    this.prune(now);
    const stream = this.getOrCreate(deviceId, now);
    stream.touchedAt = now;
    if (isReplayableBridgeEvent(event)) {
      stream.entries.push({ sequence: stream.nextSequence, event: cloneEvent(event) });
      stream.nextSequence += 1;
      if (stream.entries.length > this.maxEventsPerDevice) {
        stream.entries.splice(0, stream.entries.length - this.maxEventsPerDevice);
      }
    }

    try {
      stream.binding?.deliver(event);
    } catch {
      // A delivery exception must never interrupt an already-running local
      // workflow. Mark this binding absent so the next authenticated resume
      // gets the recorded event plus the conservative delivery tail.
      if (stream.binding) this.detach(deviceId, stream.binding.id);
    }
  }

  /** Clears all in-memory display state when the bridge rotates pairing. */
  public clear(): void {
    this.streams.clear();
  }

  /** Test/diagnostic view with no delivery callback or device contents exposed. */
  public size(): number {
    this.prune(this.now());
    return this.streams.size;
  }

  private detach(deviceId: string, bindingId: symbol): void {
    const stream = this.streams.get(deviceId);
    if (!stream || stream.binding?.id !== bindingId) return;
    stream.binding = undefined;
    // WebSocket close has no application-level receipt. Include a small tail
    // of just-delivered display frames in the recovery window, which favors a
    // duplicate status over silently losing a completed report.
    stream.replayFromSequence = Math.max(1, stream.nextSequence - DEVICE_EVENT_REPLAY_UNCERTAINTY_TAIL);
    stream.touchedAt = this.now();
  }

  private getOrCreate(deviceId: string, now: number): DeviceStream {
    const existing = this.streams.get(deviceId);
    if (existing) return existing;
    this.evictForCapacity();
    const stream: DeviceStream = {
      nextSequence: 1,
      entries: [],
      replayFromSequence: undefined,
      binding: undefined,
      touchedAt: now,
    };
    this.streams.set(deviceId, stream);
    return stream;
  }

  private prune(now: number): void {
    for (const [deviceId, stream] of this.streams) {
      // Do not remove an actively connected phone solely because a long local
      // model run exceeds the recovery TTL. Its events remain bounded anyway.
      if (!stream.binding && now - stream.touchedAt >= this.ttlMs) this.streams.delete(deviceId);
    }
  }

  private evictForCapacity(): void {
    while (this.streams.size >= this.maxDevices) {
      const candidates = [...this.streams.entries()]
        .sort(([, left], [, right]) => Number(Boolean(left.binding)) - Number(Boolean(right.binding)) || left.touchedAt - right.touchedAt);
      const oldest = candidates[0]?.[0];
      if (!oldest) return;
      this.streams.delete(oldest);
    }
  }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const candidate = Number.isFinite(value) ? Math.floor(value!) : fallback;
  return Math.max(minimum, Math.min(maximum, candidate));
}

function cloneEvent<T extends ReplayableBridgeEvent>(event: T): T {
  return structuredClone(event);
}
