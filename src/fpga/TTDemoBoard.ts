// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2024-2025, Tiny Tapeout LTD

import { LineBreakTransformer } from './LineBreakTransformer';
import ttFpga from './ttfpga.py?raw';

export interface ILogEntry {
  sent: boolean;
  text: string;
}

export class TTDemoBoard extends EventTarget {
  private reader?: ReadableStreamDefaultReader<string>;
  private readableStreamClosed?: Promise<void>;
  private writableStreamClosed?: Promise<void>;
  private writer?: WritableStreamDefaultWriter<string>;
  private binaryWriter?: WritableStreamDefaultWriter<Uint8Array>;

  boot = false;
  version: string | null = null;

  constructor(readonly port: SerialPort) {
    super();
  }

  private addLogEntry(entry: ILogEntry) {
    this.dispatchEvent(new CustomEvent<ILogEntry>('log', { detail: entry }));
    // TODO: implement log storage and trimming
  }

  async writeText(data: string) {
    if (this.binaryWriter) {
      this.binaryWriter.releaseLock();
      this.binaryWriter = undefined;
    }
    if (!this.writer) {
      const textEncoderStream = new TextEncoderStream();
      this.writer = textEncoderStream.writable.getWriter();
      this.writableStreamClosed = textEncoderStream.readable.pipeTo(this.port.writable);
    }
    await this.writer.write(data);
  }

  async writeBinary(data: Uint8Array) {
    if (this.writer) {
      await this.writer?.close();
      await this.writableStreamClosed;
      this.writer = undefined;
    }
    if (!this.binaryWriter) {
      this.binaryWriter = this.port.writable.getWriter();
    }
    await this.binaryWriter.write(data);
  }

  addLineListener(listener: (line: string) => void) {
    const abortController = new AbortController();
    this.addEventListener(
      'line',
      (e) => {
        listener((e as CustomEvent<string>).detail.trim());
      },
      { signal: abortController.signal },
    );
    return abortController;
  }

  async waitUntil(condition: (line: string) => boolean) {
    return new Promise<string>((resolve) => {
      const lineListener = this.addLineListener((line) => {
        if (condition(line)) {
          lineListener.abort();
          resolve(line);
        }
      });
    });
  }

  async sendCommand(command: string, log = true) {
    if (log) {
      this.addLogEntry({ text: command, sent: true });
    }
    await this.writeText(`${command}\x04`);
  }

  async programBitstream(data: Uint8Array) {
    const waitForFpgaProg = () => this.waitUntil((line) => line.startsWith('fpga_prog='));
    const chunkSize = 4096;
    const fpgaProgPromise = waitForFpgaProg();
    await this.sendCommand(`program_bitstream()`);
    await fpgaProgPromise;
    for (let i = 0; i < data.length; i += chunkSize) {
      // measured transport speed: ~92kb/sec
      const chunkData = data.slice(i, i + chunkSize);
      await this.writeBinary(new TextEncoder().encode(`${chunkData.length}\r\n`));
      await this.writeBinary(chunkData);
      await waitForFpgaProg();
    }
    await this.writeBinary(new TextEncoder().encode(`0\r\n`));
    await waitForFpgaProg();
  }

  async syncState() {
    await this.sendCommand('dump_state()');
  }

  async setClock(hz: number) {
    await this.sendCommand(`set_clock_hz(${hz})`);
  }

  async enableUIIn(enable: boolean) {
    await this.sendCommand(`enable_ui_in(${enable ? 'True' : 'False'})`);
  }

  async writeUIIn(value: number) {
    await this.sendCommand(`write_ui_in(0b${value.toString(2).padStart(8, '0')})`);
  }

  async stopAllMonitoring() {
    await this.sendCommand('stop_all_monitoring()', false);
  }

  async resetProject() {
    await this.sendCommand('reset_project()');
  }

  async manualClock() {
    await this.sendCommand('manual_clock()');
  }

  private processInput(line: string) {
    if (line.startsWith('BOOT: ')) {
      this.boot = true;
      return;
    }

    this.dispatchEvent(new CustomEvent('line', { detail: line }));

    const [name, value] = line.split(/=(.+)/);
    switch (name) {
      case 'tt.sdk_version':
        this.version = value.replace(/^release_v/, '');
        break;
    }
  }

  async start() {
    void this.run();

    const textEncoderStream = new TextEncoderStream();
    this.writer = textEncoderStream.writable.getWriter();
    this.writableStreamClosed = textEncoderStream.readable.pipeTo(this.port.writable);
    if (this.version == null) {
      await this.writeText('\n'); // Send a newlines to get REPL prompt.
      await this.writeText('print(f"tt.sdk_version={tt.version}")\r\n');
      await new Promise((resolve) => setTimeout(resolve, 100)); // Wait for the response.
    }
    if (this.boot) {
      // Wait for the board to finish booting, up to 6 seconds:
      for (let i = 0; i < 60; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (this.version) {
          break;
        }
      }
    }
    if (this.version == null) {
      // The following sequence tries to ensure clean reboot:
      // Send Ctrl+C twice to stop any running program,
      // followed by Ctrl+B to exit RAW REPL mode (if it was entered),
      // and finally Ctrl+D to soft reset the board.
      await this.writeText('\x03\x03\x02');
      await this.writeText('\x04');
    }
    await this.writeText('\x01'); // Send Ctrl+A to enter RAW REPL mode.
    await this.writeText(ttFpga + '\x04'); // Send the ttfpga.py script and execute it.
    await this.syncState();
  }

  private async run() {
    const { port } = this;

    function cleanupRawREPL(value: string) {
      /* eslint-disable no-control-regex */
      return (
        value
          // Remove the OK responses:
          .replace(/^(\x04+>OK)+\x04*/, '')
          // Remove ANSI escape codes:
          .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      );
      /* eslint-enable no-control-regex */
    }

    while (port.readable) {
      const textDecoder = new TextDecoderStream();
      this.readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
      const [stream1, stream2] = textDecoder.readable.tee();
      this.reader = stream1
        .pipeThrough(new TransformStream(new LineBreakTransformer()))
        .getReader();

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await this.reader.read();
          if (done) {
            this.reader.releaseLock();
            return;
          }
          if (value) {
            const cleanValue = cleanupRawREPL(value);
            this.processInput(cleanValue);
            this.addLogEntry({ text: cleanValue, sent: false });
          }
        }
      } catch (error) {
        console.error('SerialReader error:', error);
        this.dispatchEvent(new Event('close'));
      } finally {
        this.reader.releaseLock();
      }
    }
  }

  async close() {
    await this.reader?.cancel();
    await this.readableStreamClosed?.catch(() => {});

    try {
      await this.stopAllMonitoring();
      await this.writeText('\x03\x03\x02'); // Stop any running code and exit the RAW REPL mode.
    } catch (e) {
      console.warn('Failed to exit RAW REPL mode:', e);
    }

    await this.writer?.close();
    await this.writableStreamClosed?.catch(() => {});
    await this.binaryWriter?.close();

    await this.port.close();
    this.dispatchEvent(new Event('close'));
  }
}
