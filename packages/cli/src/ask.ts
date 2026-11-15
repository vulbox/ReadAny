/**
 * readany ask — run the in-app reading agent for one prompt, read-only.
 *
 * Reuses the desktop reading agent (streamReadingAgent) with:
 * - the AIConfig persisted by the desktop app (readany-store/settings.json)
 * - a language resolved without the webview (READANY_LANG → OS locale)
 * - explicit book context modes (--book / --current / library-wide)
 * - a read-only tool provider that drops library write tools
 * - the shared StreamingChat execution and message pipeline (one send per prompt)
 *
 * Stateless by default. Pass --thread <id> (or --continue) to persist the
 * conversation in CLI-owned files under readany-store/cli-threads/; the
 * app's chat database and reader context are never written.
 */
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolveActiveEndpoint } from "@readany/core/ai";
import type { AgentStreamEvent, ReadingAgentOptions } from "@readany/core/ai/agents/reading-agent";
import { hydrateReadingContextFromSnapshot } from "@readany/core/ai/reading-context-service";
import { detectOperationType, generateSemanticContext } from "@readany/core/ai/semantic-context";
import { getBuiltinSkills } from "@readany/core/ai/skills/builtin-skills";
import { getToolResultError } from "@readany/core/ai/tool-result";
import { getAvailableTools as coreGetAvailableTools } from "@readany/core/ai/tools";
import { getPlatformService } from "@readany/core/services";
import type { AIConfig, Book, ReadingContext, SemanticContext, Skill, Thread } from "@readany/core/types";
import {
  type ParsedCommand,
  InvalidCommandOptionError,
  getBooleanOption,
  getNumberOption,
  getRequiredStringOption,
} from "./commands.js";
import { registerCliFallbackContentProvider } from "./fallback-content.js";
import { configureRagSearchForCli } from "./rag-config.js";
import type { CommandResult } from "./result.js";
import { failure, success } from "./result.js";

/** Library write tools removed from the CLI agent — `ask` is read-only. */
const ASK_WRITE_TOOL_NAMES = new Set([
  "tagBooks",
  "updateBookMetadata",
  "manageBookGroups",
  "manageBookTags",
  "classifyBooks",
]);

const SUPPORTED_LANGUAGES = ["zh-TW", "zh", "ja", "ko", "fr", "es", "en"] as const;
export type AskLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Legacy flags may request one execution, never an automatic continuation. */
export const DEFAULT_ASK_ROUNDS = 1;
export const MAX_ASK_ROUNDS = 1;

/**
 * Core's read-only markers for "this turn cannot continue with tools":
 * buildRepeatedToolCallResult(reason: "limit") and the recursion-stop notice
 * (packages/core reading-agent.ts). Tool results arrive as objects or JSON
 * strings depending on the provider path, so accept both.
 */
function isToolBudgetExhaustedResult(result: unknown): boolean {
  let parsed: unknown = result;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return false;
    }
  }
  if (!parsed || typeof parsed !== "object") return false;
  const record = parsed as Record<string, unknown>;
  if (record.stopToolCalls === true && record.repeatedToolCall === true) {
    return record.reason === "Tool execution limit reached for this turn.";
  }
  return typeof record.notice === "string" && record.notice.includes("本轮检索步骤过多");
}

/** Core reports output-limit truncation with a stable error message. */
function isOutputLimitError(error: string): boolean {
  return error.toLowerCase().includes("output limit");
}

export type AskCitation = Extract<AgentStreamEvent, { type: "citation" }>["citation"];

export type AskToolCall = {
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
};

export type AskArtifact = {
  type: "mindmap";
  format: "markmap";
  title: string;
  markdown: string;
  stats?: { nodeCount: number; maxDepth: number };
};

export type AskResult = {
  answer: string;
  citations: AskCitation[];
  artifacts: AskArtifact[];
  toolCalls: AskToolCall[];
  bookId: string | null;
  contextTimestamp: number | null;
  /** One shared chat execution per user prompt. Kept for JSON compatibility. */
  rounds: number;
  /** Present when --thread/--continue persisted this conversation. */
  threadId?: string;
};

