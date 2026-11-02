import { existsSync } from "node:fs";

// A standalone build does not read .env files; Docker passes real variables in deployment
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
process.env.PORT ??= "3001";
await import("../.next/standalone/server.js");
