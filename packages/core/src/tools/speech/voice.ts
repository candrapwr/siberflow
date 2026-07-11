import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { randomBytes } from "node:crypto";
import type { Tool, ToolContext } from "../base.js";
import { resolveWithin } from "../file/path-utils.js";
import { runPython, formatPythonResult } from "../python-runner.js";

/**
 * Speech tools (text_to_speech + speech_to_text) — backed by Python libraries:
 *   - text_to_speech uses `edge-tts` (Microsoft Edge neural voices, no API key)
 *   - speech_to_text uses `speech_recognition` (Google Web Speech, no API key)
 *
 * Both tools shell out to `python3` via a generated temp script (the shared
 * `runPython` runner). They are filesystem-group tools: text_to_speech writes
 * its .mp3 into the workdir, and speech_to_text reads an audio file from the
 * workdir (so the sandbox applies). Because they invoke Python, the host must
 * have python3 + the libraries installed. If anything is missing, the FULL
 * python stderr is returned to the model as the tool result so it can diagnose
 * and explain the failure.
 *
 * Requirements on the host:
 *   - python3 on PATH
 *   - pip install edge-tts SpeechRecognition pydub
 *   - ffmpeg on PATH (for ogg→wav conversion in speech_to_text)
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
/** Default voice for text_to_speech (Indonesian male neural voice). */
const DEFAULT_VOICE = "id-ID-ArdiNeural";
/** Default recognition language for speech_to_text. */
const DEFAULT_LANGUAGE = "id-ID";

interface TtsArgs {
  text: string;
  voice: string;
  rate?: string;
  outputPath: string;
}

interface SttArgs {
  path: string;
  language: string;
}

export const textToSpeechTool: Tool = {
  name: "text_to_speech",
  description:
    "Convert text to a spoken-audio MP3 via Edge neural TTS (voice: id-ID-ArdiNeural, Indonesian male). " +
    "Writes to `outputPath` inside the workdir; optional `rate` adjusts speed (e.g. '+10%'). " +
    "Requires python3 + edge-tts on the host; if missing, the full error is returned.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to synthesize into speech." },
      voice: {
        type: "string",
        description: "Neural voice BCP-47 tag. Default and recommended: id-ID-ArdiNeural (Indonesian male).",
      },
      rate: {
        type: "string",
        description: "Speaking rate adjustment, e.g. '+10%' (faster) or '-5%' (slower). Optional.",
      },
      outputPath: {
        type: "string",
        description: "Output .mp3 path inside the project workdir (e.g. 'voice.mp3'). Required.",
      },
    },
    required: ["text", "outputPath"],
    additionalProperties: false,
  },
  async execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const args = parseTtsArgs(rawArgs);
    const outputPath = await resolveWithin(ctx.projectDir, args.outputPath);

    // Build a python script. The script writes to the resolved absolute path
    // so the file lands inside the workdir sandbox (resolveWithin enforced it).
    // We pass strings as base64 to avoid any shell/quote-escaping issues in the
    // generated python source.
    const textB64 = Buffer.from(args.text, "utf8").toString("base64");
    const voiceB64 = Buffer.from(args.voice, "utf8").toString("base64");
    const rateB64 = Buffer.from(args.rate ?? "", "utf8").toString("base64");
    const outB64 = Buffer.from(outputPath, "utf8").toString("base64");

    const script = `import base64, asyncio
text = base64.b64decode("${textB64}").decode("utf-8")
voice = base64.b64decode("${voiceB64}").decode("utf-8")
rate = base64.b64decode("${rateB64}").decode("utf-8")
out = base64.b64decode("${outB64}").decode("utf-8")
import edge_tts
async def main():
    kwargs = {}
    if rate:
        kwargs["rate"] = rate
    communicate = edge_tts.Communicate(text, voice, **kwargs)
    await communicate.save(out)
    print("Saved:", out)
asyncio.run(main())
`;
    const result = await runPython(script, ctx.projectDir, DEFAULT_TIMEOUT_MS);
    return formatPythonResult(result);
  },
};

