# เป้าหมายอุปกรณ์ NPC +7 — 2026-10-03

เจ้าของกำหนดให้เลือกอุปกรณ์ราคาแพงที่สุดที่ **อาชีพปัจจุบันใส่ได้จริง** จาก NPC อย่างละ 1 ชิ้น ใช้ขวานสองมือ ตรวจ Equipment, Inventory และ Kafra ก่อนซื้อ ไม่ซื้อสำรองเพราะตีพลาดแล้วไม่แตกในช่วงเป้าหมายนี้ หยุดที่ +7 และยืนยันว่าใส่กลับแล้วก่อนขายของ เงินสำรองเดิม 100,000 zeny ยังคงอยู่

## ชุดสำหรับ Blacksmith ปัจจุบัน (Base 98, STR 96 ตอนตรวจ)

| ช่อง | เป้าหมาย | ID | ราคาประกาศ NPC ก่อน Discount | ร้าน |
|---|---|---:|---:|---|
| อาวุธสองมือ | Doom Slayer [1] | 1371 | 100,000 | Axes, prontera 164,264 |
| หมวกบน | Lord Kaho's Horn | 5013 | 700,000 | Rare Headgear, prontera 164,238 |
| เกราะ | Chain Mail [1] | 2315 | 75,000 | Armor, prontera 147,240 |
| ผ้าคลุม | Ancient Cape | 2507 | 82,000 | Garments, prontera 164,256 |
| รองเท้า | Vidar's Boots | 2418 | 50,000 | Footgear, prontera 147,244 |

รวมราคาประกาศ 1,007,000 zeny ก่อนส่วนลด ไม่รวมแร่/ค่าตีบวก และต้องหักของที่มีใน Kafra ก่อน ไม่ใช้ราคานี้แทนใบเสนอราคาจริงจากร้าน

- Doom Slayer เป็น Weapon Lv.4: STR พื้นฐาน >=95 ได้ ATK +340 แต่ ASPD -40% และใช้ SP +100% ต้องนำต้นทุน SP ไปประเมินการล่า ไม่แปลว่าราคาแพงกว่าจะคุ้มทุกสถานการณ์
- Chain Mail [1] ราคาเท่ากับ Odin's Blessing; เลือก DEF 55 แทน 53 ในกรณีราคาเสมอ รองเท้า Vidar's Boots ราคาเสมอ Fricco's Shoes; เลือก HP/SP +9%
- **ห้ามซื้อ Meteo Plate Armor, Wool Scarf, Tidal Shoes ให้ Blacksmith ธรรมดา**: item_db กำหนด Upper/Third/Fourth ถึงแม้คำอธิบายไคลเอนต์แสดงชื่อ Blacksmith ต้องประเมินชุดใหม่เมื่อเปลี่ยนอาชีพ
- Nut Shell, Romantic Flower และ Skull Ring ตีบวกไม่ได้ ไม่อยู่ในเป้าหมาย +7; ไม่ซื้อโล่ชนกับขวานสองมือ

## วัสดุและสูตรที่ยืนยันจากเซิร์ฟเวอร์

| การใช้งาน | วัสดุ | ค่า NPC ต่อครั้ง |
|---|---|---:|
| อาวุธ Lv.4 แบบ Normal | Oridecon 984 x1 | 20,000 zeny |
| เกราะทั่วไปแบบ Normal | Elunium 985 x1 | 2,000 zeny |
| แปลง Rough Oridecon | 756 x5 → 984 x1 ที่ Christopher | ฟรี |
| แปลง Rough Elunium | 757 x5 → 985 x1 ที่ Christopher | ฟรี |

Hollgrehenn: `prt_in 63,60` เปิด Refine UI; Christopher: `geffen_in 110,172` → `Purify Rough Ores` → `Make Oridecon` / `Make Elunium`

Dietrich `prt_in 63,69` ถูก Renewal script แทนที่ NPC เก่า เมนูสดเป็น `View advanced smelting ores` → barter_refine_1 ไม่ใช่ `Make Oridecon` โดยตรง ตัวควบคุมใช้ Dietrich แลกเป็นชุด โดยตรวจ quote ว่าไม่มีค่า zeny และใช้ rough ชนิดที่ถูกต้อง 5:1 เท่านั้น; Christopher เป็นเส้นทางสำรองแบบบทสนทนา

Craft Supply Dealer: `morocc 154,109` → **Refine ores** มี Enriched Oridecon 7620 / Enriched Elunium 7619 ราคาประกาศชิ้นละ 300,000 และ HD ores แต่ **ไม่มี Oridecon/Elunium ธรรมดาขาย** ให้ใช้แร่ปกติ/rough ใน Kafra ก่อนซื้อ Enriched อ่านราคาจริงหลัง Discount และค่า refine ของชิ้นนั้นทุกครั้ง ห้ามตีราคาของที่มีอยู่เป็นการรับประกันต้นทุนฟาร์ม

Normal เกราะทั่วไปและ Weapon Lv.4: โอกาสไป +1..+7 เท่ากับ `100,100,100,100,60,40,40%` พลาดแล้วไม่แตก/ไม่ลดระดับในช่วงนี้ จึงใช้เฉลี่ยประมาณ **10.67 ครั้งต่อชิ้น** จาก +0 ถึง +7 ไม่ใช่จำนวนที่รับประกัน ต้องซื้อแร่เพิ่มตามผลจริง โดยไม่แตะเงินสำรอง ไม่ใช้ Blacksmith Blessing โดยอัตโนมัติ และไม่ขยายไป +8 หรืออุปกรณ์ Ethernium

