const express = require("express");
const cors = require("cors");
const pool = require("./db");
const jwt = require("jsonwebtoken");

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = "SUPER_SECRET_KEY_CHANGE_THIS";

/* =====================================================
   JWT MIDDLEWARE
===================================================== */
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ message: "No token" });

  try {
    const token = header.split(" ")[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
}

/* =====================================================
   ADMIN ONLY MIDDLEWARE
===================================================== */
function adminOnly(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ message: "Admin only" });
  }
  next();
}

/* =====================================================
   🔔 NOTIFICATION HELPER (DEBUG ENABLED)
===================================================== */
async function notify(userRole, userId, message) {
  console.log("🔔 NOTIFY:", userRole, userId, message);

  await pool.query(
    `INSERT INTO notifications (user_role, user_id, message)
     VALUES ($1,$2,$3)`,
    [userRole, userId, message]
  );
}


/* =====================================================
   HEALTH CHECK
===================================================== */
app.get("/", (req, res) => {
  res.json({ status: "API running" });
});

/* =====================================================
   LOGIN
===================================================== */
app.post("/api/login", async (req, res) => {
  const { loginId, password } = req.body;
  const id = loginId.trim().toUpperCase();

  const student = await pool.query(
    "SELECT roll_number,password FROM students WHERE roll_number=$1",
    [id]
  );

  if (student.rows.length) {
    if (student.rows[0].password !== password)
      return res.status(401).json({ message: "Invalid credentials" });

    const token = jwt.sign(
      { role: "student", rollNumber: id },
      JWT_SECRET,
      { expiresIn: "8h" }
    );
    return res.json({ token, role: "student" });
  }

  const staff = await pool.query(
    "SELECT staff_id,name,password,role FROM staff WHERE staff_id=$1",
    [id]
  );

  if (staff.rows.length) {
    if (staff.rows[0].password !== password)
      return res.status(401).json({ message: "Invalid credentials" });

    const role = staff.rows[0].role.toLowerCase();
    if (!["staff", "hod", "admin"].includes(role))
      return res.status(403).json({ message: "Invalid role in DB" });

    const token = jwt.sign(
      { role, staffId: id, name: staff.rows[0].name },
      JWT_SECRET,
      { expiresIn: "8h" }
    );
    return res.json({ token, role });
  }

  res.status(401).json({ message: "User not found" });
});

/* =====================================================
   APPLY LEAVE (STUDENT) + 🔔 NOTIFY STAFF
===================================================== */
app.post("/api/student/apply-leave", auth, async (req, res) => {
  if (req.user.role !== "student")
    return res.status(403).json({ message: "Forbidden" });

  const { fromDate, toDate, reason } = req.body;

  const pending = await pool.query(
    "SELECT 1 FROM leave_requests WHERE roll_number=$1 AND status='PENDING'",
    [req.user.rollNumber]
  );

  if (pending.rows.length)
    return res.status(400).json({ message: "Already has pending leave" });

  await pool.query(
    `INSERT INTO leave_requests
     (roll_number,from_date,to_date,reason,status)
     VALUES ($1,$2,$3,$4,'PENDING')`,
    [req.user.rollNumber, fromDate, toDate, reason]
  );

  const staffList = await pool.query(
    "SELECT staff_id FROM staff WHERE role='staff'"
  );

  for (const s of staffList.rows) {
    await notify("staff", s.staff_id, `New leave request from ${req.user.rollNumber}`);
  }

  res.json({ message: "Leave applied" });
});

/* =====================================================
   STUDENT LEAVE HISTORY
===================================================== */
app.get("/api/student/leaves/:roll", auth, async (req, res) => {
  if (req.user.role !== "student")
    return res.status(403).json({ message: "Forbidden" });

  const result = await pool.query(
    "SELECT * FROM leave_requests WHERE roll_number=$1 ORDER BY applied_time DESC",
    [req.user.rollNumber]
  );

  res.json(result.rows);
});

/* =====================================================
   STAFF / HOD VIEW LEAVES
===================================================== */
app.get("/api/staff/leave-requests", auth, async (req, res) => {
  if (!["staff", "hod"].includes(req.user.role))
    return res.status(403).json({ message: "Forbidden" });

  const result = await pool.query(
    "SELECT * FROM leave_requests ORDER BY applied_time DESC"
  );

  res.json(result.rows);
});

/* =====================================================
   STAFF / HOD / ADMIN: GET STUDENT BASIC INFO
===================================================== */
app.get("/api/students/:roll", auth, async (req, res) => {
  if (!["staff", "hod", "admin"].includes(req.user.role)) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const { roll } = req.params;

  const result = await pool.query(
    "SELECT roll_number, name, department FROM students WHERE roll_number=$1",
    [roll]
  );

  if (!result.rows.length) {
    return res.status(404).json({ message: "Student not found" });
  }

  res.json(result.rows[0]);
});

