export type ApiKeyScope = "quotes:read" | "quotes:write" | "reactions:write" | "comments:write" | "me:read";

export type AmrEntry = { method: string; timestamp: number };

// `internal` is an independent dimension: it only changes quota and list access, never identity (§4.2)
export type Caller = { internal: boolean; ip: string } & (
  | { type: "anonymous" }
  | { type: "user"; userId: string; aal: string; sessionId: string; amr: AmrEntry[]; token: string }
  | { type: "api_key"; userId: string; keyId: string; scopes: ApiKeyScope[] }
);

export type IdentifiedCaller = Exclude<Caller, { type: "anonymous" }>;
