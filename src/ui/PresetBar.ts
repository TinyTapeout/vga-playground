import { Project } from '../examples/Project';

export interface PresetBarHandle {
  clearActive(): void;
}

export interface PresetBarOptions {
  container: HTMLElement;
  examples: Project[];
  initialPreset?: string;
  onSelect: (example: Project) => void;
}

export function initPresetBar(opts: PresetBarOptions): PresetBarHandle {
  const { container, examples, initialPreset, onSelect } = opts;
  let activeButton: HTMLButtonElement | null = null;

  for (const example of examples) {
    const button = document.createElement('button');
    button.textContent = example.name;
    button.addEventListener('click', () => {
      activeButton?.classList.remove('active');
      button.classList.add('active');
      activeButton = button;
      button.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      onSelect(example);
      history.replaceState(null, '', `?preset=${example.id}`);
    });
    container.appendChild(button);

    if (initialPreset != null && example.id === initialPreset) {
      button.classList.add('active');
      activeButton = button;
    }
  }

  // If no initialPreset matched (or none was provided), activate the first button
  if (!activeButton) {
    const firstButton = container.querySelector('button');
    if (firstButton) {
      firstButton.classList.add('active');
      activeButton = firstButton;
    }
  }

  return {
    clearActive() {
      activeButton?.classList.remove('active');
      activeButton = null;
    },
  };
}
