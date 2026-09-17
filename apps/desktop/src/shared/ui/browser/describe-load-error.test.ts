import { describe, expect, it } from "vitest";
import { describeLoadError } from "./describe-load-error";

describe("describeLoadError", () => {
  it("maps a known code to plain English while preserving the raw code", () => {
    const result = describeLoadError("ERR_CONNECTION_REFUSED");
    expect(result.humanText).not.toBe(result.rawCode);
    expect(result.rawCode).toBe("ERR_CONNECTION_REFUSED");
  });

  it("groups every ERR_CERT_* variant under the same certificate message", () => {
    const authorityInvalid = describeLoadError("ERR_CERT_AUTHORITY_INVALID");
    const dateInvalid = describeLoadError("ERR_CERT_DATE_INVALID");
    expect(authorityInvalid.humanText).toBe(dateInvalid.humanText);
    expect(authorityInvalid.humanText).not.toBe(authorityInvalid.rawCode);
  });

  it("falls back to the raw text, verbatim, for an unknown code", () => {
    const result = describeLoadError("ERR_SOMETHING_NEW_AND_UNMAPPED");
    expect(result.humanText).toBe("ERR_SOMETHING_NEW_AND_UNMAPPED");
    expect(result.rawCode).toBe("ERR_SOMETHING_NEW_AND_UNMAPPED");
  });

  it("falls back to the raw text, verbatim, for a non-code message", () => {
    const result = describeLoadError("The page could not be opened.");
    expect(result.humanText).toBe("The page could not be opened.");
    expect(result.rawCode).toBe("The page could not be opened.");
  });

  it("trims surrounding whitespace before matching", () => {
    const result = describeLoadError("  ERR_CONNECTION_REFUSED  ");
    expect(result.rawCode).toBe("ERR_CONNECTION_REFUSED");
    expect(result.humanText).not.toBe("  ERR_CONNECTION_REFUSED  ");
  });
});
