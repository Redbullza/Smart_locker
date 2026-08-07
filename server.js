
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

// เชื่อมต่อฐานข้อมูล Supabase PostgreSQL ผ่าน Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // จำเป็นสำหรับการเชื่อมต่อ Supabase บน Cloud
  }
});

// ตั้งค่า timezone ของทุก connection ในระบบ Pool ให้เป็นเวลาไทย
// (ไม่งั้น NOW() ในฐานข้อมูลจะได้เวลา UTC ทำให้ timestamp ใน logs ผิดเวลา)
pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'Asia/Bangkok'");
});

// ==================================================================
// ส่วนที่ 1: ระบบตรวจสอบสิทธิ์การเข้าใช้งาน (User Authentication)
// ==================================================================

app.post('/register', async (req, res) => {
  const { username, password, firstname, lastname } = req.body;
  if (!username || !password || !firstname || !lastname) {
    return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบ' });
  }
  const hashedPassword = await bcrypt.hash(password, 10);
  try {
    await pool.query(
      'INSERT INTO users (username, password, firstname, lastname) VALUES ($1, $2, $3, $4)',
      [username, hashedPassword, firstname, lastname]
    );
    res.json({ success: true, message: 'สมัครสมาชิกสำเร็จ' });
  } catch (err) {
    res.status(400).json({ success: false, message: 'ชื่อผู้ใช้นี้มีอยู่แล้ว' });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  if (result.rows.length === 0) {
    return res.status(401).json({ success: false, message: 'ไม่พบผู้ใช้งานนี้' });
  }
  const user = result.rows[0];
  if (user.status === 'suspended') {
    return res.status(403).json({ success: false, message: 'บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ' });
  }
  const isPasswordCorrect = await bcrypt.compare(password, user.password);
  if (!isPasswordCorrect) {
    return res.status(401).json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });
  }
  res.json({
    success: true, message: 'เข้าสู่ระบบสำเร็จ',
    user_id: user.user_id, role: user.role, firstname: user.firstname, lastname: user.lastname,
  });
});

// ==================================================================
// ส่วนที่ 2: ตู้ล็อกเกอร์ (ฟรีสำหรับนักศึกษา ไม่มีค่าบริการ)
// ==================================================================

app.get('/lockers', async (req, res) => {
  const result = await pool.query('SELECT * FROM lockers ORDER BY locker_number');
  res.json({ success: true, data: result.rows });
});

// ==================================================================
// ส่วนที่ 3: จองตู้ล็อกเกอร์ (ฟรี ไม่มีขั้นตอนชำระเงิน ฝากได้ไม่จำกัดเวลา)
// ==================================================================

app.post('/booking', async (req, res) => {
  const { user_id, locker_id, hours } = req.body;
  if (!user_id || !locker_id) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุ user_id และ locker_id' });
  }
  // hours เป็นแค่ข้อมูลอ้างอิงว่าผู้ใช้ "ตั้งใจ" จะฝากกี่ชั่วโมง ไม่บังคับ ไม่มีผลต่อค่าปรับหรือการล็อกตู้
  const plannedHours = Number.isInteger(hours) && hours > 0 ? hours : null;

  const lockerResult = await pool.query('SELECT * FROM lockers WHERE locker_id = $1', [locker_id]);
  if (lockerResult.rows.length === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบตู้ล็อกเกอร์นี้' });
  }
  const locker = lockerResult.rows[0];
  if (locker.status !== 'available') {
    return res.status(400).json({ success: false, message: 'ตู้นี้ไม่ว่าง หรืออยู่ระหว่างซ่อมบำรุง' });
  }

  const pinCode = Math.floor(100000 + Math.random() * 900000).toString();

  // ฝากได้ไม่จำกัดเวลาจริง (planned_hours เก็บไว้แสดงผลเฉยๆ) จึงไม่ต้องตั้ง end_time หรือ price
  const bookingResult = await pool.query(
    `INSERT INTO bookings (user_id, locker_id, pin_code, planned_hours, status)
     VALUES ($1, $2, $3, $4, 'active') RETURNING booking_id`,
    [user_id, locker_id, pinCode, plannedHours]
  );

  await pool.query('UPDATE lockers SET status = $1 WHERE locker_id = $2', ['unavailable', locker_id]);
  await pool.query('INSERT INTO logs (locker_id, user_id, action) VALUES ($1, $2, $3)', [locker_id, user_id, 'book']);

  res.json({
    success: true, message: 'จองตู้สำเร็จ',
    booking_id: bookingResult.rows[0].booking_id,
    pin_code: pinCode,
    locker_number: locker.locker_number,
    planned_hours: plannedHours,
  });
});

// ดูรายการจองของผู้ใช้คนหนึ่ง (แสดงระยะเวลาที่ฝากไปแล้ว ไม่มีกำหนดคืน)
app.get('/my-bookings', async (req, res) => {
  const { user_id } = req.query;
  const result = await pool.query(
    `SELECT b.*, l.locker_number, l.location, l.size
     FROM bookings b JOIN lockers l ON b.locker_id = l.locker_id
     WHERE b.user_id = $1 ORDER BY b.created_at DESC`,
    [user_id]
  );
  res.json({ success: true, data: result.rows });
});

// ==================================================================
// ส่วนที่ 4: ตรวจสอบรหัส PIN + ควบคุมการเปิด/ปิดตู้
// ==================================================================

