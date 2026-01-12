import binaryen from 'binaryen';
import { HDLError } from './hdlruntime';
import {
  hasDataType,
  HDLBinop,
  HDLBlock,
  HDLConstant,
  HDLDataType,
  HDLExpr,
  HDLExtendop,
  HDLFuncCall,
  HDLLogicType,
  HDLModuleDef,
  HDLModuleRunner,
  HDLSourceObject,
  HDLTriop,
  HDLUnop,
  HDLVariableDef,
  HDLVarRef,
  HDLWhileOp,
  isArrayItem,
  isArrayType,
  isBigConstExpr,
  isBinop,
  isBlock,
  isConstExpr,
  isFuncCall,
  isLogicType,
  isTriop,
  isUnop,
  isVarDecl,
  isVarRef,
  isWhileop,
} from './hdltypes';

const VERILATOR_UNIT_FUNCTIONS = [
  '_ctor_var_reset',
  '_eval_initial',
  '_eval_settle',
  '_eval',
  '_change_request',
];

interface Options {
  store?: boolean;
  funcblock?: HDLBlock;
  funcarg?: boolean;
  resulttype?: number;
}

const GLOBALOFS = 0;
const MEMORY = '$$MEM';
const GLOBAL = '$$GLOBAL';
const CHANGEDET = '$$CHANGE';
const TRACERECLEN = '$$treclen';
const TRACEOFS = '$$tofs';
const TRACEEND = '$$tend';
const TRACEBUF = '$$tbuf';

///

function getDataTypeSize(dt: HDLDataType): number {
  if (isLogicType(dt)) {
    if (dt.left <= 7) return 1;
    else if (dt.left <= 15) return 2;
    else if (dt.left <= 31) return 4;
    else if (dt.left <= 63) return 8;
    else return (dt.left >> 6) * 8 + 8; // 64-bit words
  } else if (isArrayType(dt)) {
    // TODO: additional padding for array?
    return (Math.abs(dt.high.cvalue - dt.low.cvalue) + 1) * getDataTypeSize(dt.subtype);
  } else {
    throw new HDLError(dt, `don't know data type`);
  }
}

function isReferenceType(dt: HDLDataType): boolean {
  return getDataTypeSize(dt) > 8;
}

function getArrayElementSizeFromType(dtype: HDLDataType): number {
  if (isArrayType(dtype)) {
    return getArrayElementSizeFromType(dtype.subtype);
  } else {
    return getDataTypeSize(dtype);
  }
}

function getArrayElementSizeFromExpr(e: HDLExpr): number {
  if (hasDataType(e) && isArrayType(e.dtype)) {
    return getDataTypeSize(e.dtype.subtype);
  } else if (hasDataType(e) && isLogicType(e.dtype) && e.dtype.left > 63) {
    throw new HDLError(e, `elements > 64 bits not supported`);
  }
  throw new HDLError(e, `cannot figure out array element size`);
}

function getArrayValueSize(e: HDLExpr): number {
  return getDataTypeSize(getArrayValueType(e));
}

function getArrayValueType(e: HDLExpr): HDLDataType {
  if (isVarRef(e)) {
    var dt = e.dtype;
    while (isArrayType(dt)) dt = dt.subtype;
    return dt;
  } else if (isBinop(e) && e.op == 'arraysel') {
    return getArrayValueType(e.left);
  } else if (isBinop(e) && e.op == 'wordsel') {
    return getArrayValueType(e.left);
  }
  throw new HDLError(e, `cannot figure out array value type`);
}

function getAlignmentForSize(size) {
  if (size <= 1) return 1;
  else if (size <= 2) return 2;
  else if (size <= 4) return 4;
  else return 8;
}

function getBinaryenType(size: number) {
  if (size <= 4) return binaryen.i32;
  else if (size <= 8) return binaryen.i64;
  else return binaryen.none;
}

/**
 * Check if a data type is wider than 64 bits
 */
function isWideType(dt: HDLDataType): boolean {
  return isLogicType(dt) && dt.left > 63;
}

/**
 * Get the number of 32-bit chunks needed for a data type
 */
function getNumChunks(dt: HDLDataType): number {
  if (isLogicType(dt)) {
    return Math.ceil((dt.left + 1) / 32);
  }
  throw new HDLError(dt, `cannot get chunk count for non-logic type`);
}

interface StructRec {
  name: string;
  type: HDLDataType;
  offset: number;
  size: number;
  itype: number;
  index: number;
  init: HDLBlock;
  constval: HDLConstant;
  reset: boolean;
}

class Struct {
  parent: Struct;
  len: number = 0;
  vars: { [name: string]: StructRec } = {};
  locals: StructRec[] = [];
  params: StructRec[] = [];

  addVar(vardef: HDLVariableDef) {
    var size = getDataTypeSize(vardef.dtype);
    var rec = this.addEntry(vardef.name, size, getBinaryenType(size), vardef.dtype, false);
    rec.init = vardef.initValue;
    rec.constval = vardef.constValue;
    return rec;
  }

  alignTo(align: number): void {
    while (this.len % align) this.len++;
  }

  addEntry(
    name: string,
    size: number,
    itype?: number,
    hdltype?: HDLDataType,
    isParam?: boolean,
  ): StructRec {
    this.alignTo(getAlignmentForSize(size));
    // pointers are 32 bits, so if size > 8 it's a pointer
    var rec: StructRec = {
      name: name,
      type: hdltype,
      size: size,
      itype: itype,
      index: this.params.length + this.locals.length,
      offset: this.len,
      init: null,
      constval: null,
      reset: false,
    };
    this.len += size;
    if (rec.name != null) this.vars[rec.name] = rec;
    if (isParam) this.params.push(rec);
    else this.locals.push(rec);
    return rec;
  }

  getLocals() {
    var vars = [];
    for (const rec of this.locals) {
      vars.push(rec.itype);
    }
    return vars;
  }

  lookup(name: string): StructRec {
    return this.vars[name];
  }
}

///

export class HDLModuleWASM implements HDLModuleRunner {
  bmod: binaryen.Module;
  instance: WebAssembly.Instance;

  hdlmod: HDLModuleDef;
  constpool: HDLModuleDef;
  globals: Struct;
  locals: Struct;
  databuf: Buffer;
  data8: Uint8Array;
  data16: Uint16Array;
  data32: Uint32Array;
  getFileData = null;
  maxMemoryMB: number;
  optimize: boolean = false;
  maxEvalIterations: number = 8;

  state: any;
  statebytes: number;
  outputbytes: number;

  traceBufferSize: number = 0xff000;
  traceRecordSize: number;
  traceReadOffset: number;
  traceStartOffset: number;
  traceEndOffset: number;
  trace: any;

  randomizeOnReset: boolean = false;
  finished: boolean;
  stopped: boolean;
  resetStartTimeMsec: number;

  _tick2: (ofs: number, iters: number) => void;

  constructor(moddef: HDLModuleDef, constpool: HDLModuleDef, maxMemoryMB?: number) {
    this.hdlmod = moddef;
    this.constpool = constpool;
    this.maxMemoryMB = maxMemoryMB || 16;
    this.genMemory();
    this.genFuncs();
    this.validate();
  }

  async init() {
    await this.genModule();
    this.genStateInterface();
    this.enableTracing();
    this.cacheFunctions();
  }

  initSync() {
    this.genModuleSync();
    this.genStateInterface();
    this.enableTracing();
    this.cacheFunctions();
  }

  private cacheFunctions() {
    // Cache the tick2 function for performance:
    this._tick2 = (this.instance.exports as any).tick2;
  }

  powercycle() {
    // TODO: merge w/ JS runtime
    this.resetStartTimeMsec = new Date().getTime() - 1;
    this.finished = false;
    this.stopped = false;
    this.clearMutableState();
    this.setInitialValues();
    (this.instance.exports as any)._ctor_var_reset(GLOBALOFS);
    (this.instance.exports as any)._eval_initial(GLOBALOFS);
    for (var i = 0; i < 100; i++) {
      (this.instance.exports as any)._eval_settle(GLOBALOFS);
      (this.instance.exports as any)._eval(GLOBALOFS);
      var Vchange = (this.instance.exports as any)._change_request(GLOBALOFS);
      if (!Vchange) {
        return;
      }
    }
    throw new HDLError(null, `model did not converge on reset()`);
  }

  eval() {
    (this.instance.exports as any).eval(GLOBALOFS);
  }

  tick() {
    this.state.clk ^= 1;
    this.eval();
  }

  tick2(iters: number) {
    this._tick2(GLOBALOFS, iters);
  }

  isFinished() {
    return this.finished;
  }

  isStopped() {
    return this.stopped;
  }

  saveState() {
    return { o: this.data8.slice(0, this.statebytes) };
  }

  loadState(state) {
    this.data8.set(state.o as Uint8Array);
  }

  // get tree of global variables for debugging
  getGlobals() {
    var g = {};
    for (const [varname, vardef] of Object.entries(this.hdlmod.vardefs)) {
      var o = g;
      var toks = varname.split('$');
      for (var tok of toks.slice(0, -1)) {
        o[tok] = o[tok] || {};
        o = o[tok];
      }
      o[toks[toks.length - 1]] = this.state[varname];
    }
    return g;
  }

  enableTracing() {
    if (this.outputbytes == 0) throw new Error(`outputbytes == 0`);
    if (this.outputbytes % 8) throw new Error(`outputbytes must be 8-byte aligned`);
    if (this.traceBufferSize % 8) throw new Error(`trace buffer size must be 8-byte aligned`);
    this.traceStartOffset = this.globals.lookup(TRACEBUF).offset;
    this.traceEndOffset = this.traceStartOffset + this.traceBufferSize - this.outputbytes;
    this.state[TRACEEND] = this.traceEndOffset;
    this.state[TRACERECLEN] = this.outputbytes;
    this.resetTrace();
    //console.log(this.state[TRACEOFS], this.state[TRACERECLEN], this.state[TRACEEND]);
    this.trace = this.makeScopeProxy(() => {
      return this.traceReadOffset;
    });
  }

  resetTrace() {
    this.traceReadOffset = this.traceStartOffset;
    this.state[TRACEOFS] = this.traceStartOffset;
  }

  nextTrace() {
    this.traceReadOffset += this.outputbytes;
    if (this.traceReadOffset >= this.traceEndOffset) this.traceReadOffset = this.traceStartOffset;
  }

  getTraceRecordSize() {
    return this.traceRecordSize;
  }

  dispose() {
    if (this.bmod) {
      this.bmod.dispose();
      this.bmod = null;
      this.instance = null;
      this.databuf = null;
      this.data8 = null;
      this.data16 = null;
      this.data32 = null;
    }
  }

  //

  private genMemory() {
    this.bmod = new binaryen.Module();
    this.bmod.setFeatures(binaryen.Features.SignExt);
    this.genTypes();
    var membytes = this.globals.len;
    if (membytes > this.maxMemoryMB * 1024 * 1024)
      throw new HDLError(
        null,
        `cannot allocate ${membytes} bytes, limit is ${this.maxMemoryMB} MB`,
      );
    var memblks = Math.ceil(membytes / 65536);
    this.bmod.setMemory(memblks, memblks, MEMORY); // memory is in 64k chunks
  }

