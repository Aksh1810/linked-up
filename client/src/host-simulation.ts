import type { ClientInput, PlayerId, ServerSnapshot } from "./gameplay-protocol.ts";
import type { MapId } from "./lobby-state.ts";
import {
  parseWorkerEvent,
  type SimulationWorkerCommand,
  type SimulationWorkerEvent,
} from "./simulation-worker-protocol.ts";

const stepMilliseconds = 1_000 / 60;
const maxCatchUpSteps = 8;

export interface SimulationWorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: SimulationWorkerCommand): void;
  terminate(): void;
}

export interface HostSimulationClock {
  now(): number;
  request(callback: (timestamp: number) => void): unknown;
  cancel(id: unknown): void;
}

export interface HostSimulationHandlers {
  onSnapshot?(snapshot: ServerSnapshot): void;
  onFinished?(elapsedTicks: number): void;
  onError?(message: string): void;
}

export interface HostSimulationDependencies {
  worker?: SimulationWorkerLike;
  clock?: HostSimulationClock;
}

const browserClock: HostSimulationClock = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id as number),
};

function browserWorker(): SimulationWorkerLike {
  return new Worker(new URL("./simulation-worker.ts", import.meta.url), { type: "module" });
}

export class HostSimulation {
  readonly #worker: SimulationWorkerLike;
  readonly #clock: HostSimulationClock;
  readonly #handlers: HostSimulationHandlers;
  readonly #roster: readonly PlayerId[];
  #frameId: unknown;
  #lastTime: number;
  #accumulator = 0;
  #disposed = false;

  private constructor(
    worker: SimulationWorkerLike,
    clock: HostSimulationClock,
    roster: readonly PlayerId[],
    handlers: HostSimulationHandlers,
  ) {
    this.#worker = worker;
    this.#clock = clock;
    this.#roster = [...roster];
    this.#handlers = handlers;
    this.#lastTime = clock.now();
  }

  static create(
    mapId: MapId,
    roster: readonly PlayerId[],
    handlers: HostSimulationHandlers = {},
    dependencies: HostSimulationDependencies = {},
  ): Promise<HostSimulation> {
    const worker = dependencies.worker ?? browserWorker();
    const clock = dependencies.clock ?? browserClock;
    const simulation = new HostSimulation(worker, clock, roster, handlers);
    return new Promise((resolve, reject) => {
      let initialized = false;
      worker.onmessage = (event) => {
        if (simulation.#disposed) return;
        let message: SimulationWorkerEvent;
        try { message = parseWorkerEvent(event.data, simulation.#roster); }
        catch {
          simulation.#fail("The host simulation stopped unexpectedly.", initialized ? undefined : reject);
          return;
        }
        if (message.type === "ready" && !initialized) {
          initialized = true;
          simulation.#lastTime = clock.now();
          simulation.#schedule();
          resolve(simulation);
          return;
        }
        if (message.type === "snapshot") handlers.onSnapshot?.(message.snapshot);
        if (message.type === "finished") handlers.onFinished?.(message.elapsedTicks);
        if (message.type === "error") simulation.#fail(message.message, initialized ? undefined : reject);
      };
      worker.onerror = () => simulation.#fail(
        initialized ? "The host simulation stopped unexpectedly." : "Could not start the match simulation.",
        initialized ? undefined : reject,
      );
      worker.postMessage({ type: "initialize", mapId, roster: [...roster] });
    });
  }

  setInput(player: PlayerId, input: ClientInput): void {
    if (this.#disposed || !this.#roster.includes(player)) return;
    this.#worker.postMessage({ type: "input", player, input });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#frameId !== undefined) this.#clock.cancel(this.#frameId);
    this.#worker.postMessage({ type: "dispose" });
    this.#worker.onmessage = null;
    this.#worker.onerror = null;
    this.#worker.terminate();
  }

  #schedule(): void {
    this.#frameId = this.#clock.request((timestamp) => this.#frame(timestamp));
  }

  #frame(timestamp: number): void {
    if (this.#disposed) return;
    const elapsed = Math.max(0, timestamp - this.#lastTime);
    this.#lastTime = Math.max(this.#lastTime, timestamp);
    this.#accumulator = Math.min(this.#accumulator + elapsed, stepMilliseconds * maxCatchUpSteps);
    const steps = Math.min(maxCatchUpSteps, Math.floor((this.#accumulator + 0.0000001) / stepMilliseconds));
    if (steps > 0) {
      this.#accumulator -= steps * stepMilliseconds;
      this.#worker.postMessage({ type: "advance", steps });
    }
    this.#schedule();
  }

  #fail(message: string, reject?: (reason: Error) => void): void {
    if (this.#disposed) return;
    this.#handlers.onError?.(message);
    this.dispose();
    reject?.(new Error(message));
  }
}
