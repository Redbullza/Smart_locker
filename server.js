/**
 * ==================================================================
 *  SMART STORAGE LOCKER - BACKEND (เวอร์ชันไฟล์เดียว อธิบายง่าย)
 * ==================================================================
 *  User Role-1 ผู้ใช้งาน:
 *    1. ลงทะเบียน/เข้าสู่ระบบ         -> /register, /login
 *    2. ดูสถานะตู้ (ขนาด+ราคา)        -> /lockers, /pricing
 *    3. จองตู้ + ชำระเงินด้วย QR      -> /payment-sessions, /payment-sessions/:id/confirm
 *    4. ปลดล็อกตู้ (รหัสสุ่ม)          -> /verify-pin
 *    5. ดูประวัติ/ระยะเวลาที่ฝาก      -> /my-bookings (ไม่จำกัดเวลา ไม่มีค่าปรับ)
 *
 *  User Role-2 ผู้ดูแลระบบ (Admin):
 *    1. จัดการผู้ใช้งาน               -> /users
 *    2. จัดการสถานะตู้ + ปล่อยตู้ค้าง  -> /lockers/:id, /bookings/:id/release
 *    3. รายงานสถิติ (วัน/เดือน/ปี)     -> /reports
 *    4. Log ความปลอดภัย               -> /logs
 * ==================================================================
 */

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
  dateStrings: true,
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
// ส่วนที่ 2: ตู้ล็อกเกอร์ + ราคาตามขนาด (ราคาคงที่ กำหนดไว้ในฐานข้อมูลล่วงหน้า)
// ==================================================================

app.get('/lockers', async (req, res) => {
  const [lockers] = await db.query(`
    SELECT l.*, p.price
    FROM lockers l LEFT JOIN pricing p ON l.size = p.size
    ORDER BY l.locker_number
  `);
  res.json({ success: true, data: lockers });
});

app.get('/pricing', async (req, res) => {
  const [rows] = await db.query('SELECT * FROM pricing');
  res.json({ success: true, data: rows });
});

// ==================================================================
// ส่วนที่ 3: จองตู้ + ชำระเงินด้วย QR (จำลอง)
// ==================================================================
// Flow: 1) POST /payment-sessions สร้าง QR ใหม่ทุกครั้ง (ref_code สุ่มไม่ซ้ำ)
//       2) ผู้ใช้ "สแกน" แล้วกด POST /payment-sessions/:id/confirm เพื่อยืนยันจ่ายเงินจริง
//          ตอนนั้นระบบถึงจะสร้างรายการจองจริงและสุ่มรหัส PIN ให้
// หมายเหตุ: ฝากได้ไม่จำกัดเวลา ไม่มีค่าปรับ ไม่มีเวลาครบกำหนด

function generateRefCode() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `SL-${timestamp}-${random}`;
}

app.post('/payment-sessions', async (req, res) => {
  const { user_id, locker_id } = req.body;

  const [lockerRows] = await db.query(
    `SELECT l.*, p.price FROM lockers l LEFT JOIN pricing p ON l.size = p.size WHERE l.locker_id = ?`,
    [locker_id]
  );
  if (lockerRows.length === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบตู้ล็อกเกอร์นี้' });
  }
  const locker = lockerRows[0];
  if (locker.status !== 'available') {
    return res.status(400).json({ success: false, message: 'ตู้นี้ไม่ว่าง หรืออยู่ระหว่างซ่อมบำรุง' });
  }

  const amount = parseFloat(locker.price) || 0;
  const refCode = generateRefCode();

  const [result] = await db.query(
    `INSERT INTO payment_sessions (user_id, locker_id, amount, ref_code, status) VALUES (?, ?, ?, ?, 'pending')`,
    [user_id, locker_id, amount, refCode]
  );

  const qrPayload = `SMARTLOCKER-PAY|REF:${refCode}|LOCKER:${locker.locker_number}|AMOUNT:${amount.toFixed(2)}`;

  res.json({
    success: true,
    session_id: result.insertId,
    ref_code: refCode,
    amount,
    qr_payload: qrPayload,
    locker_number: locker.locker_number,
    locker_size: locker.size,
  });
});

app.put('/payment-sessions/:id/cancel', async (req, res) => {
  await db.query(`UPDATE payment_sessions SET status = 'cancelled' WHERE session_id = ? AND status = 'pending'`, [req.params.id]);
  res.json({ success: true, message: 'ยกเลิกรายการชำระเงินแล้ว' });
});

