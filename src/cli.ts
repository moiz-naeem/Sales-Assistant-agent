// This file is the chat window in the terminal: you type, the assistant answers, "exit" quits.
// Nothing else is printed. Everything we might want to inspect later goes quietly into the log file.

import { createInterface } from "node:readline/promises";
import { handleMessage, type LoopDeps } from "./agent/loop";
import { SYSTEM_PROMPT } from "./agent/prompt";
import { newSession } from "./agent/state";
import { TOOLS, type ToolName } from "./agent/tools";
import { validateAnswer } from "./agent/validateAnswer";
import { generate } from "./llm/gemini";
import { writeTrace } from "./log/trace";
import { serviceRecords } from "./services/records";

const deps: LoopDeps = {
  generate,
  runTool: (name: ToolName, args) => {
    const tool = TOOLS[name];
    if (!("run" in tool)) throw new Error(`${name} is not a tool the loop runs.`);
    return tool.run(args as never);
  },
  validateAnswer,
  system: SYSTEM_PROMPT,
  records: serviceRecords(),
};


async function* linesFrom(): AsyncGenerator<string> {
  if (process.stdin.isTTY) {
    const io = createInterface({ input: process.stdin, output: process.stdout });

    try {
      for (;;) {
        const asked = await io.question("you> ").catch(() => null);
        if (asked === null) break;
        yield asked;
      }
    } finally {
      io.close();
    }
    return;
  }
  let piped = "";
  for await (const chunk of process.stdin) piped += chunk;
  for (const line of piped.split(/\r?\n/)) {
    process.stdout.write(`you> ${line}\n`);
    yield line;
  }
}

async function main() {
  const state = newSession();
  console.log('Ask about Metso equipment or what a service visit cost before. Type "exit" to quit.\n');

  for await (const asked of linesFrom()) {
    const said = asked.trim();
    if (!said) continue;
    if (said.toLowerCase() === "exit") break;

    try {
      const turn = await handleMessage(state, said, deps);
      writeTrace(turn.trace);
      console.log(`\nassistant> ${turn.text}\n`);
    } catch (error) {
      console.log("\nassistant> Sorry, something went wrong on my side. Please try that again.\n");
      writeTrace({
        turn: state.turn_index,
        user_message: said,
        state_before: "",
        iterations: [],
        slots: { grounded: [], missing: [] },
        validator: [],
        outcome: "failure",
        totals: { tokens: 0, latencyMs: 0 },
        clarification: error instanceof Error ? error.stack : String(error),
      });
    }
  }
}

await main();
