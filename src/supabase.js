import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
const googleUiFlag = import.meta.env.VITE_SUPABASE_GOOGLE_ENABLED?.trim();

export const supabaseBrowserConfigured = Boolean(supabaseUrl && publishableKey);
export const supabaseGoogleConfigured = supabaseBrowserConfigured
  && (googleUiFlag ? googleUiFlag === "true" : import.meta.env.PROD);

export const supabase = supabaseBrowserConfigured
  ? createClient(supabaseUrl, publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        flowType: "pkce",
      },
    })
  : null;