  private genTypes() {
    // generate global variables
    var state = new Struct();
    this.globals = state;
    // separate vars and constants
    var vardefs = Object.values(this.hdlmod.vardefs).filter((vd) => vd.constValue == null);
    var constdefs = Object.values(this.hdlmod.vardefs).filter((vd) => vd.constValue != null);
    // sort globals by output flag and size
    function getVarDefSortKey(vdef: HDLVariableDef) {
      var val = getDataTypeSize(vdef.dtype); // sort by size
      if (!vdef.isOutput) val += 1000000; // outputs are first in list
      return val;
    }
    vardefs.sort((a, b) => {
      return getVarDefSortKey(a) - getVarDefSortKey(b);
    });
    // outputs are contiguous so we can copy them to the trace buffer
    // so we put them all first in the struct order
    for (var vardef of vardefs) {
      if (vardef.isOutput) state.addVar(vardef);
    }
    if (state.len == 0) state.addEntry('___', 1); // ensure as least 8 output bytes for trace buffer
    state.alignTo(8);
    this.outputbytes = state.len;
    // followed by inputs and internal vars (arrays after logical types)
    for (var vardef of vardefs) {
      if (!vardef.isOutput) state.addVar(vardef);
    }
    state.alignTo(8);
    this.statebytes = state.len;
    // followed by constants and constant pool
    if (this.constpool) {
      for (const vardef of Object.values(constdefs)) {
        state.addVar(vardef);
      }
      for (const vardef of Object.values(this.constpool.vardefs)) {
        state.addVar(vardef);
      }
    }
    state.alignTo(8);
    // and now the trace buffer
    state.addEntry(TRACERECLEN, 4, binaryen.i32);
    state.addEntry(TRACEOFS, 4, binaryen.i32);
    state.addEntry(TRACEEND, 4, binaryen.i32);
    state.addEntry(TRACEBUF, this.traceBufferSize);
    this.traceRecordSize = this.outputbytes;
  }

  private genFuncs() {
    // function type (dsegptr)
    for (var block of this.hdlmod.blocks) {
      this.genFunction(block);
    }
    // export functions
    for (var fname of VERILATOR_UNIT_FUNCTIONS) {
      this.bmod.addFunctionExport(fname, fname);
    }
    // create helper functions
    this.addHelperFunctions();
    // link imported functions
    this.addImportedFunctions();
  }

  private validate() {
    // optimize wasm module (default passes crash binaryen.js)
    if (this.optimize) {
      var size = this.bmod.emitBinary().length;
      // TODO: more passes?
      // https://github.com/WebAssembly/binaryen/blob/369b8bdd3d9d49e4d9e0edf62e14881c14d9e352/src/passes/pass.cpp#L396
      this.bmod.runPasses([
        'dce',
        'optimize-instructions',
        'precompute',
        'simplify-locals',
        'simplify-globals',
        'rse',
        'vacuum' /*,'dae-optimizing','inlining-optimizing'*/,
      ]);
      var optsize = this.bmod.emitBinary().length;
      console.log('optimize', size, '->', optsize);
    }
    // validate wasm module
    if (!this.bmod.validate()) {
      //console.log(this.bmod.emitText());
      throw new HDLError(null, `could not validate wasm module`);
    }
  }

  private genFunction(block) {
    // TODO: cfuncs only
    var fnname = block.name;
    // find locals of function
    var fscope = new Struct();
    fscope.addEntry(GLOBAL, 4, binaryen.i32, null, true); // 1st param to function
    // add __req local if change_request function
    if (this.funcResult(block.name) == binaryen.i32) {
      fscope.addEntry(CHANGEDET, 1, binaryen.i32, null, false);
    }
    this.pushScope(fscope);
    block.exprs.forEach((e) => {
      if (e && isVarDecl(e)) {
        // TODO: make local reference types, instead of promoting local arrays to global
        if (isReferenceType(e.dtype)) {
          this.globals.addVar(e);
        } else {
          fscope.addVar(e);
        }
      }
    });
    // create function body
    var fbody = this.block2wasm(block, { funcblock: block });
    //var fbody = this.bmod.return(this.bmod.i32.const(0));
    var fret = this.funcResult(block.name);
    var fsig = binaryen.createType([binaryen.i32]); // pass dataptr()
    var fref = this.bmod.addFunction(fnname, fsig, fret, fscope.getLocals(), fbody);
    this.popScope();
  }

  private async genModule() {
    var wasmData = this.bmod.emitBinary();
    var compiled = await WebAssembly.compile(wasmData);
    this.instance = await WebAssembly.instantiate(compiled, this.getImportObject());
  }

  private genModuleSync() {
    var wasmData = this.bmod.emitBinary();
    var compiled = new WebAssembly.Module(wasmData);
    this.instance = new WebAssembly.Instance(compiled, this.getImportObject());
  }

  private genStateInterface() {
    this.databuf = (this.instance.exports[MEMORY] as any).buffer;
    this.data8 = new Uint8Array(this.databuf);
    this.data16 = new Uint16Array(this.databuf);
    this.data32 = new Uint32Array(this.databuf);
    // proxy object to access globals (starting from 0)
    this.state = this.makeScopeProxy(() => {
      return 0;
    });
  }

  private defineProperty(proxy, basefn: () => number, vref: StructRec) {
    var _this = this;
    // precompute some things
    var elsize = vref.type && getArrayElementSizeFromType(vref.type);
    var eltype = vref.type;
    while (eltype && isArrayType(eltype)) {
      eltype = eltype.subtype;
    }
    var mask = -1; // set all bits
    if (eltype && isLogicType(eltype) && eltype.left < 31) {
      mask = (1 << (eltype.left + 1)) - 1; // set partial bits
    }
    // Check if this is a wide type (> 64 bits) for BigInt handling
    var isWide = vref.type && isLogicType(vref.type) && vref.type.left > 63;
    var numChunks = isWide ? Math.ceil(((vref.type as HDLLogicType).left + 1) / 32) : 0;
    // Compute BigInt mask for wide types
    var bigMask = isWide ? (1n << BigInt((vref.type as HDLLogicType).left + 1)) - 1n : 0n;
    // define get/set on proxy object
    Object.defineProperty(proxy, vref.name, {
      get() {
        let base = basefn();
        if (vref.type && isArrayType(vref.type)) {
          // TODO: can't mask unused bits in array
          if (elsize == 1) {
            return new Uint8Array(_this.databuf, base + vref.offset, vref.size);
          } else if (elsize == 2) {
            return new Uint16Array(_this.databuf, (base >> 1) + vref.offset, vref.size >> 1);
          } else if (elsize == 4) {
            return new Uint32Array(_this.databuf, (base >> 2) + vref.offset, vref.size >> 2);
          }
        } else {
          if (vref.size == 1) {
            return _this.data8[base + vref.offset];
          } else if (vref.size == 2) {
            return _this.data16[(base + vref.offset) >> 1];
          } else if (vref.size == 4) {
            return _this.data32[(base + vref.offset) >> 2];
          } else if (isWide) {
            // Wide type: read 32-bit chunks and combine into BigInt
            let result = 0n;
            const startIdx = (base + vref.offset) >> 2;
            for (let i = 0; i < numChunks; i++) {
              result |= BigInt(_this.data32[startIdx + i]) << BigInt(i * 32);
            }
            return result & bigMask;
          }
        }
        return new Uint32Array(_this.databuf, (base >> 2) + vref.offset, vref.size >> 2);
      },
      set(value) {
        var base = basefn();
        if (vref.size == 1) {
          _this.data8[base + vref.offset] = value & mask;
          return true;
        } else if (vref.size == 2) {
          _this.data16[(base + vref.offset) >> 1] = value & mask;
          return true;
        } else if (vref.size == 4) {
          _this.data32[(base + vref.offset) >> 2] = value & mask;
          return true;
        } else if (isWide) {
          // Wide type: break BigInt into 32-bit chunks and store
          let bigValue = BigInt(value) & bigMask;
          const startIdx = (base + vref.offset) >> 2;
          for (let i = 0; i < numChunks; i++) {
            _this.data32[startIdx + i] = Number(bigValue & 0xffffffffn);
            bigValue >>= 32n;
          }
          return true;
        } else {
          throw new HDLError(vref, `can't set property ${vref.name}`);
        }
      },
      enumerable: true,
      configurable: false,
    });
  }

  private makeScopeProxy(basefn: () => number): {} {
    var proxy = Object.create(null); // no inherited properties
    for (var vref of Object.values(this.globals.vars)) {
      if (vref != null) this.defineProperty(proxy, basefn, vref);
    }
    return proxy;
  }

  setInitialValues() {
    for (var rec of this.globals.locals) {
      this.setInitialValue(rec);
    }
  }

  private setInitialValue(rec: StructRec) {
    var arr = this.state[rec.name];
    if (rec.init) {
      if (!arr) throw new HDLError(rec, `no array to init`);
      for (let i = 0; i < rec.init.exprs.length; i++) {
        let e = rec.init.exprs[i];
        if (isArrayItem(e) && isConstExpr(e.expr)) {
          arr[e.index] = e.expr.cvalue;
        } else {
          throw new HDLError(
            e,
            `non-const expr in initarray (multidimensional arrays not supported)`,
          );
        }
      }
      //console.log(rec.name, rec.type, arr);
    } else if (rec.constval) {
      // Use cvalue if it's a number (even 0), otherwise use bigvalue for large constants
      this.state[rec.name] =
        typeof rec.constval.cvalue === 'number' ? rec.constval.cvalue : rec.constval.bigvalue;
    } else if (rec.type && rec.reset && this.randomizeOnReset) {
      if (isLogicType(rec.type) && typeof arr === 'number') {
        this.state[rec.name] = Math.random() * 4294967296; // don't need to mask
      } else if (isArrayType(rec.type) && isLogicType(rec.type.subtype)) {
        // array types are't mask-protected yet
        var mask = (1 << (rec.type.subtype.left + 1)) - 1;
        for (var i = 0; i < arr.length; i++) {
          arr[i] = (Math.random() * 4294967296) & mask;
        }
      } else {
        console.log(`could not reset ${rec.name}`);
      }
    }
  }

  clearMutableState() {
    this.data32.fill(0, 0, this.statebytes >> 2);
  }

  private addHelperFunctions() {
    this.addCopyTraceRecFunction();
    this.addEvalFunction();
    this.addTick2Function();
  }

  private addImportedFunctions() {
    this.bmod.addFunctionImport(
      '$finish_0',
      'builtins',
      '$finish',
      binaryen.createType([binaryen.i32]),
      binaryen.none,
    );
    this.bmod.addFunctionImport(
      '$stop_0',
      'builtins',
      '$stop',
      binaryen.createType([binaryen.i32]),
      binaryen.none,
    );
    this.bmod.addFunctionImport(
      '$time_0',
      'builtins',
      '$time',
      binaryen.createType([binaryen.i32]),
      binaryen.i64,
    );
    this.bmod.addFunctionImport(
      '$rand_0',
      'builtins',
      '$rand',
      binaryen.createType([binaryen.i32]),
      binaryen.i32,
    );
    this.bmod.addFunctionImport(
      '$readmem_2',
      'builtins',
      '$readmem',
      binaryen.createType([binaryen.i32, binaryen.i32, binaryen.i32]),
      binaryen.none,
    );
  }

