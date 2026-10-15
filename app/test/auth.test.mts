import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OAUTH_LABEL, oauthOptions, redirectParams } from "../src/auth-model.ts";
describe("GitHub phone OAuth", () => {
  it("uses the Team Hub provider and returns to the native auth callback", () => {
    assert.equal(OAUTH_LABEL, "Continue with GitHub");
    assert.deepEqual(oauthOptions("loom://auth-callback"), { provider: "github", options: { redirectTo: "loom://auth-callback", skipBrowserRedirect: true } });
  });
  it("parses a PKCE code and consent cancellation without exposing tokens", () => {
    assert.deepEqual(redirectParams("loom://auth-callback?code=pkce%2Bvalue", "loom://auth-callback"), { code: "pkce+value" });
    assert.deepEqual(redirectParams("loom://auth-callback#error=access_denied&error_description=Consent+cancelled", "loom://auth-callback"), { error: "access_denied", error_description: "Consent cancelled" });
  });
  it("refuses foreign callbacks, ambiguous values and malformed encodings", () => {
    assert.throws(() => redirectParams("https://example.com/?code=foreign", "loom://auth-callback"), /unexpected callback/);
    assert.throws(() => redirectParams("loom://auth-callback?code=one#code=two", "loom://auth-callback"), /duplicate/);
    assert.throws(() => redirectParams("loom://auth-callback?code=%QQ", "loom://auth-callback"));
  });
});
