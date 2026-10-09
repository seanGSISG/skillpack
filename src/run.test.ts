import { expect, test } from "bun:test";
import { signInOptions } from "./run.ts";

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
