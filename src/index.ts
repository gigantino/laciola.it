import { Hono } from "hono";

type Bindings = {
  DB: D1Database;
	ASSETS: Fetcher;
};

const app = new Hono<{ Bindings: Bindings }>();

// Database interface types
interface LeaderboardEntry {
  name: string;
  score: number;
  timestamp: number;
}

interface PlayerActivity {
  lastSubmission: number;
  submissionCount: number;
  firstSeen: number;
  sessionId: string;
}

// Name validation function
function isValidName(name: string): boolean {
  const regex = /^[a-zA-Z0-9_]{3,16}$/;
  return regex.test(name);
}

// Anticheat functions
function isValidScore(score: number): boolean {
  // Maximum reasonable score (assuming 1 section per second, max 1 hour play)
  const MAX_SCORE = 3600;
  return score > 0 && score <= MAX_SCORE && Number.isInteger(score);
}

function generateSessionId(): string {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

async function checkRateLimit(
	db: D1Database,
  playerName: string,
  sessionId?: string
): Promise<{
  allowed: boolean;
  reason?: string;
}> {
  const now = Date.now();
  const playerKey = playerName.toLowerCase();

  // Get player activity from database
  const activity = await db
    .prepare(
      `
    SELECT 
      last_submission as lastSubmission, 
      submission_count as submissionCount, 
      first_seen as firstSeen, 
      session_id as sessionId 
    FROM player_activity 
    WHERE name = ?
  `
    )
    .bind(playerKey)
    .first() as PlayerActivity | null;

  if (!activity) {
    // New player - insert into database
    await db.prepare(
      `
      INSERT INTO player_activity (name, last_submission, submission_count, first_seen, session_id)
      VALUES (?, ?, ?, ?, ?)
    `
    ).bind(playerKey, now, 1, now, sessionId || generateSessionId()).run();
    return { allowed: true };
  }

  // Check if too soon since last submission (minimum 30 seconds)
  if (now - activity.lastSubmission < 30000) {
    return {
      allowed: false,
      reason: "Aspetta almeno 30 secondi tra i tentativi",
    };
  }

  // Check daily submission limit (max 50 per day)
  const daysSinceFirst = (now - activity.firstSeen) / (1000 * 60 * 60 * 24);
  if (daysSinceFirst < 1 && activity.submissionCount >= 50) {
    return {
      allowed: false,
      reason: "Troppi tentativi oggi. Riprova domani.",
    };
  }

  // Update activity in database
  await db.prepare(
    `
    UPDATE player_activity 
    SET last_submission = ?, submission_count = submission_count + 1
    WHERE name = ?
  `
  ).bind(now, playerKey).run();

  return { allowed: true };
}

async function validateScoreProgression(
  db: D1Database,
  playerName: string,
  newScore: number
): Promise<{ valid: boolean; reason?: string }> {
  const playerKey = playerName.toLowerCase();

  // Get existing score from database
  const existingEntry = await db
    .prepare(
      `
    SELECT score FROM leaderboard WHERE name = ?
  `
    )
    .bind(playerKey)
    .first() as { score: number } | null;

  if (existingEntry) {
    // Must be better than previous score
    if (newScore <= existingEntry.score) {
      return {
        valid: false,
        reason: `Devi superare il tuo record di ${existingEntry.score} punti`,
      };
    }
  }

  return { valid: true };
}

// Enable CORS middleware for Hono
app.use("*", async (c, next) => {
	c.header("Access-Control-Allow-Origin", "*");
	c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
	c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
	if (c.req.method === "OPTIONS") {
		return new Response("", { status: 204 });
	}
	await next();
});

// Get leaderboard
app.get("/api/leaderboard", async (c) => {
	const db = c.env.DB;
	const topScores = await db
		.prepare(
			`
			SELECT name, score, timestamp
			FROM leaderboard
			ORDER BY score DESC
			LIMIT 10
		`
		)
		.all<LeaderboardEntry>();
	return c.json({
		success: true,
		data: topScores.results,
	});
});

// Submit score
app.post("/api/submit-score", async (c) => {
	const db = c.env.DB;
	const body = await c.req.json();
	const { name, score, sessionId } = body as {
		name: string;
		score: number;
		sessionId?: string;
	};

	if (!name || typeof name !== "string" || !isValidName(name.trim())) {
		return c.json(
			{
				success: false,
				error: "Nome non valido! Usa 3-16 caratteri (lettere, numeri, _)",
			},
			400
		);
	}

	if (!score || typeof score !== "number" || !isValidScore(score)) {
		return c.json(
			{
				success: false,
				error: "Punteggio non valido o sospetto",
			},
			400
		);
	}

	const playerName = name.trim();

	// You need to adapt checkRateLimit and validateScoreProgression to accept db as argument
	const rateLimitCheck = await checkRateLimit(db, playerName, sessionId);
	if (!rateLimitCheck.allowed) {
		return c.json(
			{
				success: false,
				error: rateLimitCheck.reason || "Rate limit exceeded",
			},
			429
		);
	}

	const progressionCheck = await validateScoreProgression(db, playerName, score);
	if (!progressionCheck.valid) {
		return c.json(
			{
				success: false,
				error: progressionCheck.reason || "Score progression invalid",
			},
			400
		);
	}

	const existingEntry = await db
		.prepare(
			`
			SELECT name FROM leaderboard WHERE name = ?
		`
		)
		.bind(playerName.toLowerCase())
		.first<{ name: string }>();

	const timestamp = Date.now();

	if (existingEntry) {
		await db
			.prepare(
				`
				UPDATE leaderboard 
				SET score = ?, timestamp = ?
				WHERE name = ?
			`
			)
			.bind(score, timestamp, playerName.toLowerCase())
			.run();
	} else {
		await db
			.prepare(
				`
				INSERT INTO leaderboard (name, score, timestamp)
				VALUES (?, ?, ?)
			`
			)
			.bind(playerName.toLowerCase(), score, timestamp)
			.run();
	}

	console.log(`Score submitted: ${playerName} - ${score} points`);

	return c.json({
		success: true,
		message: "Punteggio salvato!",
	});
});

// Get current score rank
app.get("/api/rank/:name", async (c) => {
	const db = c.env.DB;
	const { name } = c.req.param();
	const playerKey = name.toLowerCase();

	const rankResult = await db
		.prepare(
			`
			SELECT rank, total_players FROM (
				SELECT 
					name,
					ROW_NUMBER() OVER (ORDER BY score DESC) as rank,
					COUNT(*) OVER() as total_players
				FROM leaderboard
			) WHERE name = ?
		`
		)
		.bind(playerKey)
		.first<{ rank: number; total_players: number }>();

	return c.json({
		success: true,
		rank: rankResult ? rankResult.rank : null,
		totalPlayers: rankResult ? rankResult.total_players : 0,
	});
});

// Admin endpoint to view player activity (for debugging) (rimosso oggetto a detto di si)
// app.get("/api/admin/activity", async (c) => {
// 	const db = c.env.DB;
// 	const activities = await db
// 		.prepare(
// 			`
// 			SELECT 
// 				name,
// 				last_submission as lastSubmission,
// 				submission_count as submissionCount,
// 				first_seen as firstSeen,
// 				session_id as sessionId,
// 				(? - last_submission) as lastSubmissionAgo
// 			FROM player_activity
// 			ORDER BY last_submission DESC
// 		`
// 		)
// 		.bind(Date.now())
// 		.all();

// 	return c.json({
// 		success: true,
// 		data: activities.results,
// 	});
// });

app.get("/", async (c) => {
	return c.env.ASSETS.fetch(c.req.raw);
});

export default app satisfies ExportedHandler<Env>;
