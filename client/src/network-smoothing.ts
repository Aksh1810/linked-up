import type {
  ClientInput,
  NetworkPlayerState,
  PlayerId,
  ServerSnapshot,
  Vector3State,
} from "./gameplay-protocol.ts";
import { stepMotion } from "./motion.ts";
import type { MotionConfig } from "./motion.ts";

export interface SmoothingConfig {
  interpolationDelayTicks: number;
  maxSnapshots: number;
  maxPendingInputs: number;
  correctionHalfLifeMs: number;
  snapDistance: number;
}

export const defaultSmoothingConfig: SmoothingConfig = {
  interpolationDelayTicks: 6,
  maxSnapshots: 32,
  maxPendingInputs: 240,
  correctionHalfLifeMs: 80,
  snapDistance: 2,
};

interface BufferedSnapshot {
  snapshot: ServerSnapshot;
  receivedAtMs: number;
}

const networkMotionConfig: MotionConfig = {
  acceleration: 30,
  floorHeight: Number.NEGATIVE_INFINITY,
  gravity: -9.81,
  jumpSpeed: 7,
  maxDelta: 1 / 60,
  maxSpeed: 6,
};

function validateConfig(config: SmoothingConfig): void {
  if (Object.values(config).some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new RangeError("Smoothing configuration values must be finite and positive.");
  }
}

export class SnapshotBuffer {
  readonly #config: SmoothingConfig;
  readonly #entries: BufferedSnapshot[] = [];

  constructor(config: SmoothingConfig = defaultSmoothingConfig) {
    validateConfig(config);
    this.#config = config;
  }

  push(snapshot: ServerSnapshot, receivedAtMs: number): boolean {
    const newest = this.#entries.at(-1)?.snapshot;
    if (newest) {
      if (snapshot.resetCount < newest.resetCount) return false;
      if (snapshot.resetCount > newest.resetCount) this.#entries.length = 0;
      else if (snapshot.tick <= newest.tick) return false;
    }

    this.#entries.push({ snapshot, receivedAtMs });
    if (this.#entries.length > this.#config.maxSnapshots) this.#entries.shift();
    return true;
  }

  sample(nowMs: number, tickRate: number): ServerSnapshot | undefined {
    const oldest = this.#entries[0];
    const newest = this.#entries.at(-1);
    if (!oldest || !newest) return undefined;

    const estimatedTick = newest.snapshot.tick +
      Math.max(0, nowMs - newest.receivedAtMs) * tickRate / 1_000;
    const renderTick = estimatedTick - this.#config.interpolationDelayTicks;
    if (renderTick <= oldest.snapshot.tick) return oldest.snapshot;
    if (renderTick >= newest.snapshot.tick) return newest.snapshot;

    const newerIndex = this.#entries.findIndex(({ snapshot }) => snapshot.tick >= renderTick);
    const older = this.#entries[newerIndex - 1].snapshot;
    const newer = this.#entries[newerIndex].snapshot;
    const amount = (renderTick - older.tick) / (newer.tick - older.tick);
    const mix = (left: number, right: number): number => left + (right - left) * amount;
    if (!sameRoster(older, newer) || !sameObstacles(older, newer)) return newer;
    const player = (newerPlayer: NetworkPlayerState): NetworkPlayerState => {
      const olderPlayer = older.players.find(({ id }) => id === newerPlayer.id)!;
      return {
      id: newerPlayer.id,
      acknowledgedInput: newerPlayer.acknowledgedInput,
      position: {
        x: mix(olderPlayer.position.x, newerPlayer.position.x),
        y: mix(olderPlayer.position.y, newerPlayer.position.y),
        z: mix(olderPlayer.position.z, newerPlayer.position.z),
      },
      velocity: {
        x: mix(olderPlayer.velocity.x, newerPlayer.velocity.x),
        y: mix(olderPlayer.velocity.y, newerPlayer.velocity.y),
        z: mix(olderPlayer.velocity.z, newerPlayer.velocity.z),
      },
      grounded: amount < 0.5
        ? olderPlayer.grounded
        : newerPlayer.grounded,
      };
    };

    return {
      type: "snapshot",
      tick: renderTick,
      resetCount: newer.resetCount,
      tetherTension: mix(older.tetherTension, newer.tetherTension),
      players: newer.players.map(player),
      matchState: newer.matchState,
      elapsedTicks: newer.elapsedTicks,
      checkpoint: newer.checkpoint,
      obstacles: newer.obstacles.map((newerObstacle) => {
        const olderObstacle = older.obstacles.find(({ id }) => id === newerObstacle.id)!;
        return {
          ...newerObstacle,
          position: {
            x: mix(olderObstacle.position.x, newerObstacle.position.x),
            y: mix(olderObstacle.position.y, newerObstacle.position.y),
            z: mix(olderObstacle.position.z, newerObstacle.position.z),
          },
          rotation: {
            x: mix(olderObstacle.rotation.x, newerObstacle.rotation.x),
            y: mix(olderObstacle.rotation.y, newerObstacle.rotation.y),
            z: mix(olderObstacle.rotation.z, newerObstacle.rotation.z),
          },
        };
      }),
    };
  }

  get latest(): ServerSnapshot | undefined {
    return this.#entries.at(-1)?.snapshot;
  }
}

function sameObstacles(left: ServerSnapshot, right: ServerSnapshot): boolean {
  return left.obstacles.length === right.obstacles.length && left.obstacles.every(
    (obstacle, index) => {
      const other = right.obstacles[index];
      return obstacle.id === other.id && obstacle.kind === other.kind && obstacle.zone === other.zone
        && obstacle.halfExtent.x === other.halfExtent.x && obstacle.halfExtent.y === other.halfExtent.y
        && obstacle.halfExtent.z === other.halfExtent.z;
    },
  );
}

export class PredictionReconciler {
  readonly #player: PlayerId;
  readonly #tickRate: number;
  readonly #config: SmoothingConfig;
  readonly #pending: ClientInput[] = [];
  #predicted?: NetworkPlayerState;
  #correction: Vector3State = { x: 0, y: 0, z: 0 };
  #resetCount?: number;
  #hardReset = false;

