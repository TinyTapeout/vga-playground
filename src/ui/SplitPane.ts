import { readStoredNumber, writeStorage } from './storage';

export interface SplitPaneOptions {
  /** Flex container holding both panes and the splitter. */
  container: HTMLElement;
  /** The draggable handle between the panes. */
  splitter: HTMLElement;
  /** Smallest size, in pixels, the first pane may shrink to. */
  minFirstSize?: number;
  /** Smallest size, in pixels, the second pane may shrink to. */
  minSecondSize?: number;
}

const DEFAULT_FRACTION = 0.5;
const ROW_KEY = 'vga-playground.splitRow';
const COLUMN_KEY = 'vga-playground.splitColumn';
const KEYBOARD_STEP = 0.02;

/**
 * Splits `container` into two resizable panes. The first pane's share of the main
 * axis is published as the `--split-fraction` custom property, which the
 * stylesheet turns into a flex-basis; the second pane absorbs the remainder.
 *
 * The container switches between row and column layout responsively, so each
 * orientation keeps its own remembered fraction.
 */
export class SplitPane {
  private readonly container: HTMLElement;
  private readonly splitter: HTMLElement;
  private readonly minFirstSize: number;
  private readonly minSecondSize: number;
  private readonly columnQuery = window.matchMedia('(max-width: 799px)');

  private fraction = DEFAULT_FRACTION;

  constructor(opts: SplitPaneOptions) {
    this.container = opts.container;
    this.splitter = opts.splitter;
    this.minFirstSize = opts.minFirstSize ?? 200;
    this.minSecondSize = opts.minSecondSize ?? 200;

    this.splitter.setAttribute('role', 'separator');
    this.splitter.setAttribute('aria-label', 'Resize editor and display');
    this.splitter.tabIndex = 0;

    this.splitter.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.splitter.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.splitter.addEventListener('dblclick', () => this.setFraction(DEFAULT_FRACTION, true));

    this.columnQuery.addEventListener('change', () => this.loadFraction());
    this.loadFraction();
  }

  private get isColumn() {
    return this.columnQuery.matches;
  }

  private get storageKey() {
    return this.isColumn ? COLUMN_KEY : ROW_KEY;
  }

  /**
   * Size of the container along the axis being split. The fraction is relative to
   * this same total in CSS (`calc(var(--split-fraction) * 100%)`), so the handle
   * tracks the pointer exactly.
   */
  private containerSize() {
    const rect = this.container.getBoundingClientRect();
    return this.isColumn ? rect.height : rect.width;
  }

  private handleSize() {
    const rect = this.splitter.getBoundingClientRect();
    return this.isColumn ? rect.height : rect.width;
  }

  /** Keeps both panes above their pixel minimums when there is room for them. */
  private clamp(fraction: number) {
    const total = this.containerSize();
    if (total <= 0) {
      return Math.min(0.9, Math.max(0.1, fraction));
    }
    let min = this.minFirstSize / total;
    let max = (total - this.handleSize() - this.minSecondSize) / total;
    if (min > max) {
      // Too cramped to honour both minimums; fall back to an even split.
      min = max = DEFAULT_FRACTION;
    }
    return Math.min(max, Math.max(min, fraction));
  }

  private loadFraction() {
    this.splitter.setAttribute('aria-orientation', this.isColumn ? 'horizontal' : 'vertical');
    this.setFraction(readStoredNumber(this.storageKey, DEFAULT_FRACTION), false);
  }

  private setFraction(fraction: number, persist: boolean) {
    this.fraction = this.clamp(fraction);
    this.container.style.setProperty('--split-fraction', String(this.fraction));
    this.splitter.setAttribute('aria-valuenow', String(Math.round(this.fraction * 100)));
    if (persist) {
      writeStorage(this.storageKey, this.fraction.toFixed(4));
    }
  }

  private onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    this.splitter.setPointerCapture(e.pointerId);

    const rect = this.container.getBoundingClientRect();
    const total = this.containerSize();
    const handle = this.splitter.getBoundingClientRect();
    // Grab offset within the handle, so the splitter does not jump under the cursor.
    const grab = this.isColumn ? e.clientY - handle.top : e.clientX - handle.left;

    document.body.classList.add(this.isColumn ? 'split-resizing-y' : 'split-resizing-x');

    const onMove = (ev: PointerEvent) => {
      const offset = this.isColumn ? ev.clientY - rect.top - grab : ev.clientX - rect.left - grab;
      this.setFraction(total > 0 ? offset / total : DEFAULT_FRACTION, false);
    };
    const onUp = () => {
      this.splitter.removeEventListener('pointermove', onMove);
      this.splitter.removeEventListener('pointerup', onUp);
      this.splitter.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('split-resizing-x', 'split-resizing-y');
      writeStorage(this.storageKey, this.fraction.toFixed(4));
    };
    this.splitter.addEventListener('pointermove', onMove);
    this.splitter.addEventListener('pointerup', onUp);
    this.splitter.addEventListener('pointercancel', onUp);
  }

  private onKeyDown(e: KeyboardEvent) {
    const decrease = this.isColumn ? 'ArrowUp' : 'ArrowLeft';
    const increase = this.isColumn ? 'ArrowDown' : 'ArrowRight';

    if (e.key === decrease) {
      e.preventDefault();
      this.setFraction(this.fraction - KEYBOARD_STEP, true);
    } else if (e.key === increase) {
      e.preventDefault();
      this.setFraction(this.fraction + KEYBOARD_STEP, true);
    } else if (e.key === 'Home') {
      e.preventDefault();
      this.setFraction(DEFAULT_FRACTION, true);
    }
  }
}
