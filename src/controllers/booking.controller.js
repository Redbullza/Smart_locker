const pool = require('../config/db');

// ==================================================================
// ส่วนที่ 3: จองตู้ล็อกเกอร์ (ฟรี ไม่มีขั้นตอนชำระเงิน)
// ผู้ใช้เลือก "ระยะเวลาที่ตั้งใจฝาก" เองตอนจอง (planned_hours) — เก็บไว้แสดงผล/อ้างอิงเท่านั้น
// ไม่มีการคิดค่าปรับหากคืนช้ากว่าที่เลือกไว้ และไม่มีการ fix เวลาตายตัว (เช่น บล็อกละ 2 ชม.)
// ==================================================================

async function finalizeBooking({ user_id, locker_id, planned_hours = null }) {
  const pinCode = Math.floor(100000 + Math.random() * 900000).toString();

  const bookingResult = await pool.query(
    `INSERT INTO bookings (user_id, locker_id, pin_code, planned_hours, status)
     VALUES ($1, $2, $3, $4, 'active') RETURNING booking_id`,
    [user_id, locker_id, pinCode, planned_hours]
  );

  await pool.query('UPDATE lockers SET status = $1 WHERE locker_id = $2', ['unavailable', locker_id]);
  await pool.query('INSERT INTO logs (locker_id, user_id, action) VALUES ($1, $2, $3)', [locker_id, user_id, 'book']);

  return { booking_id: bookingResult.rows[0].booking_id, pin_code: pinCode };
}

async function createBooking(req, res) {
  const { user_id, locker_id, hours } = req.body;
  if (!user_id || !locker_id) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุ user_id และ locker_id' });
  }
  // hours คือชั่วโมงที่ผู้ใช้ "เลือกเอง" ว่าตั้งใจจะฝากนานเท่าไหร่ ไม่บังคับ เก็บไว้แสดงผลอ้างอิงเท่านั้น
  const plannedHours = Number.isInteger(hours) && hours > 0 ? hours : null;

  const lockerResult = await pool.query('SELECT * FROM lockers WHERE locker_id = $1', [locker_id]);
  if (lockerResult.rows.length === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบตู้ล็อกเกอร์นี้' });
  }
  const locker = lockerResult.rows[0];
  if (locker.status !== 'available') {
    return res.status(400).json({ success: false, message: 'ตู้นี้ไม่ว่าง หรืออยู่ระหว่างซ่อมบำรุง' });
  }

  const booking = await finalizeBooking({ user_id, locker_id, planned_hours: plannedHours });

  res.json({
    success: true,
    message: 'จองตู้สำเร็จ',
    booking_id: booking.booking_id,
    pin_code: booking.pin_code,
    locker_number: locker.locker_number,
    planned_hours: plannedHours,
  });
}

// ดูรายการจองของผู้ใช้คนหนึ่ง (แสดงระยะเวลาที่ฝากไปแล้ว ไม่มีกำหนดคืน)
async function myBookings(req, res) {
  const { user_id } = req.query;
  const result = await pool.query(
    `SELECT b.*, l.locker_number, l.location, l.size
     FROM bookings b JOIN lockers l ON b.locker_id = l.locker_id
     WHERE b.user_id = $1 ORDER BY b.created_at DESC`,
    [user_id]
  );
  res.json({ success: true, data: result.rows });
}

// รายการจองทั้งหมด (Admin) — ใช้ปล่อยตู้ที่ไม่มีคนมาใช้งานได้
async function allBookings(req, res) {
  const result = await pool.query(
    `SELECT b.*, l.locker_number, u.username, u.firstname, u.lastname
     FROM bookings b
     JOIN lockers l ON b.locker_id = l.locker_id
     JOIN users u ON b.user_id = u.user_id
     ORDER BY b.created_at DESC
     LIMIT 100`
  );
  res.json({ success: true, data: result.rows });
}

async function releaseBooking(req, res) {
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
    booking.locker_id,
    booking.user_id,
    'admin_release',
  ]);

  res.json({ success: true, message: 'ปล่อยตู้สำเร็จ คืนสิทธิ์ให้ผู้อื่นจองต่อได้แล้ว' });
}

module.exports = { createBooking, myBookings, allBookings, releaseBooking, finalizeBooking };
