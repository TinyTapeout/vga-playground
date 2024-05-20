import { VerilogXMLParser } from '../sim/vxmlparser';
import { ErrorParser, IErrorMessage } from './ErrorParser';
import verilator_bin from './verilator_bin';
import verilator_wasm from './verilator_bin.wasm?url';

const verilator_wasm_bin = await fetch(verilator_wasm).then((res) => res.arrayBuffer());

export interface ICompileOptions {
  topModule: string;
  sources: Record<string, string>;
}

export async function compileVerilator(opts: ICompileOptions) {
  const errorParser = new ErrorParser();

  const verilatorInst = verilator_bin({
    wasmBinary: verilator_wasm_bin,
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
    console.log(e, e.stack);

    return {
      errors: [
        ...errorParser.errors,
        { file: '', line: 1, column: 1, message: 'XML parsing failed: ' + e } as IErrorMessage,
      ],
    };
  }
  return {
    errors: errorParser.errors,
    output: xmlParser,
  };
}
