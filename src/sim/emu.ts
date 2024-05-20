export interface SourceLocation {
  line: number;
  label?: string;
  path?: string; // TODO: make mandatory?
  start?: number;
  end?: number;
  segment?: string;
  func?: string;
}

export class EmuHalt extends Error {
  $loc?: SourceLocation;
  squelchError = true;

  constructor(msg: string, loc?: SourceLocation) {
    super(msg);
    this.$loc = loc;
    Object.setPrototypeOf(this, EmuHalt.prototype);
  }
}
