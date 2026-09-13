import type { GameplayTransport, GameplayTransportHandlers } from "./gameplay-connection.ts";
import type { ClientInput, PlayerId, ServerSnapshot } from "./gameplay-protocol.ts";
import { HostSimulation, type HostSimulationHandlers } from "./host-simulation.ts";
import type { PeerMatchLaunch } from "./lobby-polling.ts";
import type { PeerControlMessage } from "./peer-protocol.ts";

export interface HostGameplayMesh {
  broadcastSnapshot(snapshot: ServerSnapshot): void;
  broadcastControl(message: PeerControlMessage): void;
  dispose(): void;
}

export interface GuestGameplayMesh {
  sendInput(input: ClientInput): void;
  dispose(): void;
}

export interface HostSimulationLike {
  setInput(player: PlayerId, input: ClientInput): void;
  dispose(): void;
}

export type HostSimulationFactory = (
  mapId: PeerMatchLaunch["mapId"],
  roster: readonly PlayerId[],
  handlers: HostSimulationHandlers,
) => Promise<HostSimulationLike>;

const createHostSimulation: HostSimulationFactory = (mapId, roster, handlers) =>
  HostSimulation.create(mapId, roster, handlers);

export class PeerGameplayConnection implements GameplayTransport {
  readonly #launch: PeerMatchLaunch;
  readonly #hostMesh?: HostGameplayMesh;
  readonly #guestMesh?: GuestGameplayMesh;
  readonly #simulationFactory?: HostSimulationFactory;
  readonly #onDispose?: () => void;
  #handlers?: GameplayTransportHandlers;
  #simulation?: HostSimulationLike;
  #connected = false;
  #disposed = false;

  private constructor(
    launch: PeerMatchLaunch,
    options: {
      hostMesh?: HostGameplayMesh;
      guestMesh?: GuestGameplayMesh;
      simulationFactory?: HostSimulationFactory;
      onDispose?: () => void;
    },
  ) {
    this.#launch = launch;
    this.#hostMesh = options.hostMesh;
    this.#guestMesh = options.guestMesh;
    this.#simulationFactory = options.simulationFactory;
    this.#onDispose = options.onDispose;
  }

  static host(
    launch: PeerMatchLaunch,
    mesh: HostGameplayMesh,
    simulationFactory: HostSimulationFactory = createHostSimulation,
    onDispose?: () => void,
  ): PeerGameplayConnection {
    if (launch.role !== "host") throw new TypeError("Host launch required.");
    return new PeerGameplayConnection(launch, { hostMesh: mesh, simulationFactory, onDispose });
  }

  static guest(
    launch: PeerMatchLaunch,
    mesh: GuestGameplayMesh,
    onDispose?: () => void,
  ): PeerGameplayConnection {
    if (launch.role !== "guest") throw new TypeError("Guest launch required.");
    return new PeerGameplayConnection(launch, { guestMesh: mesh, onDispose });
  }

  async connect(handlers: GameplayTransportHandlers): Promise<void> {
    if (this.#connected || this.#disposed) return;
    this.#connected = true;
    this.#handlers = handlers;
    handlers.onStatus("connecting");
    const roster = this.#launch.players.map((player) => player.color);
    if (this.#hostMesh && this.#simulationFactory) {
      try {
        this.#simulation = await this.#simulationFactory(this.#launch.mapId, roster, {
          onSnapshot: (snapshot) => {
            if (this.#disposed) return;
            handlers.onSnapshot(snapshot);
            this.#hostMesh?.broadcastSnapshot(snapshot);
          },
          onFinished: (elapsedTicks) => {
            if (!this.#disposed) this.#hostMesh?.broadcastControl({ kind: "finished", protocol: 1, elapsedTicks });
          },
          onError: (message) => this.#fail(message),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not start the match simulation.";
        this.#fail(message);
        throw error;
      }
    }
    if (this.#disposed) return;
    handlers.onWelcome({
      type: "welcome",
      player: this.#launch.localPlayer.color,
      players: roster,
      tickRate: 60,
      snapshotRate: 20,
      mapId: this.#launch.mapId,
    });
    handlers.onStatus("connected");
  }

  sendInput(input: ClientInput): boolean {
    if (this.#disposed || !this.#connected) return false;
    if (this.#simulation) this.#simulation.setInput(this.#launch.localPlayer.color, input);
    else if (this.#guestMesh) this.#guestMesh.sendInput(input);
    else return false;
    return true;
  }

  acceptGuestInput(playerId: string, input: ClientInput): void {
    if (this.#disposed || !this.#simulation) return;
    const player = this.#launch.players.find((candidate) => candidate.id === playerId);
    if (player && !player.isHost) this.#simulation.setInput(player.color, input);
  }

  acceptHostSnapshot(snapshot: ServerSnapshot): void {
    if (!this.#disposed && this.#guestMesh) this.#handlers?.onSnapshot(snapshot);
  }

  acceptHostControl(message: PeerControlMessage): void {
    if (this.#disposed || !this.#guestMesh) return;
    if (message.kind === "failed") this.#fail(message.reason);
  }

  hostLost(): void {
    if (!this.#guestMesh || this.#disposed) return;
    this.#handlers?.onError("The host connection was lost.");
    this.#handlers?.onStatus("disconnected");
    this.dispose();
  }

  networkError(message = "The peer connection stopped unexpectedly."): void {
    this.#fail(message);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#simulation?.dispose();
    this.#hostMesh?.dispose();
    this.#guestMesh?.dispose();
    this.#onDispose?.();
  }

  #fail(message: string): void {
    if (this.#disposed) return;
    this.#handlers?.onError(message);
    this.#handlers?.onStatus("disconnected");
    this.dispose();
  }
}
