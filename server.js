
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


// อ่านค่าคงที่ของระบบจากตาราง settings (ปรับได้จากหน้า Admin โดยไม่ต้องแก้โค้ด)
async function getSetting(key, fallback) {
  const result = await pool.query('SELECT setting_value FROM settings WHERE setting_key = $1', [key]);
  return result.rows.length ? parseFloat(result.rows[0].setting_value) : fallback;
}

// คำนวณค่าปรับ: ถ้าเวลาปัจจุบันเลย end_time ไปแล้ว คิดเป็นรายชั่วโมง (ปัดเศษขึ้น)
function calculateFee(endTimeStr, referenceDate, ratePerHour) {
  if (!endTimeStr) return 0;
  // แปลงรูปแบบวันที่ให้รองรับทั้งมาตรฐาน ISO และรูปแบบเดิม
  const endTime = new Date(endTimeStr.toString().replace(' ', 'T'));
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
// ส่วนที่ 2: ตู้ล็อกเกอร์ + ราคาตามขนาด (ราคาคงที่ กำหนดไว้ในฐานข้อมูลล่วงหน้า)
// ==================================================================

app.get('/lockers', async (req, res) => {
  const result = await pool.query(`
    SELECT l.*, p.price
    FROM lockers l LEFT JOIN pricing p ON l.size = p.size
    ORDER BY l.locker_number
  `);
  res.json({ success: true, data: result.rows });
});

app.get('/pricing', async (req, res) => {
  const result = await pool.query('SELECT * FROM pricing');
  res.json({ success: true, data: result.rows });
});


// Admin ปรับราคาตามขนาดตู้ — body: { price }
app.put('/pricing/:size', async (req, res) => {
  const { price } = req.body;
  if (!price || price < 0) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุราคาที่ถูกต้อง' });
  }
  await pool.query('UPDATE pricing SET price = $1 WHERE size = $2', [price, req.params.size]);
  res.json({ success: true, message: 'อัปเดตราคาสำเร็จ' });
});

app.get('/settings', async (req, res) => {
  const result = await pool.query('SELECT * FROM settings');
  const data = {};
  result.rows.forEach(r => { data[r.setting_key] = parseFloat(r.setting_value); });
  res.json({ success: true, data });
});

// Admin ปรับค่าปรับ/ชม. หรือระยะเวลามาตรฐาน — body: { key, value }
app.put('/settings', async (req, res) => {
  const { key, value } = req.body;
  if (!['late_fee_per_hour', 'standard_duration_hours'].includes(key) || value === undefined) {
    return res.status(400).json({ success: false, message: 'ข้อมูลไม่ถูกต้อง' });
  }
  // PostgreSQL ใช้ ON CONFLICT แทน ON DUPLICATE KEY UPDATE
  await pool.query(
    `INSERT INTO settings (setting_key, setting_value) VALUES ($1, $2)
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2`,
    [key, value]
  );
  res.json({ success: true, message: 'อัปเดตค่าคงที่สำเร็จ' });
});


function generateRefCode() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `SL-${timestamp}-${random}`;
}

app.post('/payment-sessions', async (req, res) => {
  const { user_id, locker_id } = req.body;

  const lockerResult = await pool.query(
    `SELECT l.*, p.price FROM lockers l LEFT JOIN pricing p ON l.size = p.size WHERE l.locker_id = $1`,
    [locker_id]
  );
  if (lockerResult.rows.length === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบตู้ล็อกเกอร์นี้' });
  }
  const locker = lockerResult.rows[0];
  if (locker.status !== 'available') {
    return res.status(400).json({ success: false, message: 'ตู้นี้ไม่ว่าง หรืออยู่ระหว่างซ่อมบำรุง' });
  }

  const amount = parseFloat(locker.price) || 0;
  const refCode = generateRefCode();

  const result = await pool.query(
    `INSERT INTO payment_sessions (user_id, locker_id, amount, ref_code, status)
     VALUES ($1, $2, $3, $4, 'pending') RETURNING session_id`,
    [user_id, locker_id, amount, refCode]
  );

  const qrPayload = `SMARTLOCKER-PAY|REF:${refCode}|LOCKER:${locker.locker_number}|AMOUNT:${amount.toFixed(2)}`;

  res.json({
    success: true,
    session_id: result.rows[0].session_id,
    ref_code: refCode,
    amount,
    qr_payload: qrPayload,
    locker_number: locker.locker_number,
    locker_size: locker.size,
  });
});

app.put('/payment-sessions/:id/cancel', async (req, res) => {
  await pool.query(
    `UPDATE payment_sessions SET status = 'cancelled' WHERE session_id = $1 AND status = 'pending'`,
    [req.params.id]
  );
  res.json({ success: true, message: 'ยกเลิกรายการชำระเงินแล้ว' });
});

