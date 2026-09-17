import { describe, expect, it } from "vitest";
import { describeLoadError } from "@/entities/browser/describe-load-error";

describe("describeLoadError", () => {
  it("explains a refused connection as the dev server probably not running", () => {
    const result = describeLoadError("ERR_CONNECTION_REFUSED");
    expect(result.humanText).toBe(
      "The dev server is probably not running yet.",
    );
    expect(result.rawCode).toBe("ERR_CONNECTION_REFUSED");
  });

  it("explains a DNS failure", () => {
    const result = describeLoadError("ERR_NAME_NOT_RESOLVED");
    expect(result.humanText).toBe("The address could not be resolved (DNS lookup failed).");
  });

  it("groups every ERR_CERT_* code under a certificate problem", () => {
    expect(describeLoadError("ERR_CERT_AUTHORITY_INVALID").humanText).toBe(
      "The site's certificate is not trusted.",
    );
    expect(describeLoadError("ERR_CERT_DATE_INVALID").humanText).toBe(
      "The site's certificate is not trusted.",
    );
  });

  it("explains a dropped internet connection", () => {
    expect(describeLoadError("ERR_INTERNET_DISCONNECTED").humanText).toBe(
      "There is no internet connection.",
    );
  });

  it("explains a connection timeout", () => {
    expect(describeLoadError("ERR_CONNECTION_TIMED_OUT").humanText).toBe(
      "The connection timed out.",
    );
  });

  it("explains an aborted load", () => {
    expect(describeLoadError("ERR_ABORTED").humanText).toBe(
      "The page load was interrupted.",
    );
  });

  it("falls back to the raw text for an unknown code", () => {
    const result = describeLoadError("ERR_SOMETHING_NEW_AND_UNMAPPED");
    expect(result.humanText).toBe("ERR_SOMETHING_NEW_AND_UNMAPPED");
    expect(result.rawCode).toBe("ERR_SOMETHING_NEW_AND_UNMAPPED");
  });

  it("falls back to the raw text for a non-code message", () => {
    const result = describeLoadError("The page could not be opened.");
    expect(result.humanText).toBe("The page could not be opened.");
    expect(result.rawCode).toBe("The page could not be opened.");
  });

  it("trims surrounding whitespace before matching", () => {
    expect(describeLoadError("  ERR_CONNECTION_REFUSED  ").humanText).toBe(
      "The dev server is probably not running yet.",
    );
  });
});
