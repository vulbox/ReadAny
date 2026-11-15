import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { getReadingContextSnapshot } from "@readany/core/ai/reading-context-service";
import type { AIConfig, AIEndpoint } from "@readany/core/types";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { askOptionsFromCommand, mapLocaleToAskLanguage, resolveAskLanguage } from "./ask.js";
import { parseCommand, runCommand } from "./commands.js";
import { ensureCoreInitialized, resetCoreForTests } from "./data.js";

type CapturedAgentCall = {
  options: {
    aiConfig: AIConfig;
    book: { id: string } | null;
    bookId: string | null;
    semanticContext: unknown;
    userLanguage: string;
    isVectorized: boolean;
    getAvailableTools: (options: {
      bookId: string | null;
      isVectorized: boolean;
      enabledSkills: never[];
    }) => Array<{ name: string }>;
  };
  input: string;
  history: unknown[];
};

const {
  agentCalls,
  streamReadingAgent,
  setMockAgentEvents,
  setMockAgentEventSequences,
  clearAgentCalls,
} = vi.hoisted(() => {
  const agentCalls: CapturedAgentCall[] = [];
  let mockEvents: Array<Record<string, unknown>> = [];
  let mockEventSequences: Array<Array<Record<string, unknown>>> | null = null;
  const streamReadingAgent = async function* (
    options: CapturedAgentCall["options"],
    input: string,
    history: unknown[],
  ) {
    agentCalls.push({ options, input, history });
    const events = mockEventSequences ? (mockEventSequences.shift() ?? []) : mockEvents;
    for (const event of events) {
      if (event.type === "diagnostic") {
        console.log("raw tool diagnostic");
        console.warn("raw provider diagnostic");
      }
      yield event;
    }
  };
  return {
    agentCalls,
    streamReadingAgent,
    setMockAgentEvents: (events: Array<Record<string, unknown>>) => {
      mockEvents = events;
      mockEventSequences = null;
    },
    setMockAgentEventSequences: (sequences: Array<Array<Record<string, unknown>>>) => {
      mockEventSequences = sequences;
    },
    clearAgentCalls: () => {
      agentCalls.length = 0;
    },
  };
});

vi.mock("@readany/core/ai/agents/reading-agent", () => ({
  streamReadingAgent,
}));

const WRITE_TOOLS = ["tagBooks", "updateBookMetadata", "manageBookGroups", "manageBookTags", "classifyBooks"];

async function createWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "readany-cli-ask-"));
  const dataRoot = join(root, "library");
  await mkdir(dataRoot, { recursive: true });
  return {
    root,
    dataRoot,
    env: {
      ...process.env,
      READANY_HOME: dataRoot,
    } as NodeJS.ProcessEnv,
  };
}

async function seedLibrary(dataRoot: string): Promise<void> {
  await resetCoreForTests();
  await ensureCoreInitialized({ ...process.env, READANY_HOME: dataRoot });
  const db = new Database(join(dataRoot, "readany.db"));
  for (const [id, title] of [
    ["book-1", "Agent Systems"],
    ["book-2", "Reader Contexts"],
  ] as const) {
    db.exec(`
      INSERT INTO books (
        id, file_path, format, title, author, publisher, language, isbn, description,
        cover_url, publish_date, rating, reviews, subjects, total_pages, total_chapters,
        group_id, added_at, last_opened_at, updated_at, deleted_at, progress, current_cfi,
        is_vectorized, vectorize_progress, tags, file_hash, sync_status
      ) VALUES (
        '${id}', 'books/${id}.epub', 'epub', '${title}', 'Ada Reader', NULL, 'en',
        NULL, NULL, NULL, NULL, NULL, NULL, '[]',
        100, 8, NULL, 1000, 2000, 3000, NULL, 0.5, 'epubcfi(/6/2)', 0, 0,
        '[]', 'hash-${id}', 'local'
      );
    `);
  }
  db.close();
}

function buildAiConfig(
  configOverrides: Partial<AIConfig> = {},
  endpointOverrides: Partial<AIEndpoint> = {},
): AIConfig {
  return {
    endpoints: [
      {
        id: "ep-1",
        name: "Test Endpoint",
        provider: "openai",
        apiKey: "test-key",
        baseUrl: "https://model.internal.example",
        models: ["test-model"],
        modelsFetched: true,
        ...endpointOverrides,
      },
    ],
    activeEndpointId: "ep-1",
    activeModel: "test-model",
    temperature: 0.7,
    maxTokens: 2048,
    slidingWindowSize: 10,
    ...configOverrides,
  };
}

async function writeSettings(dataRoot: string, aiConfig: AIConfig): Promise<void> {
  await mkdir(join(dataRoot, "readany-store"), { recursive: true });
  await writeFile(
    join(dataRoot, "readany-store", "settings.json"),
    JSON.stringify({ aiConfig }),
    "utf8",
  );
}

