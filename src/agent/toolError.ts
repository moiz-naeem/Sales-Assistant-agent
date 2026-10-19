// This file holds the one shape we use when a tool cannot do its job.


export type ToolError = {
  kind: "tool_error";
  tool: string;
  reason: "validation" | "budget" | "runtime" | "cap" | "ungrounded";
  message: string;
};

export const toolError = (tool: string, reason: ToolError["reason"], message: string): ToolError => ({
  kind: "tool_error",
  tool,
  reason,
  message,
});