  private getImportObject(): {} {
    var n = 0;
    return {
      // TODO: merge w/ JS runtime
      builtins: {
        $finish: (o) => {
          if (!this.finished) console.log('... Finished @', o);
          this.finished = true;
        },
        $stop: (o) => {
          if (!this.stopped) console.log('... Stopped @', o);
          this.stopped = true;
        },
        $time: (o) => BigInt(new Date().getTime() - this.resetStartTimeMsec), // TODO: timescale
        $rand: (o) => (Math.random() * (65536 * 65536)) | 0,
        $readmem: (o, a, b) => this.$readmem(a, b),
      },
    };
  }

  private $readmem(p_filename, p_rom) {
    var fn = '';
    for (var i = 0; i < 255; i++) {
      var charCode = this.data8[p_filename + i];
      if (charCode == 0) break;
      fn = String.fromCharCode(charCode) + fn;
    }
    var filedata = this.getFileData && this.getFileData(fn);
    if (filedata == null) throw new HDLError(fn, `no file "${fn}" for $readmem`);
    if (typeof filedata !== 'string')
      throw new HDLError(fn, `file "${fn}" must be lines of hex or binary values`);
    var ishex = !fn.endsWith('.binary'); // TODO: hex should be attribute in xml
    var data = filedata
      .split('\n')
      .filter((s) => s !== '')
      .map((s) => parseInt(s, ishex ? 16 : 2));
    for (var i = 0; i < data.length; i++) {
      this.data8[p_rom + i] = data[i];
    }
    return 0;
  }

  // create a new unique label
  labelseq = 0;
  private label(s?: string): string {
    return `@${s || 'label'}_${++this.labelseq}`;
  }

  private addCopyTraceRecFunction() {
    const m = this.bmod;
    const o_TRACERECLEN = this.globals.lookup(TRACERECLEN).offset;
    const o_TRACEOFS = this.globals.lookup(TRACEOFS).offset;
    const o_TRACEEND = this.globals.lookup(TRACEEND).offset;
    const o_TRACEBUF = this.globals.lookup(TRACEBUF).offset;
    var i32 = binaryen.i32;
    var none = binaryen.none;
    var l_block = this.label('@block');
    var l_loop = this.label('@loop');
    m.addFunction(
      'copyTraceRec',
      binaryen.createType([]),
      none,
      [i32, i32, i32], // src, len, dest
      m.block(l_block, [
        // $0 = 0 (start of globals)
        m.local.set(0, m.i32.const(GLOBALOFS)),
        // don't use $0 as data seg offset, assume trace buffer offsets start @ 0
        // $1 = TRACERECLEN
        m.local.set(1, m.i32.load(0, 4, m.i32.const(o_TRACERECLEN))),
        // $2 = TRACEOFS
        m.local.set(2, m.i32.load(0, 4, m.i32.const(o_TRACEOFS))),
        // while ($1--) [$0]++ = [$2]++
        m.loop(
          l_loop,
          m.block(null, [
            m.i64.store(0, 8, m.local.get(2, i32), m.i64.load(0, 8, m.local.get(0, i32))),
            m.local.set(0, m.i32.add(m.local.get(0, i32), m.i32.const(8))),
            m.local.set(2, m.i32.add(m.local.get(2, i32), m.i32.const(8))),
            m.local.set(1, m.i32.sub(m.local.get(1, i32), m.i32.const(8))),
            this.bmod.br_if(l_loop, m.local.get(1, i32)),
          ]),
        ),
        // TRACEOFS += TRACERECLEN
        m.i32.store(
          0,
          4,
          m.i32.const(o_TRACEOFS),
          m.i32.add(
            m.i32.load(0, 4, m.i32.const(o_TRACEOFS)),
            m.i32.load(0, 4, m.i32.const(o_TRACERECLEN)),
          ),
        ),
        // break if TRACEOFS < TRACEEND
        m.br_if(
          l_block,
          m.i32.lt_u(
            m.i32.load(0, 4, m.i32.const(o_TRACEOFS)),
            m.i32.load(0, 4, m.i32.const(o_TRACEEND)),
          ),
        ),
        // TRACEOFS = @TRACEBUF
        m.i32.store(0, 4, m.i32.const(o_TRACEOFS), m.i32.const(o_TRACEBUF)),
      ]),
    );
  }

  private addTick2Function() {
    const m = this.bmod;
    var l_loop = this.label('@loop');
    if (this.globals.lookup('clk')) {
      var v_dseg = m.local.get(0, binaryen.i32);
      //var v_count = m.local.get(1, binaryen.i32);
      m.addFunction(
        'tick2',
        binaryen.createType([binaryen.i32, binaryen.i32]),
        binaryen.none,
        [],
        m.loop(
          l_loop,
          m.block(null, [
            this.makeSetVariableFunction('clk', 0),
            m.drop(m.call('eval', [v_dseg], binaryen.i32)),
            this.makeSetVariableFunction('clk', 1),
            m.drop(m.call('eval', [v_dseg], binaryen.i32)),
            // call copyTraceRec
            m.call('copyTraceRec', [], binaryen.none),
            // goto @loop if ($1 = $1 - 1)
            m.br_if(
              l_loop,
              m.local.tee(1, m.i32.sub(m.local.get(1, binaryen.i32), m.i32.const(1)), binaryen.i32),
            ),
          ]),
        ),
      );
      m.addFunctionExport('tick2', 'tick2');
    } else {
      m.addFunctionExport('eval', 'tick2');
    }
  }

  private addEvalFunction() {
    this.bmod.addFunction(
      'eval',
      binaryen.createType([binaryen.i32]),
      binaryen.i32,
      [],
      this.makeTickFuncBody(0),
    );
    this.bmod.addFunctionExport('eval', 'eval');
  }

  private makeGetVariableFunction(name: string, value: number) {
    var dtype = this.globals.lookup(name).type;
    var src: HDLVarRef = { refname: name, dtype: dtype };
    return this.e2w(src);
  }

  private makeSetVariableFunction(name: string, value: number) {
    var dtype = this.globals.lookup(name).type;
    var dest: HDLVarRef = { refname: name, dtype: dtype };
    var src: HDLConstant = { cvalue: value, bigvalue: null, dtype: dtype };
    return this.assign2wasm(dest, src);
  }

  private makeTickFuncBody(count: number) {
    var dseg = this.bmod.local.get(0, binaryen.i32);
    if (count > this.maxEvalIterations) return this.bmod.i32.const(count);
    return this.bmod.block(
      null,
      [
        this.bmod.call('_eval', [dseg], binaryen.none),
        this.bmod.if(
          this.bmod.call('_change_request', [dseg], binaryen.i32),
          this.makeTickFuncBody(count + 1),
          this.bmod.return(this.bmod.local.get(0, binaryen.i32)),
        ),
      ],
      binaryen.i32,
    );
  }

  private funcResult(funcname: string) {
    // only _change functions return a result
    if (funcname.startsWith('_change_request')) return binaryen.i32;
    else if (funcname == '$time') return binaryen.i64;
    else if (funcname == '$rand') return binaryen.i32;
    else return binaryen.none;
  }

  private pushScope(scope: Struct) {
    scope.parent = this.locals;
    this.locals = scope;
  }

  private popScope() {
    this.locals = this.locals.parent;
  }

  private i3264(dt: HDLDataType) {
    var size = getDataTypeSize(dt);
    var type = getBinaryenType(size);
    if (type == binaryen.i32) return this.bmod.i32;
    else if (type == binaryen.i64) return this.bmod.i64;
    else throw new HDLError(dt, `data types > 64 bits not supported`);
  }

  private i3264rel(e: HDLBinop) {
    if (hasDataType(e.left) && hasDataType(e.right)) {
      var lsize = getDataTypeSize(e.left.dtype);
      var rsize = getDataTypeSize(e.right.dtype);
      if (lsize > rsize) return this.i3264(e.left.dtype);
      else return this.i3264(e.right.dtype);
    }
    throw new HDLError(e, `can't ${e.op} arguments`);
  }

  private dataptr(): number {
    return this.bmod.local.get(0, binaryen.i32); // 1st param of function == data ptr
  }

  private e2w(e: HDLExpr, opts?: Options): number {
    if (e == null) {
      return this.bmod.nop();
    } else if (isBlock(e)) {
      return this.block2wasm(e, opts);
    } else if (isVarDecl(e)) {
      return this.local2wasm(e, opts);
    } else if (isVarRef(e)) {
      return this.varref2wasm(e, opts);
    } else if (isConstExpr(e) || isBigConstExpr(e)) {
      return this.const2wasm(e, opts);
    } else if (isFuncCall(e)) {
      return this.funccall2wasm(e, opts);
    } else if (isUnop(e) || isBinop(e) || isTriop(e) || isWhileop(e)) {
      var n = `_${e.op}2wasm`;
      var fn = this[n];
      if (fn == null) {
        throw new HDLError(e, `no such method ${n}`);
      }
      return this[n](e, opts);
    } else {
      throw new HDLError(e, `could not translate expr`);
    }
  }

  block2wasm(e: HDLBlock, opts?: Options): number {
    var stmts = e.exprs.map((stmt) => this.e2w(stmt));
    var ret = opts && opts.funcblock ? this.funcResult(opts.funcblock.name) : binaryen.none;
    // must have return value for change_request function
    if (ret == binaryen.i32) {
      stmts.push(this.bmod.return(this.bmod.local.get(this.locals.lookup(CHANGEDET).index, ret)));
    }
    // return block value for loop condition
    if (opts && opts.resulttype) {
      ret = binaryen.i32;
    }
    return this.bmod.block(e.name, stmts, ret);
  }

  funccall2wasm(e: HDLFuncCall, opts?: Options): number {
    var args = [this.dataptr()];
    for (var arg of e.args) {
      args.push(this.e2w(arg, { funcarg: true }));
    }
    var internal = e.funcname;
    if (e.funcname.startsWith('$')) {
      if ((e.funcname == '$stop' || e.funcname == '$finish') && e.$loc) {
        args = [this.bmod.i32.const(e.$loc.line)]; // line # of source code
      }
      internal += '_' + (args.length - 1);
    }
    var ret = this.funcResult(e.funcname);
    return this.bmod.call(internal, args, ret);
  }

  const2wasm(e: HDLConstant, opts: Options): number {
    var size = getDataTypeSize(e.dtype);
    if (isLogicType(e.dtype)) {
      if (e.bigvalue != null) {
        let low = e.bigvalue & BigInt(0xffffffff);
        let high = (e.bigvalue >> BigInt(32)) & BigInt(0xffffffff);
        return this.i3264(e.dtype).const(Number(low), Number(high));
      } else if (size <= 4) return this.bmod.i32.const(e.cvalue | 0);
      else if (size <= 8) return this.bmod.i64.const(e.cvalue | 0, 0);
      else throw new HDLError(e, `constants > 64 bits not supported`);
    } else {
      throw new HDLError(e, `non-logic constants not supported`);
    }
  }

