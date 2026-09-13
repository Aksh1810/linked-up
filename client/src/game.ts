import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import "@babylonjs/core/Engines/engine";
import { EngineFactory } from "@babylonjs/core/Engines/engineFactory";
import "@babylonjs/core/Engines/webgpuEngine";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import type { ArcRotateCameraPointersInput } from "@babylonjs/core/Cameras/Inputs/arcRotateCameraPointersInput";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";

import type { GameplayTransport } from "./gameplay-connection";
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
import { obstacleAppearance, obstacleDimensions, obstaclePresentation } from "./world-blockout";
import { formatCompletionTime } from "./completion";
import { describeGameplayStatus, tetherLabel } from "./gameplay-status";
import { controlsHintVisible } from "./controls-hint";
import { cameraSettings, readUiPreferences, type UiPreferences } from "./ui-preferences";
import { tetherPath } from "./tether-path";
import { mapName, type MapId } from "./lobby-state";

interface RobotVisual {
  root: TransformNode;
  visual: TransformNode;
  leftArm: TransformNode;
  rightArm: TransformNode;
  leftLeg: TransformNode;
  rightLeg: TransformNode;
}

interface ObstacleVisual {
  root: Mesh;
  warning?: Mesh;
}

export interface GameOptions {
  transport: GameplayTransport;
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
  readonly #shadows: ShadowGenerator;
  readonly #input = new InputController();
  readonly #robots = new Map<PlayerId, RobotVisual>();
  readonly #obstacles = new Map<string, ObstacleVisual>();
  readonly #tether: LinesMesh;
  readonly #connection: GameplayTransport;
  readonly #options: GameOptions;
  readonly #speedLabel: HTMLOutputElement;
  readonly #tickLabel: HTMLOutputElement;
  readonly #routeLabel: HTMLOutputElement;
  readonly #tetherLabel: HTMLOutputElement;
  readonly #headings = new Map<PlayerId, number>();
  readonly #animationTimes = new Map<PlayerId, number>();
  readonly #snapshots = new SnapshotBuffer();
  readonly #reducedMotion: MediaQueryList;
  readonly #uiEvents = new AbortController();
  #preferences: UiPreferences;
  #snapshot?: ServerSnapshot;
  #predictor?: PredictionReconciler;
  #tickRate?: number;
  #player?: PlayerId;
  #mapId: MapId = "classic-ascent";
  #roster: readonly PlayerId[] = [];
  #sequence = 0;
  #clientTick = 0;
  #inputElapsed = 0;
  #welcomed = false;
  #ready = false;
  #completed = false;
  #settingsOpen = false;
  #lastResetCount = 0;

  static async create(canvas: HTMLCanvasElement, options: GameOptions): Promise<Game> {
    const engine = await EngineFactory.CreateAsync(canvas, {
      antialias: true,
      adaptToDeviceRatio: true,
    });
    const game = new Game(canvas, engine, options);
    await game.#connect();
    return game;
  }

  private constructor(canvas: HTMLCanvasElement, engine: AbstractEngine, options: GameOptions) {
    this.#engine = engine;
    this.#options = options;
    this.#reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.#preferences = readUiPreferences(window.localStorage);
    this.#scene = new Scene(engine);
    this.#scene.clearColor = Color4.FromHexString("#86c4d4ff");
    this.#scene.fogMode = Scene.FOGMODE_EXP2;
    this.#scene.fogDensity = 0.006;
    this.#scene.fogColor = Color3.FromHexString("#86c4d4");
    this.#scene.imageProcessingConfiguration.exposure = 0.88;
    this.#scene.imageProcessingConfiguration.contrast = 1.12;

    this.#camera = new ArcRotateCamera(
      "follow-camera",
      -Math.PI / 2 - 0.42,
      1.18,
      16.5,
      new Vector3(0, 1.6, 0),
      this.#scene,
    );
    this.#camera.lowerBetaLimit = 0.65;
    this.#camera.upperBetaLimit = 1.38;
    this.#camera.lowerRadiusLimit = 10;
    this.#camera.upperRadiusLimit = 22;
    this.#camera.panningSensibility = 0;
    this.#camera.wheelPrecision = 60;
    this.#camera.attachControl(canvas, true);
    this.#applyCameraPreferences();
    this.#bindSettings(canvas);
    const controlsHint = document.querySelector<HTMLElement>("#controls-hint");
    if (controlsHint && controlsHintVisible(window.localStorage)) {
      controlsHint.addEventListener("click", () => {
        controlsHint.hidden = true;
        window.localStorage.setItem("linked-up.controls-seen", "1");
      }, { once: true });
    } else if (controlsHint) controlsHint.hidden = true;