/* =====================================================
   APPROVE / REJECT + 🔔 NOTIFY STUDENT
===================================================== */
app.put("/api/leave/:id/action", auth, async (req, res) => {
  if (!["staff", "hod"].includes(req.user.role))
    return res.status(403).json({ message: "Forbidden" });

  const { decision } = req.body;
  const leaveId = req.params.id;

  const newStatus =
    req.user.role === "staff"
      ? decision === "approve" ? "STAFF_APPROVED" : "STAFF_REJECTED"
      : decision === "approve" ? "HOD_APPROVED" : "HOD_REJECTED";

  const updated = await pool.query(
    `UPDATE leave_requests
     SET status=$1,action_by=$2,action_role=$3,action_time=NOW()
     WHERE id=$4 RETURNING roll_number`,
    [newStatus, req.user.name, req.user.role.toUpperCase(), leaveId]
  );

  if (updated.rows.length) {
    await notify(
      "student",
      updated.rows[0].roll_number,
      `Your leave was ${newStatus.replace("_", " ").toLowerCase()}`
    );
  }

  res.json({ message: "Leave updated" });
});

/* =====================================================
   🔔 NOTIFICATIONS (UPDATED & COMPLETE)
===================================================== */

/* Get all notifications */
app.get("/api/notifications", auth, async (req, res) => {
  const userId =
    req.user.role === "student"
      ? req.user.rollNumber
      : req.user.staffId;

  const result = await pool.query(
    `SELECT id, message, is_read, created_at
     FROM notifications
     WHERE user_role=$1 AND user_id=$2
     ORDER BY created_at DESC`,
    [req.user.role, userId]
  );

  res.json(result.rows);
});

/* Mark ONE as read */
app.put("/api/notifications/:id/read", auth, async (req, res) => {
  await pool.query(
    "UPDATE notifications SET is_read=true WHERE id=$1",
    [req.params.id]
  );
  res.json({ message: "Notification read" });
});

/* ✅ Mark ALL as read */
app.put("/api/notifications/read-all", auth, async (req, res) => {
  const userId =
    req.user.role === "student"
      ? req.user.rollNumber
      : req.user.staffId;

  await pool.query(
    `UPDATE notifications
     SET is_read=true
     WHERE user_role=$1 AND user_id=$2`,
    [req.user.role, userId]
  );

  res.json({ message: "All notifications marked as read" });
});
/* =====================================================
   👑 ADMIN: ANALYTICS
===================================================== */
app.get("/api/admin/analytics", auth, adminOnly, async (req, res) => {
  const students = await pool.query("SELECT COUNT(*) FROM students");
  const staff = await pool.query("SELECT COUNT(*) FROM staff");
  const totalLeaves = await pool.query("SELECT COUNT(*) FROM leave_requests");
  const pending = await pool.query(
    "SELECT COUNT(*) FROM leave_requests WHERE status='PENDING'"
  );
  const approved = await pool.query(
    "SELECT COUNT(*) FROM leave_requests WHERE status LIKE '%APPROVED%'"
  );
  const rejected = await pool.query(
    "SELECT COUNT(*) FROM leave_requests WHERE status LIKE '%REJECTED%'"
  );

  res.json({
    students: students.rows[0].count,
    staff: staff.rows[0].count,
    totalLeaves: totalLeaves.rows[0].count,
    pending: pending.rows[0].count,
    approved: approved.rows[0].count,
    rejected: rejected.rows[0].count
  });
});

/* =====================================================
   👑 ADMIN: GET ALL STUDENTS
===================================================== */
app.get("/api/admin/students", auth, adminOnly, async (req, res) => {
  const result = await pool.query(
    "SELECT roll_number, name, department FROM students ORDER BY roll_number"
  );
  res.json(result.rows);
});

/* =====================================================
   👑 ADMIN: GET ALL STAFF
===================================================== */
app.get("/api/admin/staff", auth, adminOnly, async (req, res) => {
  const result = await pool.query(
    "SELECT staff_id, name, role FROM staff ORDER BY staff_id"
  );
  res.json(result.rows);
});
/* =====================================================
   👑 ADMIN: ADD STUDENT
===================================================== */
app.post("/api/admin/students", auth, adminOnly, async (req, res) => {
  const { roll_number, name, department, password } = req.body;

  if (!roll_number || !name || !department || !password) {
    return res.status(400).json({ message: "All fields required" });
  }

  const exists = await pool.query(
    "SELECT 1 FROM students WHERE roll_number=$1",
    [roll_number]
  );

  if (exists.rows.length) {
    return res.status(409).json({ message: "Student already exists" });
  }

  await pool.query(
    `INSERT INTO students (roll_number, name, department, password)
     VALUES ($1,$2,$3,$4)`,
    [roll_number.toUpperCase(), name, department, password]
  );

  res.json({ message: "Student added successfully" });
});
/* =====================================================
   👑 ADMIN: ADD STAFF
===================================================== */
app.post("/api/admin/staff", auth, adminOnly, async (req, res) => {
  const { staff_id, name, role, password } = req.body;

  if (!staff_id || !name || !role || !password) {
    return res.status(400).json({ message: "All fields required" });
  }

  if (!["staff", "hod", "admin"].includes(role)) {
    return res.status(400).json({ message: "Invalid role" });
  }

  const exists = await pool.query(
    "SELECT 1 FROM staff WHERE staff_id=$1",
    [staff_id]
  );

  if (exists.rows.length) {
    return res.status(409).json({ message: "Staff already exists" });
  }

  await pool.query(
    `INSERT INTO staff (staff_id, name, role, password)
     VALUES ($1,$2,$3,$4)`,
    [staff_id.toUpperCase(), name, role, password]
  );

  res.json({ message: "Staff added successfully" });
});


/* =====================================================
   START SERVER
===================================================== */
app.listen(3000, () => {
  console.log("✅ API server running on http://localhost:3000");
});