app.post('/payment-sessions/:id/confirm', async (req, res) => {
  const [sessionRows] = await db.query('SELECT * FROM payment_sessions WHERE session_id = ?', [req.params.id]);
  if (sessionRows.length === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบรายการชำระเงินนี้' });
  }
  const session = sessionRows[0];
  if (session.status !== 'pending') {
    return res.status(400).json({ success: false, message: 'รายการชำระเงินนี้ถูกใช้ไปแล้วหรือถูกยกเลิก' });
  }

  const [lockerRows] = await db.query('SELECT * FROM lockers WHERE locker_id = ?', [session.locker_id]);
  if (lockerRows.length === 0 || lockerRows[0].status !== 'available') {
    return res.status(400).json({ success: false, message: 'ขออภัย ตู้นี้ถูกจองไปแล้วระหว่างที่คุณกำลังชำระเงิน' });
  }

  const pinCode = Math.floor(100000 + Math.random() * 900000).toString();

  // ฝากได้ไม่จำกัดเวลา จึงไม่ตั้ง end_time และไม่มีค่าปรับ
  const [result] = await db.query(
    `INSERT INTO bookings (user_id, locker_id, pin_code, price, payment_status, status)
     VALUES (?, ?, ?, ?, 'paid', 'active')`,
    [session.user_id, session.locker_id, pinCode, session.amount]
  );
  await db.query('UPDATE lockers SET status = "unavailable" WHERE locker_id = ?', [session.locker_id]);
  await db.query(`UPDATE payment_sessions SET status = 'paid' WHERE session_id = ?`, [req.params.id]);
  await db.query('INSERT INTO logs (locker_id, user_id, action) VALUES (?, ?, "payment")', [session.locker_id, session.user_id]);
  await db.query('INSERT INTO logs (locker_id, user_id, action) VALUES (?, ?, "book")', [session.locker_id, session.user_id]);

  res.json({
    success: true, message: 'ชำระเงินสำเร็จ จองตู้เรียบร้อยแล้ว',
    booking_id: result.insertId, pin_code: pinCode, price: session.amount,
  });
});

// ดูรายการจองของผู้ใช้คนหนึ่ง (แสดงระยะเวลาที่ฝากไปแล้ว ไม่มีค่าปรับ ไม่มีกำหนดคืน)
app.get('/my-bookings', async (req, res) => {
  const { user_id } = req.query;
  const [rows] = await db.query(
    `SELECT b.*, l.locker_number, l.location, l.size
     FROM bookings b JOIN lockers l ON b.locker_id = l.locker_id
     WHERE b.user_id = ? ORDER BY b.created_at DESC`,
    [user_id]
  );
  res.json({ success: true, data: rows });
});

// ==================================================================
// ส่วนที่ 4: ตรวจสอบรหัส PIN + ควบคุมการเปิด/ปิดตู้
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
      booking.locker_id, booking.user_id,
    ]);
    return res.status(401).json({ success: false, message: 'รหัส PIN ไม่ถูกต้อง' });
  }

  // TODO: ในระบบจริงจะยิง request ไปสั่งงานบอร์ด ESP32 ตรงนี้

  if (action === 'close') {
    await db.query('UPDATE bookings SET status = "completed", completed_at = NOW() WHERE booking_id = ?', [booking_id]);
    await db.query('UPDATE lockers SET status = "available" WHERE locker_id = ?', [booking.locker_id]);
  }

  await db.query('INSERT INTO logs (locker_id, user_id, action) VALUES (?, ?, ?)', [
    booking.locker_id, booking.user_id, action,
  ]);

  res.json({ success: true, message: action === 'open' ? 'ปลดล็อกตู้สำเร็จ' : 'คืนตู้สำเร็จ' });
});

// ==================================================================
// ส่วนที่ 5: ประวัติการใช้งาน (Admin)
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

// รายการจองทั้งหมด (Admin) — ใช้ปล่อยตู้ที่ไม่มีคนมาใช้งานได้
app.get('/bookings', async (req, res) => {
  const [rows] = await db.query(
    `SELECT b.*, l.locker_number, u.username, u.firstname, u.lastname
     FROM bookings b
     JOIN lockers l ON b.locker_id = l.locker_id
     JOIN users u ON b.user_id = u.user_id
     ORDER BY b.created_at DESC
     LIMIT 100`
  );
  res.json({ success: true, data: rows });
});

