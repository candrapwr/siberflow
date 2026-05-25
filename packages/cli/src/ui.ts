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

export interface BannerInfo {
  version: string;
  provider: string;
  model: string;
  projectDir: string;
  session: { label: string; messageCount: number } | null;
}

export const ui = {
  banner(info: BannerInfo): string {
    const logo = LOGO_LINES.map(
      (line, i) => `  ${LOGO_GRADIENT[i] ?? ""}${BOLD}${line}${RESET}`,
    ).join("\n");

    const sessionLine = info.session
      ? `${info.session.label} ${DIM}(${info.session.messageCount} msgs)${RESET}`
      : `${DIM}(new, unsaved — /name <label> to save)${RESET}`;

    const meta = [
      "",
      `  ${DIM}v${info.version}${RESET}  ${DIM}·${RESET}  ${YELLOW}${info.provider}${RESET}${DIM}/${RESET}${YELLOW}${info.model}${RESET}`,
      `  ${DIM}project${RESET}  ${info.projectDir} ${DIM}· sandbox${RESET}`,
      `  ${DIM}session${RESET}  ${sessionLine}`,
      "",
      `  ${DIM}/help · /list · /new · /exit${RESET}`,
      "",
    ].join("\n");

    return logo + "\n" + meta;
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
};
