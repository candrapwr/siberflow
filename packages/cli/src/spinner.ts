const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

/**
 * Minimal terminal spinner. Disabled in non-TTY contexts (piped output).
 * Idempotent: start() and stop() are safe to call repeatedly.
 */
export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private label: string;

  constructor(label = "thinking…") {
    this.label = label;
  }

  setLabel(label: string): void {
    this.label = label;
    if (this.timer) this.draw();
  }

  start(): void {
    if (this.timer || !process.stdout.isTTY) return;
    process.stdout.write(HIDE_CURSOR);
    this.draw();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.draw();
    }, INTERVAL_MS);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    process.stdout.write(`\r\x1b[2K${SHOW_CURSOR}`);
  }

  private draw(): void {
    process.stdout.write(`\r${DIM}  ${FRAMES[this.frame]} ${this.label}${RESET}`);
  }
}