export interface AskCommandOptions {
  prompt: string;
  bookId?: string;
  current: boolean;
  deepThinking: boolean;
  spoilerFree: boolean;
  json: boolean;
  /** Include internal tool results and diagnostic logs only when requested. */
  debug?: boolean;
  /** Persist round evidence separately from the user-facing result. */
  traceFile?: string;
  maxRounds: number;
  /** Named conversation thread to create or continue (--thread). */
  threadId?: string;
  /** Continue the most recently used thread (--continue). */
  continueThread: boolean;

}

/**
 * Map a parsed CLI command (`readany ask …` or the standalone `readany-ask …`
 * entrypoint) to runAsk options. Single source of flag semantics for both.
 */
export function askOptionsFromCommand(command: ParsedCommand): AskCommandOptions {
  if (getBooleanOption(command, "thorough", false)) {
    throw new InvalidCommandOptionError("--thorough is no longer supported: ask forwards the original prompt to the shared chat service.");
  }
  return {
    prompt: command.args.join(" "),
    bookId: getRequiredStringOption(command, "book"),
    current: getBooleanOption(command, "current", false),
    deepThinking: getBooleanOption(command, "deep-thinking", false),
    spoilerFree: getBooleanOption(command, "spoiler-free", false),
    json: command.json,
    debug: getBooleanOption(command, "debug", false),
    traceFile: getRequiredStringOption(command, "trace-file"),
    maxRounds: getNumberOption(command, "max-rounds", DEFAULT_ASK_ROUNDS, {
      min: 1,
      max: MAX_ASK_ROUNDS,
    }),
    threadId: getRequiredStringOption(command, "thread"),
    continueThread: getBooleanOption(command, "continue", false),
  };
}

/** Failure with a stable CLI error code (usage/config/agent failures). */
class AskFailureError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

// --- Thread memory (CLI-owned JSON files; the app's database is never touched) ---

const THREAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const THREADS_DIR_NAME = "cli-threads";
/** How many user/assistant pairs a thread file keeps on disk. */
const THREAD_MAX_STORED_PAIRS = 50;

type AskThreadTurn = {
  role: "user" | "assistant";
  content: string;
  /** Stored on assistant turns so replays can re-inject citation quotes. */
  citations?: AskCitation[];
  artifacts?: AskArtifact[];
};

type AskThread = {
  id: string;
  bookId: string | null;
  createdAt: number;
  updatedAt: number;
  turns: AskThreadTurn[];
  /** Legacy stored memory, passed through to the shared message pipeline. */
  memorySummary?: string;
  /** How many leading turns (messages) are already covered by memorySummary. */
  memoryMessageCount?: number;
};

function createAskThread(id: string): AskThread {
  const now = Date.now();
  return { id, bookId: null, createdAt: now, updatedAt: now, turns: [] };
}

/** Keep the last `maxPairs` user/assistant pairs of a conversation. */
function capThreadTurns(turns: AskThreadTurn[], maxPairs: number): AskThreadTurn[] {
  const maxMessages = Math.max(1, maxPairs) * 2;
  return turns.length > maxMessages ? turns.slice(-maxMessages) : turns;
}

async function askThreadDir(): Promise<string> {
  const platform = getPlatformService();
  const appData = await platform.getAppDataDir();
  return platform.joinPath(appData, "readany-store", THREADS_DIR_NAME);
}

