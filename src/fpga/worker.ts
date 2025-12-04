import { runIcepack, runNextpnrIce40 } from '@yowasp/nextpnr-ice40';
import { runYosys } from '@yowasp/yosys';
import { IWorkerJobData, IWorkerMessage, WorkerMessageType } from './worker-types';
import pcfFile from './verilog/tt_fpga_fabricfox.pcf?raw';
import fpgaTopVerilog from './verilog/tt_fpga_top.v?raw';

function postMessageToMain(message: IWorkerMessage) {
  postMessage(message);
}

function postCommandOutput(stream: 'stdout' | 'stderr', bytes: Uint8Array) {
  postMessageToMain({
    type: WorkerMessageType.OutputMessage,
    stream,
    data: new TextDecoder().decode(bytes),
  });
}

async function main(data: IWorkerJobData) {
  const sourceFileNames = Object.keys(data.sources);
  const yosysArgs = [
    '-l',
    'yosys.log',
    '-DSYNTH',
    '-p',
    `synth_ice40 -top tt_fpga_top -json output.json`,
    'top.v',
    ...sourceFileNames,
  ];
  const yosysFiles = {
    ...data.sources,
    'top.v': fpgaTopVerilog.replace('__tt_um_placeholder', data.topModule),
  };
  postMessageToMain({ type: WorkerMessageType.Command, command: 'yosys', args: yosysArgs });
  const yosysResult = await runYosys(yosysArgs, yosysFiles, {
    stdout: (bytes) => bytes && postCommandOutput('stdout', bytes),
    stderr: (bytes) => bytes && postCommandOutput('stderr', bytes),
  });
  if (!yosysResult) {
    postMessageToMain({ type: WorkerMessageType.Error, message: 'Yosys failed' });
    return;
  }

  const nextPnrArgs = [
    '--pcf-allow-unconstrained',
    '--seed',
    '10',
    '--freq',
    '48',
    '--package',
    'sg48',
    '--up5k',
    '--asc',
    'output.asc',
    '--pcf',
    'fpga.pcf',
    '--json',
    'output.json',
  ];
  const nextpnrFiles = {
    'fpga.pcf': pcfFile,
    'output.json': yosysResult['output.json'] ?? '{}',
  };
  postMessageToMain({
    type: WorkerMessageType.Command,
    command: 'nextpnr-ice40',
    args: nextPnrArgs,
  });
  const nextpnrResult = await runNextpnrIce40(nextPnrArgs, nextpnrFiles, {
    stdout: (bytes) => bytes && postCommandOutput('stdout', bytes),
    stderr: (bytes) => bytes && postCommandOutput('stderr', bytes),
  });
  if (!nextpnrResult) {
    postMessageToMain({ type: WorkerMessageType.Error, message: 'nextpnr failed' });
    return;
  }

  const icepackArgs = ['output.asc', 'output.bin'];
  postMessageToMain({ type: WorkerMessageType.Command, command: 'icepack', args: icepackArgs });
  const icepackFiles = {
    'output.asc': nextpnrResult?.['output.asc'] ?? '',
  };
  const icepackResult = await runIcepack(icepackArgs, icepackFiles, {
    stdout: (bytes) => bytes && postCommandOutput('stdout', bytes),
    stderr: (bytes) => bytes && postCommandOutput('stderr', bytes),
  });
  if (!icepackResult) {
    postMessageToMain({ type: WorkerMessageType.Error, message: 'icepack failed' });
    return;
  }

  const bitstreamFile = icepackResult['output.bin'];
  if (bitstreamFile && bitstreamFile instanceof Uint8Array) {
    postMessageToMain({
      type: WorkerMessageType.BitStream,
      data: bitstreamFile,
    });
  } else {
    postMessageToMain({ type: WorkerMessageType.Error, message: 'Bitstream not found' });
    console.warn('no bitstream or not a Uint8Array', bitstreamFile);
  }
}

addEventListener('message', async (event) => {
  try {
    await main(event.data);
  } catch (error: any) {
    console.error(error);
    postMessageToMain({ type: WorkerMessageType.Error, message: error.toString() });
  }
});
