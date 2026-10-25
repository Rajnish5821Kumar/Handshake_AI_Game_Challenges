import { handler } from "../netlify/functions/game.mjs";

export default async function gameApi(request, response) {
  const body = typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {});
  const result = await handler({
    httpMethod: request.method,
    path: new URL(request.url, "http://localhost").pathname,
    body
  });

  response.statusCode = result.statusCode;
  for (const [name, value] of Object.entries(result.headers || {})) {
    response.setHeader(name, value);
  }
  response.end(result.body);
}
