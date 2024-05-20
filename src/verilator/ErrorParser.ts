export interface IErrorMessage {
  type: 'warning' | 'error';
  warningClass?: string;
  file: string;
  line: number;
  column: number;
  endColumn?: number;
  message: string;
}

export class ErrorParser {
  readonly errors: IErrorMessage[] = [];

  constructor() {}

  feedLine(s: string) {
    if (s.startsWith('%Error: ')) {
      const matches = /%Error: ([^:]+):(\d+):(\d+): (.*)/.exec(s);
      if (matches) {
        this.errors.push({
          type: 'error',
          file: matches[1],
          line: parseInt(matches[2]),
          column: parseInt(matches[3]),
          message: matches[4],
        });
      }
    }
    if (s.startsWith('%Warning-')) {
      const matches = /%Warning-([^:]+): ([^:]+):(\d+):(\d+): (.*)/.exec(s);
      if (matches) {
        this.errors.push({
          type: 'warning',
          warningClass: matches[1],
          file: matches[2],
          line: parseInt(matches[3]),
          column: parseInt(matches[4]),
          message: matches[5],
        });
      }
    }
    const elipssisMatch = /\s+:? \.\.\. (.+)/.exec(s);
    if (elipssisMatch) {
      const lastError = this.errors[this.errors.length - 1];
      if (lastError) {
        lastError.message += '\n' + elipssisMatch[1].trim();
      }
    }
    if (s.startsWith('      |')) {
      const matches = /      \|\s*(\^~*)/.exec(s);
      const lastError = this.errors[this.errors.length - 1];
      if (lastError && matches) {
        lastError.endColumn = lastError.column + matches[1].length;
      }
    }
  }
}
