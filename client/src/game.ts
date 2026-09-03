import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import "@babylonjs/core/Engines/engine";
import { EngineFactory } from "@babylonjs/core/Engines/engineFactory";
import "@babylonjs/core/Engines/webgpuEngine";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";

import { GameplayConnection, type GameplayConnectionIdentity } from "./gameplay-connection";
import type {
  ClientInput,
  NetworkObstacleState,
  NetworkPlayerState,
  PlayerId,
  ServerSnapshot,
  WelcomeMessage,
} from "./gameplay-protocol";
import { InputController } from "./input";
import { cameraRelativeMovement } from "./motion";
import { PredictionReconciler, SnapshotBuffer } from "./network-smoothing";

interface RobotVisual {
  root: TransformNode;
  visual: TransformNode;
  leftArm: TransformNode;
  rightArm: TransformNode;
  leftLeg: TransformNode;
  rightLeg: TransformNode;
}

export interface GameOptions {
  gameplayUrl: string;
  identity: GameplayConnectionIdentity;
  onReady(): void;
  onStatus(message: string): void;
  onError(message: string): void;
}

const playerName = (player: PlayerId): string => ({
  blue: "Blue", orange: "Orange", green: "Green", purple: "Purple",
})[player];

export class Game {
  readonly #engine: AbstractEngine;
  readonly #scene: Scene;
  readonly #camera: ArcRotateCamera;
  readonly #input = new InputController();
  readonly #robots = new Map<PlayerId, RobotVisual>();
  readonly #obstacles = new Map<string, Mesh>();
  readonly #tether: LinesMesh;
  readonly #connection: GameplayConnection;
  readonly #options: GameOptions;
  readonly #speedLabel: HTMLOutputElement;
  readonly #tickLabel: HTMLOutputElement;
  readonly #headings = new Map<PlayerId, number>();
  readonly #animationTimes = new Map<PlayerId, number>();
  readonly #snapshots = new SnapshotBuffer();
  #snapshot?: ServerSnapshot;
  #predictor?: PredictionReconciler;
  #tickRate?: number;
  #player?: PlayerId;
  #roster: readonly PlayerId[] = [];
  #sequence = 0;
  #clientTick = 0;
  #inputElapsed = 0;
  #welcomed = false;
  #ready = false;
  #completed = false;

  static async create(canvas: HTMLCanvasElement, options: GameOptions): Promise<Game> {
    const engine = await EngineFactory.CreateAsync(canvas, {
      antialias: true,
      adaptToDeviceRatio: true,
    });
    return new Game(canvas, engine, options);
  }

  private constructor(canvas: HTMLCanvasElement, engine: AbstractEngine, options: GameOptions) {
    this.#engine = engine;
    this.#options = options;
    this.#scene = new Scene(engine);
    this.#scene.clearColor = Color4.FromHexString("#8fd9ffff");
    this.#scene.fogMode = Scene.FOGMODE_EXP2;
    this.#scene.fogDensity = 0.008;
    this.#scene.fogColor = Color3.FromHexString("#8fd9ff");

    this.#camera = new ArcRotateCamera(
      "follow-camera",
      -Math.PI / 2,
      1.05,
      8,
      new Vector3(0, 1.6, 0),
      this.#scene,
    );
    this.#camera.lowerBetaLimit = 0.65;
    this.#camera.upperBetaLimit = 1.38;
    this.#camera.lowerRadiusLimit = 6;
    this.#camera.upperRadiusLimit = 10;
    this.#camera.inertia = 0.82;
    this.#camera.panningSensibility = 0;
    this.#camera.wheelPrecision = 60;
    this.#camera.attachControl(canvas, true);

