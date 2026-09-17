import type {
  BrowserAnnotationElement,
  BrowserAnnotationViewport,
} from "@/shared/browser-protocol";

/**
 * The annotation layer's vocabulary: the two IPC channels between main and the
 * embedded page, and the Electron-free functions both ends need — element
 * description in the page's isolated world, message validation in main.
 *
 * This module is imported by the annotation preload and by main, never by the
 * Pace renderer preload: the two preloads must not share a runtime module or
 * electron-vite would hoist it into a chunk that a sandboxed preload cannot
 * require (PRD S2 implementation constraint 6). The import above is type-only
 * and therefore erased, which is what keeps that true.
 */

/** Page → main. Everything on it is validated before it is believed. */
export const browserAnnotationChannel = "pigui:browser-annotation";
/** Main → page. Design mode is a command, never a page-side decision. */
export const browserAnnotationCommandChannel = "pigui:browser-annotation-command";

/** Marks, and the space they were measured in — always reported together. */
type AnnotationsPayload = {
  annotations: BrowserAnnotationElement[];
  viewport: BrowserAnnotationViewport;
};

export type BrowserAnnotationMessage =
  /** A fresh document's overlay is live: it has no annotations yet. */
  | { type: "ready" }
  | { type: "design-mode"; enabled: boolean }
  | ({ type: "annotations" } & AnnotationsPayload)
  /**
   * The overlay has put itself out of shot — comment bubble committed and
   * closed, hover highlight hidden — and states what it holds right now. Main
   * waits for this before `capturePage`.
   */
  | ({ type: "capture-ready" } & AnnotationsPayload);

export type BrowserAnnotationCommand =
  | { type: "set-design-mode"; enabled: boolean }
  | { type: "clear-annotations" }
  | { type: "prepare-capture" };

const maxTextLength = 120;
const maxCommentLength = 500;
const maxTagLength = 40;
const maxSelectorLength = 1_000;
const maxAnnotations = 200;
/** `file:line` or `file:line:column`, with a file part that is not empty. */
const sourcePattern = /^(.+?):(\d+)(?::(\d+))?$/;

/**
 * One line, then at most `max` characters of it.
 *
 * The prompt Pi reads is one row per mark, so a newline anywhere in a field is
 * a page writing rows of its own. Core's formatter defends its own template
 * too; this is the boundary where nothing from the page gets in unshaped.
 */
