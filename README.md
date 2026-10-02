# morroc101-laya

AI เล่น Ragnarok Online (Morroc 101, roBrowser) ใน browser ด้วยสมอง 3 ชั้นตามเอกสารระบบ:
**Planner** (oMLX · Qwen) วางเป้าหมาย · **LAYA** ตัดสินใจทีละ tick · **Chat** (oMLX) คุยกับผู้เล่น

เป้าหมายทั้งหมดและสถานะว่าทำได้แค่ไหน: [docs/GOALS.md](docs/GOALS.md)

## รัน

```sh
bun install
cp .env.example .env     # ใส่ LAYA_API_KEY, OMLX_API_KEY, DISCORD_WEBHOOK_URL
bun test                 # unit test (ไม่ต่อเน็ต)
bun run check            # เรียก LAYA + oMLX จริงด้วย prompt จริง
bun run check:browser    # เปิดเกม headless เช็คว่า window.RO + packet observer ขึ้น
bun start                # เปิด/เชื่อม Chrome อัตโนมัติ (CDP 9333) → ล็อกอินเองครั้งแรก → agent เริ่มเมื่อเข้าแมพ
```

Bot เชื่อม Chrome เดิมที่พอร์ต 9333 ถ้ายังไม่เปิดจะเปิดเองด้วยโปรไฟล์ `.browser-profile` แล้วรอพอร์ตพร้อม ไม่ต้องพิมพ์คำสั่งเปิด Chrome แยก หากติดตั้ง Chrome ในตำแหน่งอื่นให้ตั้ง `CHROME_PATH` เป็นพาธไฟล์โปรแกรม

Ctrl+C หยุดแค่ agent, session เกมยังอยู่ `bun start` ใหม่ต่อแท็บเดิมได้ทันที
(อย่ากด F5 ตอน agent ไม่รัน: หน้าเกมจะโหลดใหม่โดยไม่มี `window.RO` และต้องล็อกอินใหม่)

### ให้ Claude Code แก้โค้ดเองจากความผิดพลาด

```
bot (bun run dev) ──เขียน──▶ logs/incidents.jsonl ◀──เฝ้าดู── Claude Code session
      ▲                                                      │ อ่าน incident + log รอบๆ
      └──── bun --watch restart เอง เมื่อไฟล์ใน src เปลี่ยน ◀──┘ แก้โค้ด → bun test ผ่าน
```

- `bun run dev` = `bun --watch src/main.js` — โค้ดเปลี่ยนเมื่อไร bot restart เอง (browser + session เกมยังอยู่)
- ความผิดพลาดที่ควรแก้โค้ด (loop_error, errand_failed, jobchange_failed, travel_failed, …) ถูกเขียนแยกไว้ที่ `logs/incidents.jsonl`
- ใน Claude Code session สั่ง `/loop` ให้เฝ้าไฟล์นั้น เช่น
  `/loop 5m อ่าน logs/incidents.jsonl ที่ใหม่กว่ารอบที่แล้ว ถ้ามี ให้หาสาเหตุจาก logs/decisions.jsonl แก้โค้ด รัน bun test ให้ผ่านก่อนบันทึก`

## ภาพรวม

```mermaid
flowchart TB
  subgraph Browser["Chrome (แยก process, CDP :9333)"]
    RO["roBrowser<br/>window.RO (dev mode)"]
    PA["page-agent.js<br/>snapshot · packet observer · act"]
    RO <--> PA
  end

  subgraph Agent["bun src/main.js"]
    LOOP["main loop (~300ms)"]
    REFLEX["reflex.js<br/>กฎเอาตัวรอด + LAYA"]
    SKILLS["skills.js<br/>buff → skill → attack"]
    TRAVEL["travel.js<br/>NaviRoute + @go + BFS"]
    ERRAND["errand.js<br/>ไปร้าน ขาย/ซื้อ"]
    CHAT["chat.js + memory.js"]
    PLAN["planner.js"]
    WORLD["world.js<br/>spawn · แมพ · ร้าน"]
    GOALS["goals.js<br/>สัญญาณ Priority 60"]
    BUILD["build.js<br/>อัป stat"]
    SCOUT["scout.js<br/>@where"]
  end

  LAYA[("LAYA API<br/>choice / noul")]
  LLM[("oMLX · Qwen3.8-9B")]
  DISCORD[("Discord webhook")]
  DATA[("navi_mob / navi_map / navi_shop")]

  PA <-->|evaluate| LOOP
  LOOP --> REFLEX --> SKILLS
  LOOP --> TRAVEL & ERRAND & BUILD
  REFLEX --> SCOUT
  REFLEX -->|เลือก action| LAYA
  CHAT -->|ตอบไหม / ถามถึงเจ้าของไหม| LAYA
  CHAT -->|แต่งข้อความ| LLM
  PLAN -->|goal + hunt_map| LLM
  SKILLS -->|จัดลำดับสกิล| LLM
  WORLD --> DATA
  LOOP --> GOALS --> PLAN
  PLAN -->|เปลี่ยนเป้าหมาย| DISCORD
```

## ลำดับการตัดสินใจในแต่ละ tick

```mermaid
flowchart TD
  T([tick]) --> S[snapshot + drain events]
  S --> EV{events}
  EV -->|chat| C[chat.js async]
  EV -->|status / skill_fail| SK[skills เรียนรู้]
  EV -->|shop_result| ER[errand]
  EV -->|died| D[นับตาย / ตัดแมพ]
  S --> SIG[detectSignals<br/>ของเต็ม · ยาใกล้หมด · เงินต่ำ<br/>อาชีพพร้อมเปลี่ยน · point เหลือ]
  SIG -->|สัญญาณใหม่| RP[ถาม Planner ใหม่]
  S --> SAFE{ปลอดภัย?}
  SAFE -->|ใช่ + มี point| ST[อัป stat แล้วค่อย skill ตาม build]
  SAFE --> MODE{mode}
  MODE -->|follow| F[เดินตามผู้เล่น]
  MODE -->|wait| W[ยืนรอ]
  MODE -->|farm| P100{"ตาย / โดนตี / HP < 40%"}
  P100 -->|ใช่| R1["reflex<br/>(ระหว่างเดินทาง: สู้เฉพาะตัวที่ตีก่อน)"]
  P100 -->|ไม่| E{ต้องไปร้าน?}
  E -->|ใช่ / กำลังไป| ERR[errand.tick]
  E -->|ไม่| J{"พร้อมเปลี่ยนอาชีพ?<br/>(ตาม CLASS_PATH, skill point หมด)"}
  J -->|ใช่ / กำลังไป| JC[jobchange.tick → Job Master]
  J -->|ไม่| H{มีแมพล่า?}
  H -->|ไม่มี / เลเวลขึ้น 3| PICK[world.pickHuntingGrounds<br/>→ Planner เลือกจากรายการ]
  H -->|อยู่แมพอื่น| TR[travel.tick<br/>portal · @go · BFS อ้อม]
  H -->|อยู่แมพล่าแล้ว| R2[reflex: หา + ตีมอนที่เลเวลเหมาะ]
```

## Reflex: เลือก action

```mermaid
flowchart TD
  A[snapshot] --> E{"กฎ Priority 100"}
  E -->|ตาย| RS[เกิดใหม่]
  E -->|"HP < hp_potion_pct"| POT[กินยา]
  E -->|"HP < retreat_hp_pct + โดนตี"| ESC[Novice Fly Wing → Novice Butterfly Wing → หนี]
  E -->|ไม่มีมอนนาน| FLY[Novice Fly Wing]
  E -->|ไม่เข้าเงื่อนไข| ONE{"ตี 1v1 และ HP ≥ 60%?"}
  ONE -->|ใช่| KF[ตีต่อ]
  ONE -->|ไม่| SET["สร้างชุด action ที่ทำได้จริงตอนนี้<br/>attack / keep_fighting / ยา / เก็บของ / หนี / wing / นั่ง / สำรวจ / รอ"]
  SET --> LAYA[(LAYA choice)]
  LAYA --> X{action}
  X -->|attack / keep_fighting| CB
  X -->|explore| EXP["@where มอนเป้าหมาย<br/>ไม่เจอ → สุ่มจุดที่เดินถึงได้ (BFS)"]
  X -->|pickup / retreat| WALK[walk_to: BFS อ้อมกำแพง]
  KF --> CB
  subgraph CB[ต่อสู้]
    B{บัฟหมด?} -->|ใช่| BUFF[ใช้บัฟ]
    B -->|ไม่| SKL{"สกิลแรงสุดที่<br/>SP พอ · ไม่ติด cooldown · อยู่ในระยะ"}
    SKL -->|มี| CAST["ใช้สกิล<br/>(มอนรวมกลุ่ม ≥ 3 → สกิลวงกว้างก่อน)"]
    SKL -->|ไม่มี| ATK[ตีธรรมดา]
  end
```

## ธุระไปร้าน (ซื้อ/ขาย)

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> travel: potion < 10 และเงินพอ<br/>หรือ น้ำหนัก ≥ 80%
  note right of travel
    ร้าน = เดินน้อยช่องสุดจากจุดที่ยืน
    (portal + ระยะเดินในแมพ, @go = 40 ช่อง)
  end note
  travel --> approach: ถึงแมพร้าน (@go / portal)
  approach --> talk_sell: มี ETC ให้ขาย
  approach --> talk_buy: ไม่มีของขาย
  talk_sell --> selling: deal = ขาย
  selling --> talk_buy: ขายเสร็จ และต้องซื้อยา
  selling --> idle: ขายอย่างเดียว
  talk_buy --> buying: deal = ซื้อ
  buying --> idle: ซื้อยาที่ "ฟื้นทันดาเมจ + ถูกสุดต่อ HP"<br/>ด้วยราคาจริงของร้าน ภายในงบ/น้ำหนัก
  travel --> idle: ไปไม่ได้ / timeout (ข้ามร้านนี้ 10 นาที)
  idle --> [*]
  note right of idle: จบธุระ → แจ้ง Discord → travel กลับแมพล่า
```

## เปลี่ยนอาชีพ + คุย NPC

สาย (`CLASS_PATH`): **Merchant → Blacksmith → High Novice (rebirth) → High Merchant → Whitesmith → Mechanic → Meister** · build `axe_meister` (ขวาน 2 มือ)

```mermaid
flowchart TD
  R{"jobChangeReady + nextJob<br/>Novice job10 · อาชีพ1 job40<br/>อาชีพ2 base99/job50 · อาชีพ3 base200/job70"} -->|ยัง| L[เก็บเลเวลต่อ]
  R -->|พร้อม| SP{skill point เหลือ?}
  SP -->|เหลือ| UP["อัป skill ตาม build<br/>(Qwen + ลำดับสำรอง)"] --> SP
  SP -->|หมด| GO["@go prontera → เดินไป Job Master (153,193)"]
  GO --> TALK[talk NPC]
  TALK --> D{dialog state}
  D -->|next| NX[กด Next] --> D
  D -->|menu| M{"เลือกเมนู"}
  M -->|ตรงชื่ออาชีพ / Rebirth / Yes| PICK[เลือก]
  M -->|ไม่ตรงกฎ| LY{"LAYA มั่นใจ ≥ 50%?"}
  LY -->|ใช่| PICK
  LY -->|ไม่ / มีแต่ reset·delete| CAN[ยกเลิก + ปิด]
  PICK --> D
  D -->|close / ended| V{"อาชีพเปลี่ยนจริง?"}
  V -->|ใช่| OK["🎓 แจ้ง Discord · จัดสกิลใหม่ · เลือกแมพล่าใหม่"]
  V -->|ไม่| NG["⚠️ แจ้ง Discord พร้อมสิ่งที่ NPC พูด · ลองใหม่ใน 30 นาที"]
  CAN --> NG
