export interface Vector3State {
  x: number;
  y: number;
  z: number;
}

export interface MotionState {
  position: Vector3State;
  velocity: Vector3State;
  grounded: boolean;
}

export interface MotionInput {
  x: number;
  z: number;
  jumpPressed: boolean;
}

export interface MotionConfig {
  acceleration: number;
  floorHeight: number;
  gravity: number;
  jumpSpeed: number;
  maxDelta: number;
  maxSpeed: number;
}

export const defaultMotionConfig: MotionConfig = {
  acceleration: 28,
  floorHeight: 1,
  gravity: -24,
  jumpSpeed: 8,
  maxDelta: 0.05,
  maxSpeed: 6,
};

export function createMotionState(
  config = defaultMotionConfig,
): MotionState {
  return {
    position: { x: 0, y: config.floorHeight, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    grounded: true,
  };
}

export function stepMotion(
  state: MotionState,
  input: MotionInput,
  cameraYaw: number,
  deltaTime: number,
  config = defaultMotionConfig,
): MotionState {
  const delta = Number.isFinite(deltaTime)
    ? Math.max(0, Math.min(deltaTime, config.maxDelta))
    : 0;
  const movement = worldMovement(input, cameraYaw);
  const targetX = movement.x * config.maxSpeed;
  const targetZ = movement.z * config.maxSpeed;
  const changeX = targetX - state.velocity.x;
  const changeZ = targetZ - state.velocity.z;
  const changeLength = Math.hypot(changeX, changeZ);
  const maxChange = config.acceleration * delta;
  const changeScale = changeLength > maxChange ? maxChange / changeLength : 1;
  const velocity = {
    x: state.velocity.x + changeX * changeScale,
    y: state.velocity.y,
    z: state.velocity.z + changeZ * changeScale,
  };
  let grounded = state.grounded;

  if (input.jumpPressed && grounded) {
    velocity.y = config.jumpSpeed;
    grounded = false;
  }
  if (!grounded) velocity.y += config.gravity * delta;

  const position = {
    x: state.position.x + velocity.x * delta,
    y: state.position.y + velocity.y * delta,
    z: state.position.z + velocity.z * delta,
  };
  if (position.y <= config.floorHeight) {
    position.y = config.floorHeight;
    velocity.y = 0;
    grounded = true;
  }

  return { position, velocity, grounded };
}

export function worldMovement(
  input: Pick<MotionInput, "x" | "z">,
  cameraYaw: number,
): { x: number; z: number } {
  const inputX = Number.isFinite(input.x) ? input.x : 0;
  const inputZ = Number.isFinite(input.z) ? input.z : 0;
  const length = Math.hypot(inputX, inputZ);
  const scale = length > 1 ? 1 / length : 1;
  const x = inputX * scale;
  const z = inputZ * scale;
  const sine = Math.sin(cameraYaw);
  const cosine = Math.cos(cameraYaw);
  return { x: x * cosine + z * sine, z: z * cosine - x * sine };
}

export function cameraRelativeMovement(
  input: Pick<MotionInput, "x" | "z">,
  orbitAlpha: number,
): { x: number; z: number } {
  return worldMovement(input, -orbitAlpha - Math.PI / 2);
}