app.post('/payment-sessions/:id/confirm', async (req, res) => {
  const sessionResult = await pool.query('SELECT * FROM payment_sessions WHERE session_id = $1', [req.params.id]);
  if (sessionResult.rows.length === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบรายการชำระเงินนี้' });
  }
  const session = sessionResult.rows[0];
  if (session.status !== 'pending') {
    return res.status(400).json({ success: false, message: 'รายการชำระเงินนี้ถูกใช้ไปแล้วหรือถูกยกเลิก' });
  }

  const lockerResult = await pool.query('SELECT * FROM lockers WHERE locker_id = $1', [session.locker_id]);
  if (lockerResult.rows.length === 0 || lockerResult.rows[0].status !== 'available') {
    return res.status(400).json({ success: false, message: 'ขออภัย ตู้นี้ถูกจองไปแล้วระหว่างที่คุณกำลังชำระเงิน' });
  }

  const pinCode = Math.floor(100000 + Math.random() * 900000).toString();

  // ฝากได้ไม่จำกัดเวลา จึงไม่ตั้ง end_time และไม่มีค่าปรับ
  const bookingResult = await pool.query(
    `INSERT INTO bookings (user_id, locker_id, pin_code, price, payment_status, status)
     VALUES ($1, $2, $3, $4, 'paid', 'active') RETURNING booking_id`,
    [session.user_id, session.locker_id, pinCode, session.amount]
  );

  await pool.query('UPDATE lockers SET status = $1 WHERE locker_id = $2', ['unavailable', session.locker_id]);
  await pool.query(`UPDATE payment_sessions SET status = 'paid' WHERE session_id = $1`, [req.params.id]);
  await pool.query('INSERT INTO logs (locker_id, user_id, action) VALUES ($1, $2, $3)', [session.locker_id, session.user_id, 'payment']);
  await pool.query('INSERT INTO logs (locker_id, user_id, action) VALUES ($1, $2, $3)', [session.locker_id, session.user_id, 'book']);

  res.json({
    success: true, message: 'ชำระเงินสำเร็จ จองตู้เรียบร้อยแล้ว',
    booking_id: bookingResult.rows[0].booking_id, pin_code: pinCode, price: session.amount,
  });
});

// ดูรายการจองของผู้ใช้คนหนึ่ง (แสดงระยะเวลาที่ฝากไปแล้ว ไม่มีค่าปรับ ไม่มีกำหนดคืน)
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

app.post('/lockers/:id/emergency-unlock', async (req, res) => {
  const lockerId = req.params.id;

  const lockerResult = await pool.query('SELECT * FROM lockers WHERE locker_id = $1', [lockerId]);
  if (lockerResult.rows.length === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบตู้ล็อกเกอร์นี้' });
  }

  const activeBookings = await pool.query(
    'SELECT * FROM bookings WHERE locker_id = $1 AND status = $2', [lockerId, 'active']
  );

  if (activeBookings.rows.length > 0) {
    const booking = activeBookings.rows[0];
    await pool.query('UPDATE bookings SET status = $1, completed_at = NOW() WHERE booking_id = $2', ['completed', booking.booking_id]);
    await pool.query('INSERT INTO logs (locker_id, user_id, action) VALUES ($1, $2, $3)', [lockerId, booking.user_id, 'emergency_open']);
  } else {
    const adminUserId = req.body.admin_user_id || null;
    if (adminUserId) {
      await pool.query('INSERT INTO logs (locker_id, user_id, action) VALUES ($1, $2, $3)', [lockerId, adminUserId, 'emergency_open']);
    }
  }

  await pool.query('UPDATE lockers SET status = $1 WHERE locker_id = $2', ['available', lockerId]);
  res.json({ success: true, message: 'ปลดล็อกตู้ฉุกเฉินสำเร็จ ตู้กลับเป็นสถานะว่างแล้ว' });
});

// ==================================================================
// ส่วนที่ 8: รายงานสถิติ — รายวัน/รายเดือน/รายปี + รายได้รวม + อัตราการใช้ตู้
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

  // รายได้จากค่าบริการ (นับตอนจอง — ไม่มีค่าปรับแล้วเพราะฝากได้ไม่จำกัดเวลา)
  const priceResult = await pool.query(
    `SELECT TO_CHAR(created_at, $1) AS period_label, SUM(price) AS total_price
     FROM bookings WHERE payment_status = 'paid' GROUP BY period_label`,
    [pgDateFormat]
  );
  const priceMap = {}; priceResult.rows.forEach(r => { priceMap[r.period_label] = parseFloat(r.total_price) || 0; });

  const lockerCountResult = await pool.query('SELECT COUNT(*) AS total_lockers FROM lockers');
  const total_lockers = parseInt(lockerCountResult.rows[0].total_lockers) || 0;

  const data = logResult.rows.map(r => {
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