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
  client.query("SET TIME ZONE 'Asia/Bangkok'");
});

module.exports = pool;
