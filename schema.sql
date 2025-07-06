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