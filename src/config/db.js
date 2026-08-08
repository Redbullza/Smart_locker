const { Pool } = require('pg');

// เชื่อมต่อฐานข้อมูล Supabase PostgreSQL ผ่าน Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // จำเป็นสำหรับการเชื่อมต่อ Supabase บน Cloud
  },
});

// ตั้งค่า timezone ของทุก connection ในระบบ Pool ให้เป็นเวลาไทย
// (ไม่งั้น NOW() ในฐานข้อมูลจะได้เวลา UTC ทำให้ timestamp ใน logs ผิดเวลา)
pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'Asia/Bangkok'").catch((err) => {
    console.error('ตั้งค่า timezone ของ connection ไม่สำเร็จ:', err.message);
  });
});

// สำคัญมาก: node-postgres กำหนดว่าต้อง listen 'error' บน pool เสมอ
// ถ้าไม่มี listener นี้ พอมี connection ที่ idle อยู่ใน pool เกิด error ขึ้นมา (เช่น Supabase
// ตัดการเชื่อมต่อ, เน็ตกระตุก) Node จะมองว่าเป็น uncaught exception แล้ว "process ทั้งตัวล่มทันที"
// แบบไม่มี stack trace ให้เห็นชัดเจน — อาการตรงกับที่ server รันได้ปกติพักนึงแล้วเงียบหายไปเฉยๆ
pool.on('error', (err) => {
  console.error('Unexpected error on idle PG client:', err);
});

module.exports = pool;
