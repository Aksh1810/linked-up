import assert from "node:assert/strict";
import test from "node:test";

import { encodePeerMessage } from "./peer-protocol.ts";
import {
  HostPeerMesh,
  defaultPeerConfiguration,
  type MeshPeerConnection,
  type MeshDataChannel,
  type MeshTimers,
  type PeerSignaling,
} from "./peer-mesh.ts";

const hostId = "10000000-0000-4000-8000-000000000001";
const guestIds = ["10000000-0000-4000-8000-000000000003", "10000000-0000-4000-8000-000000000004"];

class FakeChannel implements MeshDataChannel {
  readyState: RTCDataChannelState = "connecting";
  binaryType: BinaryType = "blob";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly sent: Array<string | ArrayBuffer> = [];
  readonly label: string;
  readonly options: RTCDataChannelInit;
  constructor(label: string, options: RTCDataChannelInit) { this.label = label; this.options = options; }
  send(data: string | ArrayBuffer): void { this.sent.push(data); }
  close(): void { this.readyState = "closed"; this.onclose?.(); }
  open(): void { this.readyState = "open"; this.onopen?.(); }
  receive(data: ArrayBuffer): void { this.onmessage?.({ data } as MessageEvent); }
}

class FakePeer implements MeshPeerConnection {
  connectionState: RTCPeerConnectionState = "new";
  localDescription: RTCSessionDescription | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  readonly channels: FakeChannel[] = [];
  restartCount = 0;
  readonly configuration: RTCConfiguration;
  constructor(configuration: RTCConfiguration) { this.configuration = configuration; }
  createDataChannel(label: string, options: RTCDataChannelInit = {}): MeshDataChannel {
    const channel = new FakeChannel(label, options);
    this.channels.push(channel);
    return channel;
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: "offer", sdp: "v=0" }; }
  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: "answer", sdp: "v=0" }; }
  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
  }
  async setRemoteDescription(): Promise<void> {}
  async addIceCandidate(): Promise<void> {}
  restartIce(): void { this.restartCount++; }
  close(): void { this.connectionState = "closed"; }
}

class FakeSignaling implements PeerSignaling {
  readonly sent: unknown[] = [];
  async send(envelope: any): Promise<void> { this.sent.push(envelope); }
  async poll(): Promise<any[]> { return []; }
}

class FakeTimers implements MeshTimers {
  readonly delays: number[] = [];
  readonly callbacks: Array<() => void | Promise<void>> = [];
  setTimeout(callback: () => void | Promise<void>, milliseconds: number): number {
    this.delays.push(milliseconds); this.callbacks.push(callback); return this.callbacks.length;
  }
  clearTimeout(): void {}
  async runNext(): Promise<void> { await this.callbacks.shift()?.(); }
}

test("host creates one correctly configured three-channel connection per guest", async () => {
  const peers: FakePeer[] = [];
  const signaling = new FakeSignaling();
  const mesh = new HostPeerMesh(hostId, guestIds, "windworks", signaling, {},
    (configuration) => { const peer = new FakePeer(configuration); peers.push(peer); return peer; }, new FakeTimers());
  await mesh.connect();

  assert.equal(peers.length, 2);
  assert.deepEqual(peers[0]!.configuration, defaultPeerConfiguration());
  assert.deepEqual(peers[0]!.channels.map((channel) => [channel.label, channel.options]), [
    ["control", { ordered: true }],
    ["input", { ordered: false, maxRetransmits: 0 }],
    ["snapshot", { ordered: false, maxRetransmits: 0 }],
  ]);
  assert.equal(signaling.sent.length, 2);
});

test("channel identity is bound to the guest and readiness waits for all channels", async () => {
  const peers: FakePeer[] = [];
  const inputs: unknown[] = [];
  const ready: string[] = [];
  const mesh = new HostPeerMesh(hostId, [guestIds[0]!], "classic-ascent", new FakeSignaling(), {
    onInput: (playerId, input) => inputs.push({ playerId, input }),
    onReady: (playerId) => ready.push(playerId),
  }, (configuration) => { const peer = new FakePeer(configuration); peers.push(peer); return peer; }, new FakeTimers());
  await mesh.connect();
  const [control, input, snapshot] = peers[0]!.channels;
  control!.open(); input!.open();
  assert.deepEqual(ready, []);
  snapshot!.open();
  assert.deepEqual(ready, [guestIds[0]]);

  input!.receive(encodePeerMessage({ kind: "input", sequence: 1, clientTick: 1, moveX: 1, moveZ: 0, jump: false }));
  assert.deepEqual(inputs, [{
    playerId: guestIds[0],
    input: { sequence: 1, clientTick: 1, moveX: 1, moveZ: 0, jump: false },
  }]);
});

test("disconnect emits neutral input and negotiation allows one ICE restart", async () => {
  const peers: FakePeer[] = [];
  const timers = new FakeTimers();
  const inputs: unknown[] = [];
  const failures: string[] = [];
  const mesh = new HostPeerMesh(hostId, [guestIds[0]!], "classic-ascent", new FakeSignaling(), {
    onInput: (playerId, input) => inputs.push({ playerId, input }),
    onFailure: (playerId) => failures.push(playerId),
  }, (configuration) => { const peer = new FakePeer(configuration); peers.push(peer); return peer; }, timers);
  await mesh.connect();
  peers[0]!.channels[1]!.close();
  assert.deepEqual(inputs.at(-1), {
    playerId: guestIds[0], input: { sequence: 1, clientTick: 0, moveX: 0, moveZ: 0, jump: false },
  });
  assert.deepEqual(timers.delays, [15_000]);
  await timers.runNext();
  assert.equal(peers[0]!.restartCount, 1);
  assert.deepEqual(timers.delays, [15_000, 15_000]);
  await timers.runNext();
  assert.deepEqual(failures, [guestIds[0]]);
});
