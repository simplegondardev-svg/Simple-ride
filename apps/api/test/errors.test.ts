import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Every error code the API can return must be in docs/ERRORS.md, and vice versa. */

const root = path.join(import.meta.dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });

function codesInSource(): string[] {
  const codes = new Set<string>();
  const patterns = [/AppError\(\s*\d+,\s*"([A-Z_]+)"/g, /conflict\(\s*"([A-Z_]+)"/g, /code: "([A-Z_]+)"/g];
  for (const file of files(path.join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const re of patterns) for (const m of text.matchAll(re)) codes.add(m[1]!);
  }
  return [...codes].sort();
}

function codesInCatalogue(): string[] {
  const doc = readFileSync(path.join(root, "..", "..", "docs", "ERRORS.md"), "utf8");
  return [...doc.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]!).sort();
}

describe("error code catalogue", () => {
  it("documents exactly the codes the API returns", () => {
    expect(codesInCatalogue()).toEqual(codesInSource());
  });

  it("has no duplicates", () => {
    const listed = codesInCatalogue();
    expect(new Set(listed).size).toBe(listed.length);
  });
});
