import { Elysia } from "elysia";
import { Database } from "bun:sqlite";

// Database setup
const db = new Database("laciola.db");

// Initialize database tables
db.exec(`
  CREATE TABLE IF NOT EXISTS leaderboard (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    score INTEGER NOT NULL,
    timestamp INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS player_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    last_submission INTEGER NOT NULL,
    submission_count INTEGER NOT NULL,
    first_seen INTEGER NOT NULL,
    session_id TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_leaderboard_score ON leaderboard(score DESC);
  CREATE INDEX IF NOT EXISTS idx_player_activity_name ON player_activity(name);
`);

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
  // Just check if it's a positive integer
  return score > 0 && Number.isInteger(score);
}

function generateSessionId(): string {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

function checkRateLimit(
  playerName: string,
  sessionId?: string
): {
  allowed: boolean;
  reason?: string;
} {
  const now = Date.now();
  const playerKey = playerName.toLowerCase();

  // Get player activity from database
  const activity = db
    .prepare(
      `
    SELECT last_submission, submission_count, first_seen, session_id 
    FROM player_activity 
    WHERE name = ?
  `
    )
    .get(playerKey) as PlayerActivity | undefined;

  if (!activity) {
    // New player - insert into database
    db.prepare(
      `
      INSERT INTO player_activity (name, last_submission, submission_count, first_seen, session_id)
      VALUES (?, ?, ?, ?, ?)
    `
    ).run(playerKey, now, 1, now, sessionId || generateSessionId());
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
  db.prepare(
    `
    UPDATE player_activity 
    SET last_submission = ?, submission_count = submission_count + 1
    WHERE name = ?
  `
  ).run(now, playerKey);

  return { allowed: true };
}

function validateScoreProgression(
  playerName: string,
  newScore: number
): { valid: boolean; reason?: string } {
  const playerKey = playerName.toLowerCase();

  // Get existing score from database
  const existingEntry = db
    .prepare(
      `
    SELECT score FROM leaderboard WHERE name = ?
  `
    )
    .get(playerKey) as { score: number } | undefined;

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

const app = new Elysia()
  // Enable CORS for frontend communication
  .use(
    new Elysia().derive(({ set }) => {
      set.headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      };
    })
  )
  // Handle preflight OPTIONS requests
  .options("*", () => new Response(null, { status: 204 }))

  // Get leaderboard
  .get("/api/leaderboard", () => {
    // Return top 10 sorted by score (descending)
    const topScores = db
      .prepare(
        `
      SELECT name, score, timestamp
      FROM leaderboard
      ORDER BY score DESC
      LIMIT 10
    `
      )
      .all() as LeaderboardEntry[];

    return {
      success: true,
      data: topScores,
    };
  })

  // Submit score
  .post("/api/submit-score", async ({ body }: { body: any }) => {
    const { name, score, sessionId } = body as {
      name: string;
      score: number;
      sessionId?: string;
    };

    // Validate input
    if (!name || typeof name !== "string" || !isValidName(name.trim())) {
      return {
        success: false,
        error: "Nome non valido! Usa 3-16 caratteri (lettere, numeri, _)",
      };
    }

    if (!score || typeof score !== "number" || !isValidScore(score)) {
      return {
        success: false,
        error: "Punteggio non valido o sospetto",
      };
    }

    const playerName = name.trim();

    // Check rate limiting
    const rateLimitCheck = checkRateLimit(playerName, sessionId);
    if (!rateLimitCheck.allowed) {
      return {
        success: false,
        error: rateLimitCheck.reason || "Rate limit exceeded",
      };
    }

    // Validate score progression
    const progressionCheck = validateScoreProgression(playerName, score);
    if (!progressionCheck.valid) {
      return {
        success: false,
        error: progressionCheck.reason || "Score progression invalid",
      };
    }

    // Check if user already exists, update if better score
    const existingEntry = db
      .prepare(
        `
      SELECT name FROM leaderboard WHERE name = ?
    `
      )
      .get(playerName.toLowerCase()) as { name: string } | undefined;

    const timestamp = Date.now();

    if (existingEntry) {
      // Update score (we already validated it's better)
      db.prepare(
        `
        UPDATE leaderboard 
        SET score = ?, timestamp = ?
        WHERE name = ?
      `
      ).run(score, timestamp, playerName.toLowerCase());
    } else {
      // Add new entry
      db.prepare(
        `
        INSERT INTO leaderboard (name, score, timestamp)
        VALUES (?, ?, ?)
      `
      ).run(playerName.toLowerCase(), score, timestamp);
    }

    console.log(`Score submitted: ${playerName} - ${score} points`);

    return {
      success: true,
      message: "Punteggio salvato!",
    };
  })

  // Get current score rank
  .get("/api/rank/:name", ({ params }: { params: any }) => {
    const { name } = params;
    const playerKey = name.toLowerCase();

    // Get player's rank using a window function
    const rankResult = db
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
      .get(playerKey) as { rank: number; total_players: number } | undefined;

    return {
      success: true,
      rank: rankResult ? rankResult.rank : null,
      totalPlayers: rankResult ? rankResult.total_players : 0,
    };
  })

  // Admin endpoint to view player activity (for debugging)
  .get("/api/admin/activity", () => {
    const activities = db
      .prepare(
        `
      SELECT 
        name,
        last_submission as lastSubmission,
        submission_count as submissionCount,
        first_seen as firstSeen,
        session_id as sessionId,
        (? - last_submission) as lastSubmissionAgo
      FROM player_activity
      ORDER BY last_submission DESC
    `
      )
      .all(Date.now());

    return {
      success: true,
      data: activities,
    };
  })

  // Serve index.html at root
  .get("/", () => Bun.file("index.html"))

  .listen(3000);

console.log(
  `🗼 La Ciola Infinita Leaderboard API running at http://localhost:3000`
);
