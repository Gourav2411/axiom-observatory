import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const functionUrl = new URL(
  "../supabase/functions/axiom-embed/index.ts",
  import.meta.url,
);
const configUrl = new URL("../supabase/config.toml", import.meta.url);

test("axiom-embed keeps the built-in embedding session warm and authenticated", async () => {
  const source = await readFile(functionUrl, "utf8");
  const serveOffset = source.indexOf("Deno.serve");
  const sessionOffset = source.indexOf(
    'new Supabase.ai.Session("gte-small")',
  );

  assert.ok(sessionOffset >= 0, "gte-small session must be declared");
  assert.ok(
    sessionOffset < serveOffset,
    "embedding session must be initialized at module scope",
  );
  assert.match(source, /request\.method !== "POST"/);
  assert.match(source, /\^Bearer\\s\+\\S\+\$\/i/);
  assert.match(source, /"www-authenticate": "Bearer"/);
  assert.match(source, /Deno\.env\.get\("AXIOM_EMBED_INTERNAL_KEY"\)/);
  assert.match(source, /request\.headers\.get\("x-axiom-internal-key"\)/);
  assert.match(source, /internalKeyMatches/);
});

test("axiom-embed enforces the bounded, normalized 384d batch contract", async () => {
  const source = await readFile(functionUrl, "utf8");

  assert.match(source, /const MAX_BATCH_SIZE = 6;/);
  assert.match(source, /const MIN_INPUT_CHARACTERS = 3;/);
  assert.match(source, /const MAX_INPUT_CHARACTERS = 2_000;/);
  assert.match(source, /const DIMENSIONS = 384;/);
  assert.match(source, /mean_pool: true/);
  assert.match(source, /normalize: true/);
  assert.match(source, /Number\.isFinite\(entry\)/);
  assert.match(source, /Math\.abs\(magnitudeSquared - 1\) > 0\.02/);
  assert.match(source, /model: MODEL/);
  assert.match(source, /revision: MODEL_REVISION/);
  assert.match(source, /normalized: true/);
  assert.match(source, /embeddings\.push\(\{ id: item\.id, embedding \}\)/);
});

test("axiom-embed leaves Supabase gateway JWT verification enabled", async () => {
  const config = await readFile(configUrl, "utf8");
  const functionConfig = config.match(
    /\[functions\.axiom-embed\]([\s\S]*?)(?=\n\[|$)/,
  )?.[1] ?? "";

  assert.doesNotMatch(functionConfig, /verify_jwt\s*=\s*false/);
});
