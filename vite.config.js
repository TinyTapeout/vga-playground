import { defineConfig } from 'vite';
import monacoEditorPlugin from 'vite-plugin-monaco-editor';

export default defineConfig({
  plugins: [
    monacoEditorPlugin.default({
      languageWorkers: ['editorWorkerService'],
    }),
  ],
  build: {
    target: 'esnext'
  },
  optimizeDeps: {
    exclude: ['@yowasp/yosys', '@yowasp/nextpnr-ice40'],
    esbuildOptions: {
      target: 'esnext',
    },
  },
  assetsInclude: ['**/*.wasm', '**/*.tar'],
});
