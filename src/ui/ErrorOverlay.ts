import { IErrorMessage } from '../verilator/ErrorParser';

export interface ErrorOverlayHandle {
  show(title: string, body: string): void;
  showCompileErrors(errors: IErrorMessage[]): void;
  hide(): void;
}

export function initErrorOverlay(container: HTMLElement): ErrorOverlayHandle {
  function show(title: string, body: string) {
    container.replaceChildren();
    const heading = document.createElement('strong');
    heading.textContent = title;
    container.append(heading, '\n\n' + body);
    container.hidden = false;
  }

  return {
    show,
    showCompileErrors(errors: IErrorMessage[]) {
      const message = errors
        .filter((e) => e.type !== 'warning')
        .map((e) => {
          const file = e.file.replace(/^src\//, '');
          const loc = file ? `${file}:${e.line}:${e.column}: ` : '';
          return loc + e.message;
        })
        .join('\n\n');
      show('Compilation Error', message);
    },
    hide() {
      container.hidden = true;
    },
  };
}
