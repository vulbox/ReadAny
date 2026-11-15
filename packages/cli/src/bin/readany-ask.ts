/**
 * readany-ask — standalone entrypoint for `readany ask`.
 *
 * Only parses arguments and delegates to the shared runAsk implementation
 * (the same one behind `readany ask`); all agent, book-selection, and output
 * formatting logic lives in src/ask.ts.
 */
import { askOptionsFromCommand, runAsk } from "../ask.js";
import { parseCommand } from "../commands.js";
import { formatJson, formatText } from "../format.js";

// Prepend the "ask" command name so parseCommand keeps the full prompt in
// args (positional[0] is always treated as the command name).
const parsed = parseCommand(["ask", ...process.argv.slice(2)]);

try {
  const result = await runAsk(askOptionsFromCommand(parsed));
  const output = parsed.json ? formatJson(result) : formatText(result);

  if (result.ok) {
    process.stdout.write(output);
  } else {
    process.stderr.write(output);
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
