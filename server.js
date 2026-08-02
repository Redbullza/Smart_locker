const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'smart_locker',
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
    await db.query(
      'INSERT INTO users (username, password, firstname, lastname) VALUES (?, ?, ?, ?)',
      [username, hashedPassword, firstname, lastname]
    );
    res.json({ success: true, message: 'สมัครสมาชิกสำเร็จ' });
  } catch (err) {
    res.status(400).json({ success: false, message: 'ชื่อผู้ใช้นี้มีอยู่แล้ว' });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  const [rows] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
  if (rows.length === 0) {
    return res.status(401).json({ success: false, message: 'ไม่พบผู้ใช้งานนี้' });
  }

  const user = rows[0];

  // ตรวจสอบว่าบัญชีถูกระงับสิทธิ์ไว้หรือไม่ (Admin กดระงับผ่าน /users/:id/status)
  if (user.status === 'suspended') {
    return res.status(403).json({ success: false, message: 'บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ' });
  }

  const isPasswordCorrect = await bcrypt.compare(password, user.password);
  if (!isPasswordCorrect) {
    return res.status(401).json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });
  }

  res.json({
    success: true,
    message: 'เข้าสู่ระบบสำเร็จ',
    user_id: user.user_id,
    role: user.role,
    firstname: user.firstname,
    lastname: user.lastname,
  });
});

// ==================================================================
// ส่วนที่ 2: ระบบจองตู้ (Booking Locker)
// ==================================================================

app.get('/lockers', async (req, res) => {
  const [lockers] = await db.query('SELECT * FROM lockers ORDER BY locker_number');
  res.json({ success: true, data: lockers });
});

app.post('/booking', async (req, res) => {
  const { user_id, locker_id } = req.body;

  const [lockerRows] = await db.query('SELECT * FROM lockers WHERE locker_id = ?', [locker_id]);
  if (lockerRows.length === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบตู้ล็อกเกอร์นี้' });
  }
  if (lockerRows[0].status !== 'available') {
    return res.status(400).json({ success: false, message: 'ตู้นี้ไม่ว่าง หรืออยู่ระหว่างซ่อมบำรุง' });
  }

  const pinCode = Math.floor(100000 + Math.random() * 900000).toString();

  const [result] = await db.query(
    'INSERT INTO bookings (user_id, locker_id, pin_code, status) VALUES (?, ?, ?, "active")',
    [user_id, locker_id, pinCode]
  );
  await db.query('UPDATE lockers SET status = "unavailable" WHERE locker_id = ?', [locker_id]);
  await db.query('INSERT INTO logs (locker_id, user_id, action) VALUES (?, ?, "book")', [locker_id, user_id]);

  res.json({
    success: true,
    message: 'จองตู้สำเร็จ',
    booking_id: result.insertId,
    pin_code: pinCode,
  });
});

// ดูรายการจองของผู้ใช้คนหนึ่ง พร้อมข้อมูลเวลาสำหรับคำนวณ "ระยะเวลาที่เช่า"
app.get('/my-bookings', async (req, res) => {
  const { user_id } = req.query;
  const [rows] = await db.query(
    `SELECT b.*, l.locker_number, l.location
     FROM bookings b JOIN lockers l ON b.locker_id = l.locker_id
     WHERE b.user_id = ? ORDER BY b.created_at DESC`,
    [user_id]
  );
  res.json({ success: true, data: rows });
});

// ==================================================================
// ส่วนที่ 3: ตรวจสอบรหัส PIN + ควบคุมการเปิด/ปิดตู้ (Locker Control)
// ==================================================================

app.post('/verify-pin', async (req, res) => {
  const { booking_id, pin_code, action } = req.body;

  const [rows] = await db.query('SELECT * FROM bookings WHERE booking_id = ?', [booking_id]);
  if (rows.length === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบรายการจองนี้' });
  }
  const booking = rows[0];

  if (booking.pin_code !== pin_code) {
    await db.query('INSERT INTO logs (locker_id, user_id, action) VALUES (?, ?, "wrong_pin")', [
      booking.locker_id,
      booking.user_id,
    ]);
    return res.status(401).json({ success: false, message: 'รหัส PIN ไม่ถูกต้อง' });
  }

  // TODO: ในระบบจริงจะยิง request ไปสั่งงานบอร์ด ESP32 ตรงนี้

  if (action === 'close') {
    // บันทึกเวลาสิ้นสุด เพื่อใช้คำนวณระยะเวลาที่เช่าไปทั้งหมด
    await db.query('UPDATE bookings SET status = "completed", completed_at = NOW() WHERE booking_id = ?', [booking_id]);
    await db.query('UPDATE lockers SET status = "available" WHERE locker_id = ?', [booking.locker_id]);
  }

  await db.query('INSERT INTO logs (locker_id, user_id, action) VALUES (?, ?, ?)', [
    booking.locker_id,
    booking.user_id,
    action,
  ]);

  res.json({ success: true, message: action === 'open' ? 'ปลดล็อกตู้สำเร็จ' : 'คืนตู้สำเร็จ' });
});

