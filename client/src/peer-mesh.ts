import type { ClientInput, PlayerId, ServerSnapshot } from "./gameplay-protocol.ts";
import type { MapId } from "./lobby-state.ts";
import { encodePeerMessage, parsePeerMessage, type PeerControlMessage } from "./peer-protocol.ts";
import type { SignalEnvelope } from "../../shared/signaling-contract.ts";

export interface PeerSignaling {
  send(envelope: SignalEnvelope): Promise<void>;
  poll(): Promise<SignalEnvelope[]>;
}

export interface MeshDataChannel {
  readonly label: string;
  readyState: RTCDataChannelState;
  binaryType: BinaryType;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(): void;
}

export interface MeshPeerConnection {
  connectionState: RTCPeerConnectionState;
  readonly localDescription: RTCSessionDescription | null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null;
  onconnectionstatechange: (() => void) | null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null;
  createDataChannel(label: string, options?: RTCDataChannelInit): MeshDataChannel;
  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void>;
  restartIce(): void;
  close(): void;
}

export type PeerConnectionFactory = (configuration: RTCConfiguration) => MeshPeerConnection;

export interface MeshTimers {
  setTimeout(callback: () => void | Promise<void>, milliseconds: number): unknown;
  clearTimeout(id: unknown): void;
}

const browserTimers: MeshTimers = {
  setTimeout(callback, milliseconds) { return window.setTimeout(() => { void callback(); }, milliseconds); },
  clearTimeout(id) { window.clearTimeout(id as number); },
};

const browserPeerFactory: PeerConnectionFactory = (configuration) =>
  new RTCPeerConnection(configuration) as unknown as MeshPeerConnection;

export function defaultPeerConfiguration(): RTCConfiguration {
  return { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] };
}

export interface HostMeshHandlers {
  onInput?(playerId: string, input: ClientInput): void;
  onReady?(playerId: string): void;
  onDisconnect?(playerId: string): void;
  onFailure?(playerId: string, reason: string): void;
}

export interface HostGuestIdentity { id: string; color: PlayerId; }

interface HostPeer {
  connection: MeshPeerConnection;
  channels: Record<"control" | "input" | "snapshot", MeshDataChannel>;
  lastInputSequence: number;
  ready: boolean;
  disconnected: boolean;
  restarted: boolean;
  timer?: unknown;
}

export class HostPeerMesh {
  readonly #hostId: string;
  readonly #guestIds: readonly string[];
  readonly #guestColors = new Map<string, PlayerId>();
  readonly #mapId: MapId;
  readonly #signaling: PeerSignaling;
  readonly #handlers: HostMeshHandlers;
  readonly #factory: PeerConnectionFactory;
  readonly #timers: MeshTimers;
  readonly #peers = new Map<string, HostPeer>();

  constructor(
    hostId: string,
    guests: readonly (string | HostGuestIdentity)[],
    mapId: MapId,
    signaling: PeerSignaling,
    handlers: HostMeshHandlers = {},
    factory: PeerConnectionFactory = browserPeerFactory,
    timers: MeshTimers = browserTimers,
  ) {
    this.#hostId = hostId;
    this.#guestIds = guests.map((guest) => typeof guest === "string" ? guest : guest.id);
    for (const guest of guests) {
      if (typeof guest !== "string") this.#guestColors.set(guest.id, guest.color);
    }
    this.#mapId = mapId;
    this.#signaling = signaling;
    this.#handlers = handlers;
    this.#factory = factory;
    this.#timers = timers;
  }

