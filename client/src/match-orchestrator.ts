import type { RoomSession } from "./lobby-state.ts";
import { type HostSimulationFactory, PeerGameplayConnection } from "./peer-gameplay-connection.ts";
import { GuestPeerConnection, HostPeerMesh, type GuestMeshHandlers, type HostGuestIdentity, type HostMeshHandlers, type PeerSignaling } from "./peer-mesh.ts";
import type { PeerMatchLaunch } from "./lobby-polling.ts";
import type { PeerControlMessage } from "./peer-protocol.ts";
import { SignalingClient } from "./signaling-client.ts";

export interface OrchestratorHostMesh {
  connect(): Promise<void>;
  processSignals(): Promise<void>;
  broadcastSnapshot: HostPeerMesh["broadcastSnapshot"];
  broadcastControl: HostPeerMesh["broadcastControl"];
  dispose(): void;
}

export interface OrchestratorGuestMesh {
  processSignals(): Promise<void>;
  sendInput: GuestPeerConnection["sendInput"];
  dispose(): void;
}

export interface MatchOrchestratorDependencies {
  signaling(code: string, session: RoomSession): PeerSignaling;
  hostMesh(
    hostId: string,
    guests: readonly HostGuestIdentity[],
    mapId: PeerMatchLaunch["mapId"],
    signaling: PeerSignaling,
    handlers: HostMeshHandlers,
  ): OrchestratorHostMesh;
  guestMesh(
    guestId: string,
    hostId: string,
    signaling: PeerSignaling,
    handlers: GuestMeshHandlers,
  ): OrchestratorGuestMesh;
  simulationFactory?: HostSimulationFactory;
  schedule(callback: () => void, milliseconds: number): unknown;
  cancel(id: unknown): void;
}

const defaults: MatchOrchestratorDependencies = {
  signaling: (code, session) => new SignalingClient(code, session.token, session.playerId),
  hostMesh: (hostId, guests, mapId, signaling, handlers) =>
    new HostPeerMesh(hostId, guests, mapId, signaling, handlers),
  guestMesh: (guestId, hostId, signaling, handlers) =>
    new GuestPeerConnection(guestId, hostId, signaling, handlers),
  schedule: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
  cancel: (id) => window.clearTimeout(id as number),
};

export class MatchOrchestrator {
  static async start(
    launch: PeerMatchLaunch,
    session: RoomSession,
    dependencies: MatchOrchestratorDependencies = defaults,
  ): Promise<PeerGameplayConnection> {
    if (launch.protocol !== 1 || launch.localPlayer.id !== session.playerId) {
      throw new TypeError("Invalid peer match launch.");
    }
    const signaling = dependencies.signaling(launch.roomCode, session);
    let active = true;
    let timer: unknown;
    let connection: PeerGameplayConnection | undefined;
    let rejectReady: (reason: Error) => void = () => undefined;
    const stopPolling = (): void => {
      active = false;
      if (timer !== undefined) dependencies.cancel(timer);
    };
    const reportFailure = (message: string): void => {
      const error = new Error(message);
      rejectReady(error);
      connection?.networkError(message);
    };

    if (launch.role === "host") {
      const guestIds = launch.players.filter((player) => !player.isHost).map((player) => player.id);
      const guests = launch.players.filter((player) => !player.isHost).map((player) => ({
        id: player.id, color: player.color,
      }));
      const ready = new Set<string>();
      let resolveReady: () => void = () => undefined;
      const allReady = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const mesh = dependencies.hostMesh(session.playerId, guests, launch.mapId, signaling, {
        onInput: (playerId, input) => connection?.acceptGuestInput(playerId, input),
        onReady: (playerId) => {
          if (!guestIds.includes(playerId)) return;
          ready.add(playerId);
          if (ready.size === guestIds.length) resolveReady();
        },
        onFailure: (_playerId, reason) => reportFailure(`Peer connection failed: ${reason}`),
      });
      connection = PeerGameplayConnection.host(
        launch, mesh, dependencies.simulationFactory, stopPolling,
      );
      await mesh.connect();
      MatchOrchestrator.#poll(mesh, dependencies, () => active, (id) => { timer = id; }, reportFailure);
      await allReady;
      mesh.broadcastControl({ kind: "ready", protocol: 1 });
      return connection;
    }

    const host = launch.players.find((player) => player.isHost);
    if (!host) throw new TypeError("Match host is missing.");
    let resolveReady: () => void = () => undefined;
    let helloAccepted = false;
    const hostReady = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const mesh = dependencies.guestMesh(session.playerId, host.id, signaling, {
      onSnapshot: (snapshot) => connection?.acceptHostSnapshot(snapshot),
      onControl: (message: PeerControlMessage) => {
        if (message.kind === "hello") {
          if (message.protocol !== 1 || message.playerId !== launch.localPlayer.color || message.mapId !== launch.mapId) {
            reportFailure("The host sent incompatible match details.");
            return;
          }
          helloAccepted = true;
          return;
        }
        if (message.kind === "ready" && message.protocol === 1 && helloAccepted) resolveReady();
        else connection?.acceptHostControl(message);
      },
      onHostLost: () => connection?.hostLost(),
      onFailure: (reason) => reportFailure(`Peer connection failed: ${reason}`),
    });
    connection = PeerGameplayConnection.guest(launch, mesh, stopPolling);
    await mesh.processSignals();
    MatchOrchestrator.#poll(mesh, dependencies, () => active, (id) => { timer = id; }, reportFailure);
    await hostReady;
    return connection;
  }

  static #poll(
    mesh: { processSignals(): Promise<void> },
    dependencies: MatchOrchestratorDependencies,
    active: () => boolean,
    saveTimer: (id: unknown) => void,
    failed: (message: string) => void,
  ): void {
    const next = (): void => {
      if (!active()) return;
      saveTimer(dependencies.schedule(() => {
        void mesh.processSignals().then(next, () => failed("Could not exchange peer connection details."));
      }, 250));
    };
    next();
  }
}
