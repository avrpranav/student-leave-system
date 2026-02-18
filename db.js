const { Pool } = require("pg");

const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "student_leave_db",
  password: "Pranav@07",
  port: 5432,
  ssl: false
});

// 🔍 Connection test (VERY IMPORTANT)
pool.connect((err, client, release) => {
  if (err) {
    console.error("❌ Database connection failed:", err.message);
  } else {
    console.log("✅ PostgreSQL connected successfully");
    release();
  }
});

module.exports = pool;
