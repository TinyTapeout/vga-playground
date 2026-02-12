import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { AudioEngine } from './AudioEngine';
import { examples } from './examples';
import { exportProject } from './exportProject';
import { FPSCounter } from './FPSCounter';
import { loadProjectFromRepo } from './github/loadProject';
import { InputController } from './InputController';
import { HDLModuleDef } from './sim/hdltypes';
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
import { initErrorOverlay } from './ui/ErrorOverlay';
import { FileTabs } from './ui/FileTabs';
import { initPresetBar } from './ui/PresetBar';
import { compileVerilator } from './verilator/compile';
import { detectTopModule } from './verilog';

self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

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

const firstFileName = Object.keys(currentProject.sources)[0];

const editor = monaco.editor.create(codeEditorDiv, {
  value: currentProject.sources[firstFileName],
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
fileTabs.currentFileName = firstFileName;
fileTabs.render();

const errorOverlay = initErrorOverlay(document.getElementById('error-overlay')!);

// Simulation state
let jmod: HDLModuleWASM | null = null;
let uo_out_offset = 0;
let uio_out_offset = 0;
let uio_oe_offset = 0;
let syncPolarity: SyncPolarity = { hsyncActiveLow: false, vsyncActiveLow: false };
let stopped = true;

function reset() {
  if (!jmod) return;
  resetModule(jmod);
  syncPolarity = detectSyncPolarity(jmod);
  resetModule(jmod);
}

async function initModule(modules: Record<string, HDLModuleDef>) {
  if (jmod) jmod.dispose();
  jmod = new HDLModuleWASM(modules['TOP'], modules['@CONST-POOL@']);
  await jmod.init();
  jmod.getFileData = (path) => currentProject.dataFiles?.[path];
  uo_out_offset = jmod.globals.lookup('uo_out').offset;
  uio_out_offset = jmod.globals.lookup('uio_out').offset;
  uio_oe_offset = jmod.globals.lookup('uio_oe').offset;
  reset();
}

// Initial compile
const res = await compileVerilator({
  topModule: detectTopModule(currentProject.sources),
  sources: currentProject.sources,
});
fileTabs.updateMarkers(res.errors);

if (res.output) {
  try {
    await initModule(res.output.modules);
    stopped = false;
  } catch (e) {
    errorOverlay.show('Simulation Error', e instanceof Error ? e.message : String(e));
  }
} else {
  errorOverlay.showCompileErrors(res.errors);
}

function getVGASignals() {
  // it is significanly faster to read 'uo_out' value directly from the jmod data buffer
  // instead of jmod.state.uo_out acccessor property
  // see HDLModuleWASM.defineProperty() implementation for inner details on how accessor works
  return decodeVGAOutput(jmod!.data8[uo_out_offset], syncPolarity);
}

function getAudioSignal() {
  // see getVGASignals() implementation above for explanation about use of jmod.data8
  const uio_out = jmod!.data8[uio_out_offset];
  const uio_oe = jmod!.data8[uio_oe_offset];
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
  getUiIn: () => jmod?.state.ui_in ?? 0,
  setUiIn: (v) => {
    if (jmod) jmod.state.ui_in = v;
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

editor.onDidChangeModelContent(async () => {
  stopped = true;
  currentProject.sources[fileTabs.currentFileName] = editor.getValue();
  const res = await compileVerilator({
    topModule: detectTopModule(currentProject.sources),
    sources: currentProject.sources,
  });
  fileTabs.updateMarkers(res.errors);
  if (!res.output) {
    errorOverlay.showCompileErrors(res.errors);
    return;
  }
  errorOverlay.hide();
  inputController.resetButtonStates();
  try {
    await initModule(res.output.modules);
  } catch (e) {
    errorOverlay.show('Simulation Error', e instanceof Error ? e.message : String(e));
    return;
  }
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
    jmod!.tick2(1);
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
  renderVGAFrame(jmod!, data, {
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
    const first = Object.keys(currentProject.sources)[0];
    fileTabs.currentFileName = first;
    editor.setValue(currentProject.sources[first]);
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
