// ครอบ async controller ไว้ — ถ้า promise reject (เช่น query ฐานข้อมูลพัง)
// จะส่งต่อไปที่ error-handling middleware แทนที่จะเป็น unhandled rejection
// ซึ่งจะทำให้ทั้ง process ล้มไปเลย (เจอปัญหานี้ตอน DATABASE_URL ต่อไม่ติด)
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
