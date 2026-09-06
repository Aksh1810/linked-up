import type { MotionInput } from "./motion";

const controlledKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "Space"]);

export class InputController {
  readonly #pressed = new Set<string>();
  #jumpQueued = false;

  constructor() {
    window.addEventListener("keydown", this.#onKeyDown);
    window.addEventListener("keyup", this.#onKeyUp);
    window.addEventListener("blur", this.#onBlur);
  }

  consume(): MotionInput & { jumpHeld: boolean } {
    const input = {
      x: Number(this.#pressed.has("KeyD")) - Number(this.#pressed.has("KeyA")),
      z: Number(this.#pressed.has("KeyW")) - Number(this.#pressed.has("KeyS")),
      jumpPressed: this.#jumpQueued,
      jumpHeld: this.#pressed.has("Space"),
    };
    this.#jumpQueued = false;
    return input;
  }

  queueJump(): void {
    this.#jumpQueued = true;
  }

  dispose(): void {
    window.removeEventListener("keydown", this.#onKeyDown);
    window.removeEventListener("keyup", this.#onKeyUp);
    window.removeEventListener("blur", this.#onBlur);
  }

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    if (!controlledKeys.has(event.code)) return;
    event.preventDefault();
    if (event.code === "Space" && !event.repeat) this.#jumpQueued = true;
    this.#pressed.add(event.code);
  };

  readonly #onKeyUp = (event: KeyboardEvent): void => {
    if (!controlledKeys.has(event.code)) return;
    event.preventDefault();
    this.#pressed.delete(event.code);
  };

  readonly #onBlur = (): void => {
    this.#pressed.clear();
    this.#jumpQueued = false;
  };
}
