-- ============================================
-- ฐานข้อมูลระบบตู้รับฝากของอัจฉริยะ (ฉบับง่าย)
-- ตัดตาราง ROLE ออก รวมไว้เป็นฟิลด์เดียวในตาราง USERS
-- ============================================

CREATE DATABASE IF NOT EXISTS smart_locker
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE smart_locker;

-- ตารางผู้ใช้งาน (นักศึกษา + ผู้ดูแลระบบ)
CREATE TABLE IF NOT EXISTS users (
  user_id   INT AUTO_INCREMENT PRIMARY KEY,
  username  VARCHAR(50) NOT NULL UNIQUE,
  password  VARCHAR(255) NOT NULL,   -- เก็บแบบเข้ารหัสด้วย bcrypt
  firstname VARCHAR(100) NOT NULL,
  lastname  VARCHAR(100) NOT NULL,
  role      ENUM('user', 'admin') DEFAULT 'user'
);

-- ตารางตู้ล็อกเกอร์
CREATE TABLE IF NOT EXISTS lockers (
  locker_id     INT AUTO_INCREMENT PRIMARY KEY,
  locker_number VARCHAR(20) NOT NULL UNIQUE,
  location      VARCHAR(150) NOT NULL,
  status        ENUM('available', 'unavailable') DEFAULT 'available'
);

-- ตารางการจองตู้
CREATE TABLE IF NOT EXISTS bookings (
  booking_id INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  locker_id  INT NOT NULL,
  pin_code   VARCHAR(10) NOT NULL,
  status     ENUM('active', 'completed') DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (locker_id) REFERENCES lockers(locker_id)
);

-- ตารางบันทึกประวัติการใช้งาน (เปิด/ปิดตู้)
CREATE TABLE IF NOT EXISTS logs (
  log_id    INT AUTO_INCREMENT PRIMARY KEY,
  locker_id INT NOT NULL,
  user_id   INT NOT NULL,
  action    VARCHAR(20) NOT NULL,   -- 'open' หรือ 'close'
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (locker_id) REFERENCES lockers(locker_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

-- ข้อมูลตัวอย่าง: ตู้ล็อกเกอร์ 6 ช่อง ตามในเล่มโครงงาน
INSERT IGNORE INTO lockers (locker_number, location, status) VALUES
  ('A1', 'ตึกคณะศิลปศาสตร์ ชั้น 1', 'available'),
  ('A2', 'ตึกคณะศิลปศาสตร์ ชั้น 1', 'available'),
  ('A3', 'ตึกคณะศิลปศาสตร์ ชั้น 1', 'available'),
  ('A4', 'ตึกคณะศิลปศาสตร์ ชั้น 1', 'available'),
  ('A5', 'ตึกคณะศิลปศาสตร์ ชั้น 1', 'available'),
  ('A6', 'ตึกคณะศิลปศาสตร์ ชั้น 1', 'available');
