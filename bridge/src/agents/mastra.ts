import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import type { AppConfig } from "../config.js";

const WorkflowInput = z.object({ correlationId: z.string().uuid(), directive: z.string(), mode: z.enum(["build", "plan", "marketing"]), research: z.boolean().default(false) });
const WorkflowOutput = z.object({ correlationId: z.string().uuid(), directive: z.string(), mode: z.enum(["build", "plan", "marketing"]), research: z.boolean().default(false) });

const preserveCommand = createStep({
  id: "preserve-command",
  inputSchema: WorkflowInput,
  outputSchema: WorkflowOutput,
  execute: async ({ inputData }) => inputData,
});

export const ceoCommandWorkflow = createWorkflow({
  id: "ceo-command-workflow",
  inputSchema: WorkflowInput,
  outputSchema: WorkflowOutput,
}).then(preserveCommand).commit();

/**
 * Mastra owns agent identity and a typed, inspectable workflow graph. The
 * orchestrator below invokes local Ollama and optional external providers
 * directly. The default developer descriptor is local too; cloud use is only
 * selected explicitly in the bridge configuration.
 */
export function createMastraRuntime(config: AppConfig): Mastra {
  const developerModel = config.developerProvider === "responses"
    ? `openai/${config.openaiModel}`
    : `ollama/${config.ollamaDeveloperModel}`;
  const developer = new Agent({
    id: "developer-agent",
    name: "Developer",
    instructions: "Produce concise, testable implementation work. Never claim execution that did not happen.",
    model: developerModel,
  });
  const auditor = new Agent({
    id: "auditor-agent",
    name: "Auditor",
    instructions: "Return concise risk and scope summaries. Do not emit hidden chain-of-thought.",
    model: `ollama/${config.ollamaModel}`,
  });
  const marketing = new Agent({
    id: "marketing-ops-agent",
    name: "Marketing/Ops",
    instructions: "Create assets only with explicit approval and never bypass a platform's access controls.",
    // Marketing invokes its explicitly armed CLI adapter at runtime. Keeping
    // this graph descriptor local avoids an implicit cloud model dependency.
    model: `ollama/${config.ollamaDeveloperModel}`,
  });
  return new Mastra({
    agents: { developer, auditor, marketing },
    workflows: { ceoCommandWorkflow },
  });
}