app.post('/verify-pin', async (req, res) => {
  const { booking_id, pin_code, action } = req.body;

  const result = await pool.query('SELECT * FROM bookings WHERE booking_id = $1', [booking_id]);
  if (result.rows.length === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบรายการจองนี้' });
  }
  const booking = result.rows[0];

  if (booking.pin_code !== pin_code) {
    await pool.query('INSERT INTO logs (locker_id, user_id, action) VALUES ($1, $2, $3)', [
      booking.locker_id, booking.user_id, 'wrong_pin',
    ]);
    return res.status(401).json({ success: false, message: 'รหัส PIN ไม่ถูกต้อง' });
  }

  // TODO: ในระบบจริงจะยิง request ไปสั่งงานบอร์ด ESP32 ตรงนี้

  if (action === 'close') {
    await pool.query(
      'UPDATE bookings SET status = $1, completed_at = NOW() WHERE booking_id = $2',
      ['completed', booking_id]
    );
    await pool.query('UPDATE lockers SET status = $1 WHERE locker_id = $2', ['available', booking.locker_id]);
  }

  await pool.query('INSERT INTO logs (locker_id, user_id, action) VALUES ($1, $2, $3)', [
    booking.locker_id, booking.user_id, action,
  ]);

  res.json({ success: true, message: action === 'open' ? 'ปลดล็อกตู้สำเร็จ' : 'คืนตู้สำเร็จ' });
});

// ==================================================================
// ส่วนที่ 5: ประวัติการใช้งาน (Admin)
// ==================================================================

app.get('/logs', async (req, res) => {
  const result = await pool.query(
    `SELECT lg.*, l.locker_number, u.firstname, u.lastname
     FROM logs lg
     JOIN lockers l ON lg.locker_id = l.locker_id
     JOIN users u ON lg.user_id = u.user_id
     ORDER BY lg.timestamp DESC`
  );
  res.json({ success: true, data: result.rows });
});

app.get('/dashboard', async (req, res) => {
  const result = await pool.query(`
    SELECT
      COUNT(*) AS total_lockers,
      SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) AS available_lockers,
      SUM(CASE WHEN status = 'unavailable' THEN 1 ELSE 0 END) AS in_use_lockers,
      SUM(CASE WHEN status = 'maintenance' THEN 1 ELSE 0 END) AS maintenance_lockers
    FROM lockers
  `);
  res.json({ success: true, data: result.rows[0] });
});

// รายการจองทั้งหมด (Admin) — ใช้ปล่อยตู้ที่ไม่มีคนมาใช้งานได้
app.get('/bookings', async (req, res) => {
  const result = await pool.query(
    `SELECT b.*, l.locker_number, u.username, u.firstname, u.lastname
     FROM bookings b
     JOIN lockers l ON b.locker_id = l.locker_id
     JOIN users u ON b.user_id = u.user_id
     ORDER BY b.created_at DESC
     LIMIT 100`
  );
  res.json({ success: true, data: result.rows });
});

app.put('/bookings/:id/release', async (req, res) => {
  const result = await pool.query('SELECT * FROM bookings WHERE booking_id = $1', [req.params.id]);
  if (result.rows.length === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบรายการจองนี้' });
  }
  const booking = result.rows[0];
  if (booking.status !== 'active') {
    return res.status(400).json({ success: false, message: 'รายการจองนี้ไม่ได้อยู่ในสถานะใช้งาน' });
  }

  await pool.query('UPDATE bookings SET status = $1, completed_at = NOW() WHERE booking_id = $2', ['cancelled', req.params.id]);
  await pool.query('UPDATE lockers SET status = $1 WHERE locker_id = $2', ['available', booking.locker_id]);
  await pool.query('INSERT INTO logs (locker_id, user_id, action) VALUES ($1, $2, $3)', [
    booking.locker_id, booking.user_id, 'admin_release',
  ]);

  res.json({ success: true, message: 'ปล่อยตู้สำเร็จ คืนสิทธิ์ให้ผู้อื่นจองต่อได้แล้ว' });
});

// ==================================================================
// ส่วนที่ 6: จัดการผู้ใช้งาน (Admin)
// ==================================================================

app.get('/users', async (req, res) => {
  const result = await pool.query(
    'SELECT user_id, username, firstname, lastname, role, status FROM users ORDER BY user_id'
  );
  res.json({ success: true, data: result.rows });
});

app.put('/users/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['active', 'suspended'].includes(status)) {
    return res.status(400).json({ success: false, message: 'สถานะไม่ถูกต้อง' });
  }
  await pool.query('UPDATE users SET status = $1 WHERE user_id = $2', [status, req.params.id]);
  res.json({ success: true, message: status === 'suspended' ? 'ระงับสิทธิ์ผู้ใช้สำเร็จ' : 'คืนสิทธิ์ผู้ใช้สำเร็จ' });
});

// ==================================================================
// ส่วนที่ 7: จัดการตู้ล็อกเกอร์ (เปิด/ปิด/ซ่อมบำรุง/ขนาด) — Admin
// ==================================================================

app.put('/lockers/:id', async (req, res) => {
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
});

// ==================================================================
// ส่วนที่ 8: รายงานสถิติ — รายวัน/รายเดือน/รายปี + อัตราการใช้ตู้
// ==================================================================

app.get('/reports', async (req, res) => {
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

  const data = logResult.rows.map(r => {
    const utilizationRate = total_lockers > 0 ? Math.round((r.bookings / total_lockers) * 100) : 0;
    return { ...r, utilization_rate: utilizationRate };
  });

  res.json({ success: true, period, data });
});

// ------------------------------------------------------------------
// เริ่มรันเซิร์ฟเวอร์
// ------------------------------------------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Smart Storage Locker API กำลังทำงานที่ http://localhost:${PORT}`);
});
