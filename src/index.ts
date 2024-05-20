import * as monaco from 'monaco-editor';
import { examples } from './examples';
import { HDLModuleJS } from './sim/hdlruntime';
import { compileVerilator } from './verilator/compile';
import { FPSCounter } from './FPSCounter';

const codeEditorDiv = document.getElementById('code-editor');
const editor = monaco.editor.create(codeEditorDiv!, {
  value: examples[0].sources['project.v'],
  language: 'systemverilog',
  scrollBeyondLastLine: false,
  minimap: {
    enabled: false,
  },
});

const res = await compileVerilator({
  topModule: examples[0].topModule,
  sources: examples[0].sources,
});
if (!res.output) {
  console.log(res.errors);
  throw new Error('Compile error');
}

// const jmod = new HDLModuleWASM(res.output.modules['TOP'], res.output.modules['@CONST-POOL@']);
let jmod = new HDLModuleJS(res.output.modules['TOP'], res.output.modules['@CONST-POOL@']);
await jmod.init();

function reset() {
  jmod.powercycle();
  jmod.state.ena = 1;
  jmod.state.rst_n = 0;
  jmod.tick2(10);
  jmod.state.rst_n = 1;
}
reset();

function getVGASignals() {
  const uo_out = jmod.state.uo_out as number;
  return {
    hsync: !!(uo_out & 0b10000000),
    vsync: !!(uo_out & 0b00001000),
    r: ((uo_out & 0b00000001) << 1) | ((uo_out & 0b00010000) >> 4),
    g: ((uo_out & 0b00000010) << 0) | ((uo_out & 0b00100000) >> 5),
    b: ((uo_out & 0b00000100) >> 1) | ((uo_out & 0b01000000) >> 6),
  };
}

let stopped = false;
const fpsCounter = new FPSCounter();

editor.onDidChangeModelContent(async () => {
  stopped = true;
  const sources = {
    ...examples[0].sources,
    'project.v': editor.getValue(),
  };
  const res = await compileVerilator({
    topModule: examples[0].topModule,
    sources: sources,
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
  jmod = new HDLModuleJS(res.output.modules['TOP'], res.output.modules['@CONST-POOL@']);
  jmod.init();
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
    counter++;
  }
}

function animationFrame(now: number) {
  requestAnimationFrame(animationFrame);

  fpsCounter.update(now);

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
      const { hsync, vsync, r, g, b } = getVGASignals();
      if (hsync) {
        break;
      }
      if (vsync) {
        break frameLoop;
      }
      data[offset] = r << 6;
      data[offset + 1] = g << 6;
      data[offset + 2] = b << 6;
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
    editor.setValue(example.sources['project.v']);
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
