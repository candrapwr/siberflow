import { ui } from "./ui.js";

/**
 * Streams raw tool-call JSON args directly to stdout as they arrive.
 * No parsing, no buffering — what the model emits is what you see.
 */
export class ToolCallRenderer {
  private readonly name: string;
  private argsOpen = false;

  constructor(name: string) {
    this.name = name;
    process.stdout.write(ui.toolHeader(name) + "\n");
  }

  feed(delta: string): void {
    if (!this.argsOpen) {
      process.stdout.write(ui.toolArgsStart());
      this.argsOpen = true;
    }
    process.stdout.write(delta);
  }

  finishArgs(): void {
    if (this.argsOpen) {
      process.stdout.write(ui.toolArgsEnd() + "\n");
      this.argsOpen = false;
    }
  }

  result(result: string): void {
    process.stdout.write(ui.toolResult(this.name, result) + "\n");
  }
}
