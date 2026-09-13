import assert from "node:assert/strict";
import test from "node:test";

import { HostSimulation, type HostSimulationClock, type SimulationWorkerLike } from "./host-simulation.ts";
import type { SimulationWorkerCommand, SimulationWorkerEvent } from "./simulation-worker-protocol.ts";

class FakeWorker implements SimulationWorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: SimulationWorkerCommand[] = [];
  terminated = false;

  postMessage(message: SimulationWorkerCommand): void {
    this.sent.push(message);
    if (message.type === "initialize") queueMicrotask(() => this.emit({ type: "ready" }));
  }
  terminate(): void { this.terminated = true; }
  emit(message: SimulationWorkerEvent): void {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }
}

class FakeClock implements HostSimulationClock {
  time = 0;
  callback: ((timestamp: number) => void) | undefined;
  cancelled = false;
  now(): number { return this.time; }
  request(callback: (timestamp: number) => void): number { this.callback = callback; return 1; }
  cancel(): void { this.cancelled = true; this.callback = undefined; }
  frame(time: number): void {
    this.time = time;
    const callback = this.callback;
    this.callback = undefined;
    callback?.(time);
  }
}

test("host clock advances at 60 Hz with monotonic accumulation", async () => {
  const worker = new FakeWorker();
  const clock = new FakeClock();
  const simulation = await HostSimulation.create("classic-ascent", ["blue", "orange"], {}, { worker, clock });
  assert.deepEqual(worker.sent[0], {
    type: "initialize", mapId: "classic-ascent", roster: ["blue", "orange"],
  });

  clock.frame(10);
  assert.deepEqual(worker.sent.filter((message) => message.type === "advance"), []);
  clock.frame(17);
  clock.frame(34);
  clock.frame(50);
  assert.deepEqual(worker.sent.filter((message) => message.type === "advance"), [
    { type: "advance", steps: 1 }, { type: "advance", steps: 1 }, { type: "advance", steps: 1 },
  ]);
  simulation.dispose();
});

test("host caps a stalled frame at eight steps and ignores backwards time", async () => {
  const worker = new FakeWorker();
  const clock = new FakeClock();
  const simulation = await HostSimulation.create("relay-ridge", ["blue", "orange"], {}, { worker, clock });
  clock.frame(1_000);
  clock.frame(900);
  assert.deepEqual(worker.sent.filter((message) => message.type === "advance"), [
    { type: "advance", steps: 8 },
  ]);
  simulation.dispose();
});

test("inputs and events are forwarded, with no callbacks after disposal", async () => {
  const worker = new FakeWorker();
  const clock = new FakeClock();
  const events: string[] = [];
  const simulation = await HostSimulation.create("crane-shift", ["blue", "orange"], {
    onFinished: (ticks) => events.push(`finished:${ticks}`),
    onError: (message) => events.push(`error:${message}`),
  }, { worker, clock });
  simulation.setInput("blue", { sequence: 1, clientTick: 0, moveX: 1, moveZ: 0, jump: false });
  assert.deepEqual(worker.sent.at(-1), {
    type: "input", player: "blue",
    input: { sequence: 1, clientTick: 0, moveX: 1, moveZ: 0, jump: false },
  });
  worker.emit({ type: "finished", elapsedTicks: 90 });
  assert.deepEqual(events, ["finished:90"]);
  simulation.dispose();
  worker.emit({ type: "finished", elapsedTicks: 91 });
  clock.frame(2_000);
  assert.deepEqual(events, ["finished:90"]);
  assert.equal(worker.terminated, true);
  assert.equal(clock.cancelled, true);
  assert.deepEqual(worker.sent.at(-1), { type: "dispose" });
});

test("initialization errors reject with a stable message", async () => {
  const worker = new FakeWorker();
  worker.postMessage = function (message) {
    this.sent.push(message);
    queueMicrotask(() => this.emit({
      type: "error", code: "initialization-failed", message: "Could not start the match simulation.",
    }));
  };
  await assert.rejects(
    HostSimulation.create("windworks", ["blue", "orange"], {}, { worker, clock: new FakeClock() }),
    /Could not start the match simulation\./,
  );
  assert.equal(worker.terminated, true);
});
