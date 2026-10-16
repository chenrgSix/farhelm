import { afterEach, expect, it, vi } from "vitest";
import { copyText } from "../src/clipboard";
afterEach(() => vi.restoreAllMocks());
it("copies on plain HTTP without Clipboard API and restores focus", async () => {
  Object.defineProperty(navigator, "clipboard", {
    value: undefined,
    configurable: true,
  });
  const copy = vi.fn(() => true);
  Object.defineProperty(document, "execCommand", {
    value: copy,
    configurable: true,
  });
  const button = document.createElement("button");
  document.body.append(button);
  button.focus();
  await copyText("ssh -tt -p 2222 admin@platform");
  expect(copy).toHaveBeenCalledWith("copy");
  expect(document.querySelector("textarea")).toBeNull();
  expect(document.activeElement).toBe(button);
  button.remove();
});
it("reports failed HTTP copy and removes temporary contents", async () => {
  Object.defineProperty(navigator, "clipboard", {
    value: undefined,
    configurable: true,
  });
  Object.defineProperty(document, "execCommand", {
    value: () => false,
    configurable: true,
  });
  await expect(copyText("text")).rejects.toThrow("Clipboard unavailable");
  expect(document.querySelector("textarea")).toBeNull();
});
