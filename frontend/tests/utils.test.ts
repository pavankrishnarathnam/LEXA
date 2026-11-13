import { describe, expect, it } from "vitest";
import { cn, compact, timeAgo, usd } from "@/lib/utils";

describe("utils", () => {
  it("merges tailwind classes", () => expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4"));
  it("formats money including sub-cent values", () => {
    expect(usd(1.5)).toBe("$1.50");
    expect(usd(0.0012)).toBe("$0.0012");
  });
  it("formats relative time", () => {
    expect(timeAgo(new Date().toISOString())).toBe("just now");
    expect(timeAgo(new Date(Date.now() - 3 * 3600e3).toISOString())).toBe("3h ago");
    expect(timeAgo(null)).toBe("—");
  });
  it("compacts numbers", () => expect(compact(15300)).toMatch(/15\.3K/i));
});
