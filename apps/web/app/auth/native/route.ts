const MAX_TOKEN_LENGTH = 16_384;

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const value = form.get("token");
  const token = typeof value === "string" ? value.trim() : "";

  if (!token || token.length > MAX_TOKEN_LENGTH) {
    return new Response("Invalid native auth token", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  return new Response(null, {
    status: 303,
    headers: {
      Location: `multica://auth/callback?token=${encodeURIComponent(token)}`,
      "Cache-Control": "no-store",
    },
  });
}