async function loadAskThread(id: string): Promise<AskThread | null> {
  if (!THREAD_ID_RE.test(id)) {
    throw new AskFailureError(
      "invalid_thread",
      "--thread allows letters, digits, - and _ only (max 64 chars)",
    );
  }
  const platform = getPlatformService();
  const file = await platform.joinPath(await askThreadDir(), `${id}.json`);
  if (!(await platform.exists(file))) return null;
  try {
    const parsed = JSON.parse(await platform.readTextFile(file)) as Partial<AskThread>;
    if (!parsed || !Array.isArray(parsed.turns)) return null;
    return {
      id,
      bookId: typeof parsed.bookId === "string" ? parsed.bookId : null,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      turns: parsed.turns
        .filter(
          (turn): turn is AskThreadTurn =>
            (turn?.role === "user" || turn?.role === "assistant") &&
            typeof turn?.content === "string",
        )
        .map((turn) => ({
          role: turn.role, content: turn.content,
          ...(Array.isArray(turn.citations) && turn.citations.length > 0 ? { citations: turn.citations } : {}),
          ...(Array.isArray(turn.artifacts) && turn.artifacts.length > 0 ? { artifacts: turn.artifacts } : {}),
        })),
      memorySummary: typeof parsed.memorySummary === "string" ? parsed.memorySummary : undefined,
      memoryMessageCount:
        typeof parsed.memoryMessageCount === "number" ? parsed.memoryMessageCount : undefined,
    };
  } catch {
    throw new AskFailureError(
      "thread_corrupt",
      `Thread ${id} could not be read. Start a new one with a different --thread id.`,
    );
  }
}

async function saveAskThread(thread: AskThread): Promise<void> {
  const platform = getPlatformService();
  const dir = await askThreadDir();
  await platform.mkdir(dir);
  await platform.writeTextFile(
    await platform.joinPath(dir, `${thread.id}.json`),
    JSON.stringify(thread, null, 2),
  );
  await platform.writeTextFile(
    await platform.joinPath(dir, "latest.json"),
    JSON.stringify({ threadId: thread.id, updatedAt: thread.updatedAt }, null, 2),
  );
}

async function loadLatestAskThreadId(): Promise<string | null> {
  const platform = getPlatformService();
  const file = await platform.joinPath(await askThreadDir(), "latest.json");
  if (!(await platform.exists(file))) return null;
  try {
    const parsed = JSON.parse(await platform.readTextFile(file)) as { threadId?: unknown };
    return typeof parsed.threadId === "string" && THREAD_ID_RE.test(parsed.threadId)
      ? parsed.threadId
      : null;
  } catch {
    return null;
  }
}

type DataApi = typeof import("./data.js");

/** Map a locale the same way initI18nLanguage maps the system locale. */
export function mapLocaleToAskLanguage(locale: string | null | undefined): AskLanguage {
  if (!locale) return "en";
  const lc = locale.toLowerCase();
  if (lc.startsWith("zh-tw") || lc.startsWith("zh-hk") || lc.startsWith("zh-hant")) {
    return "zh-TW";
  }
  if (lc.startsWith("zh")) return "zh";
  if (lc.startsWith("ja")) return "ja";
  if (lc.startsWith("ko")) return "ko";
  if (lc.startsWith("fr")) return "fr";
  if (lc.startsWith("es")) return "es";
  return "en";
}

function getSystemLocale(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (locale) return locale;
  } catch {
    // Intl unavailable — fall through to environment variables
  }
  return env.LC_ALL || env.LC_MESSAGES || env.LANG || undefined;
}

/** READANY_LANG wins; otherwise map the OS locale like initI18nLanguage does. */
export function resolveAskLanguage(env: NodeJS.ProcessEnv = process.env): AskLanguage {
  const fromEnv = env.READANY_LANG?.trim();
  if (fromEnv) return mapLocaleToAskLanguage(fromEnv);
  return mapLocaleToAskLanguage(getSystemLocale(env));
}

/**
 * Wrap a tool provider so the write-side library tools never reach the agent.
 * Retrieval, analysis, annotations, citations, list/search/stats, and skill
 * prompt tools all stay available.
 */
export function createReadOnlyToolProvider(
  getAvailableTools: ReadingAgentOptions["getAvailableTools"] = coreGetAvailableTools,
): ReadingAgentOptions["getAvailableTools"] {
  return (options) =>
    getAvailableTools(options).filter((tool) => !ASK_WRITE_TOOL_NAMES.has(tool.name));
}

type PersistedSettingsState = {
  aiConfig?: AIConfig;
};