// Admin ปล่อยตู้ที่จองไว้แต่ไม่มาใช้งาน คืนสิทธิ์ให้คนอื่นจองต่อได้
app.put('/bookings/:id/release', async (req, res) => {
  const [rows] = await db.query('SELECT * FROM bookings WHERE booking_id = ?', [req.params.id]);
  if (rows.length === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบรายการจองนี้' });
  }
  const booking = rows[0];
  if (booking.status !== 'active') {
    return res.status(400).json({ success: false, message: 'รายการจองนี้ไม่ได้อยู่ในสถานะใช้งาน' });
  }

  await db.query('UPDATE bookings SET status = "cancelled", completed_at = NOW() WHERE booking_id = ?', [req.params.id]);
  await db.query('UPDATE lockers SET status = "available" WHERE locker_id = ?', [booking.locker_id]);
  await db.query('INSERT INTO logs (locker_id, user_id, action) VALUES (?, ?, "admin_release")', [
    booking.locker_id, booking.user_id,
  ]);

  res.json({ success: true, message: 'ปล่อยตู้สำเร็จ คืนสิทธิ์ให้ผู้อื่นจองต่อได้แล้ว' });
});

// ==================================================================
// ส่วนที่ 6: จัดการผู้ใช้งาน (Admin)
// ==================================================================

app.get('/users', async (req, res) => {
  const [rows] = await db.query(
    'SELECT user_id, username, firstname, lastname, role, status FROM users ORDER BY user_id'
  );
  res.json({ success: true, data: rows });
});

app.put('/users/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['active', 'suspended'].includes(status)) {
    return res.status(400).json({ success: false, message: 'สถานะไม่ถูกต้อง' });
  }
  await db.query('UPDATE users SET status = ? WHERE user_id = ?', [status, req.params.id]);
  res.json({ success: true, message: status === 'suspended' ? 'ระงับสิทธิ์ผู้ใช้สำเร็จ' : 'คืนสิทธิ์ผู้ใช้สำเร็จ' });
});

// ==================================================================
// ส่วนที่ 7: จัดการตู้ล็อกเกอร์ (เปิด/ปิด/ซ่อมบำรุง/ขนาด) — Admin
// ==================================================================

app.put('/lockers/:id', async (req, res) => {
  const { status, size } = req.body;
  const fields = [];
  const values = [];

  if (status) {
    if (!['available', 'unavailable', 'maintenance'].includes(status)) {
      return res.status(400).json({ success: false, message: 'สถานะไม่ถูกต้อง' });
    }
    fields.push('status = ?'); values.push(status);
  }
  if (size) {
    if (!['small', 'medium', 'large'].includes(size)) {
      return res.status(400).json({ success: false, message: 'ขนาดไม่ถูกต้อง' });
    }
    fields.push('size = ?'); values.push(size);
  }
  if (fields.length === 0) {
    return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลให้อัปเดต' });
  }

  values.push(req.params.id);
  const [result] = await db.query(`UPDATE lockers SET ${fields.join(', ')} WHERE locker_id = ?`, values);
  if (result.affectedRows === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบตู้ล็อกเกอร์นี้' });
  }
  res.json({ success: true, message: 'อัปเดตตู้ล็อกเกอร์สำเร็จ' });
});

// ==================================================================
// ส่วนที่ 8: รายงานสถิติ — รายวัน/รายเดือน/รายปี + รายได้รวม + อัตราการใช้ตู้
// ==================================================================

app.get('/reports', async (req, res) => {
  const period = ['daily', 'monthly', 'yearly'].includes(req.query.period) ? req.query.period : 'daily';
  const dateFormat = period === 'yearly' ? '%Y' : period === 'monthly' ? '%Y-%m' : '%Y-%m-%d';

  const [logRows] = await db.query(
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

  // รายได้จากค่าบริการ (นับตอนจอง — ไม่มีค่าปรับแล้วเพราะฝากได้ไม่จำกัดเวลา)
  const [priceRows] = await db.query(
    `SELECT DATE_FORMAT(created_at, ?) AS period_label, SUM(price) AS total_price
     FROM bookings WHERE payment_status = 'paid' GROUP BY period_label`,
    [dateFormat]
  );
  const priceMap = {}; priceRows.forEach(r => { priceMap[r.period_label] = parseFloat(r.total_price) || 0; });

  const [[{ total_lockers }]] = await db.query('SELECT COUNT(*) AS total_lockers FROM lockers');

  const data = logRows.map(r => {
    const totalRevenue = priceMap[r.period_label] || 0;
    const utilizationRate = total_lockers > 0 ? Math.round((r.bookings / total_lockers) * 100) : 0;
    return { ...r, total_revenue: totalRevenue, utilization_rate: utilizationRate };
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