  async connect(): Promise<void> {
    await Promise.all(this.#guestIds.map(async (guestId) => {
      const connection = this.#factory(defaultPeerConfiguration());
      const peer: HostPeer = {
        connection,
        channels: {
          control: connection.createDataChannel("control", { ordered: true }),
          input: connection.createDataChannel("input", { ordered: false, maxRetransmits: 0 }),
          snapshot: connection.createDataChannel("snapshot", { ordered: false, maxRetransmits: 0 }),
        },
        lastInputSequence: 0,
        ready: false,
        disconnected: false,
        restarted: false,
      };
      this.#peers.set(guestId, peer);
      this.#configurePeer(guestId, peer);
      await this.#sendOffer(guestId, peer);
      this.#scheduleTimeout(guestId, peer);
    }));
  }

  async processSignals(): Promise<void> {
    for (const signal of await this.#signaling.poll()) {
      const peer = this.#peers.get(signal.senderId);
      if (!peer || signal.recipientId !== this.#hostId) continue;
      if (signal.type === "answer") await peer.connection.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      if (signal.type === "candidate") await peer.connection.addIceCandidate(signal.candidate);
      if (signal.type === "failed") this.#handlers.onFailure?.(signal.senderId, signal.reason);
    }
  }

  broadcastSnapshot(snapshot: ServerSnapshot): void {
    const encoded = encodePeerMessage({ kind: "snapshot", snapshot });
    for (const peer of this.#peers.values()) {
      if (peer.channels.snapshot.readyState === "open") peer.channels.snapshot.send(encoded.slice(0));
    }
  }

  broadcastControl(message: PeerControlMessage): void {
    const encoded = encodePeerMessage(message);
    for (const peer of this.#peers.values()) {
      if (peer.channels.control.readyState === "open") peer.channels.control.send(encoded.slice(0));
    }
  }

  dispose(): void {
    for (const peer of this.#peers.values()) {
      if (peer.timer !== undefined) this.#timers.clearTimeout(peer.timer);
      for (const channel of Object.values(peer.channels)) channel.close();
      peer.connection.close();
    }
    this.#peers.clear();
  }

  #configurePeer(guestId: string, peer: HostPeer): void {
    for (const channel of Object.values(peer.channels)) channel.binaryType = "arraybuffer";
    peer.channels.control.onopen = () => {
      peer.channels.control.send(encodePeerMessage({
        kind: "hello", protocol: 1, playerId: this.#colorForGuest(guestId), mapId: this.#mapId,
      }));
      this.#checkReady(guestId, peer);
    };
    peer.channels.input.onopen = () => this.#checkReady(guestId, peer);
    peer.channels.snapshot.onopen = () => this.#checkReady(guestId, peer);
    peer.channels.input.onmessage = (event) => {
      try {
        const message = parsePeerMessage(event.data as ArrayBuffer, { lastInputSequence: peer.lastInputSequence });
        if (message.kind !== "input") return;
        peer.lastInputSequence = message.sequence;
        const { kind: _, ...input } = message;
        this.#handlers.onInput?.(guestId, input);
      } catch {}
    };
    const disconnected = () => this.#disconnect(guestId, peer);
    for (const channel of Object.values(peer.channels)) channel.onclose = disconnected;
    peer.connection.onconnectionstatechange = () => {
      if (peer.connection.connectionState === "failed" || peer.connection.connectionState === "closed"
        || peer.connection.connectionState === "disconnected") disconnected();
    };
    peer.connection.onicecandidate = (event) => {
      if (!event.candidate) return;
      const candidate = event.candidate.toJSON();
      void this.#signaling.send({
        type: "candidate", senderId: this.#hostId, recipientId: guestId,
        candidate: {
          candidate: candidate.candidate ?? "",
          sdpMid: candidate.sdpMid ?? null,
          sdpMLineIndex: candidate.sdpMLineIndex ?? null,
          usernameFragment: candidate.usernameFragment ?? null,
        },
      });
    };
  }

  #colorForGuest(guestId: string): "blue" | "orange" | "green" | "purple" {
    const assigned = this.#guestColors.get(guestId);
    if (assigned) return assigned;
    const index = this.#guestIds.indexOf(guestId) + 1;
    return (["blue", "orange", "green", "purple"] as const)[Math.min(index, 3)]!;
  }

  #checkReady(guestId: string, peer: HostPeer): void {
    if (peer.ready || Object.values(peer.channels).some((channel) => channel.readyState !== "open")) return;
    peer.ready = true;
    if (peer.timer !== undefined) this.#timers.clearTimeout(peer.timer);
    this.#handlers.onReady?.(guestId);
  }

  #disconnect(guestId: string, peer: HostPeer): void {
    if (peer.disconnected) return;
    peer.disconnected = true;
    this.#handlers.onInput?.(guestId, {
      sequence: peer.lastInputSequence + 1,
      clientTick: 0,
      moveX: 0,
      moveZ: 0,
      jump: false,
    });
    this.#handlers.onDisconnect?.(guestId);
  }

  async #sendOffer(guestId: string, peer: HostPeer): Promise<void> {
    const offer = await peer.connection.createOffer({ iceRestart: peer.restarted });
    await peer.connection.setLocalDescription(offer);
    await this.#signaling.send({
      type: "offer", senderId: this.#hostId, recipientId: guestId, sdp: offer.sdp ?? "",
    });
  }

  #scheduleTimeout(guestId: string, peer: HostPeer): void {
    peer.timer = this.#timers.setTimeout(async () => {
      if (peer.ready) return;
      if (!peer.restarted) {
        peer.restarted = true;
        peer.connection.restartIce();
        await this.#sendOffer(guestId, peer);
        this.#scheduleTimeout(guestId, peer);
        return;
      }
      this.#handlers.onFailure?.(guestId, "negotiation-timeout");
    }, 15_000);
  }
}

