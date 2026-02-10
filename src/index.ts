import * as monaco from 'monaco-editor';
import { AudioPlayer } from './AudioPlayer';
import { FPSCounter } from './FPSCounter';
import { examples } from './examples';
import { exportProject } from './exportProject';
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
import { compileVerilator } from './verilator/compile';
import { detectTopModule } from './verilog';

let currentProject = structuredClone(examples[0]);
let currentFileName = 'project.v';

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

const fileTabsContainer = document.getElementById('file-tabs')!;

const tabContextMenu = document.createElement('div');
tabContextMenu.className = 'tab-context-menu';
tabContextMenu.style.display = 'none';
document.body.appendChild(tabContextMenu);

document.addEventListener('click', () => {
  tabContextMenu.style.display = 'none';
});

function showTabContextMenu(e: MouseEvent, fileName: string) {
  e.preventDefault();
  tabContextMenu.innerHTML = '';

  const renameItem = document.createElement('div');
  renameItem.textContent = 'Rename';
  renameItem.className = 'tab-context-menu-item';
  renameItem.addEventListener('click', () => {
    const newName = prompt('Rename file:', fileName);
    if (!newName || newName === fileName) return;
    if (!newName.endsWith('.v')) {
      alert('File name must end with .v');
      return;
    }
    if (currentProject.sources[newName] != null) {
      alert('A file with that name already exists');
      return;
    }
    const content = currentProject.sources[fileName];
    delete currentProject.sources[fileName];
    currentProject.sources[newName] = content;
    if (currentFileName === fileName) {
      currentFileName = newName;
    }
    renderFileTabs();
  });
  tabContextMenu.appendChild(renameItem);

  const fileCount = Object.keys(currentProject.sources).length;
  if (fileCount > 1) {
    const deleteItem = document.createElement('div');
    deleteItem.textContent = 'Delete';
    deleteItem.className = 'tab-context-menu-item';
    deleteItem.addEventListener('click', () => {
      if (!confirm(`Delete "${fileName}"?`)) return;
      delete currentProject.sources[fileName];
      if (currentFileName === fileName) {
        currentFileName = Object.keys(currentProject.sources)[0];
        editor.setValue(currentProject.sources[currentFileName]);
      }
      renderFileTabs();
    });
    tabContextMenu.appendChild(deleteItem);
  }

  tabContextMenu.style.display = 'block';
  tabContextMenu.style.left = `${e.clientX}px`;
  tabContextMenu.style.top = `${e.clientY}px`;
}

function switchToFile(fileName: string) {
  currentProject.sources[currentFileName] = editor.getValue();
  currentFileName = fileName;
  editor.setValue(currentProject.sources[currentFileName]);
  renderFileTabs();
  updateEditorMarkers();
}

function renderFileTabs() {
  fileTabsContainer.innerHTML = '';
  for (const fileName of Object.keys(currentProject.sources)) {
    const tab = document.createElement('button');
    tab.textContent = fileName;
    if (fileName === currentFileName) {
      tab.classList.add('active');
    }
    tab.addEventListener('click', () => {
      if (fileName !== currentFileName) {
        switchToFile(fileName);
      }
    });
    tab.addEventListener('contextmenu', (e) => showTabContextMenu(e, fileName));
    fileTabsContainer.appendChild(tab);
  }
  const addBtn = document.createElement('button');
  addBtn.textContent = '+';
  addBtn.classList.add('add-file');
  addBtn.title = 'Add new file';
  addBtn.addEventListener('click', () => {
    const name = prompt('New file name (must end with .v):', 'new_module.v');
    if (!name) return;
    if (!name.endsWith('.v')) {
      alert('File name must end with .v');
      return;
    }
    if (currentProject.sources[name] != null) {
      alert('A file with that name already exists');
      return;
    }
    currentProject.sources[currentFileName] = editor.getValue();
    currentProject.sources[name] = '';
    currentFileName = name;
    editor.setValue('');
    renderFileTabs();
  });
  fileTabsContainer.appendChild(addBtn);
}

renderFileTabs();

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

type MarkerData = monaco.editor.IMarkerData;
const markersPerFile: Record<string, MarkerData[]> = {};

function toMarker(e: {
  line: number;
  column: number;
  endColumn?: number;
  message: string;
  type: string;
}): MarkerData {
  return {
    startLineNumber: e.line,
    endLineNumber: e.line,
    startColumn: e.column,
    endColumn: e.endColumn ?? 999,
    message: e.message,
    severity: e.type === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
  };
}

function updateEditorMarkers() {
  const markers = markersPerFile[currentFileName] ?? [];
  monaco.editor.setModelMarkers(editor.getModel()!, 'error', markers);
}

editor.onDidChangeModelContent(async () => {
  stopped = true;
  currentProject.sources[currentFileName] = editor.getValue();
  const res = await compileVerilator({
    topModule: detectTopModule(currentProject.sources),
    sources: currentProject.sources,
  });
  for (const key of Object.keys(markersPerFile)) {
    delete markersPerFile[key];
  }
  for (const e of res.errors) {
    const file = e.file;
    if (!markersPerFile[file]) {
      markersPerFile[file] = [];
    }
    markersPerFile[file].push(toMarker(e));
  }
  updateEditorMarkers();
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
const imageData = ctx?.createImageData(VGA_WIDTH, VGA_HEIGHT);
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
  renderVGAFrame(jmod, data, {
    polarity: syncPolarity,
    onTick: updateAudio,
    onLine: updateGamepadPmod,
  });
  ctx!.putImageData(imageData, 0, 0);
  waitFor(() => getVGASignals().vsync);
  waitFor(() => !getVGASignals().vsync);
}

requestAnimationFrame(animationFrame);

let activePresetButton: HTMLButtonElement | null = null;
const presetButtonsContainer = document.querySelector('#preset-buttons');
for (const example of examples) {
  const button = document.createElement('button');
  button.textContent = example.name;
  button.addEventListener('click', async () => {
    activePresetButton?.classList.remove('active');
    button.classList.add('active');
    activePresetButton = button;
    button.scrollIntoView({ behavior: 'smooth', inline: 'nearest' });
    currentProject = structuredClone(example);
    currentFileName = 'project.v';
    editor.setValue(currentProject.sources['project.v']);
    renderFileTabs();
  });
  presetButtonsContainer?.appendChild(button);
}
// Mark first preset as active
const firstPresetButton = presetButtonsContainer?.querySelector('button');
if (firstPresetButton) {
  firstPresetButton.classList.add('active');
  activePresetButton = firstPresetButton;
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
  if ('R' === e.key || (!enableGamepadPmod && 'r' === e.key)) {
    reset();
  }
  if (['0', '1', '2', '3', '4', '5', '6', '7'].includes(e.key)) {
    toggleButton(parseInt(e.key, 10));
  }

  const gamepadPmodIndex = (gamepadPmodKeys as Record<string, number | undefined>)[e.key];
  if (enableGamepadPmod && gamepadPmodIndex != null) {
    gamepadPmodValue = gamepadPmodValue | (1 << gamepadPmodIndex);
    gamepadPmodInputButtonsMap.get(gamepadPmodIndex)?.classList.add('active');
  }
});

document.addEventListener('keyup', (e) => {
  const gamepadPmodIndex = (gamepadPmodKeys as Record<string, number | undefined>)[e.key];
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