async function readPersistedAiConfig(): Promise<AIConfig | null> {
  // The desktop app always persists settings.json under the app-data root
  // (READANY_HOME when set, otherwise the OS app-data dir such as
  // %APPDATA%\com.readany.app) — never inside a custom library root.
  const platform = getPlatformService();
  const appData = await platform.getAppDataDir();
  const filePath = await platform.joinPath(appData, "readany-store", "settings.json");
  try {
    const parsed = JSON.parse(await platform.readTextFile(filePath)) as PersistedSettingsState;
    return parsed?.aiConfig ?? null;
  } catch {
    return null;
  }
}

/**
 * Validate the desktop AIConfig before any model call. resolveActiveEndpoint
 * messages name only the endpoint — never its API key or base URL.
 */
function assertAiConfigUsable(aiConfig: AIConfig | null): AIConfig {
  if (!aiConfig) {
    throw new AskFailureError(
      "ai_not_configured",
      "No AI settings found. Configure a model in the ReadAny app (Settings → AI) first; readany ask reuses that configuration.",
    );
  }
  try {
    resolveActiveEndpoint(aiConfig);
  } catch (error) {
    throw new AskFailureError(
      "ai_not_configured",
      error instanceof Error ? error.message : String(error),
    );
  }
  return aiConfig;
}

async function loadBookOrThrow(data: DataApi, bookId: string, env: NodeJS.ProcessEnv) {
  const book = await data.getBookById(bookId, env);
  if (!book) {
    throw new AskFailureError("book_not_found", `Book ${bookId} was not found`);
  }
  return book;
}

type AskBookContext = {
  book: Book | null;
  snapshot: ReadingContext | null;
};

/**
 * Resolve the three explicit book-context modes:
 * - --book only: answer about that book; attach the saved reader snapshot
 *   only when it belongs to that book.
 * - --current: require a saved reader snapshot and load its book.
 * - both: the snapshot must exist and match --book.
 * - neither: library-wide chat with no book and no snapshot.
 */
async function resolveAskBookContext(options: {
  data: DataApi;
  bookOption?: string;
  useCurrent: boolean;
  env: NodeJS.ProcessEnv;
}): Promise<AskBookContext> {
  const { data, bookOption, useCurrent, env } = options;
  const snapshotResult =
    bookOption || useCurrent ? await data.getReaderContextSnapshot({ env }) : null;
  const snapshot = snapshotResult?.available ? snapshotResult.context : null;

  if (bookOption && useCurrent && (!snapshot || snapshot.bookId !== bookOption)) {
    throw new AskFailureError(
      "context_mismatch",
      `--current requires the saved reader context to be for book ${bookOption}. Open that book in ReadAny, or drop --current.`,
    );
  }
  if (!bookOption && useCurrent && !snapshot) {
    throw new AskFailureError(
      "missing_reader_context",
      "No current reader context found. Open the book in ReadAny, or pass --book <book-id>.",
    );
  }

  if (useCurrent) {
    // Both verified modes land here: snapshot exists and matches bookOption.
    const snapshotBookId = bookOption ?? snapshot?.bookId;
    if (!snapshotBookId) {
      throw new AskFailureError(
        "missing_reader_context",
        "No current reader context found. Open the book in ReadAny, or pass --book <book-id>.",
      );
    }
    return { book: await loadBookOrThrow(data, snapshotBookId, env), snapshot };
  }
  if (bookOption) {
    const book = await loadBookOrThrow(data, bookOption, env);
    return { book, snapshot: snapshot?.bookId === bookOption ? snapshot : null };
  }
  return { book: null, snapshot: null };
}

