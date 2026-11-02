import { ApiError } from "@/lib/http/api-error";
import { db } from "@/lib/supabase";

// Throws USER_NOT_FOUND for a deleted account, whose name another user may now hold (D-35)
export async function findProfile(username: string) {
  // PostgREST aliases * to %. It is not a valid username character (§8.7.1a).
  if (username.includes("*")) throw new ApiError("USER_NOT_FOUND");
  const { data, error } = await db().from("profiles")
    .select("id, username, avatar_url, likes_public, favorites_public, created_at")
    .ilike("username", username.replace(/[\\%_]/g, "\\$&")).is("deleted_at", null).maybeSingle();
  if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
  if (!data) throw new ApiError("USER_NOT_FOUND");
  return data;
}