// ==================================================================
// ส่วนที่ 4: ระบบบันทึกและเรียกดูประวัติการใช้งาน (สำหรับ Admin)
// ==================================================================

app.get('/logs', async (req, res) => {
  const [rows] = await db.query(
    `SELECT lg.*, l.locker_number, u.firstname, u.lastname
     FROM logs lg
     JOIN lockers l ON lg.locker_id = l.locker_id
     JOIN users u ON lg.user_id = u.user_id
     ORDER BY lg.timestamp DESC`
  );
  res.json({ success: true, data: rows });
});

app.get('/dashboard', async (req, res) => {
  const [[summary]] = await db.query(`
    SELECT
      COUNT(*) AS total_lockers,
      SUM(status = 'available') AS available_lockers,
      SUM(status = 'unavailable') AS in_use_lockers,
      SUM(status = 'maintenance') AS maintenance_lockers
    FROM lockers
  `);
  res.json({ success: true, data: summary });
});

// ==================================================================
// ส่วนที่ 5: ระบบจัดการผู้ใช้งาน (Admin) — ตรวจสอบ/ระงับสิทธิ์
// ==================================================================

// ดูผู้ใช้งานทั้งหมด (ไม่ส่งรหัสผ่านกลับไปเด็ดขาด)
app.get('/users', async (req, res) => {
  const [rows] = await db.query(
    'SELECT user_id, username, firstname, lastname, role, status FROM users ORDER BY user_id'
  );
  res.json({ success: true, data: rows });
});

// ระงับ/คืนสิทธิ์ผู้ใช้งาน — body: { status: 'active' | 'suspended' }
app.put('/users/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['active', 'suspended'].includes(status)) {
    return res.status(400).json({ success: false, message: 'สถานะไม่ถูกต้อง' });
  }
  await db.query('UPDATE users SET status = ? WHERE user_id = ?', [status, req.params.id]);
  res.json({ success: true, message: status === 'suspended' ? 'ระงับสิทธิ์ผู้ใช้สำเร็จ' : 'คืนสิทธิ์ผู้ใช้สำเร็จ' });
});

// ==================================================================
// ส่วนที่ 6: จัดการสถานะตู้ (เปิด-ปิด/ซ่อมบำรุง) + รายงานสรุป (Admin)
// ==================================================================

// เปลี่ยนสถานะตู้ด้วยตัวเอง — body: { status: 'available' | 'unavailable' | 'maintenance' }
app.put('/lockers/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['available', 'unavailable', 'maintenance'].includes(status)) {
    return res.status(400).json({ success: false, message: 'สถานะไม่ถูกต้อง' });
  }
  const [result] = await db.query('UPDATE lockers SET status = ? WHERE locker_id = ?', [status, req.params.id]);
  if (result.affectedRows === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบตู้ล็อกเกอร์นี้' });
  }
  res.json({ success: true, message: 'อัปเดตสถานะตู้สำเร็จ' });
});

// รายงานสรุปจำนวนการใช้งาน แยกรายวัน หรือ รายเดือน
// query: /reports?period=daily  หรือ  /reports?period=monthly
app.get('/reports', async (req, res) => {
  const period = req.query.period === 'monthly' ? 'monthly' : 'daily';

  const dateFormat = period === 'monthly' ? '%Y-%m' : '%Y-%m-%d';

  const [rows] = await db.query(
    `SELECT
       DATE_FORMAT(timestamp, ?) AS period_label,
       SUM(action = 'book') AS bookings,
       SUM(action = 'open') AS opens,
       SUM(action = 'close') AS closes,
       SUM(action = 'wrong_pin') AS wrong_pins,
       COUNT(*) AS total_events
     FROM logs
     GROUP BY period_label
     ORDER BY period_label DESC
     LIMIT 30`,
    [dateFormat]
  );

  res.json({ success: true, period, data: rows });
});

// ------------------------------------------------------------------
// เริ่มรันเซิร์ฟเวอร์
// ------------------------------------------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Smart Storage Locker API กำลังทำงานที่ http://localhost:${PORT}`);
});
