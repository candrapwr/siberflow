import type { AskUserRequest, Tool } from "../base.js";

interface Args {
  question: string;
  choices?: string[];
  allowFreeText?: boolean;
  defaultChoice?: string;
}

export const askUserTool: Tool = {
  name: "ask_user",
  description:
    "Ask the user a question when you need confirmation, a decision, or free-form input before proceeding. " +
    "Use this for: destructive-action confirmation (e.g. 'Delete 10 files?'), choosing between approaches " +
    "(e.g. 'TypeScript or JavaScript?'), disambiguating ambiguous requests, or requesting a value you can't " +
    "infer (e.g. a function name). The tool blocks until the user responds. " +
    "\n\nPARAMETERS:\n" +
    "- `question` (required): the question text shown to the user.\n" +
    "- `choices` (optional): predefined options rendered as buttons. Omit for free-text-only prompts.\n" +
    "- `allowFreeText` (optional, default false): also show a free-text input alongside choices.\n" +
    "- `defaultChoice` (optional): pre-selected option or input placeholder.\n\n" +
    "If the user cancels, the tool returns a cancellation message — stop the current task and await " +
    "further instructions. If interaction is unavailable (e.g. CLI without a UI), the tool returns a " +
    "fallback message — proceed with a safe default rather than asking again.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question or prompt to show the user.",
      },
      choices: {
        type: "array",
        items: { type: "string" },
        description: "Predefined options the user can pick from. Omit for a free-text-only prompt.",
      },
      allowFreeText: {
        type: "boolean",
        description: "Also show a free-text input in addition to choices. Default false.",
      },
      defaultChoice: {
        type: "string",
        description: "Optional default selection or input placeholder.",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = parseArgs(args);
    if (!ctx.askUser) {
      // No interactive UI available (e.g. CLI). Tell the model so it can pick
      // a safe default rather than looping on a question nobody can answer.
      return "User interaction is not available in this interface. Proceed with a safe default and note the assumption.";
    }
    const resp = await ctx.askUser(parsed);
    if (resp.status === "cancel") {
      return "The user cancelled the prompt. Stop the current task and await further instructions.";
    }
    return resp.answer;
  },
};

function parseArgs(args: unknown): AskUserRequest {
  if (!args || typeof args !== "object") {
    throw new Error("arguments must be an object");
  }
  const input = args as Record<string, unknown>;

  const question = input.question;
  if (typeof question !== "string" || question.trim() === "") {
    throw new Error("`question` is required and must be a non-empty string");
  }

  const result: AskUserRequest = { question };

  if (input.choices !== undefined) {
    if (!Array.isArray(input.choices) || !input.choices.every((c) => typeof c === "string")) {
      throw new Error("`choices` must be an array of strings");
    }
    if (input.choices.length > 0) {
      result.choices = input.choices as string[];
    }
  }

  if (input.allowFreeText !== undefined) {
    if (typeof input.allowFreeText !== "boolean") {
      throw new Error("`allowFreeText` must be a boolean");
    }
    result.allowFreeText = input.allowFreeText;
  }

  if (input.defaultChoice !== undefined) {
    if (typeof input.defaultChoice !== "string") {
      throw new Error("`defaultChoice` must be a string");
    }
    result.defaultChoice = input.defaultChoice;
  }

  return result;
}
