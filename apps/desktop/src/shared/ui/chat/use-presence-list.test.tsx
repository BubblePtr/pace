import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { usePresenceList } from "@/shared/ui/chat/use-presence-list";

function Harness({ items }: { items: string[] }) {
  const { present, onExitTransitionEnd } = usePresenceList(items, (id) => id, {
    exitTimeoutMs: 150,
  });

  return (
    <ul>
      {present.map((record) => (
        <li
          key={record.key}
          data-motion={record.motion}
          data-testid={`item-${record.key}`}
          onTransitionEnd={(event) => {
            if (event.propertyName === "opacity" && record.motion === "exit") {
              onExitTransitionEnd(record.key);
            }
          }}
        >
          {record.item}
        </li>
      ))}
    </ul>
  );
}

function mockReducedMotion(enabled: boolean) {
  const original = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: enabled && query === "(prefers-reduced-motion: reduce)",
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  });
  return () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: original,
    });
  };
}

describe("usePresenceList", () => {
  const restoreMotion: Array<() => void> = [];

  afterEach(() => {
    while (restoreMotion.length > 0) {
      restoreMotion.pop()?.();
    }
  });

  it("does not mark items as entering on the first render", () => {
    render(<Harness items={["a", "b"]} />);

    expect(screen.getByTestId("item-a")).toHaveAttribute("data-motion", "none");
    expect(screen.getByTestId("item-b")).toHaveAttribute("data-motion", "none");
  });

  it("marks items added after mount as entering", () => {
    const { rerender } = render(<Harness items={["a"]} />);

    rerender(<Harness items={["a", "b"]} />);

    expect(screen.getByTestId("item-a")).toHaveAttribute("data-motion", "none");
    expect(screen.getByTestId("item-b")).toHaveAttribute("data-motion", "enter");
  });

  it("follows source order when live items are rearranged", () => {
    const { rerender } = render(<Harness items={["a", "b", "c"]} />);

    rerender(<Harness items={["c", "a", "b"]} />);

    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("keeps a removed item until its exit transition ends", () => {
    const { rerender } = render(<Harness items={["a", "b"]} />);

    rerender(<Harness items={["a"]} />);

    const leaving = screen.getByTestId("item-b");
    expect(leaving).toHaveAttribute("data-motion", "exit");
    expect(screen.getByTestId("item-a")).toBeInTheDocument();

    fireEvent.transitionEnd(leaving, { propertyName: "opacity" });

    expect(screen.queryByTestId("item-b")).not.toBeInTheDocument();
    expect(screen.getByTestId("item-a")).toBeInTheDocument();
  });

  it("unmounts immediately when reduced motion is preferred", () => {
    restoreMotion.push(mockReducedMotion(true));

    const { rerender } = render(<Harness items={["a"]} />);
    rerender(<Harness items={[]} />);

    expect(screen.queryByTestId("item-a")).not.toBeInTheDocument();
  });
});
