# WCS — Warehouse Control System (Lertvilai V2)

ระบบจัดการหุ่นยนต์ขนส่งอัตโนมัติ (AMR) แบบครบวงจร ตั้งแต่การออกแบบแผนผังคลังสินค้า การคำนวณเส้นทาง (Optimization) ไปจนถึงการควบคุมและติดตามหุ่นยนต์แบบ Real-time ผ่านหน้าเว็บ

---

## 🚀 Quick Start (การติดตั้งแบบรวดเร็ว)

โปรเจกต์นี้ถูกออกแบบมาให้ติดตั้งได้ง่ายในคำสั่งเดียว รองรับการใช้งานผ่านวง LAN ทันที

### Prerequisites (สิ่งที่ต้องมี)
*   **Docker Desktop** หรือ **Docker Engine** (v24 ขึ้นไป)
*   **Docker Compose** (v2 ขึ้นไป)

### Installation (ขั้นตอนการติดตั้ง)

1.  **Clone Repository:**
    ```bash
    git clone <repo-url>
    cd wcs
    ```

2.  **Initialize Environment:**
    รันสคริปต์เพื่อสร้างกุญแจความปลอดภัย (JWT) และตั้งค่า IP ของเครื่องอัตโนมัติ
    ```bash
    chmod +x env_init.sh
    ./env_init.sh
    ```
    *สคริปต์จะถามว่าคุณต้องการใช้หุ่นยนต์ประเภทไหน (Sim/Real) และจะตรวจหา IP เครื่อง (เช่น `10.61.6.87`) ให้เอง*

3.  **Start Services:**
    สั่งรันระบบทั้งหมด (Backend + Database + Frontend)
    ```bash
    docker compose up -d --build
    ```

---

## 🌐 LAN Access (การเข้าใช้งานผ่านเครือข่าย)

เมื่อระบบรันเสร็จสิ้น ทุกคนที่อยู่ในวง LAN เดียวกันสามารถเข้าใช้งานผ่าน Browser ได้ทันที:

| บริการ | URL | คำอธิบาย |
|---|---|---|
| **WCS Web Interface** | `http://<YOUR_IP>` | หน้าจอหลัก (เช่น `http://10.61.6.87`) |
| **Supabase Studio** | `http://<YOUR_IP>:54323` | เครื่องมือจัดการฐานข้อมูล |
| **Fleet Gateway GQL** | `http://<YOUR_IP>:8080/graphql` | หน้าทดสอบ API ของหุ่นยนต์ |

---

## 🛠 System Architecture (สถาปัตยกรรมระบบ)

ระบบทำงานบน **Docker Container** ทั้งหมด 10+ Services เพื่อความ Robust และยืดหยุ่น:

*   **Frontend:** React 19 + Vite + Tailwind CSS (รันบน Nginx)
*   **Gateway:** Python FastAPI + Strawberry GraphQL (คุยกับหุ่นยนต์ผ่าน ROS 2)
*   **Database:** Supabase (PostgreSQL + PostgREST + Realtime)
*   **Optimization:** C++ OR-Tools (VRP Server) สำหรับคำนวณเส้นทางที่สั้นที่สุด
*   **Messaging:** Redis Pub/Sub สำหรับส่งคำสั่งไปยังหุ่นยนต์แบบ Low-latency

---

## 🤖 Robot Configuration

คุณสามารถแก้ไขการตั้งค่าหุ่นยนต์เพิ่มเติมได้ในไฟล์ `.env`:

*   **`ROBOTS_CONFIG`**: กำหนด IP และ Port ของหุ่นยนต์ รวมถึงระดับความสูงของชั้นวาง (Cell Heights)
*   **`ROBOT_NAME`**: ชื่อหุ่นยนต์ที่ใช้ระบุตัวตนในระบบ

---

## 📂 Repository Structure

```text
wcs/
├── env_init.sh           # สคริปต์ติดตั้ง (Auto-config IP & JWT)
├── docker-compose.yml    # ไฟล์ควบคุมการรันของทุก Services
├── frontend/             # โค้ดหน้าเว็บ (React/TypeScript)
├── fleet_gateway_custom/ # ตัวกลางส่งคำสั่งหาหุ่นยนต์ (GraphQL)
├── robot_bridge/         # ตัวเชื่อมต่อ Redis <-> ROS 2
├── db_schema/            # ไฟล์ SQL สำหรับสร้างฐานข้อมูลอัตโนมัติ
└── volumes/              # พื้นที่จัดเก็บข้อมูลถาวรของ Docker
```

---

## 📝 Known Issues & Tips

*   **IP Change:** หากย้ายไปรันที่เครื่องอื่น หรือ IP ของเครื่องเปลี่ยน ให้รัน `./env_init.sh` ใหม่และสั่ง `docker compose up -d --build` อีกครั้ง
*   **Hard Reset:** หากหุ่นยนต์ค้าง สามารถใช้ปุ่ม **Hard Reset** ในหน้า Fleet Controller เพื่อกู้คืนสถานะหุ่นยนต์ได้โดยไม่ต้องรีสตาร์ทเครื่อง

---
*Internal project — Lertvilai V2 / WCS Team. All rights reserved.*
