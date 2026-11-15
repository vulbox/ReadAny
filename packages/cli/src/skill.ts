import { mkdir, readdir, readFile, rmdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { listTools } from "./tool-registry.js";
import { CLI_VERSION } from "./version.js";

export type SkillStatus = {
  installed: boolean;
  path: string;
  version?: string;
};

export type SkillInstallResult = {
  installed: true;
  path: string;
  version: string;
};

export type SkillUpdateResult = {
  updated: true;
  path: string;
  previousVersion?: string;
  version: string;
};

export type SkillUninstallResult = {
  removed: boolean;
  path: string;
};

const MANAGED_MARKER = "<!-- readany-cli-managed -->";

function renderMcpToolList(): string {
  return listTools()
    .map(
      (tool) =>
        `- \`${tool.name}\` (${tool.risk}; scopes: ${tool.scopes.join(", ")}): ${tool.description}`,
    )
    .join("\n");
}

export function createSkillContent(version = CLI_VERSION): string {
  return `---
name: readany
description: Use ReadAny CLI and MCP to safely access the user's local ReadAny library, notes, knowledge base, RAG context, and EPUB draft workflows.
---
${MANAGED_MARKER}

# ReadAny

Use this skill when the user asks an external AI agent to search, read, organize, or edit content stored in ReadAny.

## Capabilities

- Read book metadata, chapters, highlights, notes, bookmarks, and skills.
- Ask the built-in reading agent about a book (\`readany-ask\`): book-grounded answers through the same shared chat execution used by the app, with citations and conversation threads.
- Search ReadAny with metadata, keyword, semantic retrieval, and knowledge tools.
- Read the current reader context snapshot when the desktop client provides one.
- Inspect EPUB structure and use draft-first EPUB editing workflows when an editing profile is enabled.
- Read, patch, batch-patch, rebuild toc, inspect history, diff, undo, validate, discard, and export through ReadAny drafts.
- Export new artifacts only when the active profile allows export.
- Ask the user before high-risk actions.

## Safety Rules

- Start with readonly access unless the user explicitly asks for editing or publishing.
- Never request arbitrary shell, arbitrary SQL, or unrestricted filesystem access.
- Do not overwrite original books; use ReadAny drafts and exports.
- Treat publisher/export actions and draft discard as high-risk; ask the user to confirm in ReadAny.
- For book Q&A, follow the relay workflow below using the CLI. For other explicitly requested operations, prefer MCP tools when available.

## Client Setup Notes

- \`all\` setup links this managed skill into all known user skill discovery directories.
- \`codex\`, \`claude\`, \`cursor\`, and \`opencode\` setup link this managed skill into the known client skill directory.
- \`agents\` is a compatibility link under \`~/.agents/skills/readany\` for clients that follow OpenCode's agent-compatible lookup.
- \`generic\` setup only installs the CLI and canonical skill under \`$AGENT_HOME/skills/readany\`.

## MCP Tools

${renderMcpToolList()}

## Book Q&A (reading agent)

For book analysis, explanation, and reading questions, act only as a relay between the user and ReadAny. The built-in reading agent owns retrieval, analysis, and the final answer.

1. Keep the user's prompt unchanged. Do not expand it into a new task or add your own questions.
2. If a book id is not known, use \`readany books search "<user-supplied title>" --json\` to match the title. Use the unique matching book. If several plausible books remain, display the candidates and stop; wait for the user to select one. If no book matches, report that result and stop.
3. Make exactly ONE \`readany ask\` invocation per user question after matching. Start a named thread for the reading conversation and reuse it only when the user sends another question about the same book. Start a new thread when switching books.
4. Display the returned final answer and citations directly, without rewriting, summarizing, extending, or adding your own analysis. If using JSON, display \`data.answer\`, \`data.citations\`, and \`data.artifacts\`. Preserve Mermaid code blocks and mindmap Markdown; render them when the client supports their format. Inline artifacts are results, not diagnostic tool logs.
5. Do not autonomously follow up, retry, ask the user follow-up questions, or offer to continue. Do not call chapters, chapter, RAG, context, or other content tools to supplement the answer. Do not fetch pages in batches. Relay errors or incomplete answers as returned and stop until the user sends a new request.
6. Do not enable \`--debug\` unless the user explicitly requests diagnostics. Each invocation uses one shared ReadAny chat execution; the CLI never automatically restarts it or rewrites the user prompt.

\`\`\`bash
readany books search "<book title>" --json
readany ask "<unchanged user prompt>" --book <book-id> --thread <session>
# ONLY after the user sends a new question in the same reading conversation:
readany ask "<unchanged new user prompt>" --thread <session>
\`\`\`

\`readany-ask\` is an equivalent entrypoint. Default text output contains the final answer, inline mindmap content, and citations. The shared chat pipeline handles history windows and citation replay. CLI conversation files are separate from the app chat database; the CLI does not generate extra memory summaries. Errors, including output truncation, are relayed without automatic continuation. \`--json\` returns \`answer\`, \`citations\`, \`artifacts\` (mindmap title, markmap format, Markdown, and optional stats), \`bookId\`, \`contextTimestamp\`, \`rounds\`, \`toolCallCount\`, and optional \`threadId\` under \`data\`. Full \`toolCalls\` and diagnostic logs are opt-in with \`--debug\`. Editing and direct content access remain available only when explicitly requested by the user as a separate task.

## Commands

\`\`\`bash
readany agent setup --user --client generic --profile readonly --json
readany agent setup --user --client codex --profile readonly --json
readany agent setup --user --client claude --profile readonly --json
readany agent setup --user --client cursor --profile readonly --json
readany agent setup --user --client opencode --profile readonly --json
readany agent setup --user --client all --profile readonly --json
readany doctor --json
readany mcp serve --profile readonly
readany mcp config --profile readonly --client generic --json
readany mcp config --profile readonly --client codex --json
readany mcp config --profile readonly --client claude --json
readany mcp config --profile readonly --client cursor --json
readany mcp config --profile readonly --client opencode --json
readany tools list --json
readany books list --json
readany books search <query> --json
readany book get <book-id> --json
readany chapters list <book-id> --json
readany chapter get <book-id> <chapter-id> --json --limit 12000
readany context get --json --limit 12000
readany bookmarks list <book-id> --json
readany skills list --json
readany notes search <query> --json --book <book-id>
readany highlights search <query> --json --book <book-id>
readany knowledge search <query> --json --book <book-id>
readany rag search <query> --book <book-id> --json
readany-ask "<question>" --book <book-id> --thread <session> --json
readany-ask "<follow-up>" --thread <session> --json
readany epub inspect <book-id> --profile editor --json
readany epub draft create <book-id> --profile editor --json
readany epub chapter read <draft-id> <chapter-id> --format xhtml --profile editor --json
readany epub chapter patch <draft-id> <chapter-id> --xhtml <file> --profile editor --json
readany epub chapters patch <draft-id> --patch <file> --profile editor --json
readany epub metadata patch <draft-id> --patch <file> --profile editor --json
readany epub toc rebuild <draft-id> --profile editor --json
readany epub history <draft-id> --profile editor --json
readany epub diff <draft-id> --profile editor --json
readany epub undo <draft-id> <operation-id> --profile editor --json
readany epub draft discard <draft-id> --profile editor --reason "finished" --json
readany epub validate <draft-id> --profile publisher --json
readany epub export <draft-id> --output <path> --profile publisher --json
readany notes export <book-id> --output <path> --profile publisher --json
readany knowledge export --output <path> --profile publisher --json
readany skill status --json
\`\`\`

Managed by ReadAny CLI ${version}.
`;
}

function parseSkillVersion(content: string): string | undefined {
  const match = content.match(/Managed by ReadAny CLI ([^\s.]+(?:\.[^\s.]+)*)\./);
  return match?.[1];
}

export async function getSkillStatus(skillFile: string): Promise<SkillStatus> {
  try {
    const content = await readFile(skillFile, "utf8");
    return {
      installed: content.includes(MANAGED_MARKER),
      path: skillFile,
      version: parseSkillVersion(content),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { installed: false, path: skillFile };
    }
    throw error;
  }
}

export async function installSkill(skillFile: string): Promise<SkillInstallResult> {
  const status = await getSkillStatus(skillFile);
  if (status.version === undefined && status.installed === false) {
    try {
      await readFile(skillFile, "utf8");
      throw new Error(`Skill file already exists and is not managed by ReadAny CLI: ${skillFile}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  await mkdir(dirname(skillFile), { recursive: true });
  await writeFile(skillFile, createSkillContent(), "utf8");
  return {
    installed: true,
    path: skillFile,
    version: CLI_VERSION,
  };
}

export async function updateSkill(skillFile: string): Promise<SkillUpdateResult> {
  const status = await getSkillStatus(skillFile);
  if (!status.installed) {
    throw new Error(
      `ReadAny skill is not installed or is not managed by ReadAny CLI: ${skillFile}`,
    );
  }

  await mkdir(dirname(skillFile), { recursive: true });
  await writeFile(skillFile, createSkillContent(), "utf8");
  return {
    updated: true,
    path: skillFile,
    previousVersion: status.version,
    version: CLI_VERSION,
  };
}

export async function uninstallSkill(skillFile: string): Promise<SkillUninstallResult> {
  const status = await getSkillStatus(skillFile);
  if (!status.installed) {
    return { removed: false, path: skillFile };
  }

  await rm(skillFile, { force: true });
  await removeDirIfEmpty(dirname(skillFile));
  return { removed: true, path: skillFile };
}

async function removeDirIfEmpty(path: string): Promise<void> {
  try {
    if ((await readdir(path)).length === 0) {
      await rmdir(path);
    }
  } catch {
    // Best-effort cleanup only; user files in the skill directory must be preserved.
  }
}