  varref2wasm(e: HDLVarRef, opts: Options): number {
    if (opts && opts.store) throw Error(`cannot store here`);
    var local = this.locals && this.locals.lookup(e.refname);
    var global = this.globals.lookup(e.refname);
    if (local != null) {
      return this.bmod.local.get(local.index, local.itype);
    } else if (global != null) {
      if (global.size > 8 && opts && opts.funcarg)
        return this.address2wasm(e); // TODO: only applies to wordsel
      else return this.loadmem(e, this.dataptr(), global.offset, global.size);
    }
    throw new HDLError(e, `cannot lookup variable ${e.refname}`);
  }

  local2wasm(e: HDLVariableDef, opts: Options): number {
    var local = this.locals.lookup(e.name);
    //if (local == null) throw Error(`no local for ${e.name}`)
    return this.bmod.nop(); // TODO
  }

  assign2wasm(dest: HDLExpr, src: HDLExpr): number {
    // Check if this is a wide type assignment
    if (hasDataType(dest) && isWideType(dest.dtype)) {
      return this.wideAssign2wasm(dest, src);
    }

    var value = this.e2w(src);
    if (isVarRef(dest)) {
      var local = this.locals && this.locals.lookup(dest.refname);
      var global = this.globals.lookup(dest.refname);
      if (local != null) {
        return this.bmod.local.set(local.index, value);
      } else if (global != null) {
        return this.storemem(dest, this.dataptr(), global.offset, global.size, value);
      }
    } else if (isBinop(dest)) {
      var addr = this.address2wasm(dest);
      var elsize =
        dest.op == 'wordsel' ? getDataTypeSize(dest.dtype) : getArrayElementSizeFromExpr(dest.left);
      return this.storemem(dest, addr, 0, elsize, value);
    }
    throw new HDLError(dest, `cannot complete assignment`);
  }

  /**
   * Handle assignment to a wide type (> 64 bits).
   * Wide types are stored in memory as arrays of 32-bit chunks.
   */
  wideAssign2wasm(dest: HDLExpr, src: HDLExpr): number {
    if (!hasDataType(dest) || !isLogicType(dest.dtype)) {
      throw new HDLError(dest, `wide assign requires logic type destination`);
    }

    const destDtype = dest.dtype as HDLLogicType;
    const numChunks = getNumChunks(destDtype);
    const destAddr = this.address2wasm(dest);

    // Handle different source expression types
    if (isVarRef(src)) {
      // Simple copy from another wide variable
      const srcAddr = this.address2wasm(src);
      return this.wideMemCopy(dest, destAddr, srcAddr, numChunks);
    } else if (isConstExpr(src) || isBigConstExpr(src)) {
      // Store a constant
      return this.wideConstStore(dest, destAddr, src as HDLConstant, numChunks);
    } else if (isBinop(src)) {
      // Handle binary operations
      return this.wideBinop2wasm(src as HDLBinop, destAddr, numChunks);
    } else if (isUnop(src)) {
      // Handle unary operations
      return this.wideUnop2wasm(src as HDLUnop, destAddr, numChunks);
    } else if (isTriop(src)) {
      // Handle ternary (conditional) operations: cond ? left : right
      return this.wideTriop2wasm(src as HDLTriop, destAddr, numChunks);
    }

    throw new HDLError(src, `unsupported wide source expression type`);
  }

  /**
   * Generate code to copy wide data from src to dest (chunk by chunk)
   */
  wideMemCopy(e: HDLSourceObject, destAddr: number, srcAddr: number, numChunks: number): number {
    const stmts: number[] = [];
    for (let i = 0; i < numChunks; i++) {
      const offset = i * 4;
      stmts.push(
        this.bmod.i32.store(
          offset,
          4,
          destAddr,
          this.bmod.i32.load(offset, 4, srcAddr),
        ),
      );
    }
    return this.bmod.block(null, stmts);
  }

  /**
   * Generate code to store a wide constant to dest
   */
  wideConstStore(e: HDLSourceObject, destAddr: number, src: HDLConstant, numChunks: number): number {
    const stmts: number[] = [];
    let value = src.bigvalue ?? BigInt(src.cvalue);

    for (let i = 0; i < numChunks; i++) {
      const chunk = Number(value & 0xffffffffn);
      value >>= 32n;
      stmts.push(
        this.bmod.i32.store(i * 4, 4, destAddr, this.bmod.i32.const(chunk)),
      );
    }
    return this.bmod.block(null, stmts);
  }

  /**
   * Generate code for a wide binary operation
   */
  wideBinop2wasm(e: HDLBinop, destAddr: number, numChunks: number): number {
    const op = e.op;

    // Check for bitwise operations
    if (op === 'or' || op === 'and' || op === 'xor') {
      return this.wideBitwiseBinop(e, destAddr, numChunks, op);
    }

    // Check for arithmetic operations
    if (op === 'add') {
      return this.wideAdd(e, destAddr, numChunks);
    }
    if (op === 'sub') {
      return this.wideSub(e, destAddr, numChunks);
    }

    // Check for shift operations
    if (op === 'shiftl') {
      return this.wideShiftLeft(e, destAddr, numChunks);
    }
    if (op === 'shiftr') {
      return this.wideShiftRight(e, destAddr, numChunks, false);
    }
    if (op === 'shiftrs') {
      return this.wideShiftRight(e, destAddr, numChunks, true);
    }

    // Check for comparison operations (these produce 1-bit result, not wide)
    if (op === 'eq' || op === 'neq' || op === 'lt' || op === 'gt' || op === 'lte' || op === 'gte') {
      throw new HDLError(e, `comparison operations on wide types should not reach wideBinop2wasm`);
    }

    // Multiplication and division not yet supported for wide types
    if (op === 'mul' || op === 'muls' || op === 'div' || op === 'divs' || op === 'moddiv' || op === 'moddivs') {
      throw new HDLError(e, `${op} operation on values > 64 bits is not yet supported`);
    }

    throw new HDLError(e, `unsupported wide binary operation: ${op}`);
  }

  /**
   * Generate code for wide bitwise operations (or, and, xor)
   */
  wideBitwiseBinop(e: HDLBinop, destAddr: number, numChunks: number, op: string): number {
    const leftAddr = this.address2wasm(e.left);
    const rightAddr = this.address2wasm(e.right);

    const stmts: number[] = [];
    for (let i = 0; i < numChunks; i++) {
      const offset = i * 4;
      const leftChunk = this.bmod.i32.load(offset, 4, leftAddr);
      const rightChunk = this.bmod.i32.load(offset, 4, rightAddr);

      let result: number;
      if (op === 'or') {
        result = this.bmod.i32.or(leftChunk, rightChunk);
      } else if (op === 'and') {
        result = this.bmod.i32.and(leftChunk, rightChunk);
      } else {
        result = this.bmod.i32.xor(leftChunk, rightChunk);
      }

      stmts.push(this.bmod.i32.store(offset, 4, destAddr, result));
    }
    return this.bmod.block(null, stmts);
  }

  /**
   * Generate code for wide addition with carry propagation
   */
  wideAdd(e: HDLBinop, destAddr: number, numChunks: number): number {
    const leftAddr = this.address2wasm(e.left);
    const rightAddr = this.address2wasm(e.right);

    // We need a local for carry. Add it to the current scope.
    const carryLocal = this.locals.addEntry('$$carry', 4, binaryen.i32);
    const sumLocal = this.locals.addEntry('$$sum', 4, binaryen.i32);
    const leftLocal = this.locals.addEntry('$$left', 4, binaryen.i32);

    const stmts: number[] = [];

    // Initialize carry to 0
    stmts.push(this.bmod.local.set(carryLocal.index, this.bmod.i32.const(0)));

    for (let i = 0; i < numChunks; i++) {
      const offset = i * 4;

      // Load left chunk
      stmts.push(
        this.bmod.local.set(leftLocal.index, this.bmod.i32.load(offset, 4, leftAddr)),
      );

      // sum = left + right
      stmts.push(
        this.bmod.local.set(
          sumLocal.index,
          this.bmod.i32.add(
            this.bmod.local.get(leftLocal.index, binaryen.i32),
            this.bmod.i32.load(offset, 4, rightAddr),
          ),
        ),
      );

      // Check for overflow: if sum < left, there was overflow
      const overflow1 = this.bmod.i32.lt_u(
        this.bmod.local.get(sumLocal.index, binaryen.i32),
        this.bmod.local.get(leftLocal.index, binaryen.i32),
      );

      // Add carry to sum
      const sumPlusCarry = this.bmod.i32.add(
        this.bmod.local.get(sumLocal.index, binaryen.i32),
        this.bmod.local.get(carryLocal.index, binaryen.i32),
      );
      stmts.push(this.bmod.local.set(sumLocal.index, sumPlusCarry));

      // Store result
      stmts.push(
        this.bmod.i32.store(
          offset,
          4,
          destAddr,
          this.bmod.local.get(sumLocal.index, binaryen.i32),
        ),
      );

      // Update carry for next iteration
      // carry = overflow1 || (sumPlusCarry < carry_was)
      // Simplified: carry = overflow1 | (sum == 0 && old_carry)
      // Actually: new_carry = overflow1 | (sumPlusCarry == 0 && carry)
      if (i < numChunks - 1) {
        // carry = overflow1 | (sum+carry overflowed)
        // sum+carry overflows if sum was 0xFFFFFFFF and carry was 1
        const overflow2 = this.bmod.i32.and(
          this.bmod.i32.eq(
            this.bmod.local.get(sumLocal.index, binaryen.i32),
            this.bmod.i32.const(0),
          ),
          this.bmod.local.get(carryLocal.index, binaryen.i32),
        );
        stmts.push(
          this.bmod.local.set(carryLocal.index, this.bmod.i32.or(overflow1, overflow2)),
        );
      }
    }

    return this.bmod.block(null, stmts);
  }

  /**
   * Generate code for wide subtraction with borrow propagation
   */
  wideSub(e: HDLBinop, destAddr: number, numChunks: number): number {
    const leftAddr = this.address2wasm(e.left);
    const rightAddr = this.address2wasm(e.right);

    // We need locals for borrow and intermediate values
    const borrowLocal = this.locals.addEntry('$$borrow', 4, binaryen.i32);
    const diffLocal = this.locals.addEntry('$$diff', 4, binaryen.i32);
    const leftLocal = this.locals.addEntry('$$left2', 4, binaryen.i32);
    const rightLocal = this.locals.addEntry('$$right', 4, binaryen.i32);

    const stmts: number[] = [];

    // Initialize borrow to 0
    stmts.push(this.bmod.local.set(borrowLocal.index, this.bmod.i32.const(0)));

    for (let i = 0; i < numChunks; i++) {
      const offset = i * 4;

      // Load chunks
      stmts.push(
        this.bmod.local.set(leftLocal.index, this.bmod.i32.load(offset, 4, leftAddr)),
      );
      stmts.push(
        this.bmod.local.set(rightLocal.index, this.bmod.i32.load(offset, 4, rightAddr)),
      );

      // diff = left - right
      stmts.push(
        this.bmod.local.set(
          diffLocal.index,
          this.bmod.i32.sub(
            this.bmod.local.get(leftLocal.index, binaryen.i32),
            this.bmod.local.get(rightLocal.index, binaryen.i32),
          ),
        ),
      );

      // Check for underflow: if left < right, there was underflow
      const underflow1 = this.bmod.i32.lt_u(
        this.bmod.local.get(leftLocal.index, binaryen.i32),
        this.bmod.local.get(rightLocal.index, binaryen.i32),
      );

      // Subtract borrow from diff
      const diffMinusBorrow = this.bmod.i32.sub(
        this.bmod.local.get(diffLocal.index, binaryen.i32),
        this.bmod.local.get(borrowLocal.index, binaryen.i32),
      );
      stmts.push(this.bmod.local.set(diffLocal.index, diffMinusBorrow));

      // Store result
      stmts.push(
        this.bmod.i32.store(
          offset,
          4,
          destAddr,
          this.bmod.local.get(diffLocal.index, binaryen.i32),
        ),
      );

      // Update borrow for next iteration
      if (i < numChunks - 1) {
        // underflow2: diff-borrow underflowed if diff was 0 and borrow was 1
        const underflow2 = this.bmod.i32.and(
          this.bmod.i32.eq(
            this.bmod.i32.add(
              this.bmod.local.get(diffLocal.index, binaryen.i32),
              this.bmod.local.get(borrowLocal.index, binaryen.i32),
            ),
            this.bmod.i32.const(0),
          ),
          this.bmod.local.get(borrowLocal.index, binaryen.i32),
        );
        stmts.push(
          this.bmod.local.set(borrowLocal.index, this.bmod.i32.or(underflow1, underflow2)),
        );
      }
    }

    return this.bmod.block(null, stmts);
  }