  constructor(
    player: PlayerId,
    tickRate: number,
    config: SmoothingConfig = defaultSmoothingConfig,
  ) {
    validateConfig(config);
    if (!Number.isFinite(tickRate) || tickRate <= 0) {
      throw new RangeError("Tick rate must be finite and positive.");
    }
    this.#player = player;
    this.#tickRate = tickRate;
    this.#config = config;
  }

  record(input: ClientInput): void {
    if (this.#hardReset) return;
    this.#pending.push(input);
    if (this.#pending.length > this.#config.maxPendingInputs) {
      this.#pending.length = 0;
      this.#hardReset = true;
      return;
    }
    this.#step(input);
  }

  reconcile(snapshot: ServerSnapshot): void {
    const authoritative = snapshot.players.find(({ id }) => id === this.#player);
    if (!authoritative) return;
    const resetChanged = this.#resetCount !== undefined &&
      snapshot.resetCount !== this.#resetCount;
    this.#resetCount = snapshot.resetCount;

    if (resetChanged || this.#hardReset) {
      this.#pending.length = 0;
      this.#hardReset = false;
      this.#correction = { x: 0, y: 0, z: 0 };
      this.#predicted = clonePlayer(authoritative);
      return;
    }

    const oldPosition = this.renderState()?.position;
    const pending = this.#pending.filter(
      ({ sequence }) => sequence > authoritative.acknowledgedInput,
    );
    this.#pending.splice(0, this.#pending.length, ...pending);
    this.#predicted = clonePlayer(authoritative);
    for (const input of this.#pending) this.#step(input);

    if (!oldPosition) {
      this.#correction = { x: 0, y: 0, z: 0 };
      return;
    }
    const correction = {
      x: oldPosition.x - this.#predicted.position.x,
      y: oldPosition.y - this.#predicted.position.y,
      z: oldPosition.z - this.#predicted.position.z,
    };
    this.#correction = Math.hypot(correction.x, correction.y, correction.z) >
        this.#config.snapDistance
      ? { x: 0, y: 0, z: 0 }
      : correction;
  }

  advanceCorrection(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
    const scale = Math.pow(0.5, deltaMs / this.#config.correctionHalfLifeMs);
    this.#correction.x *= scale;
    this.#correction.y *= scale;
    this.#correction.z *= scale;
  }

  renderState(): NetworkPlayerState | undefined {
    if (!this.#predicted) return undefined;
    return {
      ...this.#predicted,
      position: {
        x: this.#predicted.position.x + this.#correction.x,
        y: this.#predicted.position.y + this.#correction.y,
        z: this.#predicted.position.z + this.#correction.z,
      },
      velocity: { ...this.#predicted.velocity },
    };
  }

  get pendingCount(): number {
    return this.#pending.length;
  }

  #step(input: ClientInput): void {
    if (!this.#predicted) return;
    const state = stepMotion(
      this.#predicted,
      { x: input.moveX, z: input.moveZ, jumpPressed: input.jump },
      0,
      1 / this.#tickRate,
      networkMotionConfig,
    );
    this.#predicted = { ...this.#predicted, ...state };
  }
}

function sameRoster(left: ServerSnapshot, right: ServerSnapshot): boolean {
  return left.players.length === right.players.length
    && left.players.every((player, index) => player.id === right.players[index].id);
}

function clonePlayer(player: NetworkPlayerState): NetworkPlayerState {
  return {
    ...player,
    position: { ...player.position },
    velocity: { ...player.velocity },
  };
}
