const pool = require('../config/db');

// ==================================================================
// ส่วนที่ 5: ประวัติการใช้งาน (Admin)
// ==================================================================

async function listLogs(req, res) {
  const result = await pool.query(
    `SELECT lg.*, l.locker_number, u.firstname, u.lastname
     FROM logs lg
     JOIN lockers l ON lg.locker_id = l.locker_id
     JOIN users u ON lg.user_id = u.user_id
     ORDER BY lg.timestamp DESC`
  );
  res.json({ success: true, data: result.rows });
}

async function dashboard(req, res) {
  const result = await pool.query(`
    SELECT
      COUNT(*) AS total_lockers,
      SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) AS available_lockers,
      SUM(CASE WHEN status = 'unavailable' THEN 1 ELSE 0 END) AS in_use_lockers,
      SUM(CASE WHEN status = 'maintenance' THEN 1 ELSE 0 END) AS maintenance_lockers
    FROM lockers
  `);
  res.json({ success: true, data: result.rows[0] });
}

module.exports = { listLogs, dashboard };
