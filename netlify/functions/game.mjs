import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
let supabase;

function database() {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Game server setup is incomplete. Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return supabase;
}

function json(statusCode, data) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": process.env.URL || "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body: JSON.stringify(data)
  };
}

function roomCode() {
  const bytes = randomBytes(5);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function cleanName(value) {
  if (typeof value !== "string") throw new Error("Enter a name to continue.");
  const name = value.trim();
  if (name.length < 1 || name.length > 20) throw new Error("Names must be between 1 and 20 characters.");
  return name;
}

function credentials(body) {
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  const token = typeof body.token === "string" ? body.token : "";
  if (!/^[A-HJ-NP-Z2-9]{5}$/.test(code)) throw new Error("Enter a valid 5-character room code.");
  if (token.length < 32 || token.length > 100) throw new Error("Your player session is invalid. Return home and rejoin the room.");
  return { code, token };
}

async function rpc(name, args) {
  const { data, error } = await database().rpc(name, args);
  if (error) throw new Error(error.message || "The game database could not complete that action.");
  return data;
}

async function dispatch(action, body) {
  if (action === "create") {
    const name = cleanName(body.name);
    const playerId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = roomCode();
      try {
        await rpc("bb_create_room", {
          p_code: code, p_player_id: playerId, p_name: name, p_token: token
        });
        return { player: { code, token, id: playerId } };
      } catch (error) {
        if (error.message.includes("duplicate key") && attempt < 4) continue;
        throw error;
      }
    }
    throw new Error("Couldn't find an available room code. Please try again.");
  }

  if (action === "join") {
    const name = cleanName(body.name);
    const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
    if (!/^[A-HJ-NP-Z2-9]{5}$/.test(code)) throw new Error("Enter a valid 5-character room code.");
    const playerId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    await rpc("bb_join_room", { p_code: code, p_player_id: playerId, p_name: name, p_token: token });
    return { player: { code, token, id: playerId } };
  }

  const { code, token } = credentials(body);
  const rpcArgs = { p_code: code, p_token: token };
  switch (action) {
    case "state":
      return await rpc("bb_game_state", rpcArgs);
    case "leave":
      await rpc("bb_leave_room", rpcArgs);
      return { ok: true };
    case "start":
      return await rpc("bb_start_round", rpcArgs);
    case "answer":
      if (typeof body.answer !== "string" || !body.answer.trim() || body.answer.trim().length > 120) {
        throw new Error("Your bluff must be between 1 and 120 characters.");
      }
      return await rpc("bb_submit_answer", { ...rpcArgs, p_answer: body.answer.trim() });
    case "vote":
      if (typeof body.answerId !== "string" || body.answerId.length > 50) throw new Error("Choose one of the answers shown.");
      return await rpc("bb_cast_vote", { ...rpcArgs, p_answer_id: body.answerId });
    case "next":
      return await rpc("bb_start_round", rpcArgs);
    default:
      throw new Error("That game action is not available.");
  }
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST for game actions." });
  try {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Request body must be valid JSON." });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json(400, { error: "Request body must be a JSON object." });
    }
    const action = event.path.split("/").filter(Boolean).at(-1);
    const result = await dispatch(action, body);
    return json(200, result ?? { ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The game server couldn't complete that action.";
    const status = /setup is incomplete/.test(message) ? 503 : 400;
    if (status === 503) console.error(message);
    return json(status, { error: message });
  }
}