    const sun = new DirectionalLight("sun", new Vector3(-0.5, -1, 0.35), this.#scene);
    sun.position = new Vector3(10, 16, -8);
    sun.intensity = 1.2;
    const fill = new HemisphericLight("sky-fill", new Vector3(0, 1, 0), this.#scene);
    fill.intensity = 0.55;
    fill.groundColor = Color3.FromHexString("#315947");

    this.#createWorld();
    this.#tether = MeshBuilder.CreateLines(
      "energy-tether",
      { points: [Vector3.Zero(), Vector3.Zero()], updatable: true },
      this.#scene,
    );
    this.#tether.color = Color3.FromHexString("#ff914d");

    const speedLabel = document.querySelector<HTMLOutputElement>("#speed-label");
    const tickLabel = document.querySelector<HTMLOutputElement>("#tick-label");
    if (!speedLabel || !tickLabel) throw new Error("Missing gameplay telemetry");
    this.#speedLabel = speedLabel;
    this.#tickLabel = tickLabel;

    this.#connection = new GameplayConnection(options.gameplayUrl, options.identity, {
      onWelcome: this.#onWelcome,
      onSnapshot: this.#onSnapshot,
      onError: options.onError,
      onStatus: (status) => {
        const text = status === "connecting"
          ? "Connecting to gameplay server"
          : status === "connected"
            ? "Connected to gameplay server"
            : "Gameplay server disconnected";
        options.onStatus(text);
      },
    });

    window.addEventListener("resize", this.#resize);
    this.#engine.runRenderLoop(this.#frame);
    this.#connection.connect();
  }

  dispose(): void {
    window.removeEventListener("resize", this.#resize);
    this.#connection.dispose();
    this.#input.dispose();
    this.#scene.dispose();
    this.#engine.dispose();
  }

  #createWorld(): void {
    const soil = this.#material("platform-soil", "#8a603e");
    const grass = this.#material("platform-grass", "#65c66a");
    const edge = this.#material("platform-edge", "#3d944f");

    const base = MeshBuilder.CreateBox(
      "bounded-platform",
      { width: 10, height: 1.2, depth: 10 },
      this.#scene,
    );
    base.position.y = -0.65;
    base.material = soil;

    const lawn = MeshBuilder.CreateBox(
      "bounded-lawn",
      { width: 10, height: 0.16, depth: 10 },
      this.#scene,
    );
    lawn.position.y = -0.01;
    lawn.material = grass;

    for (const [index, x, z, width, depth] of [
      [0, 0, -4.88, 10, 0.24],
      [1, 0, 4.88, 10, 0.24],
      [2, -4.88, 0, 0.24, 10],
      [3, 4.88, 0, 0.24, 10],
    ] as const) {
      const rim = MeshBuilder.CreateBox(
        `platform-rim-${index}`,
        { width, height: 0.12, depth },
        this.#scene,
      );
      rim.position.set(x, 0.1, z);
      rim.material = edge;
    }
  }

  #createRobot(id: PlayerId): RobotVisual {
    const colors: Record<PlayerId, readonly [string, string]> = {
      blue: ["#38bdf8", "#167ca8"], orange: ["#ff914d", "#bd5c20"],
      green: ["#65c66a", "#3d944f"], purple: ["#b58cff", "#7046bf"],
    };
    const main = this.#material(`${id}-main`, colors[id][0]);
    const dark = this.#material(`${id}-dark`, colors[id][1]);
    const joint = this.#material(`${id}-joint`, "#173449");
    const visor = this.#material(`${id}-visor`, "#10243a", "#5ee7ff");
    const socketMaterial = this.#material(`${id}-socket`, "#ffb15c", "#ff914d");
    const root = new TransformNode(`${id}-root`, this.#scene);
    const visual = new TransformNode(`${id}-visual`, this.#scene);
    visual.parent = root;

    const box = (
      name: string,
      size: { width: number; height: number; depth: number },
      position: Vector3,
      material: StandardMaterial,
      parent: TransformNode = visual,
    ): Mesh => {
      const mesh = MeshBuilder.CreateBox(`${id}-${name}`, size, this.#scene);
      mesh.position = position;
      mesh.material = material;
      mesh.parent = parent;
      return mesh;
    };

    box("torso", { width: 1.15, height: 0.95, depth: 0.72 }, new Vector3(0, 0, 0), main);
    box("chest-panel", { width: 0.5, height: 0.24, depth: 0.05 }, new Vector3(0, 0.05, 0.39), visor);
    box("head", { width: 1.05, height: 0.68, depth: 0.78 }, new Vector3(0, 0.88, 0), main);
    box("face-screen", { width: 0.74, height: 0.3, depth: 0.05 }, new Vector3(0, 0.9, 0.415), visor);
    box("left-eye", { width: 0.1, height: 0.1, depth: 0.04 }, new Vector3(-0.19, 0.92, 0.45), socketMaterial);
    box("right-eye", { width: 0.1, height: 0.1, depth: 0.04 }, new Vector3(0.19, 0.92, 0.45), socketMaterial);
    box("backpack", { width: 0.72, height: 0.75, depth: 0.34 }, new Vector3(0, 0.08, -0.53), dark);
    const socket = MeshBuilder.CreateTorus(
      `${id}-tether-socket`,
      { diameter: 0.35, thickness: 0.1, tessellation: 16 },
      this.#scene,
    );
    socket.position.set(0, 0.1, -0.76);
    socket.rotation.x = Math.PI / 2;
    socket.material = socketMaterial;
    socket.parent = visual;

    const leftArm = new TransformNode(`${id}-left-arm-pivot`, this.#scene);
    leftArm.position.set(-0.73, 0.28, 0);
    leftArm.parent = visual;
    box("left-arm", { width: 0.3, height: 0.78, depth: 0.34 }, new Vector3(0, -0.34, 0), joint, leftArm);
    const rightArm = new TransformNode(`${id}-right-arm-pivot`, this.#scene);
    rightArm.position.set(0.73, 0.28, 0);
    rightArm.parent = visual;
    box("right-arm", { width: 0.3, height: 0.78, depth: 0.34 }, new Vector3(0, -0.34, 0), joint, rightArm);

    const leftLeg = new TransformNode(`${id}-left-leg-pivot`, this.#scene);
    leftLeg.position.set(-0.29, -0.42, 0);
    leftLeg.parent = visual;
    box("left-leg", { width: 0.36, height: 0.58, depth: 0.42 }, new Vector3(0, -0.28, 0), dark, leftLeg);
    const rightLeg = new TransformNode(`${id}-right-leg-pivot`, this.#scene);
    rightLeg.position.set(0.29, -0.42, 0);
    rightLeg.parent = visual;
    box("right-leg", { width: 0.36, height: 0.58, depth: 0.42 }, new Vector3(0, -0.28, 0), dark, rightLeg);

    return { root, visual, leftArm, rightArm, leftLeg, rightLeg };
  }

  #material(name: string, diffuse: string, emissive?: string): StandardMaterial {
    const material = new StandardMaterial(name, this.#scene);
    material.diffuseColor = Color3.FromHexString(diffuse);
    material.specularColor = Color3.FromHexString("#163247").scale(0.18);
    if (emissive) material.emissiveColor = Color3.FromHexString(emissive);
    return material;
  }

  readonly #onWelcome = (message: WelcomeMessage): void => {
    this.#player = message.player;
    this.#roster = message.players;
    this.#ensureRoster(message.players);
    this.#tickRate = message.tickRate;
    this.#predictor = new PredictionReconciler(message.player, message.tickRate);
    this.#welcomed = true;
    this.#options.onStatus(`Connected as ${playerName(message.player)}`);
    this.#finishStartup();
  };

  readonly #onSnapshot = (snapshot: ServerSnapshot): void => {
    if (!this.#snapshots.push(snapshot, performance.now())) return;
    this.#snapshot = snapshot;
    this.#predictor?.reconcile(snapshot);
    this.#tickLabel.value = `Tick ${snapshot.tick}`;
    this.#finishStartup();
  };

  #finishStartup(): void {
    if (this.#ready || !this.#welcomed || !this.#snapshot) return;
    this.#ready = true;
    this.#options.onReady();
  }

  readonly #frame = (): void => {
    const delta = Math.min(this.#engine.getDeltaTime() / 1000, 0.1);
    this.#predictor?.advanceCorrection(delta * 1_000);
    if (this.#snapshot && this.#tickRate && this.#player) {
      const sampled = this.#snapshots.sample(performance.now(), this.#tickRate);
      const local = this.#predictor?.renderState() ?? this.#snapshot.players.find(({ id }) => id === this.#player);
      if (!local) return;
      const states = (sampled?.players ?? this.#snapshot.players).map(
        (state) => state.id === this.#player ? local : state,
      );
      for (const state of states) {
        const robot = this.#robots.get(state.id)!;
        robot.root.position.set(
          state.position.x,
          state.position.y,
          state.position.z,
        );
        this.#animateRobot(state, delta);
      }
      const speed = Math.hypot(local.velocity.x, local.velocity.z);
      this.#speedLabel.value = `${speed.toFixed(1)} m/s`;
      const target = new Vector3(local.position.x, local.position.y + 0.55, local.position.z);
      this.#camera.setTarget(
        Vector3.Lerp(this.#camera.target, target, 1 - Math.exp(-8 * delta)),
      );
      this.#updateTether(sampled?.tetherTension ?? this.#snapshot.tetherTension);
      this.#updateObstacles(sampled?.obstacles ?? this.#snapshot.obstacles);
      if (this.#snapshot.matchState === "finished" && !this.#completed) {
        this.#completed = true;
        this.#options.onStatus(`Summit reached in ${(this.#snapshot.elapsedTicks / this.#tickRate).toFixed(1)}s`);
      }
    }

    if (!this.#completed && this.#tickRate) this.#inputElapsed += delta;
    if (!this.#completed && this.#tickRate && this.#inputElapsed >= 1 / this.#tickRate) {
      this.#inputElapsed %= 1 / this.#tickRate;
      const input = this.#input.consume();
      const movement = cameraRelativeMovement(input, this.#camera.alpha);
      const wireInput: ClientInput = {
        sequence: ++this.#sequence,
        clientTick: ++this.#clientTick,
        moveX: movement.x,
        moveZ: movement.z,
        jump: input.jumpPressed,
      };
      const sent = this.#connection.sendInput(wireInput);
      if (sent) this.#predictor?.record(wireInput);
      else if (input.jumpPressed) this.#input.queueJump();
    }

    this.#scene.render();
  };

  #ensureRoster(players: readonly PlayerId[]): void {
    for (const player of players) {
      if (!this.#robots.has(player)) this.#robots.set(player, this.#createRobot(player));
      if (!this.#headings.has(player)) this.#headings.set(player, 0);
      if (!this.#animationTimes.has(player)) this.#animationTimes.set(player, 0);
    }
  }

  #updateObstacles(obstacles: readonly NetworkObstacleState[]): void {
    for (const state of obstacles) {
      let mesh = this.#obstacles.get(state.id);
      if (!mesh) {
        mesh = MeshBuilder.CreateBox(`obstacle-${state.id}`, { width: 2, height: 0.35, depth: 2 }, this.#scene);
        const colors: Record<NetworkObstacleState["kind"], string> = {
          movingPlatform: "#f6c56f", rotatingBeam: "#e97552", swingingBeam: "#db7698",
          fan: "#7ee7ef", conveyor: "#757d95", fallingPlatform: "#af8d68",
        };
        mesh.material = this.#material(`obstacle-${state.id}-material`, colors[state.kind]);
        this.#obstacles.set(state.id, mesh);
      }
      mesh.position.set(state.position.x, state.position.y, state.position.z);
      mesh.rotation.set(state.rotation.x, state.rotation.y, state.rotation.z);
      mesh.isVisible = state.phase !== "falling" || state.position.y > -12;
    }
  }

  #animateRobot(state: NetworkPlayerState, delta: number): void {
    const robot = this.#robots.get(state.id)!;
    const speed = Math.hypot(state.velocity.x, state.velocity.z);
    if (speed > 0.08) {
      const target = Math.atan2(state.velocity.x, state.velocity.z);
      const heading = this.#headings.get(state.id)!;
      const difference = Math.atan2(Math.sin(target - heading), Math.cos(target - heading));
      this.#headings.set(state.id, heading + difference * (1 - Math.exp(-12 * delta)));
    }
    robot.root.rotation.y = this.#headings.get(state.id)!;

    this.#animationTimes.set(state.id, this.#animationTimes.get(state.id)! + delta);
    const runAmount = Math.min(speed / 3.5, 1);
    const animationTime = this.#animationTimes.get(state.id)!;
    const swing = Math.sin(animationTime * 11) * 0.62 * runAmount;
    robot.leftArm.rotation.x = swing;
    robot.rightArm.rotation.x = -swing;
    robot.leftLeg.rotation.x = -swing * 0.72;
    robot.rightLeg.rotation.x = swing * 0.72;
    robot.visual.position.y =
      Math.sin(animationTime * (speed > 0.1 ? 11 : 2.2)) *
      (speed > 0.1 ? 0.035 : 0.025);
    robot.visual.scaling.y = state.grounded ? 1 : 0.94;
  }

  #tetherPoints(): Vector3[] {
    const points = this.#roster.map((id) => {
      const robot = this.#robots.get(id)!.root;
      return new Vector3(
        robot.position.x - Math.sin(robot.rotation.y) * 0.76,
        robot.position.y + 0.1,
        robot.position.z - Math.cos(robot.rotation.y) * 0.76,
      );
    });
    if (points.length > 2) points.push(points[0].clone());
    return points.length ? points : [Vector3.Zero(), Vector3.Zero()];
  }

  #updateTether(tension = 0): void {
    MeshBuilder.CreateLines(
      "energy-tether",
      { points: this.#tetherPoints(), instance: this.#tether },
      this.#scene,
    );
    this.#tether.alpha = 0.9 + tension * 0.1;
  }

  readonly #resize = (): void => this.#engine.resize();
}