export interface GuestMeshHandlers {
  onReady?(): void;
  onSnapshot?(snapshot: ServerSnapshot): void;
  onControl?(message: PeerControlMessage): void;
  onHostLost?(): void;
  onFailure?(reason: string): void;
}

export class GuestPeerConnection {
  readonly #guestId: string;
  readonly #hostId: string;
  readonly #signaling: PeerSignaling;
  readonly #handlers: GuestMeshHandlers;
  readonly #connection: MeshPeerConnection;
  readonly #channels = new Map<string, MeshDataChannel>();

  constructor(
    guestId: string,
    hostId: string,
    signaling: PeerSignaling,
    handlers: GuestMeshHandlers = {},
    factory: PeerConnectionFactory = browserPeerFactory,
  ) {
    this.#guestId = guestId;
    this.#hostId = hostId;
    this.#signaling = signaling;
    this.#handlers = handlers;
    this.#connection = factory(defaultPeerConfiguration());
    this.#connection.ondatachannel = (event) => this.#acceptChannel(event.channel as unknown as MeshDataChannel);
    this.#connection.onconnectionstatechange = () => {
      if (this.#connection.connectionState === "failed" || this.#connection.connectionState === "closed"
        || this.#connection.connectionState === "disconnected") this.#handlers.onHostLost?.();
    };
    this.#connection.onicecandidate = (event) => {
      if (!event.candidate) return;
      const candidate = event.candidate.toJSON();
      void this.#signaling.send({
        type: "candidate", senderId: this.#guestId, recipientId: this.#hostId,
        candidate: {
          candidate: candidate.candidate ?? "", sdpMid: candidate.sdpMid ?? null,
          sdpMLineIndex: candidate.sdpMLineIndex ?? null, usernameFragment: candidate.usernameFragment ?? null,
        },
      });
    };
  }

  async processSignals(): Promise<void> {
    for (const signal of await this.#signaling.poll()) {
      if (signal.senderId !== this.#hostId || signal.recipientId !== this.#guestId) continue;
      if (signal.type === "offer") {
        await this.#connection.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        const answer = await this.#connection.createAnswer();
        await this.#connection.setLocalDescription(answer);
        await this.#signaling.send({
          type: "answer", senderId: this.#guestId, recipientId: this.#hostId, sdp: answer.sdp ?? "",
        });
      }
      if (signal.type === "candidate") await this.#connection.addIceCandidate(signal.candidate);
      if (signal.type === "failed") this.#handlers.onFailure?.(signal.reason);
    }
  }

  sendInput(input: ClientInput): void {
    const channel = this.#channels.get("input");
    if (channel?.readyState === "open") channel.send(encodePeerMessage({ kind: "input", ...input }));
  }

  dispose(): void {
    for (const channel of this.#channels.values()) channel.close();
    this.#connection.close();
  }

  #acceptChannel(channel: MeshDataChannel): void {
    if (channel.label !== "control" && channel.label !== "input" && channel.label !== "snapshot") return;
    channel.binaryType = "arraybuffer";
    this.#channels.set(channel.label, channel);
    channel.onopen = () => {
      if (["control", "input", "snapshot"].every((label) => this.#channels.get(label)?.readyState === "open")) {
        void this.#signaling.send({ type: "ready", senderId: this.#guestId, recipientId: this.#hostId });
        this.#handlers.onReady?.();
      }
    };
    channel.onclose = () => this.#handlers.onHostLost?.();
    channel.onmessage = (event) => {
      try {
        const message = parsePeerMessage(event.data as ArrayBuffer);
        if (message.kind === "snapshot") this.#handlers.onSnapshot?.(message.snapshot);
        else if (message.kind !== "input") this.#handlers.onControl?.(message);
      } catch {}
    };
  }
}