  /**
   * Generate code for wide left shift
   */
  wideShiftLeft(e: HDLBinop, destAddr: number, numChunks: number): number {
    const srcAddr = this.address2wasm(e.left);

    if (isConstExpr(e.right)) {
      return this.wideShiftLeftConst(e, destAddr, srcAddr, numChunks, (e.right as HDLConstant).cvalue);
    }

    // Variable shift
    return this.wideShiftLeftVar(e, destAddr, srcAddr, numChunks);
  }

  /**
   * Generate code for wide left shift by a variable amount
   */
  wideShiftLeftVar(
    e: HDLBinop,
    destAddr: number,
    srcAddr: number,
    numChunks: number,
  ): number {
    const shiftAmount = this.e2w(e.right);

    // Allocate locals for loop variables
    const iLocal = this.locals.addEntry('$$shl_i', 4, binaryen.i32);
    const chunkShiftLocal = this.locals.addEntry('$$shl_chunk', 4, binaryen.i32);
    const bitShiftLocal = this.locals.addEntry('$$shl_bit', 4, binaryen.i32);
    const srcIdxLocal = this.locals.addEntry('$$shl_srcIdx', 4, binaryen.i32);
    const valueLocal = this.locals.addEntry('$$shl_value', 4, binaryen.i32);

    const stmts: number[] = [];
    const l_loop = this.label('@shl_loop');

    // chunkShift = shiftAmount / 32
    stmts.push(
      this.bmod.local.set(
        chunkShiftLocal.index,
        this.bmod.i32.shr_u(shiftAmount, this.bmod.i32.const(5)),
      ),
    );

    // bitShift = shiftAmount % 32
    stmts.push(
      this.bmod.local.set(
        bitShiftLocal.index,
        this.bmod.i32.and(shiftAmount, this.bmod.i32.const(31)),
      ),
    );

    // i = numChunks - 1 (process from MSB to LSB)
    stmts.push(this.bmod.local.set(iLocal.index, this.bmod.i32.const(numChunks - 1)));

    // Loop: while (i >= 0)
    const loopBody: number[] = [];

    // srcIdx = i - chunkShift
    loopBody.push(
      this.bmod.local.set(
        srcIdxLocal.index,
        this.bmod.i32.sub(
          this.bmod.local.get(iLocal.index, binaryen.i32),
          this.bmod.local.get(chunkShiftLocal.index, binaryen.i32),
        ),
      ),
    );

    // if (srcIdx < 0) value = 0
    // else if (bitShift == 0) value = src[srcIdx]
    // else value = (src[srcIdx] << bitShift) | (src[srcIdx-1] >> (32 - bitShift))

    const srcIdxNegative = this.bmod.i32.lt_s(
      this.bmod.local.get(srcIdxLocal.index, binaryen.i32),
      this.bmod.i32.const(0),
    );

    const bitShiftZero = this.bmod.i32.eqz(
      this.bmod.local.get(bitShiftLocal.index, binaryen.i32),
    );

    // Load src[srcIdx] - compute dynamic address: srcAddr + srcIdx * 4
    const srcChunkAddr = this.bmod.i32.add(
      srcAddr,
      this.bmod.i32.shl(
        this.bmod.local.get(srcIdxLocal.index, binaryen.i32),
        this.bmod.i32.const(2),
      ),
    );

    // Load src[srcIdx - 1] - compute dynamic address
    const srcChunkAddr2 = this.bmod.i32.add(
      srcAddr,
      this.bmod.i32.shl(
        this.bmod.i32.sub(
          this.bmod.local.get(srcIdxLocal.index, binaryen.i32),
          this.bmod.i32.const(1),
        ),
        this.bmod.i32.const(2),
      ),
    );

    // High part: src[srcIdx] << bitShift
    const highPart = this.bmod.i32.shl(
      this.bmod.i32.load(0, 4, srcChunkAddr),
      this.bmod.local.get(bitShiftLocal.index, binaryen.i32),
    );

    // Low part: src[srcIdx-1] >> (32 - bitShift)
    // But only if srcIdx > 0
    const lowPart = this.bmod.i32.shr_u(
      this.bmod.i32.load(0, 4, srcChunkAddr2),
      this.bmod.i32.sub(
        this.bmod.i32.const(32),
        this.bmod.local.get(bitShiftLocal.index, binaryen.i32),
      ),
    );

    // Combined value when bitShift != 0 and srcIdx > 0
    const combinedWithLow = this.bmod.i32.or(highPart, lowPart);

    // Select: if srcIdx <= 0, use just highPart (no low neighbor), else use combined
    const srcIdxPositive = this.bmod.i32.gt_s(
      this.bmod.local.get(srcIdxLocal.index, binaryen.i32),
      this.bmod.i32.const(0),
    );
    const shiftedValue = this.bmod.select(srcIdxPositive, combinedWithLow, highPart);

    // Select between shifted value and direct copy based on bitShift
    const copyOrShift = this.bmod.select(
      bitShiftZero,
      this.bmod.i32.load(0, 4, srcChunkAddr),
      shiftedValue,
    );

    // Select final value: 0 if srcIdx < 0, else copyOrShift
    loopBody.push(
      this.bmod.local.set(
        valueLocal.index,
        this.bmod.select(srcIdxNegative, this.bmod.i32.const(0), copyOrShift),
      ),
    );

    // Store to dest[i]
    const destChunkAddr = this.bmod.i32.add(
      destAddr,
      this.bmod.i32.shl(
        this.bmod.local.get(iLocal.index, binaryen.i32),
        this.bmod.i32.const(2),
      ),
    );
    loopBody.push(
      this.bmod.i32.store(
        0,
        4,
        destChunkAddr,
        this.bmod.local.get(valueLocal.index, binaryen.i32),
      ),
    );

    // i--
    loopBody.push(
      this.bmod.local.set(
        iLocal.index,
        this.bmod.i32.sub(
          this.bmod.local.get(iLocal.index, binaryen.i32),
          this.bmod.i32.const(1),
        ),
      ),
    );

    // Continue if i >= 0
    loopBody.push(
      this.bmod.br_if(
        l_loop,
        this.bmod.i32.ge_s(
          this.bmod.local.get(iLocal.index, binaryen.i32),
          this.bmod.i32.const(0),
        ),
      ),
    );

    stmts.push(this.bmod.loop(l_loop, this.bmod.block(null, loopBody)));

    return this.bmod.block(null, stmts);
  }

  /**
   * Generate code for wide left shift by a constant amount
   */
  wideShiftLeftConst(
    e: HDLSourceObject,
    destAddr: number,
    srcAddr: number,
    numChunks: number,
    shiftAmount: number,
  ): number {
    const chunkShift = Math.floor(shiftAmount / 32);
    const bitShift = shiftAmount % 32;

    const stmts: number[] = [];

    // Process from MSB to LSB to handle overlapping src/dest
    for (let i = numChunks - 1; i >= 0; i--) {
      const srcIdx = i - chunkShift;
      const srcIdx2 = srcIdx - 1;
      const offset = i * 4;

      if (srcIdx < 0) {
        // Below the shifted range - zero
        stmts.push(this.bmod.i32.store(offset, 4, destAddr, this.bmod.i32.const(0)));
      } else if (bitShift === 0) {
        // No bit shift, just copy chunk
        stmts.push(
          this.bmod.i32.store(
            offset,
            4,
            destAddr,
            this.bmod.i32.load(srcIdx * 4, 4, srcAddr),
          ),
        );
      } else {
        // Combine bits from two source chunks
        const highPart = this.bmod.i32.shl(
          this.bmod.i32.load(srcIdx * 4, 4, srcAddr),
          this.bmod.i32.const(bitShift),
        );

        let value: number;
        if (srcIdx2 >= 0) {
          const lowPart = this.bmod.i32.shr_u(
            this.bmod.i32.load(srcIdx2 * 4, 4, srcAddr),
            this.bmod.i32.const(32 - bitShift),
          );
          value = this.bmod.i32.or(highPart, lowPart);
        } else {
          value = highPart;
        }

        stmts.push(this.bmod.i32.store(offset, 4, destAddr, value));
      }
    }

    return this.bmod.block(null, stmts);
  }

  /**
   * Generate code for wide right shift
   */
  wideShiftRight(e: HDLBinop, destAddr: number, numChunks: number, signed: boolean): number {
    const srcAddr = this.address2wasm(e.left);

    if (isConstExpr(e.right)) {
      return this.wideShiftRightConst(e, destAddr, srcAddr, numChunks, (e.right as HDLConstant).cvalue, signed);
    }

    // Variable shift
    return this.wideShiftRightVar(e, destAddr, srcAddr, numChunks, signed);
  }

