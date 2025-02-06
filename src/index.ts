import * as monaco from 'monaco-editor';
import { AudioPlayer } from './AudioPlayer';
import { FPSCounter } from './FPSCounter';
import { examples } from './examples';
import { exportProject } from './exportProject';
import { HDLModuleWASM } from './sim/hdlwasm';
import { compileVerilator } from './verilator/compile';

let currentProject = structuredClone(examples[0]);

const inputButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('#input-values button'),
);
const audioButtonIndex = inputButtons.findIndex((e) => e.dataset.role === 'audio');
const gamepadButtonIndex = inputButtons.findIndex((e) => e.dataset.role === 'gamepad');
let enableGamepadPmod = false;
let gamepadPmodValue = 0;
const gamepadPmodInputMask = 0b01110000;
const gamepadPmodInputPins = [4, 5, 6];
const gamepadPmodInputDiv = document.getElementById('gamepad-pmod-inputs');
const gamepadPmodInputButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('#gamepad-pmod-inputs button'),
);
const gamepadPmodInputButtonsMap = new Map(
  gamepadPmodInputButtons.map((b) => [parseInt(b.dataset.index!, 10), b]),
);
const gamepadPmodKeys = {
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

const codeEditorDiv = document.getElementById('code-editor');
const editor = monaco.editor.create(codeEditorDiv!, {
  value: currentProject.sources['project.v'],
  language: 'systemverilog',
  scrollBeyondLastLine: false,
  minimap: {
    enabled: false,
  },
});

const res = await compileVerilator({
  topModule: currentProject.topModule,
  sources: currentProject.sources,
});
if (!res.output) {
  console.log(res.errors);
  throw new Error('Compile error');
}

let jmod = new HDLModuleWASM(res.output.modules['TOP'], res.output.modules['@CONST-POOL@']);
//let jmod = new HDLModuleJS(res.output.modules['TOP'], res.output.modules['@CONST-POOL@']);
await jmod.init();

const uo_out_offset_in_jmod_databuf = jmod.globals.lookup('uo_out').offset;
const uio_out_offset_in_jmod_databuf = jmod.globals.lookup('uio_out').offset;
const uio_oe_offset_in_jmod_databuf = jmod.globals.lookup('uio_oe').offset;

function reset() {
  const ui_in = jmod.state.ui_in;
  jmod.powercycle();
  jmod.state.ena = 1;
  jmod.state.rst_n = 0;
  jmod.state.ui_in = ui_in;
  jmod.tick2(10);
  jmod.state.rst_n = 1;
}
reset();

function getVGASignals() {
  // it is significanly faster to read 'uo_out' value directly from the jmod data buffer
  // instead of jmod.state.uo_out acccessor property
  // see HDLModuleWASM.defineProperty() implementation for inner details on how accessor works
  const uo_out = jmod.data8[uo_out_offset_in_jmod_databuf];

  return {
    hsync: !!(uo_out & 0b10000000),
    vsync: !!(uo_out & 0b00001000),
    r: ((uo_out & 0b00000001) << 1) | ((uo_out & 0b00010000) >> 4),
    g: ((uo_out & 0b00000010) << 0) | ((uo_out & 0b00100000) >> 5),
    b: ((uo_out & 0b00000100) >> 1) | ((uo_out & 0b01000000) >> 6),
  };
}

function getAudioSignal() {
  // see getVGASignals() implementation above for explanation about use of jmod.data8
  const uio_out = jmod.data8[uio_out_offset_in_jmod_databuf];
  const uio_oe = jmod.data8[uio_oe_offset_in_jmod_databuf];
  return (uio_out & uio_oe) >> 7;
}

const sampleRate = 192_000; // 192 kHz -- higher number gives a better quality
const audioPlayer = new AudioPlayer(sampleRate, () => {
  if (audioPlayer.isRunning()) inputButtons[audioButtonIndex].classList.add('active');
  else inputButtons[audioButtonIndex].classList.remove('active');
});
let enableAudioUpdate = audioPlayer.needsFeeding();

const vgaClockRate = 25_175_000; // 25.175 MHz -- VGA pixel clock
const ticksPerSample = vgaClockRate / sampleRate;

const lowPassFrequency = 20_000; // 20 kHz -- Audio PMOD low pass filter
const lowPassFilterSize = Math.ceil(sampleRate / lowPassFrequency);

let audioTickCounter = 0;
let audioSample = 0;

let sampleQueueForLowPassFiter = new Float32Array(lowPassFilterSize);
let sampleQueueIndex = 0;

function updateAudio() {
  if (!enableAudioUpdate) return;

  audioSample += getAudioSignal();
  if (++audioTickCounter < ticksPerSample) return;

  const newSample = audioSample / ticksPerSample;

  sampleQueueForLowPassFiter[sampleQueueIndex++] = newSample;
  sampleQueueIndex %= lowPassFilterSize;
  let filteredSample = sampleQueueForLowPassFiter[0];
  for (let i = 1; i < lowPassFilterSize; i++) filteredSample += sampleQueueForLowPassFiter[i];

  audioPlayer.feed(filteredSample / lowPassFilterSize, fpsCounter.getFPS());
  audioTickCounter = 0;
  audioSample = 0;
}

let gamepadPmodCounter = 0;
function updateGamepadPmod() {
  if (!enableGamepadPmod) return;
  const cycle = gamepadPmodCounter++ % 400;
  const dataReg = gamepadPmodValue << 12; // the lower 12 bits are for a second game controller
  const pulses = 24;
  const clock = cycle < pulses * 2 ? cycle % 2 : 0;
  const dataIndex = cycle < pulses * 2 + 1 ? cycle >> 1 : 0;
  const data = (dataReg >> dataIndex) & 1;
  const latch = cycle === pulses * 2 + 1 ? 1 : 0;
  const gamepadPmodPins = (data << 6) | (clock << 5) | (latch << 4);
  jmod.state.ui_in = (jmod.state.ui_in & ~gamepadPmodInputMask) | gamepadPmodPins;
}

let stopped = false;
const fpsCounter = new FPSCounter();

editor.onDidChangeModelContent(async () => {
  stopped = true;
  currentProject.sources = {
    ...currentProject.sources,
    'project.v': editor.getValue(),
  };
  const res = await compileVerilator({
    topModule: currentProject.topModule,
    sources: currentProject.sources,
  });
  monaco.editor.setModelMarkers(
    editor.getModel()!,
    'error',
    res.errors.map((e) => ({
      startLineNumber: e.line,
      endLineNumber: e.line,
      startColumn: e.column,
      endColumn: e.endColumn ?? 999,
      message: e.message,
      severity: e.type === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
    })),
  );
  if (!res.output) {
    return;
  }
  if (jmod) {
    jmod.dispose();
  }
  inputButtons.map((b) => b.classList.remove('active'));
  if (audioPlayer.isRunning()) inputButtons[audioButtonIndex].classList.add('active');
  jmod = new HDLModuleWASM(res.output.modules['TOP'], res.output.modules['@CONST-POOL@']);
  await jmod.init();
  reset();
  fpsCounter.reset();
  stopped = false;
});

const canvas = document.querySelector<HTMLCanvasElement>('#vga-canvas');
const ctx = canvas?.getContext('2d');
const imageData = ctx?.createImageData(736, 520);
const fpsDisplay = document.querySelector('#fps-count');
const audioLatencyDisplay = document.querySelector('#audio-latency-ms');

function waitFor(condition: () => boolean, timeout = 10000) {
  let counter = 0;
  while (!condition() && counter < timeout) {
    jmod.tick2(1);
    updateAudio();
    counter++;
  }
}

function animationFrame(now: number) {
  requestAnimationFrame(animationFrame);

  fpsCounter.update(now);

  if (fpsDisplay) {
    fpsDisplay.textContent = `${fpsCounter.getFPS().toFixed(0)}`;
  }

  if (audioLatencyDisplay) {
    audioLatencyDisplay.textContent = `${audioPlayer.latencyInMilliseconds.toFixed(0)}`;
  }

  if (stopped || !imageData || !ctx) {
    return;
  }

  enableAudioUpdate = audioPlayer.needsFeeding();
  const data = new Uint8Array(imageData.data.buffer);
  frameLoop: for (let y = 0; y < 520; y++) {
    waitFor(() => !getVGASignals().hsync);
    updateGamepadPmod();
    for (let x = 0; x < 736; x++) {
      const offset = (y * 736 + x) * 4;
      jmod.tick2(1);
      updateAudio();
      const { hsync, vsync, r, g, b } = getVGASignals();
      if (hsync) {
        break;
      }
      if (vsync) {
        break frameLoop;
      }
      data[offset] = r * 85;
      data[offset + 1] = g * 85;
      data[offset + 2] = b * 85;
      data[offset + 3] = 0xff;
    }
    waitFor(() => getVGASignals().hsync);
  }
  ctx!.putImageData(imageData, 0, 0);
  waitFor(() => getVGASignals().vsync);
  waitFor(() => !getVGASignals().vsync);
}

requestAnimationFrame(animationFrame);

const buttons = document.querySelector('#preset-buttons');
for (const example of examples) {
  const button = document.createElement('button');
  button.textContent = example.name;
  button.addEventListener('click', async () => {
    currentProject = structuredClone(example);
    editor.setValue(currentProject.sources['project.v']);
  });
  buttons?.appendChild(button);
}

window.addEventListener('resize', () => {
  editor.layout();
});

window.addEventListener('visibilitychange', () => {
  const now = performance.now();
  if (document.hidden) {
    fpsCounter.pause(now);
  } else {
    fpsCounter.resume(now);
  }
});

document.querySelector('#download-button')?.addEventListener('click', () => {
  exportProject(currentProject);
});

function toggleButton(index: number) {
  if (index === audioButtonIndex) {
    if (audioPlayer.isRunning()) audioPlayer.suspend();
    else audioPlayer.resume();
    return;
  }
  if (index === gamepadButtonIndex) {
    enableGamepadPmod = !enableGamepadPmod;
    if (enableGamepadPmod) {
      inputButtons[gamepadButtonIndex].classList.add('active');
    } else {
      inputButtons[gamepadButtonIndex].classList.remove('active');
    }
    for (const pin of gamepadPmodInputPins) {
      inputButtons[pin].disabled = enableGamepadPmod;
    }
    gamepadPmodInputDiv!.style.display = enableGamepadPmod ? 'block' : 'none';
    return;
  }
  const bit = 1 << index;
  jmod.state.ui_in = jmod.state.ui_in ^ bit;
  if (jmod.state.ui_in & bit) {
    inputButtons[index].classList.add('active');
  } else {
    inputButtons[index].classList.remove('active');
  }
}

document.addEventListener('keydown', (e) => {
  if ('r' === e.key) {
    reset();
  }
  if (['0', '1', '2', '3', '4', '5', '6', '7'].includes(e.key)) {
    toggleButton(parseInt(e.key, 10));
  }

  const gamepadPmodIndex = gamepadPmodKeys[e.key];
  if (enableGamepadPmod && gamepadPmodIndex != null) {
    gamepadPmodValue = gamepadPmodValue | (1 << gamepadPmodIndex);
    gamepadPmodInputButtonsMap.get(gamepadPmodIndex)?.classList.add('active');
  }
});

document.addEventListener('keyup', (e) => {
  const gamepadPmodIndex = gamepadPmodKeys[e.key];
  if (enableGamepadPmod && gamepadPmodIndex != null) {
    gamepadPmodValue = gamepadPmodValue & ~(1 << gamepadPmodIndex);
    gamepadPmodInputButtonsMap.get(gamepadPmodIndex)?.classList.remove('active');
  }
});

inputButtons.forEach((button, index) => {
  button.addEventListener('click', () => toggleButton(index));
});

gamepadPmodInputButtons.forEach((button) => {
  const index = parseInt(button.dataset.index!, 10);
  const mouseDown = () => {
    gamepadPmodValue = gamepadPmodValue | (1 << index);
    button.classList.add('active');
  };
  const mouseUp = () => {
    gamepadPmodValue = gamepadPmodValue & ~(1 << index);
    button.classList.remove('active');
  };
  button.addEventListener('mousedown', mouseDown);
  button.addEventListener('pointerdown', mouseDown);
  button.addEventListener('mouseup', mouseUp);
  button.addEventListener('pointerup', mouseUp);
});