    const sun = new DirectionalLight("sun", new Vector3(-0.55, -1, -0.35), this.#scene);
    sun.position = new Vector3(12, 18, -10);
    sun.diffuse = Color3.FromHexString("#ffe1ad");
    sun.intensity = 1.05;
    sun.autoUpdateExtends = true;
    sun.autoCalcShadowZBounds = true;
    const fill = new HemisphericLight("sky-fill", new Vector3(0, 1, 0), this.#scene);
    fill.diffuse = Color3.FromHexString("#c9e7ea");
    fill.intensity = 0.65;
    fill.groundColor = Color3.FromHexString("#6b858c");

    this.#shadows = new ShadowGenerator(1024, sun);
    this.#shadows.useBlurExponentialShadowMap = true;
    this.#shadows.blurKernel = 16;
    this.#shadows.bias = 0.0005;
    this.#shadows.normalBias = 0.02;
    this.#shadows.darkness = 0.62;

    this.#createWorld();
    this.#tether = MeshBuilder.CreateLines(
      "energy-tether",
      { points: Array.from({ length: 13 }, () => Vector3.Zero()), updatable: true },
      this.#scene,
    );
    this.#tether.color = Color3.FromHexString("#ff914d");

    const speedLabel = document.querySelector<HTMLOutputElement>("#speed-label");
    const tickLabel = document.querySelector<HTMLOutputElement>("#tick-label");
    const routeLabel = document.querySelector<HTMLOutputElement>("#route-label");
    const tetherLabelElement = document.querySelector<HTMLOutputElement>("#tether-label");
    if (!speedLabel || !tickLabel || !routeLabel || !tetherLabelElement) throw new Error("Missing gameplay telemetry");
    this.#speedLabel = speedLabel;
    this.#tickLabel = tickLabel;
    this.#routeLabel = routeLabel;
    this.#tetherLabel = tetherLabelElement;

    this.#connection = options.transport;

    window.addEventListener("resize", this.#resize);
    this.#engine.runRenderLoop(this.#frame);
  }

  async #connect(): Promise<void> {
    await this.#connection.connect({
      onWelcome: this.#onWelcome,
      onSnapshot: this.#onSnapshot,
      onError: this.#options.onError,
      onStatus: (status) => {
        const text = status === "connecting"
          ? "Connecting to gameplay server"
          : status === "connected"
            ? "Connected to gameplay server"
            : "Gameplay server disconnected";
        this.#options.onStatus(text);
      },
    });
  }

  dispose(): void {
    window.removeEventListener("resize", this.#resize);
    this.#uiEvents.abort();
    this.#reducedMotion.removeEventListener("change", this.#onMotionPreferenceChange);
    this.#connection.dispose();
    this.#input.dispose();
    this.#scene.dispose();
    this.#engine.dispose();
  }

  #bindSettings(canvas: HTMLCanvasElement): void {
    const panel = document.querySelector<HTMLDialogElement>("#settings-panel");
    const open = document.querySelector<HTMLButtonElement>("#settings-toggle");
    const close = document.querySelector<HTMLButtonElement>("#settings-close");
    const sensitivity = document.querySelector<HTMLSelectElement>("#camera-sensitivity");
    const invertY = document.querySelector<HTMLInputElement>("#invert-camera");
    const reset = document.querySelector<HTMLButtonElement>("#camera-reset");
    const fullscreen = document.querySelector<HTMLButtonElement>("#fullscreen-toggle");
    if (!panel || !open || !close || !sensitivity || !invertY || !reset || !fullscreen) {
      throw new Error("Missing gameplay settings");
    }

    sensitivity.value = this.#preferences.cameraSensitivity;
    invertY.checked = this.#preferences.invertY;
    const save = (): void => {
      this.#preferences = {
        cameraSensitivity: sensitivity.value as UiPreferences["cameraSensitivity"],
        invertY: invertY.checked,
      };
      window.localStorage.setItem("linked-up.ui-preferences", JSON.stringify(this.#preferences));
      this.#applyCameraPreferences();
    };
    const finishSettings = (): void => {
      this.#settingsOpen = false;
      this.#camera.attachControl(canvas, true);
      canvas.focus();
    };
    const updateFullscreenLabel = (): void => {
      fullscreen.textContent = document.fullscreenElement ? "Exit fullscreen" : "Enter fullscreen";
    };

    open.addEventListener("click", () => {
      this.#settingsOpen = true;
      this.#camera.detachControl();
      panel.showModal();
    }, { signal: this.#uiEvents.signal });
    close.addEventListener("click", () => panel.close(), { signal: this.#uiEvents.signal });
    panel.addEventListener("close", finishSettings, { signal: this.#uiEvents.signal });
    sensitivity.addEventListener("change", save, { signal: this.#uiEvents.signal });
    invertY.addEventListener("change", save, { signal: this.#uiEvents.signal });
    reset.addEventListener("click", () => {
      this.#camera.alpha = -Math.PI / 2 - 0.42;
      this.#camera.beta = 1.18;
      this.#camera.radius = 16.5;
    }, { signal: this.#uiEvents.signal });
    fullscreen.addEventListener("click", async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch {
        this.#options.onStatus("Fullscreen is unavailable");
      }
    }, { signal: this.#uiEvents.signal });
    document.addEventListener("fullscreenchange", updateFullscreenLabel, { signal: this.#uiEvents.signal });
    this.#reducedMotion.addEventListener("change", this.#onMotionPreferenceChange);
    updateFullscreenLabel();
  }

  #applyCameraPreferences(): void {
    const settings = cameraSettings(this.#preferences, this.#reducedMotion.matches, 0);
    this.#camera.inertia = settings.inertia;
    const pointers = this.#camera.inputs.attached.pointers as ArcRotateCameraPointersInput | undefined;
    if (pointers) {
      pointers.angularSensibilityX = settings.angularSensibilityX;
      pointers.angularSensibilityY = settings.angularSensibilityY;
    }
  }

  readonly #onMotionPreferenceChange = (): void => this.#applyCameraPreferences();

  #createWorld(): void {
    const soil = this.#material("platform-soil", "#4b3831");
    const grass = this.#material("platform-grass", "#527f5a");
    const edge = this.#material("platform-edge", "#294b39");

    const base = MeshBuilder.CreateBox(
      "bounded-platform",
      { width: 16, height: 1.2, depth: 16 },
      this.#scene,
    );
    base.position.y = -0.65;
    base.material = soil;
    base.receiveShadows = true;

    const lawn = MeshBuilder.CreateBox(
      "bounded-lawn",
      { width: 16, height: 0.16, depth: 16 },
      this.#scene,
    );
    lawn.position.y = -0.01;
    lawn.material = grass;
    lawn.receiveShadows = true;

    for (const [index, x, z, width, depth] of [
      [0, 0, -7.88, 16, 0.24],
      [1, 0, 7.88, 16, 0.24],
      [2, -7.88, 0, 0.24, 16],
      [3, 7.88, 0, 0.24, 16],
    ] as const) {
      const rim = MeshBuilder.CreateBox(
        `platform-rim-${index}`,
        { width, height: 0.12, depth },
        this.#scene,
      );
      rim.position.set(x, 0.1, z);
      rim.material = edge;
      rim.receiveShadows = true;
    }

    const campPad = MeshBuilder.CreateBox(
      "base-camp-pad",
      { width: 5.2, height: 0.04, depth: 3.2 },
      this.#scene,
    );
    campPad.position.y = 0.095;
    campPad.material = this.#material("base-camp-pad-material", "#294955");
    campPad.receiveShadows = true;
    campPad.isPickable = false;
    for (const [id, x, color] of [
      ["blue", -1.25, "#347e98"], ["orange", 1.25, "#a76039"],
    ] as const) {
      const lane = MeshBuilder.CreateBox(
        `base-camp-${id}-lane`,
        { width: 1.8, height: 0.02, depth: 2.35 },
        this.#scene,
      );
      lane.position.set(x, 0.125, 0);
      lane.material = this.#material(`base-camp-${id}-lane-material`, color);
      lane.receiveShadows = true;
      lane.isPickable = false;
    }

    const cloudMaterial = this.#material("cloud-haze", "#d9ecec");
    cloudMaterial.disableLighting = true;
    cloudMaterial.emissiveColor = Color3.FromHexString("#bedde1");
    cloudMaterial.alpha = 0.72;
    for (const [index, [x, y, z]] of [
      [-18, -5, 10], [18, 2, 33], [-19, 9, 56], [18, 15, 78],
      [-18, 22, 101], [19, 29, 123], [-18, 36, 145],
    ].entries()) {
      for (const [piece, offsetX, offsetY, scale] of [
        [0, -2.1, -0.2, 0.8], [1, 0, 0.25, 1.15], [2, 2.2, -0.15, 0.72],
      ] as const) {
        const cloud = MeshBuilder.CreateSphere(
          `cloud-${index}-${piece}`,
          { diameter: 4.5, segments: 8 },
          this.#scene,
        );
        cloud.position.set(x + offsetX, y + offsetY, z);
        cloud.scaling.set(scale * 1.45, scale * 0.42, scale * 0.78);
        cloud.material = cloudMaterial;
        cloud.isPickable = false;
      }
    }
  }

  #createRobot(id: PlayerId): RobotVisual {
    const colors: Record<PlayerId, readonly [string, string]> = {
      blue: ["#38a6cc", "#176789"], orange: ["#e68045", "#98502e"],
      green: ["#62a86d", "#356d49"], purple: ["#9a79c8", "#644a8f"],
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
      mesh.receiveShadows = true;
      this.#shadows.addShadowCaster(mesh);
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
    socket.receiveShadows = true;
    this.#shadows.addShadowCaster(socket);

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
    if (emissive) material.emissiveColor = Color3.FromHexString(emissive).scale(0.72);
    return material;
  }

  readonly #onWelcome = (message: WelcomeMessage): void => {
    this.#player = message.player;
    this.#roster = message.players;
    this.#mapId = message.mapId;
    const playerLabel = document.querySelector<HTMLOutputElement>("#player-label");
    if (playerLabel) playerLabel.value = `${playerName(message.player)} robot`;
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
    const zone = ["Grass", "Construction", "Industrial", "Sky", "Summit"][Math.min(snapshot.checkpoint, 4)];
    this.#routeLabel.value = `${mapName(this.#mapId)} · ${zone} · Checkpoint ${snapshot.checkpoint}`;
    this.#tetherLabel.value = `${tetherLabel(snapshot.tetherTension)} tether`;
    this.#options.onStatus(describeGameplayStatus(
      snapshot, this.#player ?? snapshot.players[0].id, this.#lastResetCount,
    ));
    this.#lastResetCount = snapshot.resetCount;
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
        Vector3.Lerp(this.#camera.target, target, cameraSettings(
          this.#preferences, this.#reducedMotion.matches, delta,
        ).targetBlend),
      );
      this.#updateTether(sampled?.tetherTension ?? this.#snapshot.tetherTension);
      this.#updateObstacles(sampled?.obstacles ?? this.#snapshot.obstacles);
      if (this.#snapshot.matchState === "finished" && !this.#completed) {
        this.#completed = true;
        const completion = document.querySelector<HTMLElement>("#completion");
        const completionTime = document.querySelector<HTMLOutputElement>("#completion-time");
        if (completion && completionTime) {
          completionTime.value = formatCompletionTime(this.#snapshot.elapsedTicks, this.#tickRate);
          completion.hidden = false;
          document.querySelector<HTMLButtonElement>("#completion-leave")?.addEventListener(
            "click", () => { window.location.href = "./"; }, { once: true },
          );
        }
        this.#options.onStatus("Summit reached");
      }
    }

    if (!this.#completed && !this.#settingsOpen && this.#tickRate) this.#inputElapsed += delta;
    if (!this.#completed && !this.#settingsOpen && this.#tickRate && this.#inputElapsed >= 1 / this.#tickRate) {
      this.#inputElapsed %= 1 / this.#tickRate;
      const input = this.#input.consume();
      const movement = cameraRelativeMovement(input, this.#camera.alpha);
      const wireInput: ClientInput = {
        sequence: ++this.#sequence,
        clientTick: ++this.#clientTick,
        moveX: movement.x,
        moveZ: movement.z,
        jump: input.jumpHeld || input.jumpPressed,
      };
      const sent = this.#connection.sendInput(wireInput);
      if (sent) this.#predictor?.record({ ...wireInput, jump: input.jumpPressed });
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
      let visual = this.#obstacles.get(state.id);
      if (!visual) {
        const dimensions = obstacleDimensions(state.halfExtent);
        const appearance = obstacleAppearance(state.zone, state.kind);
        const presentation = obstaclePresentation(state.kind, state.phase, this.#reducedMotion.matches);
        const mesh = MeshBuilder.CreateBox(`obstacle-${state.id}`, dimensions, this.#scene);
        const baseMaterial = this.#material(`obstacle-${state.id}-base`, appearance.base);
        baseMaterial.emissiveColor = Color3.FromHexString(appearance.base).scale(0.12);
        baseMaterial.alpha = presentation.opacity;
        baseMaterial.wireframe = presentation.wireframe;
        mesh.material = baseMaterial;
        mesh.receiveShadows = true;
        const cap = MeshBuilder.CreateBox(
          `obstacle-${state.id}-cap`,
          { width: dimensions.width + 0.04, height: 0.08, depth: dimensions.depth + 0.04 },
          this.#scene,
        );
        cap.position.y = dimensions.height / 2 + 0.04;
        const capMaterial = this.#material(`obstacle-${state.id}-top`, appearance.top);
        capMaterial.alpha = presentation.opacity;
        cap.material = capMaterial;
        cap.parent = mesh;
        cap.receiveShadows = true;
        if (presentation.directional) {
          for (const [index, offset] of [-0.5, 0, 0.5].entries()) {
            const stripe = MeshBuilder.CreateBox(`obstacle-${state.id}-direction-${index}`, {
              width: Math.max(0.18, dimensions.width * 0.62), height: 0.09,
              depth: Math.max(0.1, Math.min(0.22, dimensions.depth * 0.12)),
            }, this.#scene);
            stripe.position.set(0, dimensions.height / 2 + 0.1, offset * dimensions.depth);
            stripe.material = this.#material(`obstacle-${state.id}-direction-${index}-material`, "#effcff", "#8feaff");
            stripe.parent = mesh;
          }
        }
        if (presentation.hub) {
          const hub = MeshBuilder.CreateCylinder(`obstacle-${state.id}-hub`, {
            diameter: Math.max(0.3, Math.min(dimensions.width, dimensions.depth) * 0.45),
            height: dimensions.height + 0.18, tessellation: 16,
          }, this.#scene);
          hub.material = this.#material(`obstacle-${state.id}-hub-material`, "#26394a", "#ff914d");
          hub.parent = mesh;
        }
        let warning: Mesh | undefined;
        if (state.kind === "fallingPlatform") {
          warning = MeshBuilder.CreateBox(`obstacle-${state.id}-warning`, {
            width: 0.42, height: 0.42, depth: 0.12,
          }, this.#scene);
          warning.position.set(0, dimensions.height / 2 + 0.45, 0);
          warning.rotation.z = Math.PI / 4;
          warning.material = this.#material(`obstacle-${state.id}-warning-material`, "#fff4d6", "#ff914d");
          warning.parent = mesh;
          warning.setEnabled(false);
        }
        visual = { root: mesh, warning };
        this.#obstacles.set(state.id, visual);
      }
      const presentation = obstaclePresentation(state.kind, state.phase, this.#reducedMotion.matches);
      const shake = presentation.shake ? Math.sin(performance.now() * 0.035) * 0.045 : 0;
      visual.root.position.set(state.position.x + shake, state.position.y, state.position.z);
      visual.root.rotation.set(state.rotation.x, state.rotation.y, state.rotation.z);
      visual.root.isVisible = state.phase !== "falling" || state.position.y > -12;
      visual.warning?.setEnabled(presentation.warning);
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
    const swing = this.#reducedMotion.matches ? 0 : Math.sin(animationTime * 11) * 0.62 * runAmount;
    robot.leftArm.rotation.x = swing;
    robot.rightArm.rotation.x = -swing;
    robot.leftLeg.rotation.x = -swing * 0.72;
    robot.rightLeg.rotation.x = swing * 0.72;
    robot.visual.position.y = this.#reducedMotion.matches ? 0 :
      Math.sin(animationTime * (speed > 0.1 ? 11 : 2.2)) *
      (speed > 0.1 ? 0.035 : 0.025);
    robot.visual.scaling.y = state.grounded ? 1 : 0.94;
  }

  #tetherPoints(): Vector3[] {
    const anchors = this.#roster.map((id) => {
      const robot = this.#robots.get(id)!.root;
      return {
        x: robot.position.x - Math.sin(robot.rotation.y) * 0.76,
        y: robot.position.y + 0.1,
        z: robot.position.z - Math.cos(robot.rotation.y) * 0.76,
      };
    });
    if (anchors.length < 2) return Array.from({ length: 13 }, () => Vector3.Zero());
    const segmentCount = anchors.length === 2 ? 1 : anchors.length;
    const points: Vector3[] = [];
    for (let index = 0; index < segmentCount; ++index) {
      const segment = tetherPath(
        anchors[index], anchors[(index + 1) % anchors.length], this.#snapshot?.obstacles ?? [],
      );
      points.push(...segment.slice(index === 0 ? 0 : 1).map(({ x, y, z }) => new Vector3(x, y, z)));
    }
    while (points.length < 13) points.push(points.at(-1)!.clone());
    return points;
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
