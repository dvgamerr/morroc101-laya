# วิเคราะห์เป้าหมายจากเอกสารระบบตั้งต้น

เอกสารตั้งต้นมี 2 ส่วน: **System Prompt** (เป้าหมาย/พฤติกรรมของ agent) และ **Architecture** (สมอง 3 ชั้น + priority queue)
ตารางนี้แตกทุกข้อในเอกสารออกเป็นเป้าหมาย แล้วเทียบกับสิ่งที่โค้ดทำได้จริงตอนนี้

สถานะ: ✅ ทำเองได้ · 🟡 ทำได้บางส่วน · ❌ ยังไม่ทำ (Planner จะใส่ไว้ใน `todo` และแจ้ง Discord)

## 1. เป้าหมายหลัก (`goal` ใน `src/goals.js`)

| goal | จากเอกสาร | สถานะ | ทำงานยังไง / ขาดอะไร |
| --- | --- | --- | --- |
| `level` | เก็บ Base Level ให้ถึง 99 · เลือกพื้นที่ตาม EXP/เวลา, respawn, ความเสี่ยง · ย้ายพื้นที่เมื่อไม่คุ้ม/เลเวลขึ้น | ✅ | `world.js` เลือกแมพจากข้อมูล spawn จริง (มอน lv-6..+4, EXP/HP × จำนวน ÷ ระยะทาง, ตัดแมพอันตราย) → `travel.js` เดิน/@go ไป → `reflex.js` + LAYA ตี · เลือกใหม่ทุก 3 เลเวล, ตาย 2 ครั้ง, ติด, ไปไม่ได้ |
| `money` | หาเงินไปพร้อมกัน · เงินต่ำ → เปลี่ยนไปหาเงินชั่วคราว | 🟡 | เก็บ loot ทุกครั้ง + ขาย ETC อัตโนมัติ · สัญญาณ `zeny < เงินสำรอง` → goal money · **ขาด:** เลือกแมพตามมูลค่า drop (ไม่มีราคาขายใน client data) |
| `build` | พัฒนา stat/skill ให้เหมาะกับอาชีพ/build | ✅ | build `axe_meister` (STR 6 : DEX 3 : VIT 3 : AGI 2) อัป stat ทีละแต้ม · skill point: Qwen จัดลำดับตาม build จาก skill tree จริง + ลำดับสำรองสาย Merchant→Meister (Basic Skill 9 ก่อน) |
| `job_change` | เปลี่ยนอาชีพทุกครั้งที่ถึงเงื่อนไข จนถึง Class 4 | ✅ | สาย `CLASS_PATH`: Merchant → Blacksmith → High Novice (rebirth) → High Merchant → Whitesmith → Mechanic → Meister · ถึงเงื่อนไข + skill point หมด → `@go prontera` → Job Master (153,193) → `npc.js` คุยเลือกอาชีพ → เช็คว่าเปลี่ยนจริง · ไม่สำเร็จ: แนบสิ่งที่ NPC พูดไป Discord, ลองใหม่ใน 30 นาที |
| `sell` | ขาย loot/Item ให้ NPC · Resource: weight, inventory space | ✅ | `errand.js` น้ำหนัก ≥ 80% → @go/เดินไป Tool Dealer ใกล้สุด → ขายเฉพาะ ETC (ไม่ขายการ์ด/อุปกรณ์/ของที่สวม) |
| `buy` | ซื้อ Consumable · potion/SP item ใกล้หมดให้กลับเมืองซื้อก่อนกระทบการเล่น | ✅ | potion < 10 → `potions.js` เลือกชนิดจาก **ดาเมจที่โดนจริง** (p90 ต่อวินาที × 1.25) เทียบกับ HP/วิ ที่ยาฟื้นได้ (รวม VIT +2%/แต้ม) แล้วเอาตัวที่ทันและ **ถูกสุดต่อ HP ที่ฟื้นจริง** (ไม่นับส่วนที่ล้นหลอด) · ร้าน: ตัวที่ **เดินน้อยช่องสุด** (Dijkstra บนพิกัดวาร์ป + @go เป็นต้นทุนคงที่) · ที่ร้านคิดใหม่ด้วยราคาจริง · ถ้าไม่มียาไหนทันดาเมจ → ย้ายแมพล่าแทน · ตอนกินเลือกขวดที่พอดีกับ HP ที่ขาด · Novice Fly Wing เท่านั้น |
| `gear` | ซื้อ/ตีบวก/ใส่การ์ด/เปลี่ยนอาวุธ-armor-accessory เมื่อคุ้ม · ห้ามตีบวกเสี่ยงโดยไม่มี backup | ❌ | Planner ประเมินและใส่ `todo` · **ขาด:** ร้านอุปกรณ์, refine NPC, ใส่การ์ด, ประเมินมูลค่าอุปกรณ์ |
| `card_hunt` | หา Card/Item ที่เหมาะกับ class/build/level · ล่าเองหรือซื้อ | ❌ | ข้อมูล drop มีใน `navi_mob.txt` แล้ว (`getDropSources` ใน client) · **ขาด:** ตัดสินว่าการ์ดไหนคุ้มกับ build |
| `quest` | Quest ที่ช่วยให้เลเวล/พัฒนาเร็วขึ้น | ❌ | **ขาด:** ระบบคุย NPC + ติดตามเควส (`QuestPlaces` ใน client มีข้อมูลตำแหน่ง) |
| `rest` | Death prevention · พักฟื้น · ออกจากพื้นที่อันตราย | ✅ | กฎ priority 100 (ยา, Novice Fly/Butterfly Wing, หนี, เกิดใหม่) · นั่งพัก · ตายบ่อย → ตัดแมพทิ้ง 30 นาที |

