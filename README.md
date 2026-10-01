# morroc101-laya

AI เล่น Ragnarok Online (Morroc 101, roBrowser) ใน browser ด้วยสมอง 3 ชั้น

```
Planner  (oMLX · Qwen3.8-9B)   objective ระยะสั้น ทุก ~5 นาที / ตอนเลเวลขึ้น / ตาย / ติด      ~6s
   │  plan: target/avoid monsters, hp thresholds, loot, todo
LAYA     (System-1 decision)    เลือก action จากชุดที่ code กำหนด                           ~35-100ms
   │                            + ตัดสินว่าแชทไหนควรตอบ / ถามถึงเจ้าของไหม
Chat     (oMLX)                 แต่งประโยคตอบแชท พร้อมความจำรายผู้เล่น                       ~1.3s
   │
Playwright → window.RO (roBrowser debug bridge) → server
```

## ติดตั้ง

```sh
bun install
cp .env.example .env     # ใส่ LAYA_API_KEY, OMLX_API_KEY
bun test                 # unit test (ไม่ต้องต่อเน็ต)
bun run check            # เรียก LAYA + oMLX จริงด้วย prompt จริง พร้อมเวลา
bun run check:browser    # เปิดเกมแบบ headless เช็คว่า window.RO + packet observer ขึ้น
bun start                # เปิด browser → ล็อกอิน/เลือกตัวละครเอง → agent เริ่มเมื่อเข้าแมพ
```

## การออกแบบ

### อ่าน state

roBrowser ของ Morroc 101 มี `window.RO` (DebugBridge) แต่ติดตั้งเฉพาะ `development: true`
`forceDevelopmentMode()` ต่อท้าย `Config.local.js` เฉพาะใน browser ของ agent (ไม่ได้แก้ server; ผลข้างเคียงมีแค่เปิด console/debug command)
และ block service worker ไม่ให้เสิร์ฟไฟล์ config จาก cache

`page-agent.js` รันในหน้าเกม:
- `RO.me()`, `RO.entities()` → ตัวละคร / มอน / ของบนพื้น / ผู้เล่น / NPC
- Inventory component → ยา, wing, น้ำหนัก
- `RO.Network.setPacketObserver` → แชท public/party/guild/whisper, damage ที่โดน (ใครตีเรา),
  stat (`PAR_CHANGE`, `LONGPAR_CHANGE`, `LONGLONGPAR_CHANGE` ซึ่ง Renewal ใช้ส่ง EXP แบบ int64), level up
- action ส่ง packet แบบเดียวกับ client (`USE_ITEM2` เมื่อ packetver ≥ 20180307, `REQUEST_ACT2`, `ITEM_PICKUP`, ...)

### ลำดับความสำคัญ (ต่อ tick ~300ms)

| Priority | ใครตัดสิน | อะไร |
| --- | --- | --- |
| 100 | กฎใน code | ตาย → เกิดใหม่, HP < `hp_potion_pct` → ยา, HP < `retreat_hp_pct` และโดนตี → Fly/Butterfly Wing/หนี, ไม่มีมอนนาน → Fly Wing |
| 80 | LAYA + oMLX (async) | แชทเข้า → LAYA เลือก `ignore / reply / reply_and_follow / reply_and_wait` + noul "ถามถึงเจ้าของไหม" → oMLX แต่งข้อความ |
| 30 | LAYA | ตี / ตีต่อ / ยา / เก็บของ / หนี / Fly Wing / นั่งพัก / สำรวจ / รอ — มีเฉพาะ action ที่ทำได้จริงตอนนั้น |
| — | ข้าม LAYA | กำลังตี 1v1 และ HP ≥ 60% → ตีต่อเลย ไม่ต้องถาม |

ข้อกำหนดที่ป้องกันพฤติกรรมผิด:
- คำสั่งเดินมีระยะห่างขั้นต่ำ (explore 2.5s, เก็บของ 1.2s, หนี 1.5s) ไม่งั้นตัวละครจะสั่นอยู่กับที่
- ยาห่างกัน ≥ 800ms, เกิดใหม่ห่างกัน ≥ 5s, attack ต่อเนื่องส่งซ้ำทุก 3s เท่านั้น
- ไม่เก็บของเมื่อน้ำหนัก ≥ 85%
- มอนใน `avoid_monsters` ไม่ตี เว้นแต่มันตีเราก่อน
- ถ้า LAYA ตอบ action ที่ไม่อยู่ในชุด → `wait`; LAYA ล่ม → ตีต่อ/ตีตัวใกล้สุด/รอ
- แชทจำกัด 4 ข้อความ/คน/นาที และ 10 ข้อความ/นาทีรวม (กันบอทคุยกันวนไม่จบ)
- แผนจาก LLM ถูก sanitize: threshold ถูก clamp (ยา 20–80%, หนี 15–50%), list ต้องเป็น string

### Mode

`farm` (ปกติ) / `follow` (ผู้เล่นขอให้ตาม 5 นาที, หายจากจอ 30s → กลับ farm) / `wait` (หยุดรอ 60s)
— ถ้าโดนตีหรือ HP < 40% จะกลับไปใช้ reflex ทันทีไม่ว่าอยู่ mode ไหน

## ไฟล์

| ไฟล์ | หน้าที่ |
| --- | --- |
| `src/main.js` | loop หลัก, event routing, mode, เรียก planner |
| `src/page-agent.js` | รันในหน้าเกม: snapshot, ดัก packet, execute action |
| `src/browser.js` | เปิด Playwright, บังคับ dev mode, helper เรียก page agent |
| `src/reflex.js` | ชุด action + กฎเอาตัวรอด + ถาม LAYA + throttle |
| `src/chat.js` | LAYA ตัดสินโหมดตอบ → oMLX แต่งข้อความ → ส่งแชทช่องเดิม |
| `src/planner.js` | oMLX วางแผน → JSON ที่ sanitize แล้ว |
| `src/prompts.js` | System prompt ของ Planner และ persona แชท |
| `src/laya.js` / `src/llm.js` | client ของ LAYA (`/v1/systemone`) และ oMLX (`/v1/chat/completions`) |
| `test/` | unit test ของ reflex และ page agent (mock `window.RO`) |
| `logs/decisions.jsonl` | log ทุก action / แชท / แผน |

## ข้อจำกัดตอนนี้ (MVP)

ทำได้: ตีมอนที่เห็น, ใช้ยา HP/SP, เก็บของ, นั่งพัก, หนี, Fly/Butterfly Wing, เดินหามอน, เกิดใหม่เมื่อตาย,
ตอบแชท, เดินตาม / หยุดรอเมื่อผู้เล่นขอ

ยังไม่ทำ (Planner จะใส่ไว้ใน `todo` ของแผนใน log):
เดินข้ามแมพ (`RO.NaviRoute` / `RO.PathFinding` มีให้ใช้ต่อ), ซื้อ/ขายกับ NPC, เพิ่ม stat/skill,
เปลี่ยนอาชีพ, ตีบวก, voice chat (oMLX มี `/v1/audio/transcriptions`), ล็อกอินอัตโนมัติ