  /**
   * Generate code for wide right shift by a variable amount
   */
  wideShiftRightVar(
    e: HDLBinop,
    destAddr: number,
    srcAddr: number,
    numChunks: number,
    signed: boolean,
  ): number {
    const shiftAmount = this.e2w(e.right);

    // Allocate locals for loop variables
    const iLocal = this.locals.addEntry('$$shr_i', 4, binaryen.i32);
    const chunkShiftLocal = this.locals.addEntry('$$shr_chunk', 4, binaryen.i32);
    const bitShiftLocal = this.locals.addEntry('$$shr_bit', 4, binaryen.i32);
    const srcIdxLocal = this.locals.addEntry('$$shr_srcIdx', 4, binaryen.i32);
    const valueLocal = this.locals.addEntry('$$shr_value', 4, binaryen.i32);
    const signExtendLocal = this.locals.addEntry('$$shr_sign', 4, binaryen.i32);

    const stmts: number[] = [];
    const l_loop = this.label('@shr_loop');

    // chunkShift = shiftAmount / 32
    stmts.push(
      this.bmod.local.set(
        chunkShiftLocal.index,
        this.bmod.i32.shr_u(shiftAmount, this.bmod.i32.const(5)),
      ),
    );

    // bitShift = shiftAmount % 32
    stmts.push(
      this.bmod.local.set(
        bitShiftLocal.index,
        this.bmod.i32.and(shiftAmount, this.bmod.i32.const(31)),
      ),
    );

    // For signed shifts, compute sign extension value (all 1s or all 0s)
    if (signed) {
      // signExtend = (src[numChunks-1] >> 31) - this gives 0 or -1 (0xFFFFFFFF)
      stmts.push(
        this.bmod.local.set(
          signExtendLocal.index,
          this.bmod.i32.shr_s(
            this.bmod.i32.load((numChunks - 1) * 4, 4, srcAddr),
            this.bmod.i32.const(31),
          ),
        ),
      );
    } else {
      stmts.push(this.bmod.local.set(signExtendLocal.index, this.bmod.i32.const(0)));
    }

    // i = 0 (process from LSB to MSB)
    stmts.push(this.bmod.local.set(iLocal.index, this.bmod.i32.const(0)));

    // Loop: while (i < numChunks)
    const loopBody: number[] = [];

    // srcIdx = i + chunkShift
    loopBody.push(
      this.bmod.local.set(
        srcIdxLocal.index,
        this.bmod.i32.add(
          this.bmod.local.get(iLocal.index, binaryen.i32),
          this.bmod.local.get(chunkShiftLocal.index, binaryen.i32),
        ),
      ),
    );

    // if (srcIdx >= numChunks) value = signExtend
    // else if (bitShift == 0) value = src[srcIdx]
    // else value = (src[srcIdx] >> bitShift) | (src[srcIdx+1] << (32 - bitShift))

    const srcIdxOutOfRange = this.bmod.i32.ge_s(
      this.bmod.local.get(srcIdxLocal.index, binaryen.i32),
      this.bmod.i32.const(numChunks),
    );

    const bitShiftZero = this.bmod.i32.eqz(
      this.bmod.local.get(bitShiftLocal.index, binaryen.i32),
    );

    // Load src[srcIdx] - compute dynamic address: srcAddr + srcIdx * 4
    const srcChunkAddr = this.bmod.i32.add(
      srcAddr,
      this.bmod.i32.shl(
        this.bmod.local.get(srcIdxLocal.index, binaryen.i32),
        this.bmod.i32.const(2),
      ),
    );

    // Load src[srcIdx + 1] - compute dynamic address
    const srcChunkAddr2 = this.bmod.i32.add(
      srcAddr,
      this.bmod.i32.shl(
        this.bmod.i32.add(
          this.bmod.local.get(srcIdxLocal.index, binaryen.i32),
          this.bmod.i32.const(1),
        ),
        this.bmod.i32.const(2),
      ),
    );

    // Low part: src[srcIdx] >> bitShift
    const lowPart = this.bmod.i32.shr_u(
      this.bmod.i32.load(0, 4, srcChunkAddr),
      this.bmod.local.get(bitShiftLocal.index, binaryen.i32),
    );

    // High part: src[srcIdx+1] << (32 - bitShift)
    // But only if srcIdx + 1 < numChunks
    const highPart = this.bmod.i32.shl(
      this.bmod.i32.load(0, 4, srcChunkAddr2),
      this.bmod.i32.sub(
        this.bmod.i32.const(32),
        this.bmod.local.get(bitShiftLocal.index, binaryen.i32),
      ),
    );

    // For signed shift, high part when srcIdx+1 >= numChunks should be sign extended
    const signedHighPart = this.bmod.i32.shl(
      this.bmod.local.get(signExtendLocal.index, binaryen.i32),
      this.bmod.i32.sub(
        this.bmod.i32.const(32),
        this.bmod.local.get(bitShiftLocal.index, binaryen.i32),
      ),
    );

    // Combined value when bitShift != 0
    const srcIdx2InRange = this.bmod.i32.lt_s(
      this.bmod.i32.add(
        this.bmod.local.get(srcIdxLocal.index, binaryen.i32),
        this.bmod.i32.const(1),
      ),
      this.bmod.i32.const(numChunks),
    );

    // Select high part: from src if in range, else from sign extension
    const selectedHighPart = this.bmod.select(srcIdx2InRange, highPart, signedHighPart);
    const combinedWithHigh = this.bmod.i32.or(lowPart, selectedHighPart);

    // Select between shifted value and direct copy based on bitShift
    const copyOrShift = this.bmod.select(
      bitShiftZero,
      this.bmod.i32.load(0, 4, srcChunkAddr),
      combinedWithHigh,
    );

    // Select final value: signExtend if srcIdx >= numChunks, else copyOrShift
    loopBody.push(
      this.bmod.local.set(
        valueLocal.index,
        this.bmod.select(
          srcIdxOutOfRange,
          this.bmod.local.get(signExtendLocal.index, binaryen.i32),
          copyOrShift,
        ),
      ),
    );

    // Store to dest[i]
    const destChunkAddr = this.bmod.i32.add(
      destAddr,
      this.bmod.i32.shl(
        this.bmod.local.get(iLocal.index, binaryen.i32),
        this.bmod.i32.const(2),
      ),
    );
    loopBody.push(
      this.bmod.i32.store(
        0,
        4,
        destChunkAddr,
        this.bmod.local.get(valueLocal.index, binaryen.i32),
      ),
    );

    // i++
    loopBody.push(
      this.bmod.local.set(
        iLocal.index,
        this.bmod.i32.add(
          this.bmod.local.get(iLocal.index, binaryen.i32),
          this.bmod.i32.const(1),
        ),
      ),
    );

    // Continue if i < numChunks
    loopBody.push(
      this.bmod.br_if(
        l_loop,
        this.bmod.i32.lt_s(
          this.bmod.local.get(iLocal.index, binaryen.i32),
          this.bmod.i32.const(numChunks),
        ),
      ),
    );

    stmts.push(this.bmod.loop(l_loop, this.bmod.block(null, loopBody)));

    return this.bmod.block(null, stmts);
  }

  /**
   * Generate code for wide right shift by a constant amount
   */
  wideShiftRightConst(
    e: HDLSourceObject,
    destAddr: number,
    srcAddr: number,
    numChunks: number,
    shiftAmount: number,
    signed: boolean,
  ): number {
    const chunkShift = Math.floor(shiftAmount / 32);
    const bitShift = shiftAmount % 32;

    const stmts: number[] = [];

    // For signed shifts, we need to get the sign bit
    let signExtend = this.bmod.i32.const(0);
    if (signed) {
      // Get sign bit from MSB of highest chunk
      signExtend = this.bmod.i32.shr_s(
        this.bmod.i32.load((numChunks - 1) * 4, 4, srcAddr),
        this.bmod.i32.const(31),
      );
    }

    // Process from LSB to MSB
    for (let i = 0; i < numChunks; i++) {
      const srcIdx = i + chunkShift;
      const srcIdx2 = srcIdx + 1;
      const offset = i * 4;

      if (srcIdx >= numChunks) {
        // Above the shifted range - zero or sign extend
        stmts.push(this.bmod.i32.store(offset, 4, destAddr, signExtend));
      } else if (bitShift === 0) {
        // No bit shift, just copy chunk
        stmts.push(
          this.bmod.i32.store(
            offset,
            4,
            destAddr,
            this.bmod.i32.load(srcIdx * 4, 4, srcAddr),
          ),
        );
      } else {
        // Combine bits from two source chunks
        const lowPart = this.bmod.i32.shr_u(
          this.bmod.i32.load(srcIdx * 4, 4, srcAddr),
          this.bmod.i32.const(bitShift),
        );

        let value: number;
        if (srcIdx2 < numChunks) {
          const highPart = this.bmod.i32.shl(
            this.bmod.i32.load(srcIdx2 * 4, 4, srcAddr),
            this.bmod.i32.const(32 - bitShift),
          );
          value = this.bmod.i32.or(lowPart, highPart);
        } else if (signed) {
          // Sign extend for the high bits
          const highPart = this.bmod.i32.shl(signExtend, this.bmod.i32.const(32 - bitShift));
          value = this.bmod.i32.or(lowPart, highPart);
        } else {
          value = lowPart;
        }

        stmts.push(this.bmod.i32.store(offset, 4, destAddr, value));
      }
    }

    return this.bmod.block(null, stmts);
  }

  /**
   * Generate code for a wide unary operation
   */
  wideUnop2wasm(e: HDLUnop, destAddr: number, numChunks: number): number {
    const op = e.op;

    if (op === 'not') {
      return this.wideNot(e, destAddr, numChunks);
    }

    if (op === 'negate') {
      return this.wideNegate(e, destAddr, numChunks);
    }

    throw new HDLError(e, `unsupported wide unary operation: ${op}`);
  }

  /**
   * Generate code for wide bitwise NOT
   */
  wideNot(e: HDLUnop, destAddr: number, numChunks: number): number {
    const srcAddr = this.address2wasm(e.left);

    const stmts: number[] = [];
    for (let i = 0; i < numChunks; i++) {
      const offset = i * 4;
      stmts.push(
        this.bmod.i32.store(
          offset,
          4,
          destAddr,
          this.bmod.i32.xor(
            this.bmod.i32.load(offset, 4, srcAddr),
            this.bmod.i32.const(-1),
          ),
        ),
      );
    }
    return this.bmod.block(null, stmts);
  }

  /**
   * Generate code for wide negation (two's complement)
   */
  wideNegate(e: HDLUnop, destAddr: number, numChunks: number): number {
    const srcAddr = this.address2wasm(e.left);

    // Negation = NOT + 1
    // We'll do this in two passes: NOT, then add 1 with carry propagation
    const carryLocal = this.locals.addEntry('$$ncarry', 4, binaryen.i32);
    const valLocal = this.locals.addEntry('$$nval', 4, binaryen.i32);

    const stmts: number[] = [];

    // Initialize carry to 1 (for the +1)
    stmts.push(this.bmod.local.set(carryLocal.index, this.bmod.i32.const(1)));

    for (let i = 0; i < numChunks; i++) {
      const offset = i * 4;

      // NOT the source chunk
      const notted = this.bmod.i32.xor(
        this.bmod.i32.load(offset, 4, srcAddr),
        this.bmod.i32.const(-1),
      );

      // Add carry
      stmts.push(
        this.bmod.local.set(
          valLocal.index,
          this.bmod.i32.add(notted, this.bmod.local.get(carryLocal.index, binaryen.i32)),
        ),
      );

      // Store result
      stmts.push(
        this.bmod.i32.store(offset, 4, destAddr, this.bmod.local.get(valLocal.index, binaryen.i32)),
      );

      // Update carry: carry if result is 0 and old carry was 1
      if (i < numChunks - 1) {
        stmts.push(
          this.bmod.local.set(
            carryLocal.index,
            this.bmod.i32.and(
              this.bmod.i32.eqz(this.bmod.local.get(valLocal.index, binaryen.i32)),
              this.bmod.local.get(carryLocal.index, binaryen.i32),
            ),
          ),
        );
      }
    }

    return this.bmod.block(null, stmts);
  }