export const speechToTextTool: Tool = {
  name: "speech_to_text",
  description:
    "Transcribe an audio file to text (Google Web Speech via SpeechRecognition). Non-wav formats (.ogg, .m4a, " +
    "etc.) are auto-converted to 16kHz mono WAV via ffmpeg first. Defaults to Indonesian (id-ID); `language` " +
    "overrides only if the user explicitly asks. Requires python3 + SpeechRecognition + ffmpeg; if missing, " +
    "the full error is returned.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the audio file inside the project workdir (.wav, .ogg, .oga, .mp3, .m4a). Required.",
      },
      language: {
        type: "string",
        description: "Recognition language BCP-47 tag. Default id-ID (Indonesian). Override only when explicitly requested.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const args = parseSttArgs(rawArgs);
    const inputPath = await resolveWithin(ctx.projectDir, args.path);
    const langB64 = Buffer.from(args.language, "utf8").toString("base64");
    const inB64 = Buffer.from(inputPath, "utf8").toString("base64");
    const ext = extname(inputPath).toLowerCase();
    const needsConvert = ![".wav"].includes(ext);

    // Unique temp wav path inside the OS tmpdir. We convert there and read it
    // back via SpeechRecognition. Kept out of the workdir so it doesn't litter
    // the project. Removed after the run.
    const wavTmp = join(tmpdir(), `siberflow-stt-${randomBytes(6).toString("hex")}.wav`);
    const wavB64 = Buffer.from(wavTmp, "utf8").toString("base64");

    const convertBlock = needsConvert
      ? `import base64, subprocess
wav_tmp = base64.b64decode("${wavB64}").decode("utf-8")
inp = base64.b64decode("${inB64}").decode("utf-8")
r = subprocess.run(["ffmpeg", "-y", "-i", inp, "-ar", "16000", "-ac", "1", wav_tmp], capture_output=True, text=True)
if r.returncode != 0:
    print("ffmpeg conversion failed:", r.stderr)
    raise SystemExit(2)
audio_file = wav_tmp
`
      : `audio_file = base64.b64decode("${inB64}").decode("utf-8")`;

    const script = `import base64, sys
${convertBlock}
lang = base64.b64decode("${langB64}").decode("utf-8")
import speech_recognition as sr
r = sr.Recognizer()
with sr.AudioFile(audio_file) as source:
    audio = r.record(source)
try:
    text = r.recognize_google(audio, language=lang)
    print("Hasil:", text)
except sr.UnknownValueError:
    print("Tidak bisa mengenali suara (audio terlalu pendek atau tidak jelas)")
except sr.RequestError as e:
    print("Error:", e)
`;
    const result = await runPython(script, ctx.projectDir, DEFAULT_TIMEOUT_MS);
    // Best-effort cleanup of the converted temp wav (if we created one).
    if (needsConvert) void rm(wavTmp, { force: true });
    return formatPythonResult(result);
  },
};

function parseTtsArgs(raw: unknown): TtsArgs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Arguments must be an object.");
  }
  const args = raw as Record<string, unknown>;
  const text = args.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("`text` is required and must be a non-empty string.");
  }
  const outputPath = args.outputPath;
  if (typeof outputPath !== "string" || outputPath.trim().length === 0) {
    throw new Error("`outputPath` is required and must be a non-empty string.");
  }
  return {
    text: text.trim(),
    outputPath: outputPath.trim(),
    ...(typeof args.voice === "string" && args.voice.trim() ? { voice: args.voice.trim() } : { voice: DEFAULT_VOICE }),
    ...(typeof args.rate === "string" && args.rate.trim() ? { rate: args.rate.trim() } : {}),
  };
}

function parseSttArgs(raw: unknown): SttArgs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Arguments must be an object.");
  }
  const args = raw as Record<string, unknown>;
  const path = args.path;
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("`path` is required and must be a non-empty string.");
  }
  return {
    path: path.trim(),
    ...(typeof args.language === "string" && args.language.trim() ? { language: args.language.trim() } : { language: DEFAULT_LANGUAGE }),
  };
}
