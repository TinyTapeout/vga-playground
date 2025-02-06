import { EmuHalt } from './emu';
import {
  HDLBlock,
  HDLDataType,
  HDLExpr,
  HDLExtendop,
  HDLModuleDef,
  HDLModuleRunner,
  HDLValue,
  HDLVariableDef,
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
import { byteArrayToString, safeExtend } from './util';

interface VerilatorUnit {
  _ctor_var_reset(state): void;
  _eval_initial(state): void;
  _eval_settle(state): void;
  _eval(state): void;
  _change_request(state): boolean;
}

export class HDLError extends EmuHalt {
  obj: any;
  constructor(obj: any, msg: string) {
    super(msg, obj ? obj.$loc : null);
    Object.setPrototypeOf(this, HDLError.prototype);
    this.obj = obj;
    if (obj) console.log(obj);
  }
}

export class HDLModuleJS implements HDLModuleRunner {
  mod: HDLModuleDef;
  constpool: HDLModuleDef;
  globals: { [name: string]: HDLVariableDef };
  locals: { [name: string]: HDLVariableDef };
  state: { [name: string]: HDLValue };
  basefuncs: VerilatorUnit;
  curfuncs: VerilatorUnit;
  finished: boolean = false;
  stopped: boolean = false;
  settleTime: number = 0;
  curconsts: {};
  constused: number;
  specfuncs: VerilatorUnit[] = [];
  getFileData = null;
  resetStartTimeMsec: number;

  constructor(mod: HDLModuleDef, constpool: HDLModuleDef) {
    this.mod = mod;
    this.constpool = constpool;
    this.basefuncs = {} as any;
    this.state = {}; //new Object(this.funcs) as any;
    this.globals = {};
    // set built-in functions
    Object.getOwnPropertyNames(Object.getPrototypeOf(this))
      .filter((f) => f.startsWith('$'))
      .forEach((f) => {
        this.basefuncs[f] = this[f].bind(this);
      });
    // set initial state
    if (this.constpool) {
      var cp = new HDLModuleJS(this.constpool, null);
      cp.init();
      Object.assign(this.state, cp.state);
      Object.assign(this.globals, cp.globals);
    }
    for (var varname in this.mod.vardefs) {
      var vardef = this.mod.vardefs[varname];
      this.globals[varname] = vardef;
      this.state[varname] = this.defaultValue(vardef.dtype, vardef);
    }
    // generate functions
    this.basefuncs = this.genFuncs({});
    this.curfuncs = this.basefuncs;
  }

  init() {}

  dispose() {}

  genFuncs(constants: {}): VerilatorUnit {
    var funcs = Object.create(this.basefuncs);
    this.curconsts = constants;
    for (var block of this.mod.blocks) {
      this.locals = {};
      // if we have at least 1 constant value, check for it (set counter to zero)
      this.constused = Object.keys(this.curconsts).length == 0 ? 99999 : 0;
      var s = this.block2js(block);
      if (this.constused) {
        try {
          var funcname = block.name || '__anon';
          var funcbody = `'use strict'; function ${funcname}(o) { ${s} }; return ${funcname};`;
          var func = new Function('', funcbody)();
          funcs[block.name] = func;
          //console.log(funcbody);
        } catch (e) {
          console.log(funcbody);
          throw e;
        }
      }
      //if (this.constused) console.log('FUNC',constants,funcname,this.constused);
    }
    return funcs;
  }

  getJSCode(): string {
    var s = '';
    for (var funcname in this.basefuncs) {
      if (funcname && funcname.startsWith('_')) {
        s += this.basefuncs[funcname].toString();
        s += '\n';
      }
    }
    return s;
  }

  powercycle() {
    this.resetStartTimeMsec = new Date().getTime() - 1;
    this.finished = false;
    this.stopped = false;
    this.basefuncs._ctor_var_reset(this.state);
    this.basefuncs._eval_initial(this.state);
    for (var i = 0; i < 100; i++) {
      this.basefuncs._eval_settle(this.state);
      this.basefuncs._eval(this.state);
      var Vchange = this.basefuncs._change_request(this.state);
      if (!Vchange) {
        this.settleTime = i;
        return;
      }
    }
    throw new HDLError(null, `model did not converge on reset()`);
  }

  eval() {
    var clk = this.state.clk as number;
    var reset = this.state.reset as number;
    var state = this.state.test_CPU16_top$cpu$state as number;
    var opcode = this.state.CPU$opcode as number;
    var aluop = this.state.CPU$aluop as number;
    var fi = state;
    //this.curfuncs = this.specfuncs[fi & 0xff];
    this.curfuncs = this.basefuncs;
    for (var i = 0; i < 100; i++) {
      this.curfuncs._eval(this.state);
      var Vchange = this.curfuncs._change_request(this.state);
      /*
            --- don't do it this way! it's like 4x slower...
            this.call('_eval');
            var Vchange = this.call('_change_request');
            */
      if (!Vchange) {
        this.settleTime = i;
        return;
      }
    }
    throw new HDLError(null, `model did not converge on eval()`);
  }

  tick2(iters: number) {
    while (iters-- > 0) {
      this.state.clk = 0;
      this.eval();
      this.state.clk = 1;
      this.eval();
    }
  }

  defaultValue(dt: HDLDataType, vardef?: HDLVariableDef): HDLValue {
    if (isLogicType(dt)) {
      if (dt.left <= 31) return 0;
      else return BigInt(0);
    } else if (
      isArrayType(dt) &&
      typeof dt.high.cvalue === 'number' &&
      typeof dt.low.cvalue === 'number'
    ) {
      let arr;
      let arrlen = dt.high.cvalue - dt.low.cvalue + 1;
      if (arrlen < 0) arrlen = -arrlen; // TODO?
      if (isLogicType(dt.subtype)) {
        if (dt.subtype.left <= 7) arr = new Uint8Array(arrlen);
        else if (dt.subtype.left <= 15) arr = new Uint16Array(arrlen);
        else if (dt.subtype.left <= 31) arr = new Uint32Array(arrlen);
        else {
          arr = []; // TODO?
        }
      } else {
        arr = [];
        for (let i = 0; i < arrlen; i++) {
          arr[i] = this.defaultValue(dt.subtype);
        }
      }
      if (vardef != null && vardef.initValue != null) {
        for (let i = 0; i < vardef.initValue.exprs.length; i++) {
          let e = vardef.initValue.exprs[i];
          if (isArrayItem(e) && isConstExpr(e.expr)) {
            arr[e.index] = e.expr.cvalue;
          } else {
            throw new HDLError(dt, `non-const expr in initarray`);
          }
        }
      }
      return arr;
    }
    throw new HDLError(dt, `no default value for var type: ${vardef.name}`);
  }

  constValue(expr: HDLExpr): number {
    if (isConstExpr(expr)) {
      return expr.cvalue;
    } else {
      throw new HDLError(expr, `no const value for expr`);
    }
  }

  block2js(block: HDLBlock): string {
    return this.expr2js(block);
  }

  expr2js(e: HDLExpr, options?: { store?: boolean; cond?: boolean }): string {
    if (e == null) {
      return '/*null*/'; // TODO
    }
    if (isVarRef(e)) {
      if (this.curconsts[e.refname] != null && !(options || {}).store) {
        this.constused++;
        return `${this.curconsts[e.refname]}`;
      } else if (this.locals[e.refname]) {
        return `${e.refname}`;
      } else if (this.globals[e.refname]) {
        return `o.${e.refname}`;
      } else throw new HDLError(e, `cannot find variable '${e.refname}'`);
    } else if (isVarDecl(e)) {
      this.locals[e.name] = e;
      let s = `var ${e.name}`;
      if (e.constValue != null) {
        s += ` = ${this.constValue(e)}`; // TODO?
      } else if (e.initValue != null) {
        // TODO?
        throw new HDLError(e, `can't init array here`);
      } else if (isLogicType(e.dtype) && e.dtype.left > 31) {
        // TODO: hack for big ints ($readmem)
        s += ` = []`;
      }
      return s;
    } else if (isConstExpr(e)) {
      return `0x${e.cvalue.toString(16)}`;
    } else if (isBigConstExpr(e)) {
      return e.bigvalue.toString(); // TODO?
    } else if (isTriop(e)) {
      switch (e.op) {
        case 'if':
          if (e.right == null || (isBlock(e.right) && e.right.exprs.length == 0))
            return `if (${this.expr2js(e.cond, { cond: true })}) { ${this.expr2js(e.left)} }`;
          else
            return `if (${this.expr2js(e.cond, { cond: true })}) { ${this.expr2js(
              e.left,
            )} } else { ${this.expr2js(e.right)} }`;
        case 'cond':
        case 'condbound':
          return `(${this.expr2js(e.cond, { cond: true })} ? ${this.expr2js(
            e.left,
          )} : ${this.expr2js(e.right)})`;
        default:
          throw new HDLError(e, `unknown triop ${e.op}`);
      }
    } else if (isBinop(e)) {
      switch (e.op) {
        case 'contassign':
        case 'assign':
        case 'assignpre':
        case 'assigndly':
        case 'assignpost':
          return `${this.expr2js(e.right, { store: true })} = ${this.expr2js(e.left)}`;
        case 'arraysel':
        case 'wordsel':
          return `${this.expr2js(e.left)}[${this.expr2js(e.right)}]`;
        case 'changedet':
          // __req |= ((vlTOPp->control_test_top__02Ehsync ^ vlTOPp->__Vchglast__TOP__control_test_top__02Ehsync)
          // vlTOPp->__Vchglast__TOP__control_test_top__02Ehsync = vlTOPp->control_test_top__02Ehsync;
          return `$$req |= (${this.expr2js(e.left)} ^ ${this.expr2js(e.right)}); ${this.expr2js(
            e.right,
          )} = ${this.expr2js(e.left)}`;
        default:
          var jsop = OP2JS[e.op];
          if (!jsop) {
            throw new HDLError(e, `unknown binop ${e.op}`);
          }
          if (jsop.startsWith('?')) {
            jsop = jsop.substr(1);
            if (!options || !options.cond) {
              return `((${this.expr2js(e.left)} ${jsop} ${this.expr2js(e.right)})?1:0)`;
            }
          }
          return `(${this.expr2js(e.left)} ${jsop} ${this.expr2js(e.right)})`;
      }
    } else if (isUnop(e)) {
      switch (e.op) {
        case 'ccast': // TODO: cast ints, cast bools?
          return this.expr2js(e.left);
        case 'creturn':
          return `return ${this.expr2js(e.left)}`;
        case 'creset':
          return this.expr2reset(e.left);
        case 'not':
          return `(~${this.expr2js(e.left)})`;
        //return `(${this.expr2js(e.left)}?0:1)`;
        case 'negate':
          return `(-${this.expr2js(e.left)})`;
        case 'extends':
          let shift = 32 - (e as HDLExtendop).widthminv;
          return `((${this.expr2js(e.left)} << ${shift}) >> ${shift})`;
        case 'redxor':
          return `this.$$${e.op}(${this.expr2js(e.left)})`;
        default:
          throw new HDLError(e, `unknown unop ${e.op}`);
      }
    } else if (isBlock(e)) {
      // TODO: { e } ?
      var body = e.exprs.map((x) => this.expr2js(x)).join(';\n');
      if (e.name) {
        if (e.name.startsWith('_change_request')) {
          return `var $$req = 0;\n${body}\n;return $$req;`;
        } else if (e.blocktype == 'sformatf') {
          var args = e.exprs.map((x) => this.expr2js(x));
          args = [JSON.stringify(e.name)].concat(args);
          return args.join(', ');
        }
      }
      return body;
    } else if (isWhileop(e)) {
      return `for (${this.expr2js(e.precond)}; ${this.expr2js(e.loopcond)}; ${this.expr2js(
        e.inc,
      )}) { ${this.expr2js(e.body)} }`;
    } else if (isFuncCall(e)) {
      if ((e.funcname == '$stop' || e.funcname == '$finish') && e.$loc) {
        return `this.${e.funcname}(o, ${JSON.stringify(e.$loc)})`;
      } else if (e.args == null || e.args.length == 0) {
        return `this.${e.funcname}(o)`;
      } else {
        return `this.${e.funcname}(o, ${e.args.map((arg) => this.expr2js(arg)).join(', ')})`;
      }
    }
    console.log(e);
    throw new Error(`unrecognized expr: ${JSON.stringify(e)}`);
  }

  expr2reset(e: HDLExpr) {
    if (isVarRef(e)) {
      if (this.curconsts[e.refname] != null) {
        return `${e.refname}`;
      } else if (isLogicType(e.dtype)) {
        if (e.dtype.left <= 31) return `${this.expr2js(e)} = 0`;
        else return `${this.expr2js(e)} = BigInt(0)`;
      } else if (isArrayType(e.dtype)) {
        if (isLogicType(e.dtype.subtype)) {
          return `${this.expr2js(e)}.fill(0)`;
        } else if (isArrayType(e.dtype.subtype) && isLogicType(e.dtype.subtype.subtype)) {
          return `${this.expr2js(e)}.forEach((a) => a.fill(0))`;
        } else {
          // TODO: 3d arrays?
          throw new HDLError(e, `unsupported data type for reset: ${JSON.stringify(e.dtype)}`);
        }
      }
    } else {
      throw new HDLError(e, `can only reset var refs`);
    }
  }

  // runtime methods
  // TODO: $time, $display, etc

  $finish(o, loc) {
    if (!this.finished) {
      console.log('Simulation $finish', loc);
      this.finished = true;
    }
  }

  $stop(o, loc) {
    if (!this.stopped) {
      console.log('Simulation $stop', loc);
      this.stopped = true;
    }
  }

  $rand(o): number {
    return Math.random() | 0;
  }

  $display(o, fmt, ...args) {
    // TODO: replace args, etc
    console.log(fmt, args);
  }

  // TODO: implement arguments, XML
  $readmem(o, filename, memp, lsbp, msbp, ishex) {
    // parse filename from 32-bit values into characters
    var barr = [];
    for (var i = 0; i < filename.length; i++) {
      barr.push((filename[i] >> 0) & 0xff);
      barr.push((filename[i] >> 8) & 0xff);
      barr.push((filename[i] >> 16) & 0xff);
      barr.push((filename[i] >> 24) & 0xff);
    }
    barr = barr.filter((x) => x != 0); // ignore zeros
    barr.reverse(); // reverse it
    var strfn = byteArrayToString(barr); // convert to string
    // parse hex/binary file
    var strdata = this.getFileData(strfn) as string;
    if (strdata == null) throw new HDLError(null, "Could not $readmem '" + strfn + "'");
    var data = strdata
      .split('\n')
      .filter((s) => s !== '')
      .map((s) => parseInt(s, ishex ? 16 : 2));
    console.log('$readmem', ishex, strfn, data.length);
    // copy into destination array
    if (memp === null) throw new HDLError(null, 'No destination array to $readmem ' + strfn);
    if (memp.length < data.length)
      throw new HDLError(null, 'Destination array too small to $readmem ' + strfn);
    for (i = 0; i < data.length; i++) memp[i] = data[i];
  }

  $time(o) {
    return new Date().getTime() - this.resetStartTimeMsec; // TODO: timescale
  }

  //

  isStopped() {
    return this.stopped;
  }
  isFinished() {
    return this.finished;
  }

  tick() {
    (this.state as any).clk ^= 1;
    this.eval();
  }

  get(varname: string) {
    return this.state[varname];
  }

  set(varname: string, value) {
    if (varname in this.state) {
      this.state[varname] = value;
    }
  }

  saveState() {
    return safeExtend(true, {}, this.state);
  }

  getGlobals() {
    return this.saveState();
  }

  loadState(state) {
    safeExtend(true, this.state, state);
  }
}

const OP2JS: { [key: string]: string } = {
  eq: '?===',
  neq: '?!==',
  gt: '?>',
  lt: '?<',
  gte: '?>=',
  lte: '?<=',
  and: '&',
  or: '|',
  xor: '^',
  add: '+',
  sub: '-',
  shiftr: '>>>', // TODO?
  shiftl: '<<',
  // TODO: correct?
  mul: '*',
  moddiv: '%',
  div: '/',
  // TODO: signed versions? functions?
  muls: '*',
  moddivs: '%',
  divs: '/',
  gts: '?>',
  gtes: '?>=',
  lts: '?<',
  ltes: '?<=',
};
