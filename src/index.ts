import * as monaco from 'monaco-editor';
import { AudioEngine } from './AudioEngine';
import { FPSCounter } from './FPSCounter';
import { InputController } from './InputController';
import { examples } from './examples';
import { exportProject } from './exportProject';
import { loadProjectFromRepo } from './github/loadProject';
import { HDLModuleWASM } from './sim/hdlwasm';
import {
  decodeVGAOutput,
  detectSyncPolarity,
  renderVGAFrame,
  resetModule,
  SyncPolarity,
  VGA_HEIGHT,
  VGA_WIDTH,
} from './sim/vga';
import { FileTabs } from './ui/FileTabs';
import { initPresetBar } from './ui/PresetBar';
import { compileVerilator } from './verilator/compile';
import { detectTopModule } from './verilog';

let currentProject = structuredClone(examples[0]);

const params = new URLSearchParams(window.location.search);
const repoParam = params.get('repo');
const presetParam = params.get('preset');

const codeEditorDiv = document.getElementById('code-editor')!;

if (repoParam) {
  codeEditorDiv.textContent = 'Loading project from GitHub...';
  try {
    currentProject = await loadProjectFromRepo(repoParam);
  } catch (e) {
    console.error('Failed to load project from URL:', e);
  }
} else if (presetParam) {
  const match = examples.find((ex) => ex.id === presetParam);
  if (match) {
    currentProject = structuredClone(match);
  }
}

const editor = monaco.editor.create(codeEditorDiv, {
  value: currentProject.sources['project.v'],
  language: 'systemverilog',
  scrollBeyondLastLine: false,
  minimap: {
    enabled: false,
  },
});

const fileTabs = new FileTabs({
  container: document.getElementById('file-tabs')!,
  editorModel: editor.getModel()!,
  getSources: () => currentProject.sources,
  getEditorValue: () => editor.getValue(),
  setEditorValue: (v) => editor.setValue(v),
});
fileTabs.render();

const res = await compileVerilator({
  topModule: detectTopModule(currentProject.sources),
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

let syncPolarity: SyncPolarity = { hsyncActiveLow: false, vsyncActiveLow: false };

function reset() {
  resetModule(jmod);
  syncPolarity = detectSyncPolarity(jmod);
  resetModule(jmod);
}
reset();

function getVGASignals() {
  // it is significanly faster to read 'uo_out' value directly from the jmod data buffer
  // instead of jmod.state.uo_out acccessor property
  // see HDLModuleWASM.defineProperty() implementation for inner details on how accessor works
  return decodeVGAOutput(jmod.data8[uo_out_offset_in_jmod_databuf], syncPolarity);
}

function getAudioSignal() {
  // see getVGASignals() implementation above for explanation about use of jmod.data8
  const uio_out = jmod.data8[uio_out_offset_in_jmod_databuf];
  const uio_oe = jmod.data8[uio_oe_offset_in_jmod_databuf];
  return (uio_out & uio_oe) >> 7;
}

const sampleRate = 192_000; // 192 kHz -- higher number gives a better quality
const vgaClockRate = 25_175_000; // 25.175 MHz -- VGA pixel clock
const fpsCounter = new FPSCounter();

let audioEngine!: AudioEngine;
const inputController = new InputController({
  inputButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('#input-values button')),
  gamepadPmodButtons: Array.from(
    document.querySelectorAll<HTMLButtonElement>('#gamepad-pmod-inputs button'),
  ),
  gamepadPmodDiv: document.getElementById('gamepad-pmod-inputs')!,
  isAudioRunning: () => audioEngine.isRunning(),
  resumeAudio: () => audioEngine.resume(),
  suspendAudio: () => audioEngine.suspend(),
  getUiIn: () => jmod.state.ui_in,
  setUiIn: (v) => {
    jmod.state.ui_in = v;
  },
  onReset: reset,
});

audioEngine = new AudioEngine(
  sampleRate,
  vgaClockRate,
  getAudioSignal,
  () => fpsCounter.getFPS(),
  () => inputController.updateAudioButton(),
);

let stopped = false;

editor.onDidChangeModelContent(async () => {
  stopped = true;
  currentProject.sources[fileTabs.currentFileName] = editor.getValue();
  const res = await compileVerilator({
    topModule: detectTopModule(currentProject.sources),
    sources: currentProject.sources,
  });
  fileTabs.updateMarkers(res.errors);
  if (!res.output) {
    return;
  }
  if (jmod) {
    jmod.dispose();
  }
  inputController.resetButtonStates();
  jmod = new HDLModuleWASM(res.output.modules['TOP'], res.output.modules['@CONST-POOL@']);
  await jmod.init();
  reset();
  fpsCounter.reset();
  stopped = false;
});

const canvas = document.querySelector<HTMLCanvasElement>('#vga-canvas');
const ctx = canvas?.getContext('2d');
const imageData = ctx?.createImageData(VGA_WIDTH, VGA_HEIGHT);
const fpsDisplay = document.querySelector('#fps-count');
const audioLatencyDisplay = document.querySelector('#audio-latency-ms');

function waitFor(condition: () => boolean, timeout = 10000) {
  let counter = 0;
  while (!condition() && counter < timeout) {
    jmod.tick2(1);
    audioEngine.update();
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
    audioLatencyDisplay.textContent = `${audioEngine.latencyMs.toFixed(0)}`;
  }

  if (stopped || !imageData || !ctx) {
    return;
  }

  audioEngine.enablePerTickUpdate = audioEngine.needsFeeding;
  const data = new Uint8Array(imageData.data.buffer);
  renderVGAFrame(jmod, data, {
    polarity: syncPolarity,
    onTick: () => audioEngine.update(),
    onLine: () => inputController.updateGamepadPmod(),
  });
  ctx!.putImageData(imageData, 0, 0);
  waitFor(() => getVGASignals().vsync);
  waitFor(() => !getVGASignals().vsync);
}

requestAnimationFrame(animationFrame);

const presetBar = initPresetBar({
  container: document.querySelector('#preset-buttons')!,
  examples,
  initialPreset: !repoParam ? presetParam ?? examples[0].id : undefined,
  onSelect: (example) => {
    currentProject = structuredClone(example);
    fileTabs.currentFileName = 'project.v';
    editor.setValue(currentProject.sources['project.v']);
    fileTabs.render();
  },
});

if (repoParam) {
  presetBar.clearActive();
}

let resizeTimeout: ReturnType<typeof setTimeout>;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => editor.layout(), 100);
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
