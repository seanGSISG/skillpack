import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configure, signInOptions } from "./run.ts";

const octen = {
  kind: "login",
  command: "octen",
  auth: ["octen", "whoami", "--json"],
  login: ["octen", "login"],
  apiKey: { login: ["octen", "login", "--api-key"] },
} as const satisfies Parameters<typeof signInOptions>[0];
const order = (options: ReturnType<typeof signInOptions>) => options.map((option) => option.value);

test("sign-in offers the browser first, a pasted key first over SSH, and never a key the tool can't take", () => {
  expect(order(signInOptions(octen, false))).toEqual(["browser", "key", "later"]);
  expect(order(signInOptions(octen, true))).toEqual(["key", "browser", "later"]);
  const { apiKey, ...browserOnly } = octen;
  expect(order(signInOptions(browserOnly, true))).toEqual(["browser", "later"]);
});

test("setup never starts without a terminal, and a passing check skips it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skillpack-setup-"));
  const script = join(dir, "peer");
  writeFileSync(script, "#!/bin/sh\nexit 1\n");
  chmodSync(script, 0o755);
  const step: Parameters<typeof configure>[0] = {
    kind: "setup",
    id: "council@x",
    skill: "council",
    run: ["peer", "setup"],
    check: ["peer"],
  };
  // Without a terminal, even an interactive run must hand the command back.
  process.stdin.isTTY = false;
  expect(await configure(step, true, dir)).toEqual({ status: "manual", detail: `run: ${script} setup` });
  writeFileSync(script, "#!/bin/sh\nexit 0\n");
  expect((await configure(step, true, dir)).status).toBe("skipped");
});
