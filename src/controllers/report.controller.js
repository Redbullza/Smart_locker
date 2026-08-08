const pool = require('../config/db');

// ==================================================================
// ส่วนที่ 8: รายงานสถิติ — รายวัน/รายเดือน/รายปี + อัตราการใช้ตู้
// ==================================================================

async function reports(req, res) {
  const period = ['daily', 'monthly', 'yearly'].includes(req.query.period) ? req.query.period : 'daily';
  // เปลี่ยนฟอร์แมตวันที่ให้รองรับ PostgreSQL TO_CHAR
  const pgDateFormat = period === 'yearly' ? 'YYYY' : period === 'monthly' ? 'YYYY-MM' : 'YYYY-MM-DD';

  const logResult = await pool.query(
    `SELECT
        TO_CHAR(timestamp, $1) AS period_label,
        SUM(CASE WHEN action = 'book' THEN 1 ELSE 0 END) AS bookings,
        SUM(CASE WHEN action = 'open' THEN 1 ELSE 0 END) AS opens,
        SUM(CASE WHEN action = 'close' THEN 1 ELSE 0 END) AS closes,
        SUM(CASE WHEN action = 'wrong_pin' THEN 1 ELSE 0 END) AS wrong_pins,
        COUNT(*) AS total_events
     FROM logs
     GROUP BY period_label
     ORDER BY period_label DESC
     LIMIT 30`,
    [pgDateFormat]
  );

  const lockerCountResult = await pool.query('SELECT COUNT(*) AS total_lockers FROM lockers');
  const total_lockers = parseInt(lockerCountResult.rows[0].total_lockers) || 0;

  const data = logResult.rows.map((r) => {
    const utilizationRate = total_lockers > 0 ? Math.round((r.bookings / total_lockers) * 100) : 0;
    return { ...r, utilization_rate: utilizationRate };
  });

  res.json({ success: true, period, data });
}

module.exports = { reports };
