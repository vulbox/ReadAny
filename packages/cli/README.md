# @readany/cli

`@readany/cli` is the local command and MCP entry point for external AI access to ReadAny.

Book Q&A:

```bash
readany books search "<book title>" --json
readany ask "<question>" --book <book-id> --thread <session>
```

`ask` calls the existing core `StreamingChat` once, using its message pipeline,
history window, citation replay and completion/error handling. It forwards the
original prompt, without CLI deep-reading instructions, automatic continuation,
answer rewriting or merging. The read-only tool adapter remains enabled.

CLI threads stay in CLI-owned files, separate from the app chat database. The
CLI does not issue additional memory-summary model calls; stored legacy memory
is still passed through. CLI thread persistence does not write to the app chat
database.

Default output is the final answer, inline mindmap content and citations, without tool traces or diagnostic logs.
`--json` returns the answer, citations, `artifacts`, context/thread metadata and `toolCallCount`;
`artifacts` preserves mindmap title, `format: "markmap"`, original Markdown and optional
node/depth stats. Text output appends the mindmap outline, and named threads retain it.
Mermaid blocks inside the answer pass through unchanged. Rendering depends on the
receiving client; a plain terminal displays the source text.
full tool results and diagnostic logs require `--debug`.
To keep round evidence out of the response, use `--trace-file <new-file.jsonl>`.
This writes timestamped round prompts/history, observable tool results, citations,
answers and stop flags to a new local file, including evidence before failure.
Existing files are never overwritten. There is one execution per trace; hitting
a tool budget is recorded without restarting. On a shared-service error, JSON
returns a failure with any partial answer/citations in `error.details`.
Legacy `--max-rounds 1` and `--no-thorough` remain compatible; larger round counts
and `--thorough` are rejected. Known endpoint/environment credentials are
redacted; model reasoning and HTTP authentication headers are not recorded.
External agents match the book title, relay one unchanged user prompt per invocation,
and display the answer directly. They wait for a new user request before following up;
they do not automatically retry or fetch raw chapters to supplement an answer.

Current phase:

- `readany --version`
- `readany doctor`
- `readany install`
- `readany uninstall`
- `readany skill install`
- `readany skill uninstall`
- `readany skill status`
- `readany tools list`
- `readany books list`
- `readany books search`
- `readany book get`
- `readany chapters list`
- `readany chapter get`
- `readany notes search`
- `readany highlights search`
- `readany rag search --book <book-id>`
- `readany mcp serve --profile readonly`

Current MCP tools:

```text
books.list
books.search
books.get
chapters.list
chapters.get
notes.search
highlights.search
rag.search
```

Development:

```bash
pnpm --filter @readany/cli dev -- --version
pnpm --filter @readany/cli check
pnpm --filter @readany/cli test
pnpm --filter @readany/cli build
```

Design docs live in `docs/readany-cli`.
