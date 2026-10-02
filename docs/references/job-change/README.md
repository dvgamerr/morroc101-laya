# Job change references

เส้นทางที่รองรับ: Novice → Merchant → Blacksmith → High Novice → High Merchant → Whitesmith → Mechanic → Meister.

- index.json: เงื่อนไขสั้นที่โหลดครั้งเดียว ใช้ร่วมกันใน signals, planner และ job change.
- ไฟล์ราย transition: โหลดเมื่อถึงเกณฑ์เลเวล/มีสัญญาณเปลี่ยนอาชีพ, ผู้เล่นถามเรื่องอาชีพ หรือเริ่มเดินทางหา Job Master; cache เฉพาะไฟล์ที่ใช้ ไม่มีการอ่านทุก guide ทุก tick.
- Planner และ chat ได้เฉพาะ current → next แบบย่อเสมอ เพื่อแก้แผน/ความจำเดิมที่ผิด.
- เกณฑ์ขั้นต่ำเดิมยังคง Merchant/High Merchant Job 40 และ Whitesmith 99/50; recommendedJob แยก Job 50/70 ให้เห็นชัด ไม่ใช่นโยบายรออัตโนมัติ.
- Blacksmith 99/50 คือจุติเป็น High Novice ไม่ใช่ Black Mage หรือ Class 3.
- Mechanic → Meister ใช้เกณฑ์ RO ไทย 200/70; iRO อาจต่างกัน.
- แหล่งอ้างอิงอยู่ในแต่ละ JSON. เงื่อนไข official/classic ไม่ได้ยืนยันว่าใช้กับเซิร์ฟนี้ทั้งหมด; ไม่ใช้ค่าธรรมเนียมจากคู่มือเป็น target เงินอัตโนมัติ.
- Automation ใช้ Job Master ที่พบใน world directory และเลือกเฉพาะชื่อ/alias ใน guide หรือเมนูเดินหน้าทั่วไป; เมนูไม่รู้จักยกเลิก เก็บ transcript และพักก่อนลองใหม่. ไม่เลือกอาชีพด้วย LLM.
- เส้นทางไม่มี guide จะไม่เริ่มเปลี่ยนอัตโนมัติ. เพิ่ม transition ใน index และไฟล์ชื่อ id.json พร้อม sources เมื่อยืนยันข้อมูลได้.
- ยืนยันความสำเร็จจาก jobId ที่เซิร์ฟส่งกลับ ไม่ใช่จากคำตอบของ AI.