async function writeReaderContextSnapshot(dataRoot: string, bookId: string): Promise<void> {
  await mkdir(join(dataRoot, "readany-store"), { recursive: true });
  await writeFile(
    join(dataRoot, "readany-store", "reader-context.json"),
    JSON.stringify({
      bookId,
      bookTitle: "Agent Systems",
      currentChapter: { index: 1, title: "Tools", href: "OPS/chapter-1.xhtml" },
      currentPosition: { cfi: "epubcfi(/6/10)", percentage: 0.42, page: 12 },
      selection: {
        text: "Agents need safe tool boundaries.",
        cfi: "epubcfi(/6/10)",
        chapterIndex: 1,
        chapterTitle: "Tools",
      },
      surroundingText: "Agents need safe tool boundaries and permissioned local context.",
      recentHighlights: [{ text: "Draft-first editing keeps users safe.", cfi: "epubcfi(/6/8)" }],
      operationType: "selecting",
      timestamp: 1700000000000,
    }),
    "utf8",
  );
}

async function createSeededWorkspace() {
  const workspace = await createWorkspace();
  await seedLibrary(workspace.dataRoot);
  await writeSettings(workspace.dataRoot, buildAiConfig());
  return workspace;
}

/** Per-OS app-data dir (com.readany.app) for the temp home environment. */
function expectedAppDataDir(root: string): string {
  if (platform() === "win32") return join(root, "appdata", "com.readany.app");
  if (platform() === "darwin") {
    return join(root, "home", "Library", "Application Support", "com.readany.app");
  }
  return join(root, "xdg", "com.readany.app");
}

/** Environment with READANY_HOME unset and every home variable inside root. */
function buildIsolatedHomeEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    READANY_HOME: undefined,
    APPDATA: join(root, "appdata"),
    USERPROFILE: join(root, "home"),
    HOME: join(root, "home"),
    XDG_DATA_HOME: join(root, "xdg"),
  } as NodeJS.ProcessEnv;
}

async function writeAppDataSettings(appData: string, aiConfig: AIConfig): Promise<void> {
  await mkdir(join(appData, "readany-store"), { recursive: true });
  await writeFile(
    join(appData, "readany-store", "settings.json"),
    JSON.stringify({ aiConfig }),
    "utf8",
  );
}

function lastAgentCall(): CapturedAgentCall {
  const call = agentCalls.at(-1);
  if (!call) throw new Error("expected the mocked reading agent to have been called");
  return call;
}

beforeEach(() => {
  clearAgentCalls();
  setMockAgentEvents([{ type: "token", content: "It is about safe agent tools." }]);
});