## 2. พฤติกรรมที่ไม่ใช่ goal แต่อยู่ในเอกสาร

| จากเอกสาร | สถานะ | ที่อยู่ในโค้ด |
| --- | --- | --- |
| ตอบแชทแบบผู้เล่น RO จริง สั้น เป็นธรรมชาติ จำบทสนทนา (party/whisper/local) | ✅ | `chat.js` + `memory.js` (LAYA เลือกโหมด → Qwen แต่งข้อความ) |
| ถามถึงเจ้าของ → "พี่เขมทำงานอยู่" (ไม่ต้องตอบเหมือนเดิมทุกครั้ง) | ✅ | LAYA noul `about_owner` + persona ใน `prompts.js` |
| ตอบแชทโดยไม่หยุดเล่น · เอาตัวรอดก่อนตอบ | ✅ | แชทรัน async แยกจาก combat loop |
| ถูกเรียกแล้วตามไป / หยุดรอ | ✅ | `reply_and_follow` / `reply_and_wait` → mode follow/wait |
| คำแนะนำจากผู้เล่นอื่น อย่าเชื่อทันที | 🟡 | อยู่ใน prompt ของ Planner เท่านั้น |
| ใช้ skill ทำ damage สูงสุด · buff ก่อนตี | ✅ | `skills.js`: Qwen จัดลำดับสกิลตาม damage/SP + เลือก buff จากสกิลที่มีจริง · buff ก่อน → สกิลแรงสุดที่ใช้ได้ → ตีธรรมดา · เรียนรู้ว่า buff ไหนให้ status ไหน |
| Resource: Zeny, Potion, SP item, Fly Wing, Ammo, Weight, durability | 🟡 | zeny/potion/weight/wing ✅ · ammo, durability ❌ |

## 3. Priority queue จาก Architecture

| Priority | เอกสาร | สถานะ |
| --- | --- | --- |
| 100 Emergency | HP ต่ำ / โดนรุม / ตาย | ✅ `reflex.js` `emergency()` ชนะ LAYA เสมอ |
| 80 Direct interaction | ถูกเรียกชื่อ, whisper, party, voice | ✅ แชท · ❌ voice (oMLX มี `/v1/audio/transcriptions` รอทำ) |
| 60 Important gameplay | target ตาย, potion หมด, inventory เต็ม | ✅ `detectSignals()` → ถาม Planner ใหม่ (≤ 1 ครั้ง/นาที) + errand ซื้อ/ขาย |
| 30 Normal combat | เลือกมอน, attack, loot | ✅ LAYA + skill/buff |
| 10 Idle | เดินเล่น, emote, random chat | ❌ |

## 4. ข้อสังเกตจากเอกสาร

- **Base 99 ไม่ใช่เพดาน** บน Renewal: อาชีพ 3 ต้อง base 99/job 50 และ **อาชีพ 4 ต้อง base 200/job 70** (มาตรฐาน kRO) เป้าหมาย "99 แล้วขึ้น Class 4" จึงหมายถึงเก็บต่อหลัง 99 ถึง 200 — ถ้าเซิร์ฟ Morroc 101 ตั้งเงื่อนไขต่างจากนี้ ให้แก้ `jobChangeReady()` ใน `src/goals.js`
- เอกสารให้ "ซื้อ Card/Equipment จากผู้เล่น" — ต้องมีระบบเจรจาซื้อขาย ซึ่งขัดกับกฎใน persona แชทที่ห้ามรับปากซื้อขาย (กันโดนหลอก) ตอนนี้จึงยังไม่เปิด

## 5. คุย NPC (`src/npc.js`)

ทุก NPC ใช้ packet ชุดเดียว: `SAY_DIALOG` (ข้อความ) · `WAIT_DIALOG` → Next · `MENU_LIST` → `CHOOSE_MENU` · `OPEN_EDITDLG(STR)` → input · `CLOSE_DIALOG`
เลือกเมนู 3 ชั้น: กฎของงานนั้น (เช่น `jobChooser`) → LAYA (มั่นใจ ≥ 50%) → ยกเลิก · ห้ามเลือกตัวเลือกที่มี reset/delete/stylist/cash เด็ดขาด
ทุกบทสนทนาบันทึกที่ `logs/npc/<ชื่อ NPC>.jsonl`

## 6. ลำดับงานที่แนะนำต่อ

1. ใช้ `npc.js` ต่อกับ Kafra (save point / storage), Bulletin Board และ Eden (เควสล่ามอน)
2. **`gear`**: ใส่อุปกรณ์ที่ดรอปแล้วดีกว่าเดิมอัตโนมัติ (ไม่ต้องคุย NPC) → ซื้อจาก Weapon/Armor Dealer
3. **`money`**: ให้คะแนนแมพตามมูลค่า drop (ต้องหาราคาขาย NPC ของ item)
4. Priority 10 idle (emote/คุยเล่น) และ voice