## ขั้นตอนที่ AI ใช้

1. อ่านอาชีพ/เลเวล/ข้อจำกัด `Jobs`, `Classes`, `EquipLevelMin` จาก catalog ที่ตรวจเทียบ item_db
2. เปิด Kafra อ่านรายการจนจำนวนครบ ถอนชิ้นเป้าหมายที่ขาดและแร่ที่มี บันทึก `logs/gear-storage.json`; คลังที่ยังไม่อ่านเป็น unknown ไม่ใช่ empty
3. ซื้อเฉพาะชิ้นที่ยังไม่มี อย่างละ 1 ชิ้น ตรวจ quote ร้านและยืนยันของเพิ่มในกระเป๋า
4. แปลง rough ก่อน หรือซื้อแร่เพิ่มเมื่อไม่มีของใน Kafra อ่าน quote `REFINING_MATERIAL_LIST` สำหรับ index ปัจจุบัน
5. ส่งตีทีละครั้ง รอ `ACK_ITEMREFINING` แล้วอ่าน Equipment/Inventory ใหม่ ของอาจถูกถอดกลับเข้ากระเป๋า ห้ามใช้ index เก่าต่อโดยไม่ตรวจ และห้ามซื้อทดแทนเพียงเพราะมันถูกถอด
6. หยุดที่ +7 ใส่กลับ ยืนยันจาก Equipment แล้วจึงทำชิ้นถัดไป เงินไม่พอขั้นถัดไปให้หาเงินต่อโดยรักษาสำรอง; บันทึก `logs/gear-progress.json`
7. ห้ามขาย/ฝากวัสดุและชิ้นเป้าหมายระหว่างโครงการ การมีแผนหรือส่งคำสั่งไม่เท่ากับสำเร็จ ต้องยืนยันข้อมูลเซิร์ฟเวอร์

ตัวควบคุม: `src/gear-upgrade.js`; แผนและข้อมูลที่ส่งให้ Planner/LAYA: `src/gear-goal.js`, `upgrade.json`, `npc-catalog.json`

## แหล่งข้อมูล

- [คู่มือตีบวกเซิร์ฟเวอร์](https://morroc101.duckdns.org/content/refine-guide.html)
- [รายการร้านจากเซิร์ฟเวอร์](https://morroc101.duckdns.org/client/data/navi_shop.txt) และ [NPC](https://morroc101.duckdns.org/client/data/navi_npc.txt)
- `E:/morroc101-rathena/npc/scripts_custom.conf`: เปิด weapon_armor_shops, rare_headgear_shop, craft_supplies จริง; ไม่ใช้ itemmall.txt ต้นฉบับที่ปิดอยู่
- `E:/morroc101-rathena/npc/morroc101/{weapon_armor_shops,rare_headgear_shop,craft_supplies}.txt`: ร้านและราคา
- `E:/morroc101-rathena/db/re/item_db_equip.yml`: อาชีพ ชั้นอาชีพ เลเวล ช่อง และเงื่อนไขอุปกรณ์
- `E:/morroc101-rathena/db/re/refine.yml`, `db/morroc101/refine.yml`, `db/refine.yml`: สูตรและลำดับ override; โค้ด override ปัจจุบันเปลี่ยนเงื่อนไขเหนือ +10 จากคู่มือเก่า งานนี้หยุด +7 จึงไม่พึ่งข้อมูลช่วงนั้น
- `E:/morroc101-rathena/npc/merchants/refine.txt`: NPC, สูตร rough 5:1 และ Refine UI
- [Online.js](https://morroc101.duckdns.org/play/Online.js) และ `src/map/clif.cpp`: packet ของหน้าต่างตีบวกและถอนคลัง

ตรวจเฉพาะการอ่าน repository เซิร์ฟเวอร์ ไม่ได้แก้ configuration หรือข้อมูลเซิร์ฟเวอร์

## สถานะล่าสุดตามคำสั่งแก้เป้าหมาย

เจ้าของลดเป้าหมายจาก +9 เป็น +7 แล้ว ขวาน Doom Slayer +7 ใส่อยู่จริง จึงหยุดตีขวาน ไม่ซื้อแร่เพื่อ +8/+9 เงินล่าสุด 178,978 zeny; อุปกรณ์เป้าหมายอีก 4 ช่องยังไม่ครบ

ซื้อและใส่ Vidar’s Boots +0 แล้ว ราคา Discount จริง 38,000 zeny เงินหลังซื้อ 140,978 zeny; Doom Slayer +7 ยังใส่อยู่ รองเท้าเป้าหมาย +7 ยังไม่เสร็จ อีก 3 ชิ้นยังไม่ได้ซื้อ: Lord Kaho’s Horn, Chain Mail [1], Ancient Cape

เจ้าของอนุมัติใช้เงินสำรองซื้อชุดตามงบ: Saint’s Robe [1] 45,600, Morrigane’s Manteau 45,600 และ Soul Ring 38,000 zeny ซื้อและยืนยันใส่ครบแล้ว ทั้งสาม +0 เงินเหลือ 11,778 zeny เลือกชุดนี้เป็นเป้าหมาย +7 สำหรับ Blacksmith แทนชุดแพงเดิม ห้ามซื้อแทนซ้ำ การใช้เงินสำรองอนุมัติเฉพาะการซื้อครั้งนี้
