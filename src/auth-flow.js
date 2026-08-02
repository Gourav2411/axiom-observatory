const MIN_PASSWORD_LENGTH = 10;
const PASSWORD_RECOVERY_SESSION_KEY = "axiom:password-recovery";
const PASSWORD_RECOVERY_SESSION_TTL_MS = 60 * 60 * 1000;
const PKCE_FLOW_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

const AUTH_REDIRECT_PATHS = Object.freeze({
  confirmation: "/auth/callback",
  google: "/auth/callback",
  magic: "/auth/callback",
  recovery: "/reset-password",
});

const AUTH_INTENTS = new Set(Object.keys(AUTH_REDIRECT_PATHS));

function requireAuthClient(client) {
  if (!client?.auth) throw new Error("Supabase Auth is unavailable.");
  return client.auth;
}

function normalizedOrigin(origin = globalThis.location?.origin) {
  if (typeof origin !== "string" || !origin.trim()) {
    throw new Error("The authentication redirect origin is unavailable.");
  }
  return new URL(origin).origin;
}

function authRedirectUrl(intent, origin) {
  if (!AUTH_INTENTS.has(intent)) throw new Error("Unsupported authentication redirect.");
  return new URL(AUTH_REDIRECT_PATHS[intent], `${normalizedOrigin(origin)}/`).toString();
}

function readAuthCallback(url = globalThis.location?.href) {
  if (typeof url !== "string" || !url) {
    return { intent: null, error: null, isAuthRoute: false, hasAuthResponse: false };
  }
  const parsed = new URL(url, "http://localhost");
  const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  const hasCode = parsed.searchParams.has("code");
  const isCallbackRoute = parsed.pathname === "/auth/callback";
  const isRecoveryRoute = parsed.pathname === "/reset-password";
  // Supabase falls back to the configured Site URL when an explicit redirect
  // cannot be matched. Treat only a coded root URL as that safe fallback.
  const isSiteUrlFallback = parsed.pathname === "/" && hasCode;
  const queryIntent = parsed.searchParams.get("intent");
  const callbackType = parsed.searchParams.get("type") ?? fragment.get("type");
  const intent = isRecoveryRoute
    ? "recovery"
    : isCallbackRoute || isSiteUrlFallback
      ? AUTH_INTENTS.has(queryIntent)
        ? queryIntent
        : callbackType === "signup"
          ? "confirmation"
          : ["email", "magiclink"].includes(callbackType)
            ? "magic"
            : "callback"
      : AUTH_INTENTS.has(queryIntent) ? queryIntent : null;
  const errorCode = parsed.searchParams.get("error_code")
    ?? parsed.searchParams.get("error")
    ?? fragment.get("error_code")
    ?? fragment.get("error");
  const errorDescription = parsed.searchParams.get("error_description")
    ?? fragment.get("error_description");
  return {
    intent,
    error: errorCode || errorDescription
      ? { code: errorCode ?? "auth_callback_failed", message: errorDescription ?? "Authentication could not be completed." }
      : null,
    isAuthRoute: isCallbackRoute || isRecoveryRoute || isSiteUrlFallback,
    hasAuthResponse: hasCode,
  };
}

function isPasswordRecoveryRoute(url = globalThis.location?.href) {
  if (typeof url !== "string" || !url) return false;
  return new URL(url, "http://localhost").pathname === AUTH_REDIRECT_PATHS.recovery;
}

function authIntentFromRedirectType(redirectType) {
  if (redirectType === "recovery") return "recovery";
  if (redirectType === "signup") return "confirmation";
  if (["email", "magiclink"].includes(redirectType)) return "magic";
  return "callback";
}

function clearAuthCallbackLocation({
  history = globalThis.history,
  location = globalThis.location,
  preserveRecoveryRoute = true,
} = {}) {
  if (!history?.replaceState || !location?.href) return;
  const state = readAuthCallback(location.href);
  if (!state.isAuthRoute && !state.error) return;
  const destination = preserveRecoveryRoute && isPasswordRecoveryRoute(location.href)
    ? AUTH_REDIRECT_PATHS.recovery
    : "/";
  history.replaceState(history.state, "", destination);
}