```

ทุกบทสนทนาบันทึกที่ `logs/npc/<ชื่อ NPC>.jsonl` — อ่านได้ว่า NPC พูดอะไรและ agent เลือกอะไร

## แชท

```mermaid
sequenceDiagram
  participant P as ผู้เล่น
  participant G as เกม (packet observer)
  participant C as chat.js
  participant L as LAYA
  participant Q as Qwen (oMLX)
  P->>G: พิมพ์ (public / party / guild / whisper)
  G->>C: event chat
  C->>L: mode? (ignore / reply / follow / wait) + about_owner?
  L-->>C: reply, about_owner = 0.88
  C->>Q: persona + สถานการณ์ + ประวัติคุยกับคนนี้
  Q-->>C: "พี่เขมทำงานอยู่ครับ"
  C->>G: ตอบช่องเดิม (หน่วงเหมือนพิมพ์, ≤ 4 ข้อความ/คน/นาที)
```

## ไฟล์

| ไฟล์ | หน้าที่ |
| --- | --- |
| `src/main.js` | loop หลัก, event routing, mode, hunt/travel/errand, สัญญาณ, อัป stat |
| `src/page-agent.js` | รันในหน้าเกม: snapshot, ดัก packet (แชท/stat/skill/status/shop), BFS เดิน, act |
| `src/browser.js` | ต่อ Chrome ที่เปิดไว้ผ่าน CDP, บังคับ dev mode, helper |
| `src/reflex.js` | กฎเอาตัวรอด + ถาม LAYA + สำรวจ + ต่อสู้ |
| `src/skills.js` | ลำดับสกิล (Qwen + fallback), เลือกบัฟ/สกิล, เรียนรู้ buff ↔ status, ลำดับอัป skill point |
| `src/build.js` | สัดส่วน stat (`BUILD`, ค่าเริ่ม `axe_meister`), เลือกแต้มถัดไป |
| `src/world.js` | ข้อมูล spawn/แมพ/ร้าน/NPC, เลือกแมพล่า, ต้นทุนเดินทางเป็นช่อง (Dijkstra) |
| `src/travel.js` | เดินข้ามแมพตาม NaviRoute (portal + @go), BFS อ้อมเมื่อเดินไม่คืบ |
| `src/errand.js` | ไป Tool Dealer ที่ใกล้สุด (ระยะเดินจริง) ขาย ETC + ซื้อ potion |
| `src/potions.js` | เลือกชนิดยาจากดาเมจที่โดน vs HP/วิ ที่ยาฟื้น, เลือกขวดที่จะกิน, วัดดาเมจ |
| `src/scout.js` | `@where` / `@mobsearch` หาพิกัดมอน |
| `src/npc.js` | คุย NPC ทั่วไป: Next / เมนู / input / Close, ตัวเลือกต้องห้าม, transcript |
| `src/jobchange.js` | ไป Job Master เปลี่ยนอาชีพตาม `CLASS_PATH` แล้วเช็คผล |
| `src/goals.js` | เป้าหมายจากเอกสาร, อาชีพ, เงื่อนไขเปลี่ยนอาชีพ, สัญญาณ |
| `src/planner.js` / `src/prompts.js` | Planner (Qwen) + system prompt / persona แชท |
| `src/chat.js` / `src/memory.js` | ตอบแชท + ความจำรายผู้เล่น |
| `src/notify.js` | Discord webhook เมื่อเปลี่ยนเป้าหมาย/ย้ายที่ล่า |
| `src/laya.js` / `src/llm.js` | client LAYA (`/v1/systemone`) และ oMLX (`/v1/chat/completions`) |
| `test/` | unit test ทุกส่วน (mock `window.RO`, LAYA, LLM) |
| `logs/decisions.jsonl` | log ทุก action / แชท / แผน / ธุระ |

## กฎของเจ้าของที่ฝังไว้

- ใช้ **Novice Fly Wing** เท่านั้น (ไม่ใช้/ไม่ซื้อ Fly Wing), ไม่ใช้ Butterfly Wing กลับเมือง — ใช้ `@go`
- ถูกถามถึงเจ้าของ → "พี่เขมทำงานอยู่"
- ไม่ขายการ์ด/อุปกรณ์/ของที่สวม, เก็บเงินสำรองไว้เสมอ
