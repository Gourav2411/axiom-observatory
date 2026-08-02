import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTH_REDIRECT_PATHS,
  MIN_PASSWORD_LENGTH,
  authErrorMessage,
  authIntentFromRedirectType,
  authRedirectUrl,
  authSuccessMessage,
  clearAuthCallbackLocation,
  exchangeAuthCallback,
  googleSignIn,
  isDuplicateSignupError,
  isMissingMagicAccountError,
  passwordSignIn,
  passwordSignUp,
  readAuthCallback,
  sendMagicLink,
  sendPasswordReset,
  updatePassword,
  validateNewPassword,
} from "../src/auth-flow.js";

const AUTH_METHODS = [
  "signInWithPassword",
  "signUp",
  "signInWithOtp",
  "resetPasswordForEmail",
  "signInWithOAuth",
  "updateUser",
  "exchangeCodeForSession",
];

function createAuthMock(results = {}) {
  const calls = Object.fromEntries(AUTH_METHODS.map((method) => [method, []]));
  const auth = Object.fromEntries(AUTH_METHODS.map((method) => [
    method,
    async (...args) => {
      calls[method].push(args);
      return results[method] ?? { data: { operation: method }, error: null };
    },
  ]));
  return { client: { auth }, calls };
}

test("auth redirects use fixed same-origin routes and discard input paths, queries, and fragments", () => {
  const origin = "https://axiom.example.test:8443/untrusted/path?returnTo=https://attacker.test#fragment";

  assert.equal(authRedirectUrl("confirmation", origin), "https://axiom.example.test:8443/auth/callback");
  assert.equal(authRedirectUrl("google", origin), "https://axiom.example.test:8443/auth/callback");
  assert.equal(authRedirectUrl("magic", origin), "https://axiom.example.test:8443/auth/callback");
  assert.equal(authRedirectUrl("recovery", origin), "https://axiom.example.test:8443/reset-password");
  assert.equal(Object.isFrozen(AUTH_REDIRECT_PATHS), true);
  assert.throws(() => authRedirectUrl("unknown", "https://axiom.example.test"), /Unsupported authentication redirect/);
  assert.throws(() => authRedirectUrl("magic", ""), /redirect origin is unavailable/);
});

test("auth action helpers call Supabase with exact normalized payloads", async () => {
  const { client, calls } = createAuthMock();
  const origin = "https://axiom.example.test/workspace?next=ignored#ignored";

  assert.deepEqual(await passwordSignIn(client, {
    email: "  researcher@example.test  ",
    password: "current password",
  }), { operation: "signInWithPassword" });
  assert.deepEqual(calls.signInWithPassword, [[{
    email: "researcher@example.test",
    password: "current password",
  }]]);

  assert.deepEqual(await passwordSignUp(client, {
    email: "  new@example.test ",
    password: "a secure password",
    origin,
  }), { operation: "signUp" });
  assert.deepEqual(calls.signUp, [[{
    email: "new@example.test",
    password: "a secure password",
    options: {
      emailRedirectTo: "https://axiom.example.test/auth/callback",
    },
  }]]);

  assert.deepEqual(await sendMagicLink(client, {
    email: "  magic@example.test ",
    origin,
  }), { operation: "signInWithOtp" });
  assert.deepEqual(calls.signInWithOtp, [[{
    email: "magic@example.test",
    options: {
      emailRedirectTo: "https://axiom.example.test/auth/callback",
      shouldCreateUser: false,
    },
  }]]);

  assert.deepEqual(await sendPasswordReset(client, {
    email: "  reset@example.test ",
    origin,
  }), { operation: "resetPasswordForEmail" });
  assert.deepEqual(calls.resetPasswordForEmail, [[
    "reset@example.test",
    { redirectTo: "https://axiom.example.test/reset-password" },
  ]]);

  assert.deepEqual(await googleSignIn(client, { origin }), { operation: "signInWithOAuth" });
  assert.deepEqual(calls.signInWithOAuth, [[{
    provider: "google",
    options: { redirectTo: "https://axiom.example.test/auth/callback" },
  }]]);

  assert.deepEqual(await updatePassword(client, "replacement password"), { operation: "updateUser" });
  assert.deepEqual(calls.updateUser, [[{ password: "replacement password" }]]);

  assert.deepEqual(await exchangeAuthCallback(client, {
    url: "https://axiom.example.test/auth/callback?code=AUTH_CODE",
  }), { operation: "exchangeCodeForSession" });
  assert.deepEqual(calls.exchangeCodeForSession, [["AUTH_CODE"]]);
});

