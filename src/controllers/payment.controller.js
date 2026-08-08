const pool = require('../config/db');
const { finalizeBooking } = require('./booking.controller');
const { createSession, getSession, deleteSession } = require('../utils/paymentSessions');
const { SIZE_PRICE } = require('../config/pricing');

// ==================================================================
// หน้าคิดเงิน — คิดราคาตามขนาดตู้ ก่อนยืนยันจอง (QR จำลอง)
// flow: กด "จองตู้นี้" -> สร้าง payment session (แสดง QR+ราคา) -> กด "ฉันชำระเงินแล้ว" -> confirm -> สร้าง booking จริง
// ==================================================================

function generateRefCode() {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `LK-${Date.now()}-${rand}`;
}

async function createPaymentSession(req, res) {
  const { user_id, locker_id, hours } = req.body;
  if (!user_id || !locker_id) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุ user_id และ locker_id' });
  }
  // hours คือชั่วโมงที่ผู้ใช้เลือกเองว่าตั้งใจจะฝากนานเท่าไหร่ ไม่บังคับ ไม่มีผลต่อราคาหรือค่าปรับ
  const plannedHours = Number.isInteger(hours) && hours > 0 ? hours : null;

  const lockerResult = await pool.query('SELECT * FROM lockers WHERE locker_id = $1', [locker_id]);
  if (lockerResult.rows.length === 0) {
    return res.status(404).json({ success: false, message: 'ไม่พบตู้ล็อกเกอร์นี้' });
  }
  const locker = lockerResult.rows[0];
  if (locker.status !== 'available') {
    return res.status(400).json({ success: false, message: 'ตู้นี้ไม่ว่าง หรืออยู่ระหว่างซ่อมบำรุง' });
  }

  const amount = SIZE_PRICE[locker.size] ?? 0;
  const refCode = generateRefCode(); // สุ่มใหม่ทุกครั้ง แม้ราคาจะเท่าเดิม
  const qrPayload = `LOCKER|${locker.locker_number}|${amount}|${refCode}`; // จำลองเท่านั้น ไม่ใช่ QR ชำระเงินจริง

  const session = createSession({
    user_id,
    locker_id,
    locker_number: locker.locker_number,
    locker_size: locker.size,
    planned_hours: plannedHours,
    amount,
    ref_code: refCode,
  });

  res.json({
    success: true,
    session_id: session.session_id,
    locker_number: locker.locker_number,
    locker_size: locker.size,
    amount,
    ref_code: refCode,
    qr_payload: qrPayload,
    planned_hours: plannedHours,
  });
}

async function cancelPaymentSession(req, res) {
  deleteSession(req.params.id);
  res.json({ success: true, message: 'ยกเลิกรายการชำระเงินแล้ว' });
}

async function confirmPaymentSession(req, res) {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, message: 'ไม่พบรายการชำระเงินนี้ หรือหมดอายุแล้ว กรุณาลองจองใหม่' });
  }

  // เช็คซ้ำว่าตู้ยังว่างอยู่จริง กันกรณีมีคนอื่นจองแทรกระหว่างที่ session นี้ค้างอยู่
  const lockerResult = await pool.query('SELECT * FROM lockers WHERE locker_id = $1', [session.locker_id]);
  const locker = lockerResult.rows[0];
  if (!locker || locker.status !== 'available') {
    deleteSession(req.params.id);
    return res.status(400).json({ success: false, message: 'ตู้นี้ถูกจองไปแล้วก่อนหน้านี้ กรุณาเลือกตู้ใหม่' });
  }

  const booking = await finalizeBooking({
    user_id: session.user_id,
    locker_id: session.locker_id,
    planned_hours: session.planned_hours,
  });

  deleteSession(req.params.id);

  res.json({
    success: true,
    message: 'ชำระเงินสำเร็จ',
    booking_id: booking.booking_id,
    pin_code: booking.pin_code,
    locker_number: locker.locker_number,
    planned_hours: session.planned_hours,
    amount: session.amount,
  });
}

module.exports = { createPaymentSession, cancelPaymentSession, confirmPaymentSession };
