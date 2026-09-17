import { describe, expect, it, vi } from "vitest";
import { downsampleToCssWidth } from "./capture-downsample";

/** A fake `nativeImage` result, just large enough to exercise the seam. */
function fakeImage(width: number, height: number) {
  const image = {
    getSize: () => ({ width, height }),
    resize: vi.fn((options: { width: number }) =>
      fakeImage(options.width, Math.round((height * options.width) / width)),
    ),
  };

  return image;
}

describe("downsampleToCssWidth", () => {
  it("resizes a HiDPI (2x) capture down to the CSS width", () => {
    // capturePage on a 2x display answers in physical pixels: double the CSS size.
    const cssWidth = 400;
    const image = fakeImage(cssWidth * 2, 300 * 2);

    const result = downsampleToCssWidth(image, cssWidth);

    expect(image.resize).toHaveBeenCalledWith({ width: cssWidth });
    expect(result.getSize().width).toBe(cssWidth);
  });

  it("leaves a 1x capture untouched, since it is already at the CSS width", () => {
    const cssWidth = 400;
    const image = fakeImage(cssWidth, 300);

    const result = downsampleToCssWidth(image, cssWidth);

    expect(image.resize).not.toHaveBeenCalled();
    expect(result).toBe(image);
  });

  it("leaves the image untouched when no cap is given", () => {
    const image = fakeImage(800, 600);

    const result = downsampleToCssWidth(image, undefined);

    expect(image.resize).not.toHaveBeenCalled();
    expect(result).toBe(image);
  });
});
