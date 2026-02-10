import * as monaco from 'monaco-editor';
import { IErrorMessage } from '../verilator/ErrorParser';

type MarkerData = monaco.editor.IMarkerData;

export interface FileTabsOptions {
  container: HTMLElement;
  editorModel: monaco.editor.ITextModel;
  getSources: () => Record<string, string>;
  getEditorValue: () => string;
  setEditorValue: (value: string) => void;
}

export class FileTabs {
  currentFileName = 'project.v';
  private readonly markersPerFile: Record<string, MarkerData[]> = {};

  private readonly container: HTMLElement;
  private readonly getSources: () => Record<string, string>;
  private readonly getEditorValue: () => string;
  private readonly setEditorValue: (value: string) => void;
  private readonly tabContextMenu: HTMLDivElement;
  private readonly editorModel: monaco.editor.ITextModel;

  constructor(opts: FileTabsOptions) {
    this.container = opts.container;
    this.editorModel = opts.editorModel;
    this.getSources = opts.getSources;
    this.getEditorValue = opts.getEditorValue;
    this.setEditorValue = opts.setEditorValue;

    this.tabContextMenu = document.createElement('div');
    this.tabContextMenu.className = 'tab-context-menu';
    this.tabContextMenu.style.display = 'none';
    document.body.appendChild(this.tabContextMenu);

    document.addEventListener('click', () => {
      this.tabContextMenu.style.display = 'none';
    });
  }

  render() {
    const sources = this.getSources();
    this.container.innerHTML = '';
    for (const fileName of Object.keys(sources)) {
      const tab = document.createElement('button');
      const markers = this.markersPerFile[fileName] ?? [];
      const hasErrors = markers.some((m) => m.severity === monaco.MarkerSeverity.Error);
      const hasWarnings = !hasErrors && markers.length > 0;
      tab.textContent = fileName;
      if (hasErrors) {
        tab.classList.add('has-errors');
      } else if (hasWarnings) {
        tab.classList.add('has-warnings');
      }
      if (fileName === this.currentFileName) {
        tab.classList.add('active');
      }
      tab.addEventListener('click', () => {
        if (fileName !== this.currentFileName) {
          this.switchTo(fileName);
        }
      });
      tab.addEventListener('contextmenu', (e) => this.showContextMenu(e, fileName));
      this.container.appendChild(tab);
    }
    const addBtn = document.createElement('button');
    addBtn.textContent = '+';
    addBtn.classList.add('add-file');
    addBtn.title = 'Add new file';
    addBtn.addEventListener('click', () => {
      const name = prompt('New file name (must end with .v):', 'new_module.v');
      if (!name) return;
      if (!name.endsWith('.v')) {
        alert('File name must end with .v');
        return;
      }
      const sources = this.getSources();
      if (sources[name] != null) {
        alert('A file with that name already exists');
        return;
      }
      sources[this.currentFileName] = this.getEditorValue();
      sources[name] = '';
      this.currentFileName = name;
      this.setEditorValue('');
      this.render();
    });
    this.container.appendChild(addBtn);
  }

  switchTo(fileName: string) {
    const sources = this.getSources();
    sources[this.currentFileName] = this.getEditorValue();
    this.currentFileName = fileName;
    this.setEditorValue(sources[this.currentFileName]);
    this.render();
    this.updateEditorMarkers();
  }

  updateMarkers(errors: IErrorMessage[]) {
    for (const key of Object.keys(this.markersPerFile)) {
      delete this.markersPerFile[key];
    }
    for (const e of errors) {
      const file = e.file.replace(/^src\//, '');
      if (!this.markersPerFile[file]) {
        this.markersPerFile[file] = [];
      }
      this.markersPerFile[file].push(toMarker(e));
    }
    this.updateEditorMarkers();
    this.render();
  }

  updateEditorMarkers() {
    const markers = this.markersPerFile[this.currentFileName] ?? [];
    monaco.editor.setModelMarkers(this.editorModel, 'error', markers);
  }

  private showContextMenu(e: MouseEvent, fileName: string) {
    e.preventDefault();
    this.tabContextMenu.innerHTML = '';

    const renameItem = document.createElement('div');
    renameItem.textContent = 'Rename';
    renameItem.className = 'tab-context-menu-item';
    renameItem.addEventListener('click', () => {
      const newName = prompt('Rename file:', fileName);
      if (!newName || newName === fileName) return;
      if (!newName.endsWith('.v')) {
        alert('File name must end with .v');
        return;
      }
      const sources = this.getSources();
      if (sources[newName] != null) {
        alert('A file with that name already exists');
        return;
      }
      const content = sources[fileName];
      delete sources[fileName];
      sources[newName] = content;
      if (this.currentFileName === fileName) {
        this.currentFileName = newName;
      }
      this.render();
    });
    this.tabContextMenu.appendChild(renameItem);

    const sources = this.getSources();
    const fileCount = Object.keys(sources).length;
    if (fileCount > 1) {
      const deleteItem = document.createElement('div');
      deleteItem.textContent = 'Delete';
      deleteItem.className = 'tab-context-menu-item';
      deleteItem.addEventListener('click', () => {
        if (!confirm(`Delete "${fileName}"?`)) return;
        delete sources[fileName];
        if (this.currentFileName === fileName) {
          this.currentFileName = Object.keys(sources)[0];
          this.setEditorValue(sources[this.currentFileName]);
        }
        this.render();
      });
      this.tabContextMenu.appendChild(deleteItem);
    }

    this.tabContextMenu.style.display = 'block';
    this.tabContextMenu.style.left = `${e.clientX}px`;
    this.tabContextMenu.style.top = `${e.clientY}px`;
  }
}

function toMarker(e: {
  line: number;
  column: number;
  endColumn?: number;
  message: string;
  type: string;
}): MarkerData {
  return {
    startLineNumber: e.line,
    endLineNumber: e.line,
    startColumn: e.column,
    endColumn: e.endColumn ?? 999,
    message: e.message,
    severity: e.type === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
  };
}
