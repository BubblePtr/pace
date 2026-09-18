import { describe, expect, it } from "vitest";
import { sortProvidersForDisplay } from "./provider-auth";

describe("sortProvidersForDisplay", () => {
  it("orders configured, then featured, then alphabetical by label", () => {
    const items = [
      { id: "together", label: "Together", configured: false },
      { id: "radius", label: "Radius", configured: false },
      { id: "baseten", label: "Baseten", configured: true },
      { id: "anthropic", label: "Anthropic", configured: false },
      { id: "openai", label: "OpenAI", configured: true },
      { id: "cerebras", label: "Cerebras", configured: false },
    ];

    expect(sortProvidersForDisplay(items).map((item) => item.id)).toEqual([
      "openai",
      "baseten",
      "anthropic",
      "radius",
      "cerebras",
      "together",
    ]);
  });
});
