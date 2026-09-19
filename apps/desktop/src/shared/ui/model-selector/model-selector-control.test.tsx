import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeModelControls } from "@pace/core";
import { ModelSelectorControl } from "@/shared/ui/model-selector/model-selector-control";

const controls: RuntimeModelControls = {
  models: [
    {
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      thinkingLevels: ["off", "low", "medium", "high"],
    },
    {
      provider: "xai",
      modelId: "grok-4",
      name: "Grok 4",
      thinkingLevels: ["off", "medium", "high"],
    },
    {
      provider: "moonshot",
      modelId: "kimi-k3",
      name: "Kimi K3",
      thinkingLevels: ["off"],
    },
  ],
  selected: {
    provider: "xai",
    modelId: "grok-4",
    thinkingLevel: "high",
  },
};

async function openSelector() {
  const user = userEvent.setup();

  await user.click(screen.getByTestId("model-thinking-trigger"));

  return {
    user,
    list: await screen.findByTestId("model-thinking-model-list"),
  };
}

describe("ModelSelectorControl visibility", () => {
  it("lists the whole catalog when no visibility is configured", async () => {
    render(
      <ModelSelectorControl
        controls={controls}
        isDisabled={false}
        onChange={() => {}}
      />,
    );

    const { list } = await openSelector();

    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  });

  it("hides models left out of the visible set", async () => {
    render(
      <ModelSelectorControl
        controls={controls}
        isDisabled={false}
        visibleModels={[
          { provider: "anthropic", modelId: "claude-sonnet-4" },
          { provider: "xai", modelId: "grok-4" },
        ]}
        onChange={() => {}}
      />,
    );

    const { list } = await openSelector();

    expect(within(list).getByText("Claude Sonnet 4")).toBeInTheDocument();
    expect(within(list).queryByText("Kimi K3")).not.toBeInTheDocument();
  });

  it("keeps a hidden current selection listed and marks it", async () => {
    render(
      <ModelSelectorControl
        controls={controls}
        isDisabled={false}
        visibleModels={[{ provider: "anthropic", modelId: "claude-sonnet-4" }]}
        onChange={() => {}}
      />,
    );

    const { list } = await openSelector();
    const rows = within(list).getAllByRole("listitem");

    expect(rows).toHaveLength(2);
    expect(within(list).getByText("Grok 4")).toBeInTheDocument();
    expect(within(list).getByText("Hidden in Settings")).toBeInTheDocument();
  });

  it("opens model management from the Add Models row", async () => {
    const onManageModels = vi.fn();

    render(
      <ModelSelectorControl
        controls={controls}
        isDisabled={false}
        onChange={() => {}}
        onManageModels={onManageModels}
      />,
    );

    const { user } = await openSelector();

    await user.click(screen.getByText("Add Models"));

    expect(onManageModels).toHaveBeenCalledTimes(1);
  });
});

describe("ModelSelectorControl provider mark", () => {
  it("shows the provider mark next to the model name for a known provider", () => {
    render(
      <ModelSelectorControl
        controls={controls}
        isDisabled={false}
        onChange={() => {}}
      />,
    );

    // Selected model is xai/grok-4, a brand with a mark in provider-icon.tsx.
    expect(
      within(screen.getByTestId("model-thinking-trigger")).getByTestId(
        "provider-mark-xai",
      ),
    ).toBeInTheDocument();
  });

  it("renders no mark, and no placeholder, for an unknown provider", () => {
    const unknownProviderControls: RuntimeModelControls = {
      models: controls.models,
      selected: {
        // "moonshot" has no brand entry (catalog uses "moonshotai"), so it
        // exercises the unknown-provider path.
        provider: "moonshot",
        modelId: "kimi-k3",
        thinkingLevel: "off",
      },
    };

    render(
      <ModelSelectorControl
        controls={unknownProviderControls}
        isDisabled={false}
        onChange={() => {}}
      />,
    );

    const trigger = screen.getByTestId("model-thinking-trigger");

    expect(
      within(trigger).queryByTestId(/^provider-mark-/),
    ).not.toBeInTheDocument();
  });

  it("shows provider marks on model list rows for known providers", async () => {
    render(
      <ModelSelectorControl
        controls={controls}
        isDisabled={false}
        onChange={() => {}}
      />,
    );

    const { list } = await openSelector();

    // anthropic and xai both have brand marks; moonshot (catalog id) does not.
    expect(within(list).getByTestId("provider-mark-anthropic")).toBeInTheDocument();
    expect(within(list).getByTestId("provider-mark-xai")).toBeInTheDocument();
    expect(within(list).queryByTestId("provider-mark-moonshot")).not.toBeInTheDocument();
  });

  it("reserves the mark's slot on an unknown-provider list row so labels stay aligned", async () => {
    render(
      <ModelSelectorControl
        controls={controls}
        isDisabled={false}
        onChange={() => {}}
      />,
    );

    const { list } = await openSelector();

    // Kimi K3 is the moonshot row (unknown brand): its row still gets a
    // same-size placeholder box instead of no mark, so its label lines up
    // under the anthropic/xai rows' marks.
    const kimiRow = within(list).getByText("Kimi K3").closest("li");

    expect(kimiRow).not.toBeNull();
    expect(
      within(kimiRow as HTMLElement).getByTestId("provider-mark-placeholder"),
    ).toBeInTheDocument();
  });
});
