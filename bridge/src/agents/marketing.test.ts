import assert from "node:assert/strict";
import test from "node:test";
import { buildMarketingPrompt, extractHiggsfieldJob } from "./marketing.js";

test("marketing prompt is bounded and includes rights-safe creative guidance", () => {
  const prompt = buildMarketingPrompt("A small local bakery is launching a zero-waste breakfast box.");
  assert.match(prompt, /15-second vertical product-story/i);
  assert.match(prompt, /third-party trademarks, copyrighted characters, logos, or music/i);
  assert.match(prompt, /zero-waste breakfast box/i);

  const longPrompt = buildMarketingPrompt("x".repeat(7_000));
  assert.ok(longPrompt.length < 6_700);
});

test("marketing job extraction accepts final JSON and NDJSON CLI output", () => {
  assert.deepEqual(
    extractHiggsfieldJob('{"job":{"id":"job_123","status":"completed","video_url":"https://media.example/video.mp4"}}'),
    { id: "job_123", status: "completed", assetUrl: "https://media.example/video.mp4" },
  );
  assert.deepEqual(
    extractHiggsfieldJob('queued\n{"generationId":"gen_456","state":"ready","outputUrl":"https://media.example/output.mp4"}\n'),
    { id: "gen_456", status: "ready", assetUrl: "https://media.example/output.mp4" },
  );
});