function recoverySessionStorage(storage = globalThis.sessionStorage) {
  return storage && typeof storage.getItem === "function"
    && typeof storage.setItem === "function"
    && typeof storage.removeItem === "function"
    ? storage
    : null;
}

function rememberPasswordRecovery(session, {
  storage = globalThis.sessionStorage,
  now = Date.now(),
} = {}) {
  const userId = session?.user?.id;
  const target = recoverySessionStorage(storage);
  if (!target || typeof userId !== "string" || !userId) return false;
  try {
    target.setItem(PASSWORD_RECOVERY_SESSION_KEY, JSON.stringify({
      userId,
      expiresAt: now + PASSWORD_RECOVERY_SESSION_TTL_MS,
    }));
    return true;
  } catch {
    return false;
  }
}

function hasPasswordRecoverySession(session, {
  storage = globalThis.sessionStorage,
  now = Date.now(),
} = {}) {
  const userId = session?.user?.id;
  const target = recoverySessionStorage(storage);
  if (!target || typeof userId !== "string" || !userId) return false;
  try {
    const value = JSON.parse(target.getItem(PASSWORD_RECOVERY_SESSION_KEY) ?? "null");
    const valid = value?.userId === userId
      && Number.isFinite(value?.expiresAt)
      && value.expiresAt > now
      && value.expiresAt <= now + PASSWORD_RECOVERY_SESSION_TTL_MS;
    if (!valid) target.removeItem(PASSWORD_RECOVERY_SESSION_KEY);
    return valid;
  } catch {
    try { target.removeItem(PASSWORD_RECOVERY_SESSION_KEY); } catch { /* Ignore blocked storage cleanup. */ }
    return false;
  }
}

function forgetPasswordRecovery({ storage = globalThis.sessionStorage } = {}) {
  const target = recoverySessionStorage(storage);
  if (!target) return false;
  try {
    target.removeItem(PASSWORD_RECOVERY_SESSION_KEY);
    return true;
  } catch {
    return false;
  }
}

function passwordRecoveryStateForAuthEvent({
  event,
  session,
  recoveryRoute = false,
  callbackExchangePending = false,
  storage = globalThis.sessionStorage,
  now = Date.now(),
}) {
  if (event === "SIGNED_OUT") {
    forgetPasswordRecovery({ storage });
    return false;
  }
  if (event === "PASSWORD_RECOVERY") {
    rememberPasswordRecovery(session, { storage, now });
    return Boolean(session);
  }
  if (!callbackExchangePending && recoveryRoute
    && hasPasswordRecoverySession(session, { storage, now })) return true;
  return null;
}