function clampText(value: string, max: number) {
  const line = value.replace(/[\r\n]+/g, " ");

  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function resolvesUniquely(element: Element, selector: string) {
  const matches = element.ownerDocument.querySelectorAll(selector);

  return matches.length === 1 && matches[0] === element;
}

/** A selector that names the element by itself, or null if none does. */
function identifyingSelector(element: Element) {
  const id = element.id;

  // A duplicated id identifies nothing — and pages do ship them.
  if (id && resolvesUniquely(element, `#${CSS.escape(id)}`)) {
    return `#${CSS.escape(id)}`;
  }

  const testId = element.getAttribute("data-testid");
  // `CSS.escape` rather than escaping quotes by hand: a test id is page data
  // and can hold a newline, which is a parse error inside a CSS string —
  // Chromium throws on the selector, jsdom matches nothing at all.
  const testIdSelector = testId ? `[data-testid="${CSS.escape(testId)}"]` : null;

  return testIdSelector && resolvesUniquely(element, testIdSelector)
    ? testIdSelector
    : null;
}

function positionalStep(element: Element) {
  const tag = element.tagName.toLowerCase();
  const parent = element.parentElement;

  if (!parent) {
    return tag;
  }

  const sameType = Array.from(parent.children).filter(
    (child) => child.tagName === element.tagName,
  );

  return sameType.length > 1
    ? `${tag}:nth-of-type(${sameType.indexOf(element) + 1})`
    : tag;
}

/**
 * A CSS path that resolves to this element and nothing else: `id` or
 * `data-testid` where one identifies the element, otherwise an nth-of-type
 * chain that stops at the nearest ancestor which does.
 */
export function buildElementSelector(element: Element) {
  const steps: string[] = [];
  let current: Element | null = element;

  while (current) {
    const identified = identifyingSelector(current);

    if (identified) {
      steps.unshift(identified);
      break;
    }

    steps.unshift(positionalStep(current));
    current = current.parentElement;
  }

  return steps.join(" > ");
}

function readText(element: Element) {
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();

  return text ? clampText(text, maxTextLength) : undefined;
}

/**
 * Best-effort source location, read only from `data-*` attributes: either a
 * combined `data-source="file:line:column"` or the separate attributes the
 * React inspector plugins stamp. Anything else is left out rather than guessed.
 */
function readSource(element: Element) {
  const combined = sourcePattern.exec(element.getAttribute("data-source")?.trim() ?? "");

  if (combined) {
    return {
      file: combined[1]!,
      line: Number(combined[2]),
      ...(combined[3] ? { column: Number(combined[3]) } : {}),
    };
  }

  const file = element.getAttribute("data-inspector-relative-path");
  const line = Number(element.getAttribute("data-inspector-line"));

  if (!file || !Number.isFinite(line) || line <= 0) {
    return undefined;
  }

  const column = Number(element.getAttribute("data-inspector-column"));

  return {
    file,
    line,
    ...(Number.isFinite(column) && column > 0 ? { column } : {}),
  };
}

export function describeAnnotatedElement(
  element: Element,
  index: number,
): BrowserAnnotationElement {
  const rect = element.getBoundingClientRect();
  const text = readText(element);
  const source = readSource(element);

  return {
    index,
    selector: buildElementSelector(element),
    tag: element.tagName.toLowerCase(),
    ...(text ? { text } : {}),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    ...(source ? { source } : {}),
  };
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readRect(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const { x, y, width, height } = value as Record<string, unknown>;
  const sides = [x, y, width, height].map(finiteNumber);

  return sides.every((side) => side !== null)
    ? { x: sides[0]!, y: sides[1]!, width: sides[2]!, height: sides[3]! }
    : null;
}

function readViewportValue(value: unknown): BrowserAnnotationViewport | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const { width, height, dpr } = value as Record<string, unknown>;
  const measures = [width, height, dpr].map(finiteNumber);

  return measures.every((measure) => measure !== null)
    ? { width: measures[0]!, height: measures[1]!, dpr: measures[2]! }
    : null;
}

function readSourceValue(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const { file, line, column } = value as Record<string, unknown>;
  const lineNumber = finiteNumber(line);

  if (typeof file !== "string" || !file || lineNumber === null) {
    return null;
  }

  const columnNumber = finiteNumber(column);

  return {
    file: clampText(file, maxSelectorLength),
    line: Math.trunc(lineNumber),
    ...(columnNumber === null ? {} : { column: Math.trunc(columnNumber) }),
  };
}

/**
 * Rebuilt field by field rather than passed through: the sender is our own
 * preload, but everything it describes came out of a hostile page.
 */
function readAnnotation(value: unknown): BrowserAnnotationElement | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const { index, selector, tag, text, rect, source, comment } = value as Record<
    string,
    unknown
  >;
  const indexNumber = finiteNumber(index);
  const rectangle = readRect(rect);

  if (
    indexNumber === null ||
    typeof selector !== "string" ||
    typeof tag !== "string" ||
    !rectangle
  ) {
    return null;
  }

  const location = readSourceValue(source);

  return {
    index: Math.trunc(indexNumber),
    selector: clampText(selector, maxSelectorLength),
    tag: clampText(tag, maxTagLength),
    ...(typeof text === "string" && text ? { text: clampText(text, maxTextLength) } : {}),
    rect: rectangle,
    ...(location ? { source: location } : {}),
    ...(typeof comment === "string" && comment
      ? { comment: clampText(comment, maxCommentLength) }
      : {}),
  };
}

function readAnnotationsPayload(
  message: Record<string, unknown>,
): AnnotationsPayload | null {
  const viewport = readViewportValue(message.viewport);

  // Rects without the viewport they were measured in describe positions in an
  // unknown space, so the message is not usable without one.
  if (!Array.isArray(message.annotations) || !viewport) {
    return null;
  }

  return {
    annotations: message.annotations
      .slice(0, maxAnnotations)
      .map(readAnnotation)
      .filter((annotation): annotation is BrowserAnnotationElement => annotation !== null),
    viewport,
  };
}

/**
 * The gate on the annotation channel: the message has to come from the
 * embedded view's own webContents, and it has to be one of the shapes
 * this protocol knows. `pigui:invoke` also validates its sender now (see
 * `ipc-sender-guard.ts`), but annotations still get their own channel (PRD S2
 * implementation constraint 2) rather than sharing one built for a different
 * message shape and a different set of commands.
 */
export function acceptBrowserAnnotationMessage<Sender>(input: {
  sender: Sender;
  trustedSender: Sender | null;
  message: unknown;
}): BrowserAnnotationMessage | null {
  if (input.trustedSender === null || input.sender !== input.trustedSender) {
    return null;
  }

  if (typeof input.message !== "object" || input.message === null) {
    return null;
  }

  const message = input.message as Record<string, unknown>;

  switch (message.type) {
    case "ready":
      return { type: "ready" };
    case "design-mode":
      return typeof message.enabled === "boolean"
        ? { type: "design-mode", enabled: message.enabled }
        : null;
    case "annotations":
    case "capture-ready": {
      const payload = readAnnotationsPayload(message);

      return payload ? { type: message.type, ...payload } : null;
    }
    default:
      return null;
  }
}