/** Mirror the desktop session's skill loading: db skills merged over builtins. */
async function loadEnabledSkills(data: DataApi, env: NodeJS.ProcessEnv): Promise<Skill[]> {
  try {
    const dbSkills = await data.listSkills(env);
    const mergedBuiltins = getBuiltinSkills()
      .map((builtin) => {
        const dbSkill = dbSkills.find((s) => s.id === builtin.id);
        return dbSkill
          ? {
              ...builtin,
              description: dbSkill.description,
              enabled: dbSkill.enabled,
              prompt: dbSkill.prompt,
              updatedAt: dbSkill.updatedAt,
            }
          : builtin;
      })
      .filter((s) => s.enabled);
    const customSkills = dbSkills.filter((s) => !s.builtIn && s.enabled);
    return [...mergedBuiltins, ...customSkills];
  } catch {
    return [];
  }
}

/** Build the semantic context from the attached snapshot like the reader chat. */
function buildSemanticContextFromSnapshot(snapshot: ReadingContext): SemanticContext {
  return generateSemanticContext(
    {
      chapterTitle: snapshot.currentChapter?.title ?? "",
      currentCfi: snapshot.currentPosition?.cfi ?? "",
      visibleText: snapshot.surroundingText ?? "",
      selectedText: snapshot.selection?.text,
      recentHighlights: (snapshot.recentHighlights ?? []).map((highlight) => highlight.text),
    },
    detectOperationType({
      hasSelection: !!snapshot.selection?.text?.trim(),
      isSearching: false,
      isNavigating: false,
    }),
  );
}

/**
 * Approximate the live reader anchoring the in-app sidebar has when no saved
 * snapshot exists: resolve the book's stored reading position, pull that
 * chapter's opening text, and seed both the semantic context and the
 * reading-context service that the getCurrentChapter/getSurroundingContext
 * tools read. Best-effort — returns null when nothing can be resolved.
 */
async function buildPseudoReadingContext(
  data: DataApi,
  book: Book,
  env: NodeJS.ProcessEnv,
): Promise<{ semanticContext: SemanticContext; snapshot: ReadingContext } | null> {
  try {
    const chapters = await data.listIndexedChapters({ bookId: book.id, env });
    if (!chapters.length) return null;
    const progress =
      typeof book.progress === "number" ? Math.min(1, Math.max(0, book.progress)) : 0;
    const index = Math.min(chapters.length - 1, Math.max(0, Math.round(progress * chapters.length) - 1));
    const chapter = chapters[index];
    const detail = await data.getIndexedChapter({
      bookId: book.id,
      chapterId: chapter.id,
      contentLimit: 1600,
      env,
    });
    const visibleText = (detail?.content ?? chapter.title ?? "").replace(/\s+/g, " ").trim().slice(0, 900);
    if (!visibleText) return null;

    const semanticContext = generateSemanticContext(
      {
        chapterTitle: chapter.title,
        currentCfi: book.currentCfi ?? "",
        visibleText,
        selectedText: undefined,
        recentHighlights: [],
      },
      "reading",
    );
    const snapshot: ReadingContext = {
      bookId: book.id,
      bookTitle: book.meta.title,
      currentChapter: {
        index: chapter.index,
        title: chapter.title,
        href: "startCfi" in chapter && typeof chapter.startCfi === "string" ? chapter.startCfi : "",
      },
      currentPosition: { cfi: book.currentCfi ?? "", percentage: progress },
      surroundingText: visibleText,
      recentHighlights: [],
      operationType: "reading",
      timestamp: Date.now(),
    };
    return { semanticContext, snapshot };
  } catch {
    return null;
  }
}

type AgentTurnParams = {
  aiConfig: AIConfig;
  book: Book | null;
  semanticContext: SemanticContext | null;
  enabledSkills: Skill[];
  deepThinking: boolean;
  spoilerFree: boolean;
  userLanguage: AskLanguage;
  /** Durable thread memory, injected into the system prompt like the app. */
  memorySummary?: string;
};

async function openRoundTrace(path: string | undefined, secrets: string[]) {
  if (!path) return undefined;
  const filePath = resolve(path);
  await mkdir(dirname(filePath), { recursive: true });
  // Preserve earlier evidence rather than silently overwriting it.
  const file = await open(filePath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    throw new AskFailureError("trace_file_error", `Cannot create a new trace file: ${filePath} (${error.code})`);
  });
  const redactions = secrets.filter(Boolean);
  return {
    async write(type: string, data: unknown) {
      const record = JSON.stringify({ timestamp: new Date().toISOString(), type, data });
      const sanitized = redactions.reduce(
        (text, secret) => text.split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]"), record,
      );
      await file.appendFile(`${sanitized}\n`, "utf8");
    },
    close: () => file.close(),
  };
}

