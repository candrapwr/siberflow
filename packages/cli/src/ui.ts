const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

// 256-color cyan→blue gradient for the logo lines
const LOGO_GRADIENT = [
  "\x1b[38;5;51m",
  "\x1b[38;5;45m",
  "\x1b[38;5;39m",
  "\x1b[38;5;33m",
  "\x1b[38;5;27m",
  "\x1b[38;5;21m",
];

const LOGO_LINES = [
  "███████╗██╗██████╗ ███████╗██████╗ ███████╗██╗      ██████╗ ██╗    ██╗",
  "██╔════╝██║██╔══██╗██╔════╝██╔══██╗██╔════╝██║     ██╔═══██╗██║    ██║",
  "███████╗██║██████╔╝█████╗  ██████╔╝█████╗  ██║     ██║   ██║██║ █╗ ██║",
  "╚════██║██║██╔══██╗██╔══╝  ██╔══██╗██╔══╝  ██║     ██║   ██║██║███╗██║",
  "███████║██║██████╔╝███████╗██║  ██║██║     ███████╗╚██████╔╝╚███╔███╔╝",
  "╚══════╝╚═╝╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝     ╚══════╝ ╚═════╝  ╚══╝╚══╝ ",
];

export interface SplashInfo {
  version: string;
  provider: string;
  model: string;
  projectDir: string;
}

export const ui = {
  splashBanner(info: SplashInfo): string {
    const logo = LOGO_LINES.map(
      (line, i) => `  ${LOGO_GRADIENT[i] ?? ""}${BOLD}${line}${RESET}`,
    ).join("\n");

    const meta = [
      "",
      `  ${DIM}v${info.version}${RESET}  ${DIM}·${RESET}  ${YELLOW}${info.provider}${RESET}${DIM}/${RESET}${YELLOW}${info.model}${RESET}`,
      `  ${DIM}project${RESET}  ${info.projectDir} ${DIM}· sandbox${RESET}`,
    ].join("\n");

    return logo + "\n" + meta;
  },
  helpLine(): string {
    return `${DIM}/help · /list · /new · /exit${RESET}`;
  },
  prompt(): string {
    return `${BOLD}${GREEN}you${RESET} ${DIM}›${RESET} `;
  },
  assistantPrefix(): string {
    return `${BOLD}${MAGENTA}ai${RESET}  ${DIM}›${RESET} `;
  },
  toolHeader(name: string): string {
    return `${DIM}    ↳ ${YELLOW}${name}${RESET}`;
  },
  toolArgsStart(): string {
    return `      ${DIM}`;
  },
  toolArgsEnd(): string {
    return RESET;
  },
  toolResult(_name: string, result: string): string {
    const preview =
      result.length > 400
        ? result.slice(0, 400) + `\n…[+${result.length - 400} bytes]`
        : result;
    const indented = preview
      .split("\n")
      .map((l) => `      ${l}`)
      .join("\n");
    return `${DIM}${indented}${RESET}`;
  },
  info(text: string): string {
    return `${DIM}${text}${RESET}`;
  },
  error(text: string): string {
    return `${RED}error:${RESET} ${text}`;
  },
  taskList(tasks: ReadonlyArray<{ content: string; status: string }>): string {
    if (tasks.length === 0) return `${DIM}  (no tasks)${RESET}`;
    const lines = tasks.map((t) => {
      if (t.status === "completed") return `   ${GREEN}✔${RESET} ${DIM}${t.content}${RESET}`;
      if (t.status === "in_progress") return `   ${YELLOW}▶${RESET} ${BOLD}${t.content}${RESET}`;
      return `   ${DIM}○ ${t.content}${RESET}`;
    });
    return `${DIM}  tasks:${RESET}\n${lines.join("\n")}`;
  },
};