test("auth action helpers reject missing clients and preserve Supabase errors", async () => {
  assert.throws(
    () => passwordSignIn(null, { email: "user@example.test", password: "password" }),
    /Supabase Auth is unavailable/,
  );

  const expected = Object.assign(new Error("Provider is not enabled"), { code: "provider_disabled" });
  const { client } = createAuthMock({
    signInWithOAuth: { data: null, error: expected },
  });
  await assert.rejects(
    googleSignIn(client, { origin: "https://axiom.example.test" }),
    (error) => error === expected,
  );
});

test("callback parsing recognizes supported intents without returning credentials", () => {
  assert.deepEqual(
    readAuthCallback("https://axiom.example.test/auth/callback?intent=magic#access_token=ACCESS_SECRET&refresh_token=REFRESH_SECRET&type=magiclink"),
    { intent: "magic", error: null, isAuthRoute: true, hasAuthResponse: false },
  );
  assert.deepEqual(
    readAuthCallback("https://axiom.example.test/reset-password#access_token=RECOVERY_SECRET&refresh_token=REFRESH_SECRET&type=recovery"),
    { intent: "recovery", error: null, isAuthRoute: true, hasAuthResponse: false },
  );
  assert.deepEqual(
    readAuthCallback("https://axiom.example.test/auth/callback?intent=google&code=AUTH_CODE&token_hash=TOKEN_HASH"),
    { intent: "google", error: null, isAuthRoute: true, hasAuthResponse: true },
  );
  assert.deepEqual(
    readAuthCallback("https://axiom.example.test/not-auth?intent=magic"),
    { intent: "magic", error: null, isAuthRoute: false, hasAuthResponse: false },
  );

  const serialized = JSON.stringify(readAuthCallback(
    "https://axiom.example.test/reset-password#access_token=ACCESS_SECRET&refresh_token=REFRESH_SECRET&token_hash=TOKEN_HASH",
  ));
  assert.doesNotMatch(serialized, /ACCESS_SECRET|REFRESH_SECRET|TOKEN_HASH/);
});

test("callback parsing returns bounded errors from query or fragment parameters", () => {
  assert.deepEqual(
    readAuthCallback("https://axiom.example.test/reset-password?error_code=otp_expired&error_description=Recovery+link+expired"),
    {
      intent: "recovery",
      error: { code: "otp_expired", message: "Recovery link expired" },
      isAuthRoute: true,
      hasAuthResponse: false,
    },
  );
  assert.deepEqual(
    readAuthCallback("https://axiom.example.test/auth/callback?intent=google#error_description=Access+denied"),
    {
      intent: "google",
      error: { code: "auth_callback_failed", message: "Access denied" },
      isAuthRoute: true,
      hasAuthResponse: false,
    },
  );
  assert.deepEqual(readAuthCallback(), { intent: null, error: null, isAuthRoute: false, hasAuthResponse: false });
});

test("callback cleanup replaces auth URLs with a token-free root path", () => {
  const calls = [];
  const history = {
    state: { app: "state" },
    replaceState(...args) { calls.push(args); },
  };

  clearAuthCallbackLocation({
    history,
    location: {
      href: "https://axiom.example.test/reset-password#access_token=ACCESS_SECRET&refresh_token=REFRESH_SECRET",
    },
  });

  assert.deepEqual(calls, [[history.state, "", "/"]]);
  assert.doesNotMatch(JSON.stringify(calls), /ACCESS_SECRET|REFRESH_SECRET/);

  calls.length = 0;
  clearAuthCallbackLocation({
    history,
    location: { href: "https://axiom.example.test/workspace?tab=evidence" },
  });
  assert.deepEqual(calls, []);
});

