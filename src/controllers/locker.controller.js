const pool = require('../config/db');

// ==================================================================
// ส่วนที่ 2: ตู้ล็อกเกอร์ (ฟรีสำหรับนักศึกษา ไม่มีค่าบริการ)
// ==================================================================

async function listLockers(req, res) {
  const result = await pool.query('SELECT * FROM lockers ORDER BY locker_number');
  res.json({ success: true, data: result.rows });
}

// ==================================================================
// ส่วนที่ 7: จัดการตู้ล็อกเกอร์ (เปิด/ปิด/ซ่อมบำรุง/ขนาด) — Admin
// ==================================================================

async function updateLocker(req, res) {
  const { status, size } = req.body;
  const fields = [];
  const values = [];
  let paramIndex = 1;

  if (status) {
    if (!['available', 'unavailable', 'maintenance'].includes(status)) {
      return res.status(400).json({ success: false, message: 'สถานะไม่ถูกต้อง' });
    }
    fields.push(`status = $${paramIndex++}`);
    values.push(status);
  }
  if (size) {
    if (!['small', 'medium', 'large'].includes(size)) {
      return res.status(400).json({ success: false, message: 'ขนาดไม่ถูกต้อง' });
    }
    fields.push(`size = $${paramIndex++}`);
    values.push(size);
  }
  if (fields.length === 0) {
    return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลให้อัปเดต' });
  }

  values.push(req.params.id);
  const queryText = `UPDATE lockers SET ${fields.join(', ')} WHERE locker_id = $${paramIndex}`;
  const result = await pool.query(queryText, values);

  if (result.rowCount === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบตู้ล็อกเกอร์นี้' });
  }
  res.json({ success: true, message: 'อัปเดตตู้ล็อกเกอร์สำเร็จ' });
}

module.exports = { listLockers, updateLocker };