  /**
   * Generate code for wide ternary (conditional) operation: cond ? left : right
   * Evaluates condition, then copies from left or right source to destination
   */
  wideTriop2wasm(e: HDLTriop, destAddr: number, numChunks: number): number {
    // Evaluate the condition (should be a 1-bit or 32-bit value)
    const condExpr = this.e2w(e.cond);

    // Get addresses for left and right operands
    const leftAddr = this.address2wasm(e.left);
    const rightAddr = this.address2wasm(e.right);

    // Generate if-else block that copies from left or right based on condition
    const copyFromLeft: number[] = [];
    const copyFromRight: number[] = [];

    for (let i = 0; i < numChunks; i++) {
      const offset = i * 4;
      copyFromLeft.push(
        this.bmod.i32.store(offset, 4, destAddr, this.bmod.i32.load(offset, 4, leftAddr)),
      );
      copyFromRight.push(
        this.bmod.i32.store(offset, 4, destAddr, this.bmod.i32.load(offset, 4, rightAddr)),
      );
    }

    return this.bmod.if(
      condExpr,
      this.bmod.block(null, copyFromLeft),
      this.bmod.block(null, copyFromRight),
    );
  }

  loadmem(e: HDLSourceObject, ptr, offset: number, size: number): number {
    if (size == 1) {
      return this.bmod.i32.load8_u(offset, 1, ptr);
    } else if (size == 2) {
      return this.bmod.i32.load16_u(offset, 2, ptr);
    } else if (size == 4) {
      return this.bmod.i32.load(offset, 4, ptr);
    } else if (size == 8) {
      return this.bmod.i64.load(offset, 8, ptr);
    } else {
      throw new HDLError(e, `cannot load ${size} bytes (> 64 bits not supported)`);
    }
  }

  storemem(e: HDLSourceObject, ptr, offset: number, size: number, value): number {
    if (size == 1) {
      return this.bmod.i32.store8(offset, 1, ptr, value);
    } else if (size == 2) {
      return this.bmod.i32.store16(offset, 2, ptr, value);
    } else if (size == 4) {
      return this.bmod.i32.store(offset, 4, ptr, value);
    } else if (size == 8) {
      return this.bmod.i64.store(offset, 8, ptr, value);
    } else {
      throw new HDLError(e, `cannot store ${size} bytes (> 64 bits not supported)`);
    }
  }

  address2wasm(e: HDLExpr): number {
    if (isBinop(e) && (e.op == 'arraysel' || e.op == 'wordsel')) {
      var elsize =
        e.op == 'wordsel' ? getDataTypeSize(e.dtype) : getArrayElementSizeFromExpr(e.left);
      var array = this.address2wasm(e.left);
      var index = this.e2w(e.right);
      return this.bmod.i32.add(array, this.bmod.i32.mul(this.bmod.i32.const(elsize), index));
    } else if (isVarRef(e)) {
      var local = this.locals && this.locals.lookup(e.refname);
      var global = this.globals.lookup(e.refname);
      if (local != null) {
        throw new HDLError(e, `can't get array local address yet`);
      } else if (global != null) {
        return this.bmod.i32.const(global.offset);
      }
    }
    throw new HDLError(e, `cannot get address`);
  }

  // TODO: array bounds
  _arraysel2wasm(e: HDLBinop, opts: Options): number {
    var addr = this.address2wasm(e);
    var elsize = getArrayValueSize(e);
    var ret = this.loadmem(e, addr, 0, elsize);
    // cast to destination type, if it differs than fetch type
    if (elsize != getDataTypeSize(e.dtype)) {
      ret = this.castexpr(ret, getArrayValueType(e), e.dtype);
    }
    return ret;
  }

  _wordsel2wasm(e: HDLBinop, opts: Options): number {
    // wordsel selects a 32-bit word from a wide value
    // Use e.dtype size (always 32 bits) instead of source array element size
    var addr = this.address2wasm(e);
    var elsize = getDataTypeSize(e.dtype);
    return this.loadmem(e, addr, 0, elsize);
  }

  _assign2wasm(e: HDLBinop, opts: Options) {
    return this.assign2wasm(e.right, e.left);
  }
  _assignpre2wasm(e: HDLBinop, opts: Options) {
    return this._assign2wasm(e, opts);
  }
  _assigndly2wasm(e: HDLBinop, opts: Options) {
    return this._assign2wasm(e, opts);
  }
  _assignpost2wasm(e: HDLBinop, opts: Options) {
    return this._assign2wasm(e, opts);
  }
  _contassign2wasm(e: HDLBinop, opts: Options) {
    return this._assign2wasm(e, opts);
  }

  _if2wasm(e: HDLTriop, opts: Options) {
    return this.bmod.if(this.e2w(e.cond), this.e2w(e.left), this.e2w(e.right));
  }
  _cond2wasm(e: HDLTriop, opts: Options) {
    return this.bmod.select(this.e2w(e.cond), this.e2w(e.left), this.e2w(e.right));
  }
  _condbound2wasm(e: HDLTriop, opts: Options) {
    return this.bmod.select(this.e2w(e.cond), this.e2w(e.left), this.e2w(e.right));
  }

  _while2wasm(e: HDLWhileOp, opts: Options) {
    var l_block = this.label('@block');
    var l_loop = this.label('@loop');
    var block = [];
    if (e.precond) {
      block.push(this.e2w(e.precond));
    }
    if (e.loopcond) {
      // TODO: detect constant while loop condition
      block.push(
        this.bmod.if(
          this.e2w(e.loopcond, { resulttype: binaryen.i32 }),
          this.bmod.nop(),
          this.bmod.br(l_block), // exit loop
        ),
      );
    }
    if (e.body) {
      block.push(this.e2w(e.body));
    }
    if (e.inc) {
      block.push(this.e2w(e.inc));
    }
    block.push(this.bmod.br(l_loop));
    return this.bmod.loop(l_loop, this.bmod.block(l_block, block, binaryen.none));
  }

  _ccast2wasm(e: HDLUnop, opts: Options) {
    if (hasDataType(e.left)) {
      return this.castexpr(this.e2w(e.left), e.left.dtype, e.dtype);
    } else throw new HDLError(e.left, `no data type for ccast`);
  }

  castexpr(val: number, tsrc: HDLDataType, tdst: HDLDataType): number {
    if (isLogicType(tsrc) && isLogicType(tdst) && tsrc.right == 0 && tdst.right == 0) {
      if (tsrc.left == tdst.left) {
        return val;
      } else if (tsrc.left > 63 || tdst.left > 63) {
        throw new HDLError(tdst, `values > 64 bits not supported`);
      } else if (tsrc.left <= 31 && tdst.left <= 31 && !tsrc.signed && !tdst.signed) {
        return val;
      } else if (tsrc.left > 31 && tdst.left > 31 && !tsrc.signed && !tdst.signed) {
        return val;
      } else if (tsrc.left == 7 && tdst.left == 31 && tsrc.signed && tdst.signed) {
        return this.bmod.i32.extend8_s(val);
      } else if (tsrc.left == 15 && tdst.left == 31 && tsrc.signed && tdst.signed) {
        return this.bmod.i32.extend16_s(val);
      } else if (tsrc.left <= 31 && tdst.left > 31) {
        // 32 -> 64
        if (tsrc.signed) return this.bmod.i64.extend_s(val);
        else return this.bmod.i64.extend_u(val);
      } else if (tsrc.left > 31 && tdst.left <= 31) {
        // 64 -> 32
        return this.bmod.i32.wrap(val);
      } else if (tsrc.left < 31 && tdst.left == 31 && tsrc.signed) {
        // sign extend via shift (silice case)
        let inst = this.i3264(tdst);
        var shift = inst.const(31 - tsrc.left, 0);
        return inst.shr_s(inst.shl(val, shift), shift);
      }
      throw new HDLError(
        [tsrc, tdst],
        `cannot cast ${tsrc.left}/${tsrc.signed} to ${tdst.left}/${tdst.signed}`,
      );
    }
    throw new HDLError([tsrc, tdst], `cannot cast`);
  }

  _creset2wasm(e: HDLUnop, opts: Options) {
    if (isVarRef(e.left)) {
      var glob = this.globals.lookup(e.left.refname);
      // TODO: must be better way to tell non-randomize values
      // set clk and reset to known values so values are reset properly
      glob.reset = glob.name != 'clk' && glob.name != 'reset' && !glob.name.startsWith('__V');
    }
    // we reset values in powercycle()
    return this.bmod.nop();
  }

  _creturn2wasm(e: HDLUnop, opts: Options) {
    return this.bmod.return(this.e2w(e.left, opts));
  }

  _not2wasm(e: HDLUnop, opts: Options) {
    var inst = this.i3264(e.dtype);
    return inst.xor(inst.const(-1, -1), this.e2w(e.left, opts));
  }

  _negate2wasm(e: HDLUnop, opts: Options) {
    var inst = this.i3264(e.dtype);
    return inst.sub(inst.const(0, 0), this.e2w(e.left, opts));
  }

  _changedet2wasm(e: HDLBinop, opts: Options) {
    var req = this.locals.lookup(CHANGEDET);
    if (!req) throw new HDLError(e, `no changedet local`);
    var left = this.e2w(e.left);
    var right = this.e2w(e.right);
    let datainst = this.i3264(hasDataType(e.left) && e.left.dtype);
    return this.bmod.block(null, [
      // if (left != right) req = 1;
      this.bmod.if(
        datainst.ne(left, right),
        this.bmod.local.set(req.index, this.bmod.i32.const(1)),
        this.bmod.nop(),
      ),
      // ${this.expr2js(e.right)} = ${this.expr2js(e.left)}`
      this.assign2wasm(e.right, e.left),
    ]);
  }

  _extend2wasm(e: HDLExtendop, opts: Options) {
    var value = this.e2w(e.left);
    if (e.widthminv == 32 && e.width == 64) {
      return this.bmod.i64.extend_u(value);
    }
    throw new HDLError(e, `cannot extend`);
  }

  _extends2wasm(e: HDLExtendop, opts: Options) {
    var value = this.e2w(e.left);
    var inst = this.i3264(e.dtype);
    if (this.bmod.getFeatures() & binaryen.Features.SignExt) {
      if (e.widthminv == 8) {
        return inst.extend8_s(value);
      } else if (e.widthminv == 16) {
        return inst.extend16_s(value);
      } else if (e.widthminv == 32 && e.width == 64) {
        return this.bmod.i64.extend32_s(value);
      }
    }
    // TODO: this might not work? (t_math_signed2.v)
    var shift = inst.const(e.width - e.widthminv, 0);
    return inst.shr_s(inst.shl(value, shift), shift);
  }

  // TODO: i32/i64
  _redxor2wasm(e: HDLUnop) {
    if (hasDataType(e.left)) {
      var left = this.e2w(e.left);
      var inst = this.i3264(e.left.dtype);
      var rtn = inst.and(inst.const(1, 0), inst.popcnt(left)); // (num_set_bits & 1)
      return this.castexpr(rtn, e.left.dtype, e.dtype);
    } else throw new HDLError(e, '');
  }

