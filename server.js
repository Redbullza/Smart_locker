const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
app.use(express.json()); 
app.use(express.static('public')); 
// เข้าหน้าเว็บได้ที่ http://localhost:5000/ 

const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'smart_locker',
});


// สมัครสมาชิก
app.post('/register', async (req, res) => {
  const { username, password, firstname, lastname } = req.body;

  if (!username || !password || !firstname || !lastname) {
    return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบ' });
  }

  // เข้ารหัสรหัสผ่านก่อนเก็บลงฐานข้อมูล (ห้ามเก็บรหัสผ่านตัวเปล่า)
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

app.get('/lockers', async (req, res) => {
  const [lockers] = await db.query('SELECT * FROM lockers ORDER BY locker_number');
  res.json({ success: true, data: lockers });
});

// จองตู้ 1 ช่อง แล้วระบบจะสุ่มรหัส PIN ให้อัตโนมัติ
app.post('/booking', async (req, res) => {
  const { user_id, locker_id } = req.body;

  //  ตรวจสอบว่าตู้ว่างจริงหรือไม่
  const [lockerRows] = await db.query('SELECT * FROM lockers WHERE locker_id = ?', [locker_id]);
  if (lockerRows.length === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบตู้ล็อกเกอร์นี้' });
  }
  if (lockerRows[0].status !== 'available') {
    return res.status(400).json({ success: false, message: 'ตู้นี้ไม่ว่างแล้ว' });
  }

  //  สุ่มรหัส PIN 6 หลัก สำหรับใช้เปิด-ปิดตู้
  const pinCode = Math.floor(100000 + Math.random() * 900000).toString();

  //  บันทึกการจอง และเปลี่ยนสถานะตู้เป็น "ไม่ว่าง"
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
    pin_code: pinCode, // ส่งรหัส PIN กลับไปแสดงในแอปพลิเคชันของผู้ใช้
  });
});

// ดูรายการจองของผู้ใช้คนหนึ่ง 
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


// ผู้ใช้กรอกรหัส PIN เพื่อเปิดตู้ฝากของ หรือเปิดตู้เอาของออก
app.post('/verify-pin', async (req, res) => {
  const { booking_id, pin_code, action } = req.body; // action = "open" หรือ "close"

  const [rows] = await db.query('SELECT * FROM bookings WHERE booking_id = ?', [booking_id]);
  if (rows.length === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบรายการจองนี้' });
  }
  const booking = rows[0];

  // ตรวจสอบรหัส PIN ว่าตรงกันหรือไม่
  if (booking.pin_code !== pin_code) {
    // บันทึก log ไว้เผื่อมีการกรอกรหัสผิดหลายครั้ง (พฤติกรรมผิดปกติ)
    await db.query('INSERT INTO logs (locker_id, user_id, action) VALUES (?, ?, "wrong_pin")', [
      booking.locker_id,
      booking.user_id,
    ]);
    return res.status(401).json({ success: false, message: 'รหัส PIN ไม่ถูกต้อง' });
  }

  // ถ้าเป็นการ "close" หมายถึงผู้ใช้เอาของออกและคืนตู้แล้ว -> ปิดการจอง + ตู้กลับมาว่าง
  if (action === 'close') {
    await db.query('UPDATE bookings SET status = "completed" WHERE booking_id = ?', [booking_id]);
    await db.query('UPDATE lockers SET status = "available" WHERE locker_id = ?', [booking.locker_id]);
  }

  // บันทึกประวัติการใช้งาน (Log Activity)
  await db.query('INSERT INTO logs (locker_id, user_id, action) VALUES (?, ?, ?)', [
    booking.locker_id,
    booking.user_id,
    action,
  ]);

  res.json({ success: true, message: action === 'open' ? 'ปลดล็อกตู้สำเร็จ' : 'คืนตู้สำเร็จ' });
});


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

// สรุปข้อมูลภาพรวมสำหรับหน้า Dashboard ของ Admin (ตามภาพที่ 4.9)
app.get('/dashboard', async (req, res) => {
  const [[summary]] = await db.query(`
    SELECT
      COUNT(*) AS total_lockers,
      SUM(status = 'available') AS available_lockers,
      SUM(status = 'unavailable') AS in_use_lockers
    FROM lockers
  `);
  res.json({ success: true, data: summary });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Smart Storage Locker API กำลังทำงานที่ http://localhost:${PORT}`);
});