test("callback exchange requires an exact app route and maps Supabase redirect types", async () => {
  const {client}=createAuthMock();
  assert.throws(()=>exchangeAuthCallback(client,{url:"https://axiom.example.test/not-auth?code=SECRET"}),/callback code is unavailable/);
  assert.throws(()=>exchangeAuthCallback(client,{url:"https://axiom.example.test/auth/callback"}),/callback code is unavailable/);
  assert.equal(authIntentFromRedirectType("recovery"),"recovery");
  assert.equal(authIntentFromRedirectType("signup"),"confirmation");
  assert.equal(authIntentFromRedirectType("magiclink"),"magic");
  assert.equal(authIntentFromRedirectType(null),"callback");
});

test("auth errors are mapped to safe user-facing copy without leaking unknown details", () => {
  assert.equal(
    authErrorMessage({ code: "invalid_credentials" }),
    "Email or password not recognized. Try a magic link or reset your password.",
  );
  assert.equal(authErrorMessage({ message: "Email not confirmed" }), "Confirm your email address before signing in.");
  assert.equal(
    authErrorMessage({ code: "over_email_send_rate_limit" }),
    "Too many email requests were sent. Wait a minute and try again.",
  );
  assert.equal(
    authErrorMessage({ code: "weak_password" }),
    `Use a stronger password with at least ${MIN_PASSWORD_LENGTH} characters.`,
  );
  assert.equal(
    authErrorMessage({ code: "same_password" }),
    "Choose a new password that is different from the current password.",
  );
  assert.equal(
    authErrorMessage({ code: "signup_disabled" }),
    "New account registration is currently unavailable.",
  );
  assert.equal(
    authErrorMessage({ code: "provider_disabled" }),
    "Google sign-in is not configured yet. Use email authentication for now.",
  );
  assert.equal(
    authErrorMessage({ code: "otp_expired" }),
    "This authentication link has expired. Request a new link and try again.",
  );
  assert.equal(
    authErrorMessage({ code: "email_address_not_authorized" }),
    "This project’s email service cannot deliver to that address yet. Contact the workspace owner or try another sign-in method.",
  );
  assert.equal(
    authErrorMessage({ message: "PKCE code verifier not found" }),
    "This link must be opened in the same browser where it was requested. Request a new link and try again.",
  );

  const fallback = authErrorMessage({ message: "database host internal-secret.example.test" });
  assert.equal(fallback, "Authentication could not be completed. Try again or use another sign-in method.");
  assert.doesNotMatch(fallback, /internal-secret/);
});

test("only account-existence auth errors are safe to normalize", () => {
  assert.equal(isMissingMagicAccountError({code:"user_not_found"}),true);
  assert.equal(isMissingMagicAccountError({message:"Signups not allowed for otp"}),true);
  assert.equal(isMissingMagicAccountError({code:"email_address_not_authorized"}),false);
  assert.equal(isMissingMagicAccountError({code:"over_email_send_rate_limit"}),false);
  assert.equal(isDuplicateSignupError({code:"user_already_exists"}),true);
  assert.equal(isDuplicateSignupError({message:"User already registered"}),true);
  assert.equal(isDuplicateSignupError({code:"request_timeout"}),false);
});

test("auth success messages are limited to recognized callback intents", () => {
  assert.equal(authSuccessMessage("confirmation"), "Email confirmed. Your protected workspace is ready.");
  assert.equal(authSuccessMessage("google"), "Signed in securely with Google.");
  assert.equal(authSuccessMessage("magic"), "Magic link accepted. You are signed in.");
  assert.equal(authSuccessMessage("callback"), "Authentication complete. Your protected workspace is ready.");
  assert.equal(authSuccessMessage("recovery"), null);
  assert.equal(authSuccessMessage("unknown"), null);
});

test("new password validation enforces length before matching confirmation", () => {
  const tooShort = "a".repeat(MIN_PASSWORD_LENGTH - 1);
  const valid = "a".repeat(MIN_PASSWORD_LENGTH);

  assert.equal(validateNewPassword(tooShort, tooShort), `Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  assert.equal(validateNewPassword(valid, "b".repeat(MIN_PASSWORD_LENGTH)), "The passwords do not match.");
  assert.equal(validateNewPassword(valid, valid), null);
});
