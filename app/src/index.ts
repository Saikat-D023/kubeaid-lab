import express from "express";
import { Pool } from "pg";

// Settings come from environment variables (set by the ConfigMap + Secret in k8s)
const db = new Pool({
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionTimeoutMillis: 3000, // fail fast instead of hanging if the DB is gone
});

db.on("error", (err) => console.log("database connection lost:", err.message));

const app = express();
app.use(express.json());

// Liveness check: "is the app process alive?" Doesn't touch the DB.
app.get("/healthz", (req, res) => {
  res.send("ok");
});

// Readiness check: "can I serve traffic?" Fails if the DB is unreachable.
app.get("/readyz", async (req, res) => {
  try {
    await db.query("SELECT 1");
    res.send("ready");
  } catch {
    res.status(503).send("database not reachable");
  }
});

// List notes
app.get("/notes", async (req, res) => {
  const result = await db.query("SELECT * FROM notes ORDER BY id DESC");
  res.json(result.rows);
});

// Add a note: POST {"body": "some text"}
app.post("/notes", async (req, res) => {
  const result = await db.query(
    "INSERT INTO notes (body) VALUES ($1) RETURNING *",
    [req.body.body]
  );
  res.status(201).json(result.rows[0]);
});

// Start listening FIRST, so /healthz answers even while the DB is unavailable.
app.listen(3000, () => console.log("notes-api listening on :3000"));

// Then create the table. Postgres may not be ready yet, so retry.
async function start() {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await db.query("CREATE TABLE IF NOT EXISTS notes (id SERIAL PRIMARY KEY, body TEXT)");
      console.log("table ready");
      return;
    } catch {
      console.log(`database not ready, retry ${attempt}/10`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  console.log("gave up on database");
  process.exit(1);
}

start();

process.on("SIGTERM", () => process.exit(0)); // stop promptly when k8s asks
