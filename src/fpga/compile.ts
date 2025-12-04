import { downloadURL } from '../exportProject';

interface StreamMessage {
  type: 'command' | 'stdout' | 'stderr' | 'error' | 'success';
  command?: string;
  args?: string[];
  data?: string;
  message?: string;
}

export class FPGACompiler {
  private apiUrl: string;
  private consoleElement: HTMLElement | null = null;
  private outputElement: HTMLPreElement | null = null;
  private compileButton: HTMLButtonElement | null = null;
  private abortController: AbortController | null = null;
  private pendingFragment: DocumentFragment | null = null;
  private scrollPending: boolean = false;

  constructor(apiUrl: string = 'http://localhost:8080') {
    this.apiUrl = apiUrl;
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
    this.pendingFragment = null;
  }

  private appendOutput(text: string, className?: string) {
    if (!this.outputElement) return;

    // Create fragment if it doesn't exist
    if (!this.pendingFragment) {
      this.pendingFragment = document.createDocumentFragment();
    }

    // Add span to fragment
    const span = document.createElement('span');
    span.textContent = text;
    if (className) {
      span.className = className;
    }
    this.pendingFragment.appendChild(span);

    // Schedule flush on next animation frame
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (!this.scrollPending) {
      this.scrollPending = true;
      requestAnimationFrame(() => {
        this.flushOutput();
      });
    }
  }

  private flushOutput() {
    if (!this.outputElement || !this.pendingFragment) {
      this.scrollPending = false;
      return;
    }

    // Check if user has scrolled up (with 10px threshold)
    const isNearBottom =
      this.outputElement.scrollHeight -
        this.outputElement.scrollTop -
        this.outputElement.clientHeight <
      10;

    // Append all pending content at once
    this.outputElement.appendChild(this.pendingFragment);
    this.pendingFragment = null;

    // Only auto-scroll if user was already at bottom
    if (isNearBottom) {
      this.outputElement.scrollTop = this.outputElement.scrollHeight;
    }

    this.scrollPending = false;
  }

  private handleStreamMessage(message: StreamMessage) {
    switch (message.type) {
      case 'command':
        this.appendOutput(`\n$ ${message.command} ${message.args?.join(' ')}\n`, 'info');
        break;

      case 'stdout':
        this.appendOutput(message.data || '', '');
        break;

      case 'stderr':
        this.appendOutput(message.data || '', 'error');
        break;

      case 'success': {
        this.appendOutput('\n✓ Compilation successful!\n', 'success');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const fileName = `bitstream_${timestamp}.bin`;
        this.appendOutput(`Downloading ${fileName}...\n`, 'info');

        // Decode base64 bitstream
        const base64Data = message.data?.replace('base64:', '') || '';
        const binaryData = this.base64ToBytes(base64Data);
        this.downloadBitstream(fileName, binaryData);
        this.setCompiling(false);
        break;
      }

      case 'error':
        this.appendOutput(`\n✗ Error: ${message.message}\n`, 'error');
        this.setCompiling(false);
        break;
    }
  }

  private base64ToBytes(base64: string): Uint8Array {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
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
    this.appendOutput(`Source files: ${Object.keys(sources).join(', ')}\n`, 'info');

    // Cancel any ongoing compilation
    if (this.abortController) {
      this.abortController.abort();
    }

    this.abortController = new AbortController();

    try {
      const response = await fetch(`${this.apiUrl}/api/compile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sources,
          topModule,
          freq: 25.179,
        }),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // Read SSE stream
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error('No response body');
      }

      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process SSE messages
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.substring(6);
            try {
              const message: StreamMessage = JSON.parse(data);
              this.handleStreamMessage(message);
            } catch (e) {
              console.error('Failed to parse SSE message:', e);
            }
          }
        }
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        this.appendOutput('\n✗ Compilation cancelled\n', 'error');
      } else {
        this.appendOutput(`\n✗ Error: ${error.message}\n`, 'error');
      }
      this.setCompiling(false);
    }
  }

  dispose() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    // Flush any pending output before disposal
    if (this.pendingFragment) {
      this.flushOutput();
    }
  }
}
