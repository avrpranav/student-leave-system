router.get("/leaves/:rollNumber", async (req, res) => {
  try {
    const roll = req.params.rollNumber.toUpperCase();

    const result = await pool.query(
      `
      SELECT
        lr.roll_number,
        lr.from_date,
        lr.to_date,
        lr.reason,

        -- new correct fields
        lr.applied_at,
        lr.action_status,
        lr.action_by,
        lr.action_role,
        lr.action_at

      FROM leave_requests lr
      WHERE lr.roll_number = $1
      ORDER BY lr.applied_at DESC
      `,
      [roll]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Student leave history error:", err);
    res.status(500).json({
      message: "Failed to fetch leave history"
    });
  }
});