describe("ask", () => {
  it("fails when the prompt is missing", async () => {
    const workspace = await createSeededWorkspace();
    const result = await runCommand(["ask"], workspace.env);
    expect(result).toMatchObject({ ok: false, error: { code: "missing_prompt" } });
    expect(agentCalls.length).toBe(0);
  });

  it("fails when --current has no reader context snapshot", async () => {
    const workspace = await createSeededWorkspace();
    const result = await runCommand(["ask", "what am I reading", "--current"], workspace.env);
    expect(result).toMatchObject({ ok: false, error: { code: "missing_reader_context" } });
    if (!result.ok) {
      expect(result.error.message).toContain("--book");
    }
    expect(agentCalls.length).toBe(0);
  });

  it("does not attach a snapshot saved for another book when --book targets a different book", async () => {
    const workspace = await createSeededWorkspace();
    await writeReaderContextSnapshot(workspace.dataRoot, "book-2");

    const result = await runCommand(
      ["ask", "summarize the safety chapter", "--book", "book-1", "--json"],
      workspace.env,
    );
    expect(result.ok).toBe(true);
    expect(agentCalls.length).toBe(1);
    const call = lastAgentCall();
    expect(call.options.book?.id).toBe("book-1");
    expect(call.options.semanticContext).toBeNull();
    expect(getReadingContextSnapshot()?.bookId).not.toBe("book-2");
    if (result.ok) {
      const payload = result.data as { contextTimestamp: number | null; bookId: string | null };
      expect(payload.contextTimestamp).toBeNull();
      expect(payload.bookId).toBe("book-1");
    }
  });

  it("fails when --book and --current disagree with the saved snapshot", async () => {
    const workspace = await createSeededWorkspace();
    await writeReaderContextSnapshot(workspace.dataRoot, "book-2");

    const result = await runCommand(
      ["ask", "what am I reading", "--book", "book-1", "--current"],
      workspace.env,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "context_mismatch" } });
    expect(agentCalls.length).toBe(0);
  });

  it("fails when --book and --current are combined but no snapshot exists", async () => {
    const workspace = await createSeededWorkspace();
    const result = await runCommand(
      ["ask", "what am I reading", "--book", "book-1", "--current"],
      workspace.env,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "context_mismatch" } });
    expect(agentCalls.length).toBe(0);
  });

  it("fails when --book names an unknown book", async () => {
    const workspace = await createSeededWorkspace();
    const result = await runCommand(["ask", "hello", "--book", "missing-book"], workspace.env);
    expect(result).toMatchObject({ ok: false, error: { code: "book_not_found" } });
    expect(agentCalls.length).toBe(0);
  });

  it("runs a library-wide turn with a null book when neither flag is passed", async () => {
    const workspace = await createSeededWorkspace();
    const result = await runCommand(["ask", "how many books do I have", "--json"], workspace.env);
    expect(result.ok).toBe(true);
    expect(agentCalls.length).toBe(1);
    const call = lastAgentCall();
    expect(call.options.book).toBeNull();
    expect(call.options.bookId).toBeNull();
    expect(call.options.semanticContext).toBeNull();
    expect(call.input).toBe("how many books do I have");
    expect(call.history).toEqual([]);
    if (result.ok) {
      const payload = result.data as {
        answer: string;
        bookId: string | null;
        contextTimestamp: number | null;
      };
      expect(payload.answer).toBe("It is about safe agent tools.");
      expect(payload.bookId).toBeNull();
      expect(payload.contextTimestamp).toBeNull();
    }
  });

  it("passes a read-only tool provider to the agent", async () => {
    const workspace = await createSeededWorkspace();
    const result = await runCommand(["ask", "summarize my library"], workspace.env);
    expect(result.ok).toBe(true);

    const provider = lastAgentCall().options.getAvailableTools;
    const tools = provider({ bookId: "book-1", isVectorized: false, enabledSkills: [] });
    const names = tools.map((tool) => tool.name);
    for (const writeTool of WRITE_TOOLS) {
      expect(names).not.toContain(writeTool);
    }
    for (const keptTool of [
      "listBooks",
      "getReadingStats",
      "getSkills",
      "getSelection",
      "getCurrentChapter",
      "getAnnotations",
      "addCitation",
      "fallbackSearch",
    ]) {
      expect(names).toContain(keptTool);
    }
  });

  it("attaches a matching snapshot with --book and reports its timestamp", async () => {
    const workspace = await createSeededWorkspace();
    await writeReaderContextSnapshot(workspace.dataRoot, "book-1");

    const result = await runCommand(
      ["ask", "explain the current selection", "--book", "book-1", "--json"],
      workspace.env,
    );
    expect(result.ok).toBe(true);
    const call = lastAgentCall();
    expect(call.options.book?.id).toBe("book-1");
    expect(call.options.semanticContext).toMatchObject({
      currentChapter: "Tools",
      surroundingText: expect.stringContaining("safe tool boundaries"),
    });
    expect(getReadingContextSnapshot()?.bookId).toBe("book-1");
    if (result.ok) {
      const payload = result.data as { contextTimestamp: number | null };
      expect(payload.contextTimestamp).toBe(1700000000000);
    }

    // The snapshot must be hydrated in memory only — reader-context.json stays untouched.
    const onDisk = JSON.parse(
      await readFile(join(workspace.dataRoot, "readany-store", "reader-context.json"), "utf8"),
    ) as { bookId: string; timestamp: number };
    expect(onDisk.bookId).toBe("book-1");
    expect(onDisk.timestamp).toBe(1700000000000);
  });

  it("loads the snapshot book with --current", async () => {
    const workspace = await createSeededWorkspace();
    await writeReaderContextSnapshot(workspace.dataRoot, "book-1");

    const result = await runCommand(["ask", "explain this page", "--current"], workspace.env);
    expect(result.ok).toBe(true);
    const call = lastAgentCall();
    expect(call.options.book?.id).toBe("book-1");
    expect(call.options.semanticContext).not.toBeNull();
  });

  it("preserves mindmap artifacts in default JSON, text, and persisted threads without tool traces", async () => {
    const workspace = await createSeededWorkspace();
    const map = { type: "mindmap", title: "Book structure", markdown: "# Book\n## Main idea\n- Example", stats: { nodeCount: 3, maxDepth: 7 } };
    const events = [
      { type: "tool_call", name: "mindmap", args: { title: map.title, markdown: map.markdown } },
      { type: "tool_result", name: "mindmap", result: map },
      { type: "token", content: "Here is the map." },
    ];
    setMockAgentEvents(events);
    const result = await runCommand(["ask", "make a map", "--thread", "maps", "--json"], workspace.env);
    expect(result).toMatchObject({ ok: true, data: {
      answer: "Here is the map.", artifacts: [{ ...map, format: "markmap" }],
    } });
    expect(JSON.stringify(result)).not.toContain('"toolCalls"');
    setMockAgentEvents([{ type: "token", content: "Follow-up answer." }]);
    await runCommand(["ask", "follow up", "--thread", "maps", "--json"], workspace.env);
    const stored = JSON.parse(await readFile(join(workspace.dataRoot, "readany-store", "cli-threads", "maps.json"), "utf8"));
    expect(stored.turns[1].artifacts).toEqual([{ ...map, format: "markmap" }]);
    setMockAgentEvents(events);
    const text = await runCommand(["ask", "make a map"], workspace.env);
    expect(text.ok).toBe(true);
    if (text.ok) {
      expect(text.data).toContain(map.title);
      expect(text.data).toContain(map.markdown);
      expect(text.data).not.toContain("Tool calls:");
    }
  });

  it("preserves Mermaid code in the answer and handles artifact-only answers", async () => {
    const workspace = await createSeededWorkspace();
    const answer = "Process:\n```mermaid\nflowchart LR\nA --> B\n```";
    setMockAgentEvents([{ type: "token", content: answer }]);
    expect(await runCommand(["ask", "show a flowchart", "--json"], workspace.env)).toMatchObject({
      ok: true, data: { answer, artifacts: [] },
    });
    setMockAgentEvents([
      { type: "tool_call", name: "mindmap", args: {} },
      { type: "tool_result", name: "mindmap", result: { type: "mindmap", title: "Only map", markdown: "# Root\n## Leaf" } },
    ]);
    const result = await runCommand(["ask", "make a map"], workspace.env);
    if (!result.ok) throw new Error("expected an artifact answer");
    expect(result.data).toContain("# Root\n## Leaf");
    expect(result.data).not.toContain("(no answer)");
  });

  it("returns full tool results only with --debug and keeps default JSON compact", async () => {
    const workspace = await createSeededWorkspace();
    setMockAgentEvents([
      { type: "reasoning", content: "internal trace", stepType: "thinking" },
      { type: "token", content: "Chapter 2 " },
      { type: "token", content: "drafts changes safely." },
      {
        type: "tool_call",
        name: "ragSearch",
        args: { query: "drafts" },
      },
      {
        type: "tool_result",
        name: "ragSearch",
        result: { results: [{ chunk: { id: "chunk-2" } }] },
      },
      {
        type: "citation",
        citation: {
          id: "citation-1",
          bookId: "book-1",
          chapterTitle: "Drafts",
          chapterIndex: 2,
          cfi: "epubcfi(/6/14)",
          text: "Draft-first editing keeps EPUB sources safe.",
          citationIndex: 1,
        },
      },
    ]);

    const result = await runCommand(
      ["ask", "what happens in chapter 2", "--book", "book-1", "--json", "--debug"],
      workspace.env,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const payload = result.data as {
        answer: string;
        citations: Array<{ chapterTitle: string }>;
        toolCalls: Array<{ name: string; args: Record<string, unknown>; result?: unknown }>;
      };
      expect(payload.answer).toBe("Chapter 2 drafts changes safely.");
      expect(payload.citations).toEqual([
        {
          id: "citation-1",
          bookId: "book-1",
          chapterTitle: "Drafts",
          chapterIndex: 2,
          cfi: "epubcfi(/6/14)",
          text: "Draft-first editing keeps EPUB sources safe.",
          citationIndex: 1,
        },
      ]);
      expect(payload.toolCalls).toEqual([
        {
          name: "ragSearch",
          args: { query: "drafts" },
          result: { results: [{ chunk: { id: "chunk-2" } }] },
        },
      ]);
      expect(JSON.stringify(payload)).not.toContain("internal trace");
      setMockAgentEvents([
        { type: "token", content: payload.answer },
        { type: "tool_call", name: "ragSearch", args: { query: "drafts" } },
        { type: "tool_result", name: "ragSearch", result: { content: "raw book text".repeat(10000) } },
        { type: "citation", citation: payload.citations[0] },
      ]);
      const compact = await runCommand(
        ["ask", "what happens in chapter 2", "--book", "book-1", "--json"], workspace.env,
      );
      expect(compact).toMatchObject({ ok: true, data: {
        answer: payload.answer, citations: payload.citations, toolCallCount: 1,
      } });
      expect(JSON.stringify(compact)).not.toContain('"toolCalls"');
      expect(JSON.stringify(compact).length).toBeLessThan(2000);
    }
  });

  it("silences diagnostics by default and restores console methods after errors", async () => {
    const workspace = await createSeededWorkspace();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      setMockAgentEvents([
        { type: "diagnostic" },
        { type: "error", error: "model unavailable" },
      ]);
      const result = await runCommand(["ask", "question", "--json"], workspace.env);
      expect(result).toMatchObject({ ok: false, error: { message: "model unavailable" } });
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(console.log).toBe(log);
      expect(console.warn).toBe(warn);
      expect(console.error).toBe(error);
      await runCommand(["ask", "question", "--json", "--debug"], workspace.env);
      expect(error).toHaveBeenCalledWith("raw tool diagnostic");
    } finally {
      log.mockRestore(); warn.mockRestore(); error.mockRestore();
    }
  });

  it("prints only the final answer and citations without --json", async () => {
    const workspace = await createSeededWorkspace();
    setMockAgentEvents([
      { type: "token", content: "Chapter 2 drafts changes safely." },
      { type: "tool_call", name: "ragSearch", args: { query: "drafts" } },
      { type: "tool_result", name: "ragSearch", result: { results: [] } },
      {
        type: "citation",
        citation: {
          id: "citation-1",
          bookId: "book-1",
          chapterTitle: "Drafts",
          chapterIndex: 2,
          cfi: "epubcfi(/6/14)",
          text: "Draft-first editing keeps EPUB sources safe.",
          citationIndex: 1,
        },
      },
    ]);

    const result = await runCommand(["ask", "what happens in chapter 2"], workspace.env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.data).toBe("string");
      const text = result.data as string;
      expect(text).toContain("Chapter 2 drafts changes safely.");
      expect(text).toContain("Citations:");
      expect(text).toContain("Drafts");
      expect(text).not.toContain("Tool calls:");
      expect(text).not.toContain("ragSearch");
    }
  });

  it("exits non-zero on agent error events", async () => {
    const workspace = await createSeededWorkspace();
    setMockAgentEvents([{ type: "error", error: "model connection failed" }]);

    const result = await runCommand(["ask", "hello"], workspace.env);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "agent_error", message: "model connection failed" },
    });
  });

  it("reports rounds: 1 for a clean single-turn answer", async () => {
    const workspace = await createSeededWorkspace();
    setMockAgentEvents([{ type: "token", content: "Done." }]);

    const result = await runCommand(["ask", "hi", "--json"], workspace.env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as { rounds: number }).rounds).toBe(1);
    }
    expect(agentCalls).toHaveLength(1);
  });

  it("relays the shared service output-limit error without automatically continuing", async () => {
    const workspace = await createSeededWorkspace();
    setMockAgentEventSequences([
      [
        { type: "token", content: "Partial answer." },
        { type: "error", error: "The model reached its output limit before finishing." },
      ],
      [{ type: "token", content: "This must not be requested." }],
    ]);
    const result = await runCommand(["ask", "question", "--json"], workspace.env);
    expect(result).toMatchObject({ ok: false, error: {
      code: "agent_error", details: { answer: "Partial answer.", rounds: 1 },
    } });
    expect(agentCalls).toHaveLength(1);
  });

  it("returns one answer after a tool limit, without requesting a rewrite or merging citations", async () => {
    const workspace = await createSeededWorkspace();
    setMockAgentEventSequences([
      [
        { type: "tool_call", name: "ragSearch", args: { query: "a" } },
        { type: "tool_result", name: "ragSearch", result: JSON.stringify({
          repeatedToolCall: true, stopToolCalls: true,
          reason: "Tool execution limit reached for this turn.",
        }) },
        { type: "citation", citation: { id: "c1", bookId: "book-1", chapterTitle: "Drafts", chapterIndex: 2, cfi: "page:3", text: "Source one", citationIndex: 1 } },
        { type: "token", content: "The final answer from the shared service." },
      ],
      [
        { type: "citation", citation: { id: "c2", bookId: "book-1", chapterTitle: "Other", chapterIndex: 5, cfi: "page:6", text: "Different source", citationIndex: 1 } },
        { type: "token", content: "A repeated full answer." },
      ],
    ]);
    const result = await runCommand(["ask", "question", "--json"], workspace.env);
    expect(result).toMatchObject({ ok: true, data: {
      answer: "The final answer from the shared service.", rounds: 1,
      citations: [{ id: "c1", citationIndex: 1 }],
    } });
    expect(agentCalls).toHaveLength(1);
  });

  it("persists single-execution evidence, redacts credentials, and preserves existing logs", async () => {
    const workspace = await createSeededWorkspace();
    const traceFile = join(workspace.root, "trace", "rounds.jsonl");
    setMockAgentEventSequences([
      [
        { type: "reasoning", content: "private model reasoning" },
        { type: "token", content: "First draft." },
        { type: "tool_call", name: "ragSearch", args: { query: "a" } },
        { type: "tool_result", name: "ragSearch", result: {
          stopToolCalls: true, repeatedToolCall: true,
          reason: "Tool execution limit reached for this turn.", credential: "test-key",
        } },
      ],
      [{ type: "token", content: "Second draft." }],
    ]);
    const result = await runCommand(["ask", "explain", "--json", "--trace-file", traceFile], workspace.env);
    expect(result).toMatchObject({ ok: true, data: { answer: "First draft." } });
    const raw = await readFile(traceFile, "utf8");
    const records = raw.trim().split("\n").map((line) => JSON.parse(line));
    expect(raw).not.toContain("test-key");
    expect(raw).not.toContain("private model reasoning");
    expect(raw).toContain("[REDACTED]");
    expect(records.filter((r) => r.type === "round_end").map((r) => r.data)).toMatchObject([
      { round: 1, answer: "First draft.", toolBudgetExhausted: true, outputLimitTruncated: false },
    ]);
    expect(records.filter((r) => r.type === "round_start")).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({ type: "run_end", data: { rounds: 1, completed: true } });
    const repeat = await runCommand(["ask", "explain", "--trace-file", traceFile], workspace.env);
    expect(repeat.ok).toBe(false);
    expect(await readFile(traceFile, "utf8")).toBe(raw);
    expect(agentCalls).toHaveLength(1);
  });

  it("retains the failing round and closes its trace on agent failure", async () => {
    const workspace = await createSeededWorkspace();
    const traceFile = join(workspace.root, "failed.jsonl");
    setMockAgentEvents([{ type: "error", error: "model unavailable" }]);
    const result = await runCommand(["ask", "explain", "--trace-file", traceFile], workspace.env);
    expect(result.ok).toBe(false);
    const records = (await readFile(traceFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records.at(-2)).toMatchObject({ type: "round_end", data: { round: 1, fatal: { message: "model unavailable" } } });
    expect(records.at(-1)).toMatchObject({ type: "run_error", data: { message: "model unavailable" } });
  });

  it("rejects CLI continuation and prompt-expansion flags before calling the model", async () => {
    const workspace = await createSeededWorkspace();
    for (const args of [["--max-rounds", "3"], ["--thorough"]]) {
      const result = await runCommand(["ask", "question", ...args], workspace.env);
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_option" } });
    }
    expect(agentCalls).toHaveLength(0);
  });

  it("accepts the legacy single-round flag without changing the prompt", async () => {
    const workspace = await createSeededWorkspace();
    const result = await runCommand(["ask", "question", "--max-rounds", "1", "--json"], workspace.env);
    expect(result).toMatchObject({ ok: true, data: { rounds: 1 } });
    expect(lastAgentCall().input).toBe("question");
    expect(agentCalls).toHaveLength(1);
  });

  it("rejects a non-numeric --max-rounds value", async () => {
    const workspace = await createSeededWorkspace();
    const result = await runCommand(["ask", "hello", "--max-rounds", "abc"], workspace.env);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_option" } });
  });

  it("persists a thread and feeds it back as agent history on the next call", async () => {
    const workspace = await createSeededWorkspace();
    setMockAgentEvents([{ type: "token", content: "First answer." }]);

    const first = await runCommand(
      ["ask", "first question", "--book", "book-1", "--thread", "t1", "--json"],
      workspace.env,
    );
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect((first.data as { threadId?: string }).threadId).toBe("t1");
    }
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0].history).toEqual([]);

    setMockAgentEvents([{ type: "token", content: "Second answer." }]);
    const second = await runCommand(["ask", "follow up", "--thread", "t1", "--json"], workspace.env);
    expect(second.ok).toBe(true);
    expect(agentCalls).toHaveLength(2);
    // The follow-up omits --book: the thread's remembered book is used.
    expect(agentCalls[1].options.book?.id).toBe("book-1");
    // The stored user turn keeps the original prompt (no thorough framing).
    expect(agentCalls[1].history).toHaveLength(2);
    expect(agentCalls[1].history?.[0]?.role).toBe("user");
    expect(String(agentCalls[1].history?.[0]?.content)).toContain("first question");
    expect(agentCalls[1].history?.[1]).toEqual({ role: "assistant", content: "First answer." });

    const stored = JSON.parse(
      await readFile(
        join(workspace.dataRoot, "readany-store", "cli-threads", "t1.json"),
        "utf8",
      ),
    ) as { bookId: string | null; turns: Array<{ role: string; content: string }> };
    expect(stored.bookId).toBe("book-1");
    expect(stored.turns).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "First answer." },
      { role: "user", content: "follow up" },
      { role: "assistant", content: "Second answer." },
    ]);
  });

  it("continues the most recent thread with --continue", async () => {
    const workspace = await createSeededWorkspace();
    setMockAgentEvents([{ type: "token", content: "A." }]);
    await runCommand(["ask", "q1", "--thread", "alpha", "--json"], workspace.env);

    setMockAgentEvents([{ type: "token", content: "B." }]);
    const result = await runCommand(["ask", "q2", "--continue", "--json"], workspace.env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as { threadId?: string }).threadId).toBe("alpha");
    }
    expect(agentCalls[1].history).toHaveLength(2);
    expect(String(agentCalls[1].history?.[0]?.content)).toContain("q1");
    expect(agentCalls[1].history?.[1]).toEqual({ role: "assistant", content: "A." });
  });

  it("fails when --continue has no previous thread", async () => {
    const workspace = await createSeededWorkspace();
    const result = await runCommand(["ask", "hello", "--continue"], workspace.env);
    expect(result).toMatchObject({ ok: false, error: { code: "missing_thread" } });
  });

  it("rejects combining --thread with --continue and unsafe thread ids", async () => {
    const workspace = await createSeededWorkspace();
    const combined = await runCommand(
      ["ask", "hello", "--thread", "t1", "--continue"],
      workspace.env,
    );
    expect(combined).toMatchObject({ ok: false, error: { code: "invalid_option" } });

    const badId = await runCommand(["ask", "hello", "--thread", "../escape"], workspace.env);
    expect(badId).toMatchObject({ ok: false, error: { code: "invalid_thread" } });
  });

  it("stays stateless without --thread: no thread file is created", async () => {
    const workspace = await createSeededWorkspace();
    setMockAgentEvents([{ type: "token", content: "Plain." }]);

    const result = await runCommand(["ask", "hello", "--json"], workspace.env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as { threadId?: string }).threadId).toBeUndefined();
    }
    await expect(
      readFile(join(workspace.dataRoot, "readany-store", "cli-threads", "latest.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("sends the raw prompt without task framing when --no-thorough is set", async () => {
    const workspace = await createSeededWorkspace();
    const result = await runCommand(
      ["ask", "how many books do I have", "--no-thorough", "--json"],
      workspace.env,
    );
    expect(result.ok).toBe(true);
    expect(lastAgentCall().input).toBe("how many books do I have");
  });

  it("replays stored citations as quote blocks on the next thread turn", async () => {
    const workspace = await createSeededWorkspace();
    setMockAgentEvents([
      { type: "token", content: "Answer with a source." },
      {
        type: "citation",
        citation: {
          id: "c-1",
          bookId: "book-1",
          chapterTitle: "Drafts",
          chapterIndex: 2,
          cfi: "epubcfi(/6/14)",
          text: "Draft-first editing keeps EPUB sources safe.",
          citationIndex: 1,
        },
      },
    ]);
    await runCommand(
      ["ask", "q1", "--book", "book-1", "--thread", "cite", "--json"],
      workspace.env,
    );

    setMockAgentEvents([{ type: "token", content: "Follow-up." }]);
    await runCommand(["ask", "q2", "--thread", "cite", "--json"], workspace.env);

    const replayed = String(agentCalls[1].history?.[1]?.content);
    expect(replayed).toContain("Answer with a source.");
    expect(replayed).toContain('> [Drafts]: "Draft-first editing keeps EPUB sources safe."');
  });

  it("uses the shared message-count window without extra model calls or app chat writes", async () => {
    const workspace = await createWorkspace();
    await seedLibrary(workspace.dataRoot);
    await writeSettings(workspace.dataRoot, buildAiConfig({ slidingWindowSize: 3 }));
    for (const question of ["q1", "q2", "q3"]) {
      setMockAgentEvents([{ type: "token", content: `Answer ${question}` }]);
      expect((await runCommand(["ask", question, "--thread", "window", "--json"], workspace.env)).ok).toBe(true);
    }
    expect(agentCalls).toHaveLength(3);
    expect(agentCalls[2].history).toEqual([
      { role: "user", content: "q2", reasoning: undefined },
      { role: "assistant", content: "Answer q2", reasoning: undefined },
    ]);
    const db = new Database(join(workspace.dataRoot, "readany.db"));
    try {
      expect((db.prepare("SELECT COUNT(*) AS count FROM threads").get() as { count: number }).count).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count).toBe(0);
    } finally { db.close(); }
  });

  it("fails before calling the agent when no model is configured", async () => {
    const workspace = await createWorkspace();
    await seedLibrary(workspace.dataRoot);
    await writeSettings(
      workspace.dataRoot,
      buildAiConfig({ activeModel: "" }, { models: [], modelsFetched: false }),
    );

    const result = await runCommand(["ask", "hello"], workspace.env);
    expect(result).toMatchObject({ ok: false, error: { code: "ai_not_configured" } });
    if (!result.ok) {
      expect(result.error.message).toMatch(/model/i);
    }
    expect(agentCalls.length).toBe(0);
  });

  it("fails before calling the agent when the required API key is empty", async () => {
    const workspace = await createWorkspace();
    await seedLibrary(workspace.dataRoot);
    await writeSettings(workspace.dataRoot, buildAiConfig({}, { apiKey: "" }));

    const result = await runCommand(["ask", "hello"], workspace.env);
    expect(result).toMatchObject({ ok: false, error: { code: "ai_not_configured" } });
    if (!result.ok) {
      expect(result.error.message).toMatch(/api key/i);
    }
    expect(agentCalls.length).toBe(0);
  });

  it("fails when no AI settings exist at all", async () => {
    const workspace = await createWorkspace();
    await seedLibrary(workspace.dataRoot);

    const result = await runCommand(["ask", "hello"], workspace.env);
    expect(result).toMatchObject({ ok: false, error: { code: "ai_not_configured" } });
    expect(agentCalls.length).toBe(0);
  });

  it("never prints the API key or base URL in failures", async () => {
    const workspace = await createWorkspace();
    await seedLibrary(workspace.dataRoot);
    await writeSettings(workspace.dataRoot, buildAiConfig({ activeEndpointId: "gone" }));

    const result = await runCommand(["ask", "hello"], workspace.env);
    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("test-key");
    expect(serialized).not.toContain("model.internal.example");
  });

  it("loads settings from app data and the book from the desktop dataRoot when READANY_HOME is unset", async () => {
    const root = await mkdtemp(join(tmpdir(), "readany-cli-ask-dataroot-"));
    const libraryRoot = join(root, "library");
    const appData = expectedAppDataDir(root);

    // Model config lives only in the app-data settings store.
    await writeAppDataSettings(
      appData,
      buildAiConfig({ activeModel: "app-data-model" }, { models: ["app-data-model"] }),
    );
    // The library lives in the desktop-configured dataRoot.
    await writeFile(
      join(appData, "desktop-data-root.json"),
      JSON.stringify({ dataRoot: libraryRoot }),
      "utf8",
    );
    await seedLibrary(libraryRoot);

    const result = await runCommand(
      ["ask", "summarize the book", "--book", "book-1", "--json"],
      buildIsolatedHomeEnv(root),
    );
    expect(result.ok).toBe(true);
    expect(agentCalls.length).toBe(1);
    const call = lastAgentCall();
    expect(call.options.aiConfig.activeModel).toBe("app-data-model");
    expect(call.options.book?.id).toBe("book-1");
  });

  it("falls back to the app-data directory as the library when desktop-data-root.json is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "readany-cli-ask-norootfile-"));
    const appData = expectedAppDataDir(root);
    await writeAppDataSettings(appData, buildAiConfig());
    // Seed the library directly inside the app-data directory.
    await seedLibrary(appData);

    const result = await runCommand(
      ["ask", "summarize the book", "--book", "book-1", "--json"],
      buildIsolatedHomeEnv(root),
    );
    expect(result.ok).toBe(true);
    expect(agentCalls.length).toBe(1);
    expect(lastAgentCall().options.book?.id).toBe("book-1");
  });

  it("maps parsed flags for both the ask subcommand and the readany-ask entrypoint", () => {
    expect(
      askOptionsFromCommand(
        parseCommand([
          "ask",
          "what",
          "happens",
          "--book",
          "book-1",
          "--deep-thinking",
          "--spoiler-free",
          "--json",
        ]),
      ),
    ).toEqual({
      prompt: "what happens",
      bookId: "book-1",
      current: false,
      deepThinking: true,
      spoilerFree: true,
      json: true,
      maxRounds: 1,
      threadId: undefined,
      continueThread: false,
      debug: false,
      traceFile: undefined,
    });

    expect(
      askOptionsFromCommand(
        parseCommand(["ask", "what happens here", "--current", "--json"]),
      ),
    ).toEqual({
      prompt: "what happens here",
      bookId: undefined,
      current: true,
      deepThinking: false,
      spoilerFree: false,
      json: true,
      maxRounds: 1,
      threadId: undefined,
      continueThread: false,
      debug: false,
      traceFile: undefined,
    });
  });

  it("resolves the language from READANY_LANG and maps locales like initI18nLanguage", () => {
    expect(mapLocaleToAskLanguage("zh-TW")).toBe("zh-TW");
    expect(mapLocaleToAskLanguage("zh-HK")).toBe("zh-TW");
    expect(mapLocaleToAskLanguage("zh_CN.UTF-8")).toBe("zh");
    expect(mapLocaleToAskLanguage("ja_JP")).toBe("ja");
    expect(mapLocaleToAskLanguage("ko-KR")).toBe("ko");
    expect(mapLocaleToAskLanguage("fr_FR")).toBe("fr");
    expect(mapLocaleToAskLanguage("es-ES")).toBe("es");
    expect(mapLocaleToAskLanguage("pt-BR")).toBe("en");
    expect(mapLocaleToAskLanguage(undefined)).toBe("en");

    expect(resolveAskLanguage({ READANY_LANG: "zh-TW" } as NodeJS.ProcessEnv)).toBe("zh-TW");
    expect(resolveAskLanguage({ READANY_LANG: "en-US" } as NodeJS.ProcessEnv)).toBe("en");
  });
});
