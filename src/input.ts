import { type ControlInput } from "./simulation";

const KEY_TURN_RATE = 1.1; // radians per second
const KEY_ROLL_RATE = 1.2;
const PREVENT_DEFAULT = new Set(["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

export type Command =
  | "toggleWarp"
  | "toggleDrive"
  | "toggleLock"
  | "togglePause"
  | "toggleHelp"
  | "toggleDisk"
  | "toggleSky"
  | "cycleQuality"
  | "slower"
  | "faster"
  | "restart"
  | "preset1"
  | "preset2"
  | "preset3"
  | "preset4";

const COMMAND_KEYS: Record<string, Command> = {
  Space: "toggleWarp",
  KeyT: "toggleDrive",
  KeyL: "toggleLock",
  KeyP: "togglePause",
  KeyH: "toggleHelp",
  KeyK: "toggleDisk",
  KeyB: "toggleSky",
  KeyG: "cycleQuality",
  BracketLeft: "slower",
  BracketRight: "faster",
  Enter: "restart",
  Digit1: "preset1",
  Digit2: "preset2",
  Digit3: "preset3",
  Digit4: "preset4",
};

/** Collects keyboard, pointer and wheel input and turns it into per-frame controls. */
export class Input {
  private readonly held = new Set<string>();
  private readonly virtualHeld = new Set<string>();
  private dragX = 0;
  private dragY = 0;
  private wheel = 0;
  private activePointer: number | null = null;

  constructor(
    private readonly surface: HTMLElement,
    private readonly onCommand: (command: Command) => void,
  ) {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", (event) => this.held.delete(event.code));
    window.addEventListener("blur", () => this.held.clear());

    surface.addEventListener("pointerdown", (event) => {
      if (this.activePointer !== null) return;
      this.activePointer = event.pointerId;
      surface.setPointerCapture(event.pointerId);
    });
    surface.addEventListener("pointermove", (event) => {
      if (event.pointerId !== this.activePointer) return;
      this.dragX += event.movementX;
      this.dragY += event.movementY;
    });
    const release = (event: PointerEvent): void => {
      if (event.pointerId === this.activePointer) this.activePointer = null;
    };
    surface.addEventListener("pointerup", release);
    surface.addEventListener("pointercancel", release);
    surface.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.wheel += event.deltaY;
      },
      { passive: false },
    );
  }

  get dragging(): boolean {
    return this.activePointer !== null;
  }

  /** Hold a key from an on-screen button. */
  setVirtualKey(code: string, down: boolean): void {
    if (down) this.virtualHeld.add(code);
    else this.virtualHeld.delete(code);
  }

  /** Accumulated wheel movement since the last call, in pixels. */
  takeWheel(): number {
    const value = this.wheel;
    this.wheel = 0;
    return value;
  }

  /** Controls for a frame lasting `dt` seconds, with the camera seeing `fovY` radians vertically. */
  sample(dt: number, fovY: number): ControlInput {
    const axis = (positive: string, negative: string): number =>
      (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0);

    // Dragging grabs the sky: the point under the cursor follows it.
    const radiansPerPixel = fovY / Math.max(1, this.surface.clientHeight);
    const yaw = this.dragX * radiansPerPixel + axis("ArrowLeft", "ArrowRight") * KEY_TURN_RATE * dt;
    const pitch = this.dragY * radiansPerPixel + axis("ArrowUp", "ArrowDown") * KEY_TURN_RATE * dt;
    this.dragX = 0;
    this.dragY = 0;

    return {
      thrust: [axis("KeyD", "KeyA"), axis("KeyR", "KeyF"), axis("KeyW", "KeyS")],
      boost: this.isDown("ShiftLeft") || this.isDown("ShiftRight"),
      yaw,
      pitch,
      roll: axis("KeyE", "KeyQ") * KEY_ROLL_RATE * dt,
    };
  }

  private isDown(code: string): boolean {
    return this.held.has(code) || this.virtualHeld.has(code);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof HTMLElement && event.target.closest("button, a, input")) {
      // Let focused controls handle their own activation keys.
      if (event.code === "Space" || event.code === "Enter") return;
    }
    if (PREVENT_DEFAULT.has(event.code)) event.preventDefault();
    if (!event.repeat) {
      const command = COMMAND_KEYS[event.code];
      if (command) this.onCommand(command);
    }
    this.held.add(event.code);
  };
}
