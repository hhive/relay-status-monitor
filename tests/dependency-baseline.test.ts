import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const packageJson = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8"),
) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  pnpm?: {
    overrides?: Record<string, string>;
  };
};

const gitignoreRules = readFileSync(path.join(projectRoot, ".gitignore"), "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));

test("pins the supported Next.js dependency baseline", () => {
  assert.equal(packageJson.dependencies.next, "15.5.21");
  assert.equal(packageJson.devDependencies["eslint-config-next"], "15.5.21");
  assert.match(packageJson.dependencies.react, /^\^18(?:\.|$)/);
  assert.match(packageJson.dependencies["react-dom"], /^\^18(?:\.|$)/);
  assert.equal(packageJson.pnpm?.overrides?.sharp, "0.35.3");
  assert.equal(packageJson.pnpm?.overrides?.postcss, "8.5.26");
  assert.equal(packageJson.pnpm?.overrides?.nanoid, "3.3.18");
});

test("provides Node test runner and typecheck scripts", () => {
  assert.match(packageJson.scripts.test, /tsx\s+--test/);
  assert.match(packageJson.scripts["test:security"], /tsx\s+--test/);
  assert.equal(packageJson.scripts.typecheck, "tsc --noEmit");
});

test("builds a standalone Next.js deployment", async () => {
  const { default: nextConfig } = await import(
    pathToFileURL(path.join(projectRoot, "next.config.mjs")).href
  );
  assert.equal(nextConfig.output, "standalone");
});

test("keeps repository tests trackable", () => {
  assert.ok(gitignoreRules.includes("!/tests/"));
  assert.ok(gitignoreRules.includes("!/tests/**"));

  const ignored = spawnSync(
    "git",
    ["check-ignore", "--quiet", "--no-index", "tests/dependency-baseline.test.ts"],
    { cwd: projectRoot },
  );
  assert.equal(ignored.status, 1, "tests/dependency-baseline.test.ts must not be ignored");
});
