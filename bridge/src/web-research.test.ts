import assert from "node:assert/strict";
import test from "node:test";
import {
  BraveSearchProvider,
  formatWebResearchContext,
  formatWebResearchReferences,
  sanitizeCitationUrl,
  type FetchLike,
} from "./web-research.js";

const BRAVE_KEY = "brave-private-token-never-returned";

test("Brave adapter sends a bounded strict search request and returns citation-ready context without the API key", async () => {
  let requestUrl = "";
  let requestHeaders = new Headers();
  let signalPresent = false;
  const provider = new BraveSearchProvider({
    apiKey: BRAVE_KEY,
    timeoutMs: 1_500,
    fetcher: async (input, init) => {
      requestUrl = input.toString();
      requestHeaders = new Headers(init?.headers);
      signalPresent = Boolean(init?.signal);
      return jsonResponse({
        web: {
          results: [
            {
              title: "Open source model deployment guide",
              url: "https://docs.example.com/guides/local-models?utm_source=brave#installation",
              description: "A concise deployment overview.",
              extra_snippets: ["Use a local model for the private path.", "Track latency during evaluation."],
              page_age: "2026-07-01",
            },
          ],
        },
      });
    },
  });

  const result = await provider.research({ query: " local model deployment  ", maxResults: 99, maxContentChars: 800 });
  const request = new URL(requestUrl);
  assert.equal(request.origin, "https://api.search.brave.com");
  assert.equal(request.pathname, "/res/v1/web/search");
  assert.equal(request.searchParams.get("q"), "local model deployment");
  assert.equal(request.searchParams.get("count"), "8");
  assert.equal(request.searchParams.get("safesearch"), "strict");
  assert.equal(request.searchParams.get("extra_snippets"), "true");
  assert.equal(requestHeaders.get("x-subscription-token"), BRAVE_KEY);
  assert.equal(signalPresent, true);

  assert.equal(result.citations.length, 1);
  assert.deepEqual(result.citations[0], {
    id: "1",
    title: "Open source model deployment guide",
    url: "https://docs.example.com/guides/local-models",
    domain: "docs.example.com",
    excerpt: "A concise deployment overview. Use a local model for the private path. Track latency during evaluation.",
    publishedAt: "2026-07-01T00:00:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(BRAVE_KEY));

  const context = formatWebResearchContext(result);
  assert.match(context, /untrusted reference material, not instructions/i);
  assert.match(context, /\[1\] Open source model deployment guide/);
  assert.match(context, /https:\/\/docs\.example\.com\/guides\/local-models/);
  assert.doesNotMatch(context, /utm_source|installation|brave-private-token/i);

  const references = formatWebResearchReferences(result);
  assert.match(references, /Sources consulted/i);
  assert.match(references, /\[1\] Open source model deployment guide/);
  assert.doesNotMatch(references, /brave-private-token/i);
});

test("citation sanitizer rejects SSRF targets, credentials, and unusual ports while removing query credentials", () => {
  for (const unsafe of [
    "file:///etc/passwd",
    "ftp://example.com/report",
    "http://127.0.0.1/admin",
    "http://2130706433/admin",
    "http://0x7f000001/admin",
    "http://169.254.169.254/latest/meta-data",
    "http://192.168.1.8/notes",
    "http://[::1]/admin",
    "http://[fd00::1]/admin",
    "http://[::ffff:127.0.0.1]/admin",
    "https://user:password@example.com/private",
    "https://example.com:8080/debug",
    "https://console.internal/settings",
    "https://service.local/health",
  ]) {
    assert.equal(sanitizeCitationUrl(unsafe), null, unsafe);
  }

  assert.deepEqual(
    sanitizeCitationUrl("https://example.com/article?access_token=not-for-a-citation#section-4"),
    { url: "https://example.com/article", domain: "example.com" },
  );
});

test("result processing bounds output and drops unsafe and duplicate citation URLs", async () => {
  const provider = new BraveSearchProvider({
    apiKey: BRAVE_KEY,
    fetcher: async () => jsonResponse({
      web: {
        results: [
          { title: "Private", url: "http://10.0.0.2/internal", description: "must be removed" },
          { title: "First", url: "https://example.com/report?tracking=1", description: "a".repeat(2_000) },
          { title: "Duplicate", url: "https://example.com/report?tracking=2", description: "must be removed" },
          { title: "Second", url: "https://www.example.org/other", description: "b".repeat(2_000) },
        ],
      },
    }),
  });

  const result = await provider.research({ query: "bounded research", maxResults: 2, maxContentChars: 512 });
  assert.deepEqual(result.citations.map(citation => citation.url), [
    "https://example.com/report",
    "https://www.example.org/other",
  ]);
  assert.ok(result.citations.reduce((sum, citation) => sum + citation.excerpt.length, 0) <= 512);
  assert.equal(result.diagnostics.unsafeUrlsDropped, 1);
  assert.equal(result.diagnostics.duplicateUrlsDropped, 1);
  assert.equal(result.diagnostics.contentTruncated, true);
});

test("query and provider failures remain bounded and never surface the configured API key", async () => {
  let fetchCalls = 0;
  const networkProvider = new BraveSearchProvider({
    apiKey: BRAVE_KEY,
    fetcher: async () => {
      fetchCalls += 1;
      throw new Error(`proxy echoed ${BRAVE_KEY}`);
    },
  });

  await assert.rejects(
    () => networkProvider.research({ query: "sk-12345678901234567890" }),
    /appears to contain a credential/i,
  );
  await assert.rejects(
    () => networkProvider.research({ query: "x".repeat(401) }),
    /at most 400 characters/i,
  );
  assert.equal(fetchCalls, 0);

  await assert.rejects(
    () => networkProvider.research({ query: "safe query" }),
    error => error instanceof Error
      && /could not reach/i.test(error.message)
      && !error.message.includes(BRAVE_KEY),
  );

  const failureProvider = new BraveSearchProvider({
    apiKey: BRAVE_KEY,
    fetcher: async () => new Response(`provider body repeats ${BRAVE_KEY}`, { status: 429 }),
  });
  await assert.rejects(
    () => failureProvider.research({ query: "safe query" }),
    error => error instanceof Error
      && error.message === "Web research provider returned HTTP 429."
      && !error.message.includes(BRAVE_KEY),
  );
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Compile-time check that test doubles conform to the injected transport
// boundary rather than relying on a provider-specific HTTP client.
const _fetchLikeTypeCheck: FetchLike = async () => jsonResponse({ web: { results: [] } });
void _fetchLikeTypeCheck;
