import * as monaco from 'monaco-editor';
import { FPSCounter } from './FPSCounter';
import { examples } from './examples';
import { exportProject } from './exportProject';
import { HDLModuleWASM } from './sim/hdlwasm';
import { compileVerilator } from './verilator/compile';
import { AudioPlayer } from './AudioPlayer';

let currentProject = structuredClone(examples[0]);

const inputButtons = Array.from(document.querySelectorAll('#input-values button'));

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

const uo_out_offset_in_jmod_databuf = jmod.globals.lookup("uo_out").offset;
const uio_out_offset_in_jmod_databuf = jmod.globals.lookup("uio_out").offset;
const uio_oe_offset_in_jmod_databuf = jmod.globals.lookup("uio_oe").offset;

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

const expectedFPS = 60;
const sampleRate = 48_000*4;// @TODO: 192000 high sampleRate might not be supported on all platforms
                            // downsample to 48000 inside the AudioResamplerProcessor
                            // Empirically higher sampling rate helps with occasional high pitch noise.
const audioPlayer = new AudioPlayer(sampleRate, expectedFPS);

const vgaClockRate = 25_175_000;
const ticksPerSample = vgaClockRate / sampleRate;

let audioTickCounter = 0;
let audioSample = 0;
let lowPassFilter = 0;
let alphaLowPass20kHzAdjustedToFPS = 1.0;
function updateAudio() {
  const alpha = alphaLowPass20kHzAdjustedToFPS;
  // @TODO: optimize the following line, floating operations here are currently slow!
  lowPassFilter = alpha*lowPassFilter + (1.0-alpha)*getAudioSignal();
  audioSample += lowPassFilter;
  if (++audioTickCounter < ticksPerSample)
    return;
  audioPlayer.feed(audioSample / ticksPerSample, fpsCounter.getFPS());
  audioTickCounter = 0;
  audioSample = 0;
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
    }))
  );
  if (!res.output) {
    return;
  }
  if (jmod) {
    jmod.dispose();
  }
  inputButtons.map((b) => b.classList.remove('active'));
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

  // Need to simulate low pass filter of Audio PMOD
  // with a likely cutoff around 20 kHz
  // 
  // Time constant tau = 1 / (2 * π * cutoff_freq) = 1/(2*π* 20kHz) ~ 1 / 125664
  //                                               = 1/(2*π*100kHz) ~ 1 / 628318
  // Sampling period Ts = (1 / sampling_freq)      = 1/25MHz        ~ 1 / 25175000
  // Alpha = tau / (tau + Ts) = 1 / (1 + tau / Ts)
  const alphaLowPass10kHz  = 0.998  // = 1 / (1 +  62832/25175000)  ~ 1 / 1.002
  const alphaLowPass20kHz  = 0.995  // = 1 / (1 + 125664/25175000)  ~ 1 / 1.005
  const alphaLowPass100kHz = 0.9756 // = 1 / (1 + 628318/25175000)  ~ 1 / 1.025
  alphaLowPass20kHzAdjustedToFPS = 1.0 / (1.0 + 0.005 * (fpsCounter.getFPS()/expectedFPS));

  if (fpsDisplay) {
    fpsDisplay.textContent = `${fpsCounter.getFPS().toFixed(0)}`;
  }

  if (stopped || !imageData || !ctx) {
    return;
  }

  const data = new Uint8Array(imageData.data.buffer);
  frameLoop: for (let y = 0; y < 520; y++) {
    waitFor(() => !getVGASignals().hsync);
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
  if (index === 8) {
    audioPlayer.resume();
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
});

inputButtons.forEach((button, index) => {
  button.addEventListener('click', () => toggleButton(index));
});