function authErrorMessage(error) {
  const code = String(error?.code ?? "").toLowerCase();
  const message = String(error?.message ?? "").toLowerCase();
  if (code.includes("invalid_credentials") || message.includes("invalid login credentials")) {
    return "Email or password not recognized. Try a magic link or reset your password.";
  }
  if (code.includes("email_not_confirmed") || message.includes("email not confirmed")) {
    return "Confirm your email address before signing in.";
  }
  if (code.includes("over_email_send_rate_limit") || message.includes("rate limit")) {
    return "Too many email requests were sent. Wait a minute and try again.";
  }
  if (code.includes("weak_password") || message.includes("weak password")) {
    return `Use a stronger password with at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (code.includes("same_password") || message.includes("same password")) {
    return "Choose a new password that is different from the current password.";
  }
  if (code.includes("signup_disabled") || message.includes("signups not allowed")) {
    return "New account registration is currently unavailable.";
  }
  if (code.includes("provider") || message.includes("provider is not enabled") || message.includes("unsupported provider")) {
    return "Google sign-in is not configured yet. Use email authentication for now.";
  }
  if (code.includes("otp_expired") || message.includes("expired")) {
    return "This authentication link has expired. Request a new link and try again.";
  }
  if (code.includes("email_address_not_authorized") || message.includes("email address not authorized")) {
    return "This project’s email service cannot deliver to that address yet. Contact the workspace owner or try another sign-in method.";
  }
  if (["bad_code_verifier", "flow_state_not_found", "flow_state_expired"].includes(code)
    || code.includes("pkce") || message.includes("code verifier") || message.includes("code challenge")) {
    return "This link must be opened in the same browser where it was requested. Request a new link and try again.";
  }
  return "Authentication could not be completed. Try again or use another sign-in method.";
}

function isMissingMagicAccountError(error) {
  const code = String(error?.code ?? "").toLowerCase();
  const message = String(error?.message ?? "").toLowerCase();
  return code === "user_not_found"
    || message.includes("user not found")
    || message.includes("signups not allowed for otp");
}

function isDuplicateSignupError(error) {
  const code = String(error?.code ?? "").toLowerCase();
  const message = String(error?.message ?? "").toLowerCase();
  return code === "user_already_exists" || message.includes("user already registered");
}

function authSuccessMessage(intent) {
  if (intent === "confirmation") return "Email confirmed. Your protected workspace is ready.";
  if (intent === "google") return "Signed in securely with Google.";
  if (intent === "magic") return "Magic link accepted. You are signed in.";
  if (intent === "callback") return "Authentication complete. Your protected workspace is ready.";
  return null;
}

async function authResult(operation) {
  const { data, error } = await operation;
  if (error) throw error;
  return data;
}

function passwordSignIn(client, { email, password }) {
  return authResult(requireAuthClient(client).signInWithPassword({
    email: email.trim(),
    password,
  }));
}

function passwordSignUp(client, { email, password, origin }) {
  return authResult(requireAuthClient(client).signUp({
    email: email.trim(),
    password,
    options: { emailRedirectTo: authRedirectUrl("confirmation", origin) },
  }));
}

function sendMagicLink(client, { email, origin }) {
  return authResult(requireAuthClient(client).signInWithOtp({
    email: email.trim(),
    options: {
      emailRedirectTo: authRedirectUrl("magic", origin),
      shouldCreateUser: false,
    },
  }));
}

function sendPasswordReset(client, { email, origin }) {
  return authResult(requireAuthClient(client).resetPasswordForEmail(email.trim(), {
    redirectTo: authRedirectUrl("recovery", origin),
  }));
}

function googleSignIn(client, { origin }) {
  return authResult(requireAuthClient(client).signInWithOAuth({
    provider: "google",
    options: { redirectTo: authRedirectUrl("google", origin) },
  }));
}

async function exchangeAuthCallback(client, { url = globalThis.location?.href } = {}) {
  const parsed = new URL(url ?? "", "http://localhost");
  const code = parsed.searchParams.get("code");
  if (!["/", "/auth/callback", "/reset-password"].includes(parsed.pathname) || !code) {
    throw new Error("The authentication callback code is unavailable.");
  }
  const flowId = parsed.searchParams.get("sb_flow_id");
  if (flowId && !PKCE_FLOW_ID_PATTERN.test(flowId)) {
    throw new Error("The authentication callback flow is invalid.");
  }
  const auth = requireAuthClient(client);
  const data = await authResult(flowId
    ? auth.exchangeCodeForSession(code, { flowId })
    : auth.exchangeCodeForSession(code));
  if (!data?.session) {
    const error = new Error("The authentication callback did not create a session.");
    error.code = "session_not_created";
    throw error;
  }
  return data;
}

function updatePassword(client, password) {
  return authResult(requireAuthClient(client).updateUser({ password }));
}

function validateNewPassword(password, confirmation) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password !== confirmation) return "The passwords do not match.";
  return null;
}

export {
  AUTH_REDIRECT_PATHS,
  MIN_PASSWORD_LENGTH,
  PASSWORD_RECOVERY_SESSION_KEY,
  PASSWORD_RECOVERY_SESSION_TTL_MS,
  authErrorMessage,
  authIntentFromRedirectType,
  authRedirectUrl,
  authSuccessMessage,
  clearAuthCallbackLocation,
  exchangeAuthCallback,
  forgetPasswordRecovery,
  googleSignIn,
  hasPasswordRecoverySession,
  isPasswordRecoveryRoute,
  isDuplicateSignupError,
  isMissingMagicAccountError,
  passwordSignIn,
  passwordSignUp,
  passwordRecoveryStateForAuthEvent,
  readAuthCallback,
  rememberPasswordRecovery,
  sendMagicLink,
  sendPasswordReset,
  updatePassword,
  validateNewPassword,
};
