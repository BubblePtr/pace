/** The slice of `Electron.NativeImage` this seam actually needs. */
export interface DownsamplableImage<Self> {
  getSize(): { width: number; height: number };
  resize(options: { width: number }): Self;
}

/**
 * Shrinks a captured image back down to its CSS width.
 *
 * `capturePage` answers in physical pixels, which only exceed the CSS width
 * on a HiDPI (>1x) display — so this branch was previously reachable only on
 * a real HiDPI machine and never on CI's 1x runners. Taking the image as a
 * parameter (rather than reading `webContents.capturePage()` itself) makes it
 * exercisable with a fake image at both scale factors.
 */
export function downsampleToCssWidth<Image extends DownsamplableImage<Image>>(
  image: Image,
  maxWidth: number | undefined,
): Image {
  if (!maxWidth || maxWidth <= 0) {
    return image;
  }

  const { width } = image.getSize();

  return width > maxWidth ? image.resize({ width: maxWidth }) : image;
}
