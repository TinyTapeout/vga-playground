export interface InputControllerOptions {
  inputButtons: HTMLButtonElement[];
  gamepadPmodButtons: HTMLButtonElement[];
  gamepadPmodDiv: HTMLElement;
  isAudioRunning: () => boolean;
  resumeAudio: () => void;
  suspendAudio: () => void;
  getUiIn: () => number;
  setUiIn: (v: number) => void;
  onReset: () => void;
}

const gamepadPmodInputMask = 0b01110000;
const gamepadPmodInputPins = [4, 5, 6];
const gamepadPmodKeys: Record<string, number> = {
  a: 8,
  ArrowDown: 5,
  ArrowLeft: 6,
  ArrowRight: 7,
  ArrowUp: 4,
  b: 0,
  l: 10,
  r: 11,
  s: 2, // select
  t: 3, // start
  x: 9,
  y: 1,
};

export class InputController {
  private readonly inputButtons: HTMLButtonElement[];
  private readonly audioButtonIndex: number;
  private readonly gamepadButtonIndex: number;
  private readonly gamepadPmodButtons: HTMLButtonElement[];
  private readonly gamepadPmodButtonsMap: Map<number, HTMLButtonElement>;
  private readonly gamepadPmodDiv: HTMLElement;
  private readonly isAudioRunning: () => boolean;
  private readonly resumeAudio: () => void;
  private readonly suspendAudio: () => void;
  private readonly getUiIn: () => number;
  private readonly setUiIn: (v: number) => void;
  private readonly onReset: () => void;

  private enableGamepadPmod = false;
  private gamepadPmodValue = 0;
  private gamepadPmodCounter = 0;

  private readonly keydownHandler: (e: KeyboardEvent) => void;
  private readonly keyupHandler: (e: KeyboardEvent) => void;

  constructor(opts: InputControllerOptions) {
    this.inputButtons = opts.inputButtons;
    this.audioButtonIndex = opts.inputButtons.findIndex((e) => e.dataset.role === 'audio');
    this.gamepadButtonIndex = opts.inputButtons.findIndex((e) => e.dataset.role === 'gamepad');
    this.gamepadPmodButtons = opts.gamepadPmodButtons;
    this.gamepadPmodButtonsMap = new Map(
      opts.gamepadPmodButtons.map((b) => [parseInt(b.dataset.index!, 10), b]),
    );
    this.gamepadPmodDiv = opts.gamepadPmodDiv;
    this.isAudioRunning = opts.isAudioRunning;
    this.resumeAudio = opts.resumeAudio;
    this.suspendAudio = opts.suspendAudio;
    this.getUiIn = opts.getUiIn;
    this.setUiIn = opts.setUiIn;
    this.onReset = opts.onReset;

    this.inputButtons.forEach((button, index) => {
      button.addEventListener('click', () => this.toggleButton(index));
    });

    this.gamepadPmodButtons.forEach((button) => {
      const index = parseInt(button.dataset.index!, 10);
      const mouseDown = () => {
        this.gamepadPmodValue = this.gamepadPmodValue | (1 << index);
        button.classList.add('active');
      };
      const mouseUp = () => {
        this.gamepadPmodValue = this.gamepadPmodValue & ~(1 << index);
        button.classList.remove('active');
      };
      button.addEventListener('mousedown', mouseDown);
      button.addEventListener('pointerdown', mouseDown);
      button.addEventListener('mouseup', mouseUp);
      button.addEventListener('pointerup', mouseUp);
    });

    this.keydownHandler = (e: KeyboardEvent) => {
      if ('R' === e.key || (!this.enableGamepadPmod && 'r' === e.key)) {
        this.onReset();
      }
      if (['0', '1', '2', '3', '4', '5', '6', '7'].includes(e.key)) {
        this.toggleButton(parseInt(e.key, 10));
      }

      const gamepadPmodIndex = gamepadPmodKeys[e.key];
      if (this.enableGamepadPmod && gamepadPmodIndex != null) {
        this.gamepadPmodValue = this.gamepadPmodValue | (1 << gamepadPmodIndex);
        this.gamepadPmodButtonsMap.get(gamepadPmodIndex)?.classList.add('active');
      }
    };

    this.keyupHandler = (e: KeyboardEvent) => {
      const gamepadPmodIndex = gamepadPmodKeys[e.key];
      if (this.enableGamepadPmod && gamepadPmodIndex != null) {
        this.gamepadPmodValue = this.gamepadPmodValue & ~(1 << gamepadPmodIndex);
        this.gamepadPmodButtonsMap.get(gamepadPmodIndex)?.classList.remove('active');
      }
    };

    document.addEventListener('keydown', this.keydownHandler);
    document.addEventListener('keyup', this.keyupHandler);
  }

  private toggleButton(index: number) {
    if (index === this.audioButtonIndex) {
      if (this.isAudioRunning()) this.suspendAudio();
      else this.resumeAudio();
      return;
    }
    if (index === this.gamepadButtonIndex) {
      this.enableGamepadPmod = !this.enableGamepadPmod;
      if (this.enableGamepadPmod) {
        this.inputButtons[this.gamepadButtonIndex].classList.add('active');
      } else {
        this.inputButtons[this.gamepadButtonIndex].classList.remove('active');
      }
      for (const pin of gamepadPmodInputPins) {
        this.inputButtons[pin].disabled = this.enableGamepadPmod;
      }
      this.gamepadPmodDiv.style.display = this.enableGamepadPmod ? 'block' : 'none';
      return;
    }
    const bit = 1 << index;
    this.setUiIn(this.getUiIn() ^ bit);
    if (this.getUiIn() & bit) {
      this.inputButtons[index].classList.add('active');
    } else {
      this.inputButtons[index].classList.remove('active');
    }
  }

  updateGamepadPmod() {
    if (!this.enableGamepadPmod) return;
    const cycle = this.gamepadPmodCounter++ % 400;
    const dataReg = this.gamepadPmodValue << 12; // the lower 12 bits are for a second game controller
    const pulses = 24;
    const clock = cycle < pulses * 2 ? cycle % 2 : 0;
    const dataIndex = cycle < pulses * 2 + 1 ? cycle >> 1 : 0;
    const data = (dataReg >> dataIndex) & 1;
    const latch = cycle === pulses * 2 + 1 ? 1 : 0;
    const gamepadPmodPins = (data << 6) | (clock << 5) | (latch << 4);
    this.setUiIn((this.getUiIn() & ~gamepadPmodInputMask) | gamepadPmodPins);
  }

  updateAudioButton() {
    if (this.isAudioRunning()) {
      this.inputButtons[this.audioButtonIndex].classList.add('active');
    } else {
      this.inputButtons[this.audioButtonIndex].classList.remove('active');
    }
  }

  resetButtonStates() {
    this.inputButtons.forEach((b) => b.classList.remove('active'));
    this.updateAudioButton();
  }

  dispose() {
    document.removeEventListener('keydown', this.keydownHandler);
    document.removeEventListener('keyup', this.keyupHandler);
  }
}
