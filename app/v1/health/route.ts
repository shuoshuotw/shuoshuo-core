export const dynamic = "force-dynamic";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, s-maxage=5" };

export function GET() {
  return Response.json({ status: "ok" }, { headers });
}