type ReadingAgentTurnParams = AgentTurnParams & {
  prompt: string;
  priorTurns: AskThreadTurn[];
  traceFile?: string;
  traceSecrets?: string[];
};

/** Use the same single-send execution and message pipeline as the app. */
async function runSharedChatTurn(params: ReadingAgentTurnParams): Promise<AskResult> {
  // Load the app execution layer under runAsk's diagnostic routing so import-time
  // library banners cannot pollute stdout.
  const { StreamingChat } = await import("@readany/core/ai/streaming");
  const { default: i18n } = await import("@readany/core/i18n");
  const trace = await openRoundTrace(params.traceFile, [
    ...params.aiConfig.endpoints.map((endpoint) => endpoint.apiKey || ""),
    ...(params.traceSecrets ?? []),
  ]);
  const previousLanguage = i18n.language;
  const threadId = "cli-turn";
  const now = Date.now();
  const thread: Thread = {
    id: threadId, title: "", bookId: params.book?.id, createdAt: now, updatedAt: now,
    memorySummary: params.memorySummary,
    messages: [...params.priorTurns, { role: "user" as const, content: params.prompt }].map((turn, index) => ({
      ...turn, id: `cli-message-${index}`, threadId, createdAt: now,
    })),
  };
  const citations: AskCitation[] = [];
  const artifacts: AskArtifact[] = [];
  const toolCalls: AskToolCall[] = [];
  let answer = "";
  let completed = false;
  let error: Error | null = null;
  let toolBudgetExhausted = false;
  let writes = Promise.resolve();
  let traceError: unknown;
  const recordEvent = (event: unknown) => {
    if (!trace) return;
    writes = writes.then(async () => {
      if (traceError) return;
      try { await trace.write("agent_event", { round: 1, event }); }
      catch (cause) { traceError = cause; }
    });
  };
  try {
    await i18n.changeLanguage(params.userLanguage);
    await trace?.write("run_start", {
      prompt: params.prompt, bookId: params.book?.id ?? null,
      model: params.aiConfig.activeModel, maxTokens: params.aiConfig.maxTokens,
      execution: "StreamingChat", maxRounds: 1,
    });
    await trace?.write("round_start", { round: 1, continuation: null, prompt: params.prompt, history: params.priorTurns });
    const stream = new StreamingChat();
    await stream.stream({
      thread, book: params.book, bookId: params.book?.id ?? null,
      semanticContext: params.semanticContext, enabledSkills: params.enabledSkills,
      isVectorized: params.book?.isVectorized ?? false, aiConfig: params.aiConfig,
      deepThinking: params.deepThinking, spoilerFree: params.spoilerFree,
      getAvailableTools: createReadOnlyToolProvider(),
      onToken: (token) => { answer += token; },
      onCitation: (citation) => { citations.push(citation); recordEvent({ type: "citation", citation }); },
      onToolCall: (name, args) => {
        toolCalls.push({ name, args }); recordEvent({ type: "tool_call", name, args });
      },
      onToolResult: (name, result) => {
        const pending = [...toolCalls].reverse().find((call) => call.name === name && call.result === undefined);
        if (pending) {
          pending.result = result;
          pending.error = getToolResultError(result) ?? undefined;
        }
        toolBudgetExhausted ||= isToolBudgetExhaustedResult(result);
        // Mirror the app's mindmap part extraction without exposing raw tool logs.
        if (name === "mindmap" && result && typeof result === "object") {
          const map = result as Record<string, unknown>;
          if (map.type === "mindmap" && typeof map.title === "string" && typeof map.markdown === "string") {
            const stats = map.stats as Record<string, unknown> | undefined;
            artifacts.push({
              type: "mindmap", format: "markmap", title: map.title, markdown: map.markdown,
              ...(stats && typeof stats.nodeCount === "number" && typeof stats.maxDepth === "number"
                ? { stats: { nodeCount: stats.nodeCount, maxDepth: stats.maxDepth } } : {}),
            });
          }
        }
        recordEvent({ type: "tool_result", name, result });
      },
      onComplete: (text) => { answer = text; completed = true; },
      onError: (cause) => { error = cause; recordEvent({ type: "error", error: cause.message }); },
    });
    await writes;
    if (traceError) throw traceError;
    const failureMessage = error ? (error as Error).message : completed ? null : "Shared chat stream ended without a terminal result";
    await trace?.write("round_end", {
      round: 1, answer, citations, artifacts, toolCallCount: toolCalls.length,
      pendingTools: toolCalls.filter((call) => call.result === undefined).map((call) => call.name),
      outputLimitTruncated: failureMessage ? isOutputLimitError(failureMessage) : false,
      toolBudgetExhausted, incompleteToolCalls: toolCalls.some((call) => call.result === undefined),
      fatal: failureMessage ? { code: "agent_error", message: failureMessage } : null,
    });
    if (failureMessage) throw new AskFailureError("agent_error", failureMessage, { answer, citations, artifacts, rounds: 1 });
    await trace?.write("run_end", { rounds: 1, completed: true, answerCharacters: answer.length });
    return { answer, citations, artifacts, toolCalls, bookId: params.book?.id ?? null, contextTimestamp: null, rounds: 1 };
  } catch (cause) {
    await writes;
    await trace?.write("run_error", { message: cause instanceof Error ? cause.message : String(cause) });
    throw cause;
  } finally {
    await trace?.close();
    await i18n.changeLanguage(previousLanguage || "en");
  }
}

function summarizeToolArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
      const shortened = text.length > 60 ? `${text.slice(0, 60)}…` : text;
      return `${key}=${shortened}`;
    })
    .join(", ");
}

function formatAskText(result: AskResult, debug = false): string {
  const lines = result.answer.trim() ? [result.answer.trim()] : result.artifacts.length ? [] : ["(no answer)"];
  for (const artifact of result.artifacts) {
    lines.push("", `## 思维导图：${artifact.title}`, "", artifact.markdown);
  }
  if (result.citations.length > 0) {
    lines.push("", "Citations:");
    result.citations.forEach((citation, index) => {
      const text =
        citation.text.length > 80 ? `${citation.text.slice(0, 80)}… (${citation.text.length} chars)` : citation.text;
      lines.push(`- [${citation.citationIndex ?? index + 1}] ${citation.chapterTitle}: ${text}`);
    });
  }
  if (debug && result.toolCalls.length > 0) {
    lines.push("", "Tool calls:");
    for (const call of result.toolCalls) {
      const status = call.error ? `error: ${call.error}` : "ok";
      lines.push(`- ${call.name}(${summarizeToolArgs(call.args)}) → ${status}`);
    }
  }
  if (debug && result.threadId) {
    lines.push("", `Thread: ${result.threadId}`);
  }
  return lines.join("\n");
}

export async function runAsk(
  options: AskCommandOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  // CLI calls run sequentially. Keep model/tool diagnostics out of the relay
  // response, including stderr that agent shell tools often merge into stdout.
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const diagnostic = options.debug ? original.error.bind(console) : () => {};
  console.log = console.info = console.warn = console.error = diagnostic;
  try {
    return await runAskInternal(options, env);
  } finally {
    Object.assign(console, original);
  }
}

