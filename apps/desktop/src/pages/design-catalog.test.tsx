import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { componentExamples, DesignComponentsLayer } from "@/pages/design-components";

describe("Component catalog navigation", () => {
  it("groups all entries by purpose and mounts only the selected preview", async () => {
    const user = userEvent.setup();
    render(<DesignComponentsLayer />);
    const catalog = screen.getByRole("navigation", { name: "Component catalog" });
    expect(within(catalog).getAllByRole("button")).toHaveLength(componentExamples.length);
    expect(within(catalog).queryByRole("button", { name: "PiSheet" })).not.toBeInTheDocument();
    for (const category of ["Data & metrics", "Conversation", "Composer", "Reasoning & tools", "Workspace & trajectory", "Visual primitives"]) {
      expect(within(catalog).getByText(category)).toBeInTheDocument();
    }
    await user.click(within(catalog).getByRole("button", { name: "PiKpi" }));
    expect(screen.getByRole("region", { name: "PiKpi" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "ChatTool" })).not.toBeInTheDocument();
    await user.click(within(catalog).getByRole("button", { name: "ChatTool" }));
    expect(screen.getByRole("region", { name: "ChatTool" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "PiKpi" })).not.toBeInTheDocument();
  });

  it("searches names, purposes and categories, with a recoverable empty state", async () => {
    const user = userEvent.setup();
    render(<DesignComponentsLayer />);
    const search = screen.getByRole("textbox", { name: "Search components" });
    const catalog = screen.getByRole("navigation", { name: "Component catalog" });
    await user.type(search, "  COMPOSER  ");
    expect(within(catalog).getAllByRole("button")).toHaveLength(6);
    expect(screen.queryByRole("region", { name: "PiKpi" })).not.toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "token budget");
    expect(within(catalog).getByRole("button", { name: "ContextUsageMeter" })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "no-such-component");
    expect(screen.getByText("No components found")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "ContextUsageMeter" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(within(catalog).getAllByRole("button")).toHaveLength(componentExamples.length);
  });

  it("labels each preview state before its sample and supports keyboard selection", async () => {
    const user = userEvent.setup();
    render(<DesignComponentsLayer />);
    await user.click(within(screen.getByRole("navigation", { name: "Component catalog" })).getByRole("button", { name: "PiKpi" }));
    const variant = screen.getByRole("group", { name: "layout=stacked" });
    expect(variant.firstElementChild).toHaveTextContent("layout=stacked");
    const target = within(screen.getByRole("navigation", { name: "Component catalog" })).getByRole("button", { name: "PiLineChart" });
    target.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("region", { name: "PiLineChart" })).toBeInTheDocument();
    expect(target).toHaveAttribute("aria-current", "page");
  });
});
