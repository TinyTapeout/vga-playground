import { Project } from '../examples/Project';

export function initPresetBar(
  container: HTMLElement,
  examples: Project[],
  onSelect: (example: Project) => void,
) {
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
    });
    container.appendChild(button);
  }
  const firstButton = container.querySelector('button');
  if (firstButton) {
    firstButton.classList.add('active');
    activeButton = firstButton;
  }
}
