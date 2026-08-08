const { Pool } = require('pg');

// เชื่อมต่อฐานข้อมูล Supabase PostgreSQL ผ่าน Pool
// ตั้ง timezone เป็นเวลาไทยตั้งแต่ตอน connection เริ่มต้น (ผ่าน startup options ของ libpq)
// แทนที่จะยิง query "SET TIME ZONE" แยกทีหลังบน pool.on('connect') — วิธีเดิมมีช่วงเวลาที่
// connection ถูกส่งไปใช้ query จริงพร้อมๆ กับ query ตั้ง timezone ที่ยังไม่เสร็จ ทำให้ชนกัน
// (ตัว driver จะรัน query 2 อันบน connection เดียวพร้อมกันไม่ได้) เกิดเป็น deprecation warning/error
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: '-c TimeZone=Asia/Bangkok',
  ssl: {
    rejectUnauthorized: false, // จำเป็นสำหรับการเชื่อมต่อ Supabase บน Cloud
  },
});

// สำคัญมาก: node-postgres กำหนดว่าต้อง listen 'error' บน pool เสมอ
// ถ้าไม่มี listener นี้ พอมี connection ที่ idle อยู่ใน pool เกิด error ขึ้นมา (เช่น Supabase
// ตัดการเชื่อมต่อ, เน็ตกระตุก) Node จะมองว่าเป็น uncaught exception แล้ว "process ทั้งตัวล่มทันที"
// แบบไม่มี stack trace ให้เห็นชัดเจน — อาการตรงกับที่ server รันได้ปกติพักนึงแล้วเงียบหายไปเฉยๆ
pool.on('error', (err) => {
  console.error('Unexpected error on idle PG client:', err);
});

module.exports = pool;
