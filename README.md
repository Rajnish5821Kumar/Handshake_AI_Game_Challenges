# Bluff Battle

A mobile-friendly, three-round bluffing game for 2–8 players. The browser is a thin client: Netlify Functions authenticate each player's room token and call transaction-safe PostgreSQL functions. Private answer submissions stay in the database until everyone has submitted; answer authors and votes are hidden until voting closes.

## Game rules

- The host starts once at least two players have joined.
- Every player submits one fake answer in private. Submissions close automatically when everyone has answered.
- The real answer and all bluffs are shuffled before voting. Players cannot select their own bluff.
- Correctly choosing the real answer earns 1 point. Each vote for a player's bluff earns that player 1 point.
- The host starts the next round after the scoreboard. After round three, the final leaderboard is shown.
- Ties are ranked by total score, then correct real-answer guesses, then votes earned by a player's bluffs. If all three measures are tied, the players share the win.

## Set up the backend

1. Create a Supabase project.
2. In the Supabase SQL Editor, run all of [`supabase/schema.sql`](./supabase/schema.sql). It creates the tables and server-only RPC functions. Direct table access is disabled for browser roles.
3. From Supabase project settings, copy the project URL and the **service role** key. The service-role key bypasses row-level security and must only be configured as a server-side environment variable. Never put it in frontend code or commit it.

## Run locally

1. Install Node.js 22.13 or later.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and replace the placeholders with the Supabase project URL and service-role key.
4. Run `npm run dev` and open the local URL printed by Netlify CLI (normally `http://localhost:8888`).

The application uses Netlify Functions through the local Netlify dev server. `npm run build` checks the static production build; `npm run check` also runs JavaScript syntax checks.

## Deploy to Netlify

1. Push this project to a Git provider and import it in Netlify, or deploy it with the Netlify CLI.
2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the Netlify site's environment variables for Functions (and all deploy contexts you intend to use).
3. Confirm the build settings use `npm run build` and `dist` as the publish directory. `netlify.toml` already configures the build, Functions directory, API rewrite, and SPA fallback.
4. Deploy the site. Functions will not be able to access the database until both environment variables are set.

## Test with two browser windows or devices

1. Open the deployed URL (or local Netlify dev URL) in window/device A. Enter a name and create a room. Share the displayed five-character room code.
2. Open the same URL in window/device B, enter another name and that code. Both waiting rooms should show the two players without refreshing.
3. In A, start the game. Submit a different fake answer in each browser. Verify each browser waits privately until the final submission, then sees the shuffled answers.
4. Vote in both browsers. Each player should be unable to select their own bluff; after both votes, the reveal and scoreboard should appear.
5. Have the host start the next round. Complete all three rounds and confirm final scores, tie-break explanation, and winner/shared-win display.
6. Refresh either browser during a round. Its saved room token should reconnect to the same phase and score. Try submitting twice and confirm the server rejects the duplicate.

This project is not considered live until you deploy it and verify the deployed URL. The database schema must be installed before room/game actions can work.