  binop(e: HDLBinop, f_op: (a: number, b: number) => number) {
    var left = this.e2w(e.left);
    var right = this.e2w(e.right);
    var upcast = null;
    // if one argument is 64 bit and one is 32 bit, upcast the latter to 64 bits
    if (hasDataType(e.left) && hasDataType(e.right)) {
      var lsize = getDataTypeSize(e.left.dtype);
      var rsize = getDataTypeSize(e.right.dtype);
      var ltype = getBinaryenType(lsize);
      var rtype = getBinaryenType(rsize);
      if (ltype != rtype && rsize > lsize) {
        left = this.castexpr(left, e.left.dtype, e.right.dtype);
        upcast = e.right.dtype;
      } else if (ltype != rtype && lsize > rsize) {
        right = this.castexpr(right, e.right.dtype, e.left.dtype);
        upcast = e.left.dtype;
      } else if (ltype != rtype)
        throw new HDLError(e, `wrong argument sizes ${lsize} and ${rsize}`);
    }
    var rtn = f_op(left, right);
    // if we upcasted, and result is 32 bit, downcast to 32 bits
    if (upcast) {
      rtn = this.castexpr(rtn, upcast, e.dtype);
    }
    return rtn;
  }

  _or2wasm(e: HDLBinop) {
    return this.binop(e, this.i3264rel(e).or);
  }
  _and2wasm(e: HDLBinop) {
    return this.binop(e, this.i3264rel(e).and);
  }
  _xor2wasm(e: HDLBinop) {
    return this.binop(e, this.i3264rel(e).xor);
  }
  _shiftl2wasm(e: HDLBinop) {
    return this.binop(e, this.i3264rel(e).shl);
  }
  _shiftr2wasm(e: HDLBinop) {
    return this.binop(e, this.i3264rel(e).shr_u);
  }
  _shiftrs2wasm(e: HDLBinop) {
    return this.binop(e, this.i3264rel(e).shr_s);
  }
  _add2wasm(e: HDLBinop) {
    return this.binop(e, this.i3264rel(e).add);
  }
  _sub2wasm(e: HDLBinop) {
    return this.binop(e, this.i3264rel(e).sub);
  }
  _mul2wasm(e: HDLBinop) {
    return this.binop(e, this.i3264rel(e).mul);
  }
  _muls2wasm(e: HDLBinop) {
    return this.binop(e, this.i3264rel(e).mul); // TODO: signed?
  }
  _moddiv2wasm(e: HDLBinop) {
    return this.binop(e, this.i3264rel(e).rem_u);
  }
  _div2wasm(e: HDLBinop) {
    return this.binop(e, this.i3264rel(e).div_u);
  }
  _moddivs2wasm(e: HDLBinop) {
    return this.binop(e, this.i3264rel(e).rem_s);
  }
  _divs2wasm(e: HDLBinop) {
    return this.binop(e, this.i3264rel(e).div_s);
  }

  relop(e: HDLBinop, f_op: (a: number, b: number) => number) {
    return f_op(this.e2w(e.left), this.e2w(e.right));
  }

  /**
   * Check if this is a comparison involving wide operands
   */
  private isWideComparison(e: HDLBinop): boolean {
    return (
      (hasDataType(e.left) && isWideType(e.left.dtype)) ||
      (hasDataType(e.right) && isWideType(e.right.dtype))
    );
  }

  _eq2wasm(e: HDLBinop) {
    if (this.isWideComparison(e)) {
      return this.wideEq(e);
    }
    return this.relop(e, this.i3264rel(e).eq);
  }
  _neq2wasm(e: HDLBinop) {
    if (this.isWideComparison(e)) {
      return this.wideNeq(e);
    }
    return this.relop(e, this.i3264rel(e).ne);
  }
  _lt2wasm(e: HDLBinop) {
    if (this.isWideComparison(e)) {
      return this.wideLt(e, false);
    }
    return this.relop(e, this.i3264rel(e).lt_u);
  }
  _gt2wasm(e: HDLBinop) {
    if (this.isWideComparison(e)) {
      return this.wideGt(e, false);
    }
    return this.relop(e, this.i3264rel(e).gt_u);
  }
  _lte2wasm(e: HDLBinop) {
    if (this.isWideComparison(e)) {
      return this.wideLte(e, false);
    }
    return this.relop(e, this.i3264rel(e).le_u);
  }
  _gte2wasm(e: HDLBinop) {
    if (this.isWideComparison(e)) {
      return this.wideGte(e, false);
    }
    return this.relop(e, this.i3264rel(e).ge_u);
  }
  _gts2wasm(e: HDLBinop) {
    if (this.isWideComparison(e)) {
      return this.wideGt(e, true);
    }
    return this.relop(e, this.i3264rel(e).gt_s);
  }
  _lts2wasm(e: HDLBinop) {
    if (this.isWideComparison(e)) {
      return this.wideLt(e, true);
    }
    return this.relop(e, this.i3264rel(e).lt_s);
  }
  _gtes2wasm(e: HDLBinop) {
    if (this.isWideComparison(e)) {
      return this.wideGte(e, true);
    }
    return this.relop(e, this.i3264rel(e).ge_s);
  }
  _ltes2wasm(e: HDLBinop) {
    if (this.isWideComparison(e)) {
      return this.wideLte(e, true);
    }
    return this.relop(e, this.i3264rel(e).le_s);
  }

  /**
   * Wide equality: all chunks must be equal
   */
  wideEq(e: HDLBinop): number {
    const leftDtype = hasDataType(e.left) ? e.left.dtype : null;
    const rightDtype = hasDataType(e.right) ? e.right.dtype : null;
    const dtype = leftDtype && isWideType(leftDtype) ? leftDtype : rightDtype;
    if (!dtype || !isLogicType(dtype)) {
      throw new HDLError(e, `wide comparison requires logic type`);
    }

    const numChunks = getNumChunks(dtype);
    const leftAddr = this.address2wasm(e.left);
    const rightAddr = this.address2wasm(e.right);

    // Start with 1 (true), AND with each chunk comparison
    let result = this.bmod.i32.const(1);
    for (let i = 0; i < numChunks; i++) {
      const offset = i * 4;
      const chunkEq = this.bmod.i32.eq(
        this.bmod.i32.load(offset, 4, leftAddr),
        this.bmod.i32.load(offset, 4, rightAddr),
      );
      result = this.bmod.i32.and(result, chunkEq);
    }
    return result;
  }

  /**
   * Wide inequality: any chunk different
   */
  wideNeq(e: HDLBinop): number {
    const leftDtype = hasDataType(e.left) ? e.left.dtype : null;
    const rightDtype = hasDataType(e.right) ? e.right.dtype : null;
    const dtype = leftDtype && isWideType(leftDtype) ? leftDtype : rightDtype;
    if (!dtype || !isLogicType(dtype)) {
      throw new HDLError(e, `wide comparison requires logic type`);
    }

    const numChunks = getNumChunks(dtype);
    const leftAddr = this.address2wasm(e.left);
    const rightAddr = this.address2wasm(e.right);

    // Start with 0 (false), OR with each chunk comparison
    let result = this.bmod.i32.const(0);
    for (let i = 0; i < numChunks; i++) {
      const offset = i * 4;
      const chunkNeq = this.bmod.i32.ne(
        this.bmod.i32.load(offset, 4, leftAddr),
        this.bmod.i32.load(offset, 4, rightAddr),
      );
      result = this.bmod.i32.or(result, chunkNeq);
    }
    return result;
  }

  /**
   * Wide less than: compare from MSB to LSB
   * For signed, only MSB is treated as signed
   * Uses nested if-else to avoid WASM validation issues with returns
   */
  wideLt(e: HDLBinop, signed: boolean): number {
    const leftDtype = hasDataType(e.left) ? e.left.dtype : null;
    const rightDtype = hasDataType(e.right) ? e.right.dtype : null;
    const dtype = leftDtype && isWideType(leftDtype) ? leftDtype : rightDtype;
    if (!dtype || !isLogicType(dtype)) {
      throw new HDLError(e, `wide comparison requires logic type`);
    }

    const numChunks = getNumChunks(dtype);
    const leftAddr = this.address2wasm(e.left);
    const rightAddr = this.address2wasm(e.right);

    // Build nested if-else from LSB to MSB
    // Start with 0 (equal case at the end returns false for strict less than)
    let result: number = this.bmod.i32.const(0);

    for (let i = 0; i < numChunks; i++) {
      const offset = i * 4;
      const isMsb = i === numChunks - 1;

      const leftChunk = this.bmod.i32.load(offset, 4, leftAddr);
      const rightChunk = this.bmod.i32.load(offset, 4, rightAddr);

      // Compare: use signed comparison for MSB if signed, unsigned otherwise
      const lt = isMsb && signed
        ? this.bmod.i32.lt_s(leftChunk, rightChunk)
        : this.bmod.i32.lt_u(leftChunk, rightChunk);
      const gt = isMsb && signed
        ? this.bmod.i32.gt_s(leftChunk, rightChunk)
        : this.bmod.i32.gt_u(leftChunk, rightChunk);

      // For this chunk: if lt -> 1, if gt -> 0, if eq -> check lower chunks (result)
      result = this.bmod.select(lt, this.bmod.i32.const(1), this.bmod.select(gt, this.bmod.i32.const(0), result));
    }

    return result;
  }

  /**
   * Wide greater than: compare from MSB to LSB
   * Uses nested select operations to avoid WASM validation issues
   */
  wideGt(e: HDLBinop, signed: boolean): number {
    const leftDtype = hasDataType(e.left) ? e.left.dtype : null;
    const rightDtype = hasDataType(e.right) ? e.right.dtype : null;
    const dtype = leftDtype && isWideType(leftDtype) ? leftDtype : rightDtype;
    if (!dtype || !isLogicType(dtype)) {
      throw new HDLError(e, `wide comparison requires logic type`);
    }

    const numChunks = getNumChunks(dtype);
    const leftAddr = this.address2wasm(e.left);
    const rightAddr = this.address2wasm(e.right);

    // Build nested select from LSB to MSB
    // Start with 0 (equal case at the end returns false for strict greater than)
    let result: number = this.bmod.i32.const(0);

    for (let i = 0; i < numChunks; i++) {
      const offset = i * 4;
      const isMsb = i === numChunks - 1;

      const leftChunk = this.bmod.i32.load(offset, 4, leftAddr);
      const rightChunk = this.bmod.i32.load(offset, 4, rightAddr);

      const lt = isMsb && signed
        ? this.bmod.i32.lt_s(leftChunk, rightChunk)
        : this.bmod.i32.lt_u(leftChunk, rightChunk);
      const gt = isMsb && signed
        ? this.bmod.i32.gt_s(leftChunk, rightChunk)
        : this.bmod.i32.gt_u(leftChunk, rightChunk);

      // For this chunk: if gt -> 1, if lt -> 0, if eq -> check lower chunks (result)
      result = this.bmod.select(gt, this.bmod.i32.const(1), this.bmod.select(lt, this.bmod.i32.const(0), result));
    }

    return result;
  }

  /**
   * Wide less than or equal
   */
  wideLte(e: HDLBinop, signed: boolean): number {
    // a <= b is equivalent to !(a > b)
    return this.bmod.i32.eqz(this.wideGt(e, signed));
  }

  /**
   * Wide greater than or equal
   */
  wideGte(e: HDLBinop, signed: boolean): number {
    // a >= b is equivalent to !(a < b)
    return this.bmod.i32.eqz(this.wideLt(e, signed));
  }
}
