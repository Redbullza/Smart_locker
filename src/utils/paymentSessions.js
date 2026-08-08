// เก็บ session การชำระเงินไว้ใน memory ของ process (ไม่ persist ลง DB)
// เหมาะกับ flow สั้นๆ ระหว่างกด "จองตู้นี้" -> กด "ฉันชำระเงินแล้ว" ไม่กี่วินาที
// หมายเหตุ: ถ้า server restart ระหว่างนั้น (เช่น nodemon reload ตอน dev) session ที่ค้างอยู่จะหายไป
// ผู้ใช้แค่ต้องกดจองใหม่ ไม่กระทบข้อมูลถาวรใดๆ เพราะยังไม่มี booking เกิดขึ้นจนกว่าจะ confirm สำเร็จ

let nextId = 1;
const sessions = new Map();

function createSession(data) {
  const session_id = nextId++;
  const session = { session_id, ...data, created_at: Date.now() };
  sessions.set(session_id, session);
  return session;
}

function getSession(id) {
  return sessions.get(Number(id)) || null;
}

function deleteSession(id) {
  sessions.delete(Number(id));
}

module.exports = { createSession, getSession, deleteSession };
