/**
 * ==================================================================
 *  SMART STORAGE LOCKER - BACKEND (เวอร์ชันไฟล์เดียว อธิบายง่าย)
 * ==================================================================
 *  User Role-1 ผู้ใช้งาน:
 *    1. ลงทะเบียน/เข้าสู่ระบบ         -> /register, /login
 *    2. ดูสถานะตู้ (ขนาด+ราคา)        -> /lockers, /pricing
 *    3. จองตู้ + ชำระเงินจำลอง         -> /booking
 *    4. ปลดล็อกตู้ (รหัสสุ่ม)          -> /verify-pin
 *    5. แจ้งเตือน 2ชม. + คิดค่าปรับ    -> คำนวณใน /my-bookings, /verify-pin
 *    6. ดูประวัติ/ระยะเวลาที่เช่า      -> /my-bookings
 *
 *  User Role-2 ผู้ดูแลระบบ (Admin):
 *    1. จัดการผู้ใช้งาน               -> /users
 *    2. จัดการสถานะตู้ + ปล่อยตู้ค้าง  -> /lockers/:id, /bookings/:id/release
 *    3. ปลดล็อกฉุกเฉิน                -> /lockers/:id/emergency-unlock
 *    4. จัดการราคา/ค่าปรับ            -> /pricing/:size, /settings
 *    5. รายงานสถิติ (วัน/เดือน/ปี)     -> /reports
 *    6. Log ความปลอดภัย               -> /logs
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

// อ่านค่าคงที่ของระบบจากตาราง settings (ปรับได้จากหน้า Admin โดยไม่ต้องแก้โค้ด)
async function getSetting(key, fallback) {
  const [rows] = await db.query('SELECT setting_value FROM settings WHERE setting_key = ?', [key]);
  return rows.length ? parseFloat(rows[0].setting_value) : fallback;
}

// คำนวณค่าปรับ: ถ้าเวลาปัจจุบันเลย end_time ไปแล้ว คิดเป็นรายชั่วโมง (ปัดเศษขึ้น)
function calculateFee(endTimeStr, referenceDate, ratePerHour) {
  if (!endTimeStr) return 0;
  const endTime = new Date(endTimeStr.replace(' ', 'T'));
  const diffMs = referenceDate.getTime() - endTime.getTime();
  if (diffMs <= 0) return 0;
  const overdueHours = Math.ceil(diffMs / (60 * 60 * 1000));
  return overdueHours * ratePerHour;
}

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
// ส่วนที่ 2: ตู้ล็อกเกอร์ + ราคาตามขนาด
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

// Admin ปรับราคาตามขนาดตู้ — body: { price }
app.put('/pricing/:size', async (req, res) => {
  const { price } = req.body;
  if (!price || price < 0) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุราคาที่ถูกต้อง' });
  }
  await db.query('UPDATE pricing SET price = ? WHERE size = ?', [price, req.params.size]);
  res.json({ success: true, message: 'อัปเดตราคาสำเร็จ' });
});

app.get('/settings', async (req, res) => {
  const [rows] = await db.query('SELECT * FROM settings');
  const data = {};
  rows.forEach(r => { data[r.setting_key] = parseFloat(r.setting_value); });
  res.json({ success: true, data });
});

// Admin ปรับค่าปรับ/ชม. หรือระยะเวลามาตรฐาน — body: { key, value }
app.put('/settings', async (req, res) => {
  const { key, value } = req.body;
  if (!['late_fee_per_hour', 'standard_duration_hours'].includes(key) || value === undefined) {
    return res.status(400).json({ success: false, message: 'ข้อมูลไม่ถูกต้อง' });
  }
  await db.query(
    'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
    [key, value, value]
  );
  res.json({ success: true, message: 'อัปเดตค่าคงที่สำเร็จ' });
});

// ==================================================================
// ส่วนที่ 3: จองตู้ + ชำระเงินจำลอง (มาตรฐาน 2 ชม. ตาม settings)
// ==================================================================

// body: { user_id, locker_id }  — ระยะเวลาและราคาคำนวณจากระบบเอง ไม่ต้องกรอก
app.post('/booking', async (req, res) => {
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

  const standardHours = await getSetting('standard_duration_hours', 2);
  const price = parseFloat(locker.price) || 0;
  const pinCode = Math.floor(100000 + Math.random() * 900000).toString();

  // จำลองการชำระเงิน: กดจองปุ๊บถือว่าจ่ายเงินสำเร็จทันที (payment_status = 'paid')
  const [result] = await db.query(
    `INSERT INTO bookings (user_id, locker_id, pin_code, duration_hours, price, payment_status, end_time, status)
     VALUES (?, ?, ?, ?, ?, 'paid', DATE_ADD(NOW(), INTERVAL ? HOUR), 'active')`,
    [user_id, locker_id, pinCode, standardHours, price, standardHours]
  );
  await db.query('UPDATE lockers SET status = "unavailable" WHERE locker_id = ?', [locker_id]);
  await db.query('INSERT INTO logs (locker_id, user_id, action) VALUES (?, ?, "book")', [locker_id, user_id]);
  await db.query('INSERT INTO logs (locker_id, user_id, action) VALUES (?, ?, "payment")', [locker_id, user_id]);

  const [[booking]] = await db.query('SELECT end_time FROM bookings WHERE booking_id = ?', [result.insertId]);

  res.json({
    success: true, message: 'จองตู้และชำระเงินสำเร็จ',
    booking_id: result.insertId, pin_code: pinCode,
    duration_hours: standardHours, price, end_time: booking.end_time,
  });
});

// ดูรายการจองของผู้ใช้คนหนึ่ง พร้อมคำนวณค่าปรับปัจจุบันให้เลย
app.get('/my-bookings', async (req, res) => {
  const { user_id } = req.query;
  const [rows] = await db.query(
    `SELECT b.*, l.locker_number, l.location, l.size
     FROM bookings b JOIN lockers l ON b.locker_id = l.locker_id
     WHERE b.user_id = ? ORDER BY b.created_at DESC`,
    [user_id]
  );

  const rate = await getSetting('late_fee_per_hour', 10);
  const now = new Date();
  const data = rows.map(b => {
    if (b.status === 'active') {
      const currentFee = calculateFee(b.end_time, now, rate);
      return { ...b, is_overdue: currentFee > 0, current_fee: currentFee };
    }
    return { ...b, is_overdue: false, current_fee: 0 };
  });

  res.json({ success: true, data });
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

  let fee = 0;
  if (action === 'close') {
    const rate = await getSetting('late_fee_per_hour', 10);
    const now = new Date();
    fee = calculateFee(booking.end_time, now, rate);

    await db.query(
      'UPDATE bookings SET status = "completed", completed_at = NOW(), fee = ? WHERE booking_id = ?',
      [fee, booking_id]
    );
    await db.query('UPDATE lockers SET status = "available" WHERE locker_id = ?', [booking.locker_id]);
  }

  await db.query('INSERT INTO logs (locker_id, user_id, action) VALUES (?, ?, ?)', [
    booking.locker_id, booking.user_id, action,
  ]);

  res.json({ success: true, message: action === 'open' ? 'ปลดล็อกตู้สำเร็จ' : 'คืนตู้สำเร็จ', fee });
});

// ==================================================================
// ส่วนที่ 5: ประวัติการใช้งาน + รายการเกินเวลา (Admin)
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

app.get('/overdue-bookings', async (req, res) => {
  const [rows] = await db.query(
    `SELECT b.*, l.locker_number, l.location, u.username, u.firstname, u.lastname
     FROM bookings b
     JOIN lockers l ON b.locker_id = l.locker_id
     JOIN users u ON b.user_id = u.user_id
     WHERE b.status = 'active' AND b.end_time < NOW()
     ORDER BY b.end_time ASC`
  );
  const rate = await getSetting('late_fee_per_hour', 10);
  const now = new Date();
  const data = rows.map(b => ({ ...b, current_fee: calculateFee(b.end_time, now, rate) }));
  res.json({ success: true, data });
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
// ส่วนที่ 7: จัดการตู้ล็อกเกอร์ + ปลดล็อกฉุกเฉิน (Admin)
// ==================================================================

// body: { status?, size? } — แก้ได้ทีละอย่างหรือพร้อมกัน
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

// ปลดล็อกตู้ฉุกเฉิน กรณีตู้ขัดข้อง — ไม่ต้องใช้ PIN, ปิดรายการจองที่ค้างอยู่ให้อัตโนมัติ (ไม่คิดค่าปรับ)
app.post('/lockers/:id/emergency-unlock', async (req, res) => {
  const lockerId = req.params.id;

  const [lockerRows] = await db.query('SELECT * FROM lockers WHERE locker_id = ?', [lockerId]);
  if (lockerRows.length === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบตู้ล็อกเกอร์นี้' });
  }

  const [activeBookings] = await db.query(
    'SELECT * FROM bookings WHERE locker_id = ? AND status = "active"', [lockerId]
  );

  if (activeBookings.length > 0) {
    const booking = activeBookings[0];
    // ปลดล็อกฉุกเฉิน ไม่คิดค่าปรับ (fee = 0) เพราะเป็นความผิดของระบบ ไม่ใช่ผู้ใช้
    await db.query('UPDATE bookings SET status = "completed", completed_at = NOW(), fee = 0 WHERE booking_id = ?', [booking.booking_id]);
    await db.query('INSERT INTO logs (locker_id, user_id, action) VALUES (?, ?, "emergency_open")', [lockerId, booking.user_id]);
  } else {
    // ไม่มีการจองค้าง แต่ admin เป็นคนสั่งปลดล็อก บันทึก log โดยใช้ user_id ของ admin เอง (ถ้าส่งมา)
    const adminUserId = req.body.admin_user_id || null;
    if (adminUserId) {
      await db.query('INSERT INTO logs (locker_id, user_id, action) VALUES (?, ?, "emergency_open")', [lockerId, adminUserId]);
    }
  }

  await db.query('UPDATE lockers SET status = "available" WHERE locker_id = ?', [lockerId]);
  res.json({ success: true, message: 'ปลดล็อกตู้ฉุกเฉินสำเร็จ ตู้กลับเป็นสถานะว่างแล้ว' });
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

  // รายได้จากค่าบริการ (นับตอนจอง) + ค่าปรับ (นับตอนคืนตู้)
  const [priceRows] = await db.query(
    `SELECT DATE_FORMAT(created_at, ?) AS period_label, SUM(price) AS total_price
     FROM bookings WHERE payment_status = 'paid' GROUP BY period_label`,
    [dateFormat]
  );
  const [feeRows] = await db.query(
    `SELECT DATE_FORMAT(completed_at, ?) AS period_label, SUM(fee) AS total_fees
     FROM bookings WHERE completed_at IS NOT NULL GROUP BY period_label`,
    [dateFormat]
  );

  const priceMap = {}; priceRows.forEach(r => { priceMap[r.period_label] = parseFloat(r.total_price) || 0; });
  const feeMap = {}; feeRows.forEach(r => { feeMap[r.period_label] = parseFloat(r.total_fees) || 0; });

  const [[{ total_lockers }]] = await db.query('SELECT COUNT(*) AS total_lockers FROM lockers');

  const data = logRows.map(r => {
    const totalPrice = priceMap[r.period_label] || 0;
    const totalFees = feeMap[r.period_label] || 0;
    // อัตราการใช้ตู้แบบง่าย: จำนวนครั้งที่จองในช่วงนั้น เทียบกับจำนวนตู้ทั้งหมด (%)
    const utilizationRate = total_lockers > 0 ? Math.round((r.bookings / total_lockers) * 100) : 0;
    return {
      ...r,
      total_price: totalPrice,
      total_fees: totalFees,
      total_revenue: totalPrice + totalFees,
      utilization_rate: utilizationRate,
    };
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
