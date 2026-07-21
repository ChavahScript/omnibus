import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectWorkspaceContext, formatWorkspaceContext } from "./workspace-context.js";

test("workspace context stays bounded and refuses dependency, VCS, symlink, and secret paths", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "omnibus-context-test-"));
  try {
    await Promise.all([
      mkdir(path.join(workspace, "src"), { recursive: true }),
      mkdir(path.join(workspace, "node_modules", "example"), { recursive: true }),
      mkdir(path.join(workspace, ".git"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(workspace, "README.md"), "# Safe project\nThis source is useful to the local auditor.\n"),
      writeFile(path.join(workspace, "src", "index.ts"), "export const projectName = 'Omnibus';\n"),
      writeFile(path.join(workspace, "src", "runtime.ts"), "const apiKey = 'this-is-a-real-looking-secret';\nexport default apiKey;\n"),
      writeFile(path.join(workspace, ".env"), "OPENAI_API_KEY=sk-this-must-never-reach-the-model\n"),
      writeFile(path.join(workspace, "node_modules", "example", "index.ts"), "export const dependencySecret = 'blocked';\n"),
      writeFile(path.join(workspace, ".git", "config"), "[remote]\nurl = secret://never-read\n"),
    ]);
    await symlink(path.join(workspace, ".env"), path.join(workspace, "src", "linked-env.ts"));

    const context = await collectWorkspaceContext(workspace, { maxFiles: 16, maxSnippets: 6, maxChars: 4_000 });
    assert.equal(context.available, true);
    assert.deepEqual(context.files.map(file => file.path).sort(), ["README.md", "src/index.ts", "src/runtime.ts"]);
    assert.equal(context.snippets.some(snippet => snippet.path === "src/runtime.ts"), false);
    assert.equal(context.snippets.some(snippet => snippet.text.includes("real-looking-secret")), false);
    assert.equal(context.files.some(file => file.path.includes("node_modules") || file.path.includes(".git") || file.path.includes(".env")), false);
    assert.ok(context.omitted.excluded >= 3);
    assert.equal(context.omitted.sensitive, 1);

    const promptContext = formatWorkspaceContext(context);
    assert.match(promptContext, /src\/index\.ts/);
    assert.doesNotMatch(promptContext, /real-looking-secret|OPENAI_API_KEY|secret:\/\//);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