async function runAskInternal(
  options: AskCommandOptions,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const prompt = options.prompt.trim();
  if (!prompt) return failure("missing_prompt", "ask requires a prompt");

  const data = await import("./data.js");
  await data.ensureCoreInitialized(env);

  try {
    // Thread memory lives in CLI-owned files and is resolved first so a
    // thread's remembered book can stand in for --book on follow-ups.
    if (options.threadId && options.continueThread) {
      return failure("invalid_option", "--thread and --continue cannot be combined");
    }
    let thread: AskThread | null = null;
    if (options.continueThread) {
      const latestId = await loadLatestAskThreadId();
      if (!latestId) {
        return failure(
          "missing_thread",
          "No previous ask thread to continue. Start one with --thread <id>.",
        );
      }
      thread = await loadAskThread(latestId);
      if (!thread) {
        return failure(
          "missing_thread",
          `Thread ${latestId} no longer exists. Start a new one with --thread <id>.`,
        );
      }
    } else if (options.threadId) {
      thread = (await loadAskThread(options.threadId)) ?? createAskThread(options.threadId);
    }

    const { book, snapshot } = await resolveAskBookContext({
      data,
      bookOption: options.bookId ?? thread?.bookId ?? undefined,
      useCurrent: options.current,
      env,
    });

    const aiConfig = assertAiConfigUsable(await readPersistedAiConfig());

    const enabledSkills = await loadEnabledSkills(data, env);
    // Same CLI RAG path as `rag search` — remote vector-model.json config or
    // BM25. Local Transformers.js embeddings remain unavailable in the CLI.
    await configureRagSearchForCli(book?.isVectorized ? "hybrid" : "bm25", env);
    registerCliFallbackContentProvider();

    if (snapshot) {
      // Seed the in-memory service the context tools read; never rewritten.
      hydrateReadingContextFromSnapshot(snapshot);
    }

    // No saved snapshot (--book mode): approximate the live reader anchoring
    // the in-app sidebar gets — resolve the stored reading position and seed
    // the semantic context + reading-context service from that chapter.
    let semanticContext = snapshot ? buildSemanticContextFromSnapshot(snapshot) : null;
    if (!semanticContext && book) {
      const pseudo = await buildPseudoReadingContext(data, book, env);
      if (pseudo) {
        semanticContext = pseudo.semanticContext;
        hydrateReadingContextFromSnapshot(pseudo.snapshot);
      }
    }

    const result = await runSharedChatTurn({
      aiConfig,
      book,
      semanticContext,
      enabledSkills,
      deepThinking: options.deepThinking,
      spoilerFree: options.spoilerFree,
      userLanguage: resolveAskLanguage(env),
      memorySummary: thread?.memorySummary,
      prompt,
      priorTurns: thread?.turns ?? [],
      traceFile: options.traceFile,
      traceSecrets: [env.ANTHROPIC_AUTH_TOKEN || "", env.ANTHROPIC_API_KEY || "", env.OPENAI_API_KEY || ""],
    });

    if (thread) {
      // Persist one clean pair per invocation: the original prompt and the
      // final combined answer with its citations. Failed runs write nothing.
      thread.bookId = book?.id ?? null;
      const appended = capThreadTurns(
        [
          ...thread.turns,
          { role: "user", content: prompt },
          {
            role: "assistant",
            content: result.answer,
            ...(result.citations.length > 0 ? { citations: result.citations } : {}),
            ...(result.artifacts.length > 0 ? { artifacts: result.artifacts } : {}),
          },
        ],
        THREAD_MAX_STORED_PAIRS,
      );
      const dropped = thread.turns.length + 2 - appended.length;
      if (dropped > 0) {
        thread.memoryMessageCount = Math.max(0, (thread.memoryMessageCount ?? 0) - dropped);
      }
      thread.turns = appended;
      thread.updatedAt = Date.now();
      await saveAskThread(thread);
    }

    const payload: AskResult = {
      ...result,
      ...(thread ? { threadId: thread.id } : {}),
      contextTimestamp: snapshot ? snapshot.timestamp ?? null : null,
    };
    if (!options.json) return success(formatAskText(payload, options.debug));
    const { toolCalls, ...response } = payload;
    return success({
      ...response,
      toolCallCount: toolCalls.length,
      ...(options.debug ? { toolCalls } : {}),
    });
  } catch (error) {
    if (error instanceof AskFailureError) {
      return failure(error.code, error.message, error.details);
    }
    throw error;
  }
}
