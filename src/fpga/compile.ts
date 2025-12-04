import { downloadURL } from '../exportProject';
import { IWorkerMessage, WorkerMessageType } from './worker-types';

export class FPGACompiler {
  private worker: Worker | null = null;
  private consoleElement: HTMLElement | null = null;
  private outputElement: HTMLPreElement | null = null;
  private compileButton: HTMLButtonElement | null = null;

  constructor() {
    this.consoleElement = document.getElementById('compile-console');
    this.outputElement = document.getElementById('compile-console-output') as HTMLPreElement;
    this.compileButton = document.getElementById('compile-button') as HTMLButtonElement;

    const closeButton = document.getElementById('compile-console-close');
    closeButton?.addEventListener('click', () => this.hideConsole());
  }

  private showConsole() {
    if (this.consoleElement) {
      this.consoleElement.style.display = 'flex';
    }
  }

  private hideConsole() {
    if (this.consoleElement) {
      this.consoleElement.style.display = 'none';
    }
  }

  private clearOutput() {
    if (this.outputElement) {
      this.outputElement.textContent = '';
    }
  }

  private appendOutput(text: string, className?: string) {
    if (this.outputElement) {
      const span = document.createElement('span');
      span.textContent = text;
      if (className) {
        span.className = className;
      }
      this.outputElement.appendChild(span);

      // Auto-scroll to bottom
      this.outputElement.scrollTop = this.outputElement.scrollHeight;
    }
  }

  private handleWorkerMessage(event: MessageEvent<IWorkerMessage>) {
    const message = event.data;

    switch (message.type) {
      case WorkerMessageType.Command:
        this.appendOutput(`\n$ ${message.command} ${message.args.join(' ')}\n`, 'info');
        break;

      case WorkerMessageType.OutputMessage:
        this.appendOutput(message.data, message.stream === 'stderr' ? 'error' : '');
        break;

      case WorkerMessageType.BitStream: {
        this.appendOutput('\n✓ Compilation successful!\n', 'success');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const fileName = `bitstream_${timestamp}.bin`;
        this.appendOutput(`Downloading ${fileName}...\n`, 'info');
        this.downloadBitstream(fileName, message.data);
        this.setCompiling(false);
        break;
      }

      case WorkerMessageType.Error:
        this.appendOutput(`\n✗ Error: ${message.message}\n`, 'error');
        this.setCompiling(false);
        break;
    }
  }

  private downloadBitstream(fileName: string, data: Uint8Array) {
    const buffer = new Uint8Array(data);
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    downloadURL(url, fileName);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private setCompiling(isCompiling: boolean) {
    if (this.compileButton) {
      this.compileButton.disabled = isCompiling;
      const svg = this.compileButton.querySelector('svg');
      const textContent = isCompiling ? 'Compiling...' : 'Compile';

      // Clear and rebuild button content
      this.compileButton.textContent = '';
      if (svg) {
        this.compileButton.appendChild(svg);
      }
      this.compileButton.appendChild(document.createTextNode(textContent));
    }
  }

  async compile(sources: Record<string, string>, topModule: string) {
    this.showConsole();
    this.clearOutput();
    this.setCompiling(true);

    this.appendOutput('Starting FPGA compilation...\n', 'info');
    this.appendOutput(`Top module: ${topModule}\n`, 'info');
    this.appendOutput(`Source files: ${Object.keys(sources).join(', ')}\n\n`, 'info');

    // Terminate any existing worker
    if (this.worker) {
      this.worker.terminate();
    }

    // Create new worker
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
    });

    this.worker.addEventListener('message', (event) => this.handleWorkerMessage(event));

    this.worker.addEventListener('error', (error) => {
      this.appendOutput(`\n✗ Worker error: ${error.message}\n`, 'error');
      this.setCompiling(false);
    });

    // Send compilation job to worker
    this.worker.postMessage({
      sources,
      topModule,
    });
  }

  dispose() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
