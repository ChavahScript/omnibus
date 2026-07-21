import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArguments } from "./cli.js";

test("the safe first-run command requires an explicit model-pull flag", () => {
  assert.deepEqual(parseCliArguments(["setup"]), {
    command: "setup",
    installRuntime: false,
    pullModels: false,
    yes: false,
    startOllama: true,
    fix: false,
    force: false,
  });
  assert.deepEqual(parseCliArguments(["setup", "--install-runtime", "--pull-models", "--yes"]), {
    command: "setup",
    installRuntime: true,
    pullModels: true,
    yes: true,
    startOllama: true,
    fix: false,
    force: false,
  });
});

test("the CLI rejects noninteractive consent without an explicit download request", () => {
  assert.throws(() => parseCliArguments(["start", "--yes"]), /only valid with --install-runtime and\/or --pull-models/);
  assert.throws(() => parseCliArguments(["setup", "--unknown"]), /Unknown option/);
  assert.throws(() => parseCliArguments(["doctor", "--install-runtime"]), /doctor is read-only/);
});

test("the advertised help subcommand is accepted alongside --help", () => {
  assert.equal(parseCliArguments(["help"]).command, "help");
  assert.equal(parseCliArguments(["--help"]).command, "help");
});

test("the worker command accepts only an explicit invitation payload", () => {
  assert.deepEqual(parseCliArguments(["worker", "--join", "eyJ0eXBlIjoiaG9tZV9mbGVldC5qb2luIn0", "--pull-models"]), {
    command: "worker",
    installRuntime: false,
    pullModels: true,
    yes: false,
    startOllama: true,
    fix: false,
    force: false,
    joinPayload: "eyJ0eXBlIjoiaG9tZV9mbGVldC5qb2luIn0",
  });
  assert.throws(() => parseCliArguments(["start", "--join", "payload"]), /only valid with `omnibus-bridge worker`/);
  assert.throws(() => parseCliArguments(["worker", "--join"]), /requires one base64url invitation/);
});

test("the hook command exposes exactly three gate actions with scoped flags", () => {
  assert.deepEqual(parseCliArguments(["hook", "check", "--staged", "--fix"]), {
    command: "hook",
    hookAction: "check",
    installRuntime: false,
    pullModels: false,
    yes: false,
    startOllama: true,
    fix: true,
    force: false,
  });
  assert.equal(parseCliArguments(["hook", "install", "--force"]).hookAction, "install");
  assert.equal(parseCliArguments(["hook", "uninstall"]).hookAction, "uninstall");
  assert.throws(() => parseCliArguments(["hook"]), /needs one action/);
  assert.throws(() => parseCliArguments(["hook", "run"]), /needs one action/);
  assert.throws(() => parseCliArguments(["hook", "check", "--pull-models"]), /never download software or models/);
  assert.throws(() => parseCliArguments(["hook", "install", "--fix"]), /only valid with `omnibus-bridge hook check`/);
  assert.throws(() => parseCliArguments(["setup", "--force"]), /only valid with `omnibus-bridge hook install`/);
});
