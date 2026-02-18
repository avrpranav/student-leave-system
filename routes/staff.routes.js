const express = require("express");
const router = express.Router();
const pool = require("../db");
const jwt = require("jsonwebtoken");

const JWT_SECRET = "SUPER_SECRET_KEY_CHANGE_THIS";

/* ================= AUTH MIDDLEWARE ================= */
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
   STAFF / HOD: APPROVE OR REJECT LEAVE (CORRECT LOGIC)
===================================================== */
router.put("/leave/:id/action", auth, async (req, res) => {
  const { decision } = req.body;
  const leaveId = req.params.id;

  if (!["approve", "reject"].includes(decision)) {
    return res.status(400).json({ message: "Invalid decision" });
  }

  if (!["staff", "hod"].includes(req.user.role)) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const result = await pool.query(
    "SELECT status FROM leave_requests WHERE id = $1",
    [leaveId]
  );

  if (!result.rows.length) {
    return res.status(404).json({ message: "Leave not found" });
  }

  const currentStatus = result.rows[0].status;
  let newStatus;

  // STAFF LOGIC
  if (req.user.role === "staff") {
    if (currentStatus !== "PENDING") {
      return res.status(403).json({ message: "Staff can act only on pending requests" });
    }
    newStatus = decision === "approve"
      ? "STAFF_APPROVED"
      : "STAFF_REJECTED";
  }

  // HOD LOGIC
  if (req.user.role === "hod") {
    if (currentStatus === "STAFF_REJECTED") {
      return res.status(403).json({ message: "Cannot override staff rejection" });
    }
    if (!["PENDING", "STAFF_APPROVED"].includes(currentStatus)) {
      return res.status(403).json({ message: "Invalid state for HOD action" });
    }
    newStatus = decision === "approve"
      ? "HOD_APPROVED"
      : "HOD_REJECTED";
  }

  await pool.query(
    `
    UPDATE leave_requests
    SET
      status = $1,
      action_by = $2,
      action_role = $3,
      action_time = CURRENT_TIMESTAMP
    WHERE id = $4
    `,
    [newStatus, req.user.name, req.user.role.toUpperCase(), leaveId]
  );

  res.json({ message: "Leave updated", status: newStatus });
});

module.exports = router;
