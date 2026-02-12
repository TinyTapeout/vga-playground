import { VerilogXMLParser } from '../sim/vxmlparser';
import { ErrorParser } from './ErrorParser';
import verilator_bin from './verilator_bin';

let browserWasmBin: ArrayBuffer | null = null;

export interface ICompileOptions {
  topModule: string;
  sources: Record<string, string>;
  wasmBinary?: ArrayBuffer | Buffer;
}

export async function compileVerilator(opts: ICompileOptions) {
  let wasmBinary = opts.wasmBinary;
  if (!wasmBinary) {
    if (!browserWasmBin) {
      const { default: wasmUrl } = await import('./verilator_bin.wasm?url');
      browserWasmBin = await fetch(wasmUrl).then((res) => res.arrayBuffer());
    }
    wasmBinary = browserWasmBin ?? undefined;
  }

  const errorParser = new ErrorParser();

  const verilatorInst = verilator_bin({
    wasmBinary,
    noInitialRun: true,
    noExitRuntime: true,
    print: console.log,
    printErr: (message: string) => {
      console.log(message);
      errorParser.feedLine(message);
    },
  });
  await verilatorInst.ready;
  const { FS } = verilatorInst;

  let sourceList: string[] = [];
  FS.mkdir('src');
  for (const [name, source] of Object.entries(opts.sources)) {
    const path = `src/${name}`;
    sourceList.push(path);
    FS.writeFile(path, source);
  }
  const xmlPath = `obj_dir/V${opts.topModule}.xml`;
  try {
    const args = [
      '--cc',
      '-O3',
      '-Wall',
      '-Wno-EOFNEWLINE',
      '-Wno-DECLFILENAME',
      '--x-assign',
      'fast',
      '--debug-check', // for XML output
      '-Isrc/',
      '--top-module',
      opts.topModule,
      ...sourceList,
    ];
    verilatorInst.callMain(args);
  } catch (e) {
    console.log(e);
    errorParser.errors.push({
      type: 'error',
      file: '',
      line: 1,
      column: 1,
      message: 'Compilation failed: ' + e,
    });
  }

  if (errorParser.errors.filter((e) => e.type === 'error').length) {
    return { errors: errorParser.errors };
  }

  const xmlParser = new VerilogXMLParser();
  try {
    const xmlContent = FS.readFile(xmlPath, { encoding: 'utf8' });
    xmlParser.parse(xmlContent);
  } catch (e) {
    console.log(e, (e as Error).stack);

    return {
      errors: [
        ...errorParser.errors,
        {
          type: 'error' as const,
          file: '',
          line: 1,
          column: 1,
          message: 'XML parsing failed: ' + e,
        },
      ],
    };
  }
  return {
    errors: errorParser.errors,
    output: xmlParser,
  };
}
