const pool = require('../db'); // pg Pool

exports.takeAction = async (req, res) => {
  const { leaveId, decision } = req.body; // approve | reject
  const { role, name } = req.user;        // STAFF | HOD

  if (!leaveId || !decision) {
    return res.status(400).json({ message: 'Missing data' });
  }

  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({ message: 'Invalid decision' });
  }

  try {
    const result = await pool.query(
      'SELECT status FROM public.leave_requests WHERE id = $1',
      [leaveId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Leave request not found' });
    }

    const currentStatus = result.rows[0].status;
    let newStatus;

    // ---------- STAFF ----------
    if (role === 'STAFF') {
      if (currentStatus !== 'PENDING') {
        return res.status(403).json({ message: 'Staff can act only on pending requests' });
      }

      newStatus = decision === 'approve'
        ? 'STAFF_APPROVED'
        : 'STAFF_REJECTED';
    }

    // ---------- HOD ----------
    else if (role === 'HOD') {
      if (currentStatus === 'STAFF_REJECTED') {
        return res.status(403).json({ message: 'Cannot override staff rejection' });
      }

      if (!['PENDING', 'STAFF_APPROVED'].includes(currentStatus)) {
        return res.status(403).json({ message: 'Invalid state for HOD action' });
      }

      newStatus = decision === 'approve'
        ? 'HOD_APPROVED'
        : 'HOD_REJECTED';
    }

    else {
      return res.status(403).json({ message: 'Unauthorized role' });
    }

    await pool.query(
      `
      UPDATE public.leave_requests
      SET status = $1,
          action_by = $2,
          action_role = $3,
          action_time = NOW()
      WHERE id = $4
      `,
      [newStatus, name, role, leaveId]
    );

    res.json({ success: true, status: newStatus });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};
