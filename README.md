# WCS — Warehouse Control System (Lertvilai V2)

[![Docker](https://img.shields.io/badge/Docker-v24+-blue.svg?logo=docker)](https://www.docker.com/)
[![React](https://img.shields.io/badge/React-v19-61DAFB.svg?logo=react)](https://reactjs.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-v0.115-009688.svg?logo=fastapi)](https://fastapi.tiangolo.com/)

**WCS** is a production-grade, distributed orchestration platform for Autonomous Mobile Robot (AMR) fleets. It manages everything from warehouse map design and multi-robot route optimization to real-time telemetry and fleet recovery.

---

## 🏗 System Architecture

WCS runs on a microservice architecture orchestrated by **Docker Compose**:

*   **Frontend**: React 19 (Vite) served via **Nginx** on Port 80.
*   **Gateway**: Python (FastAPI + Strawberry GraphQL) on Port 8080.
*   **Database**: Self-hosted **Supabase** (Postgres, Kong, PostgREST, Storage).
*   **Solver**: C++ OR-Tools **VRP Server** for multi-vehicle path optimization.
*   **Communication**: **Redis Pub/Sub** bus for low-latency robot commands.

---

## 🚀 Deployment Guide (Turn-key)

Follow these steps to deploy the system on any machine within your LAN.

### 1. Initialize Environment
The setup script automatically detects your machine's Local IP and generates secure JWT keys.
```bash
chmod +x env_init.sh
./env_init.sh
```
*When prompted, the script will configure the fleet for both **SIMBOT** (Simulator) and **LOCALBOT** (Physical Robot at 10.61.6.87).*

### 2. Launch Services
Start the entire stack. This will build the frontend and configure the database schema + storage buckets automatically.
```bash
# Clean up any old data/volumes (Recommended for first run)
docker compose down -v 

# Start all services
docker compose up -d --build
```

### 3. Verify Access
Once the containers are healthy, access the system via:
*   **Main Dashboard**: `http://<YOUR_IP>` (e.g., `http://10.61.6.87`)
*   **Supabase Studio**: `http://<YOUR_IP>:54323`
*   **GraphQL Console**: `http://<YOUR_IP>:8080/graphql`

---

## 🌐 Team Collaboration & LAN Access

WCS is designed for multi-user, real-time collaboration. To share the system with your team:

1.  **The URL**: Provide your team with your host IP: `http://10.61.6.33`
2.  **Network**: All users must be on the same local network (VLAN/Wi-Fi).
3.  **Real-time Updates**: Map changes, robot movements, and system logs are synced across all connected browsers instantly via **Supabase Realtime** and **MQTT**.

> **Pro Tip**: To prevent the IP from changing, it is highly recommended to set a **Static IP** for the host machine in your Router settings.

---

## 🔍 Post-Installation Debugging (If you can't access the site)

If `http://<YOUR_IP>` is not loading:

1.  **Check IP Consistency**: 
    Ensure the IP detected during `./env_init.sh` matches your machine's current IP. You can check your IP using `ipconfig` (macOS) or `ip a` (Linux).
2.  **Check Container Status**:
    ```bash
    docker compose ps
    ```
    All services must be `Up` or `Healthy`. If `wcs-frontend-1` is restarting, check logs: `docker logs wcs-frontend-1`.
3.  **Local Access Test**:
    Try accessing `http://localhost` directly on the host machine. If this works but LAN doesn't, check your machine's **Firewall settings** (allow Port 80).
4.  **Database Reset**:
    If you see "Password authentication failed" in logs, run `docker compose down -v` to reset volumes and restart.

---

## 🤖 Robot Fleet Management

You can switch between robots directly from the **UI Header Dropdown**:
*   **SIMBOT**: Virtual robot running in Docker. Perfect for testing without hardware.
*   **LOCALBOT**: Physical robot expected at `10.61.6.87:9090`.

To change the physical robot IP, edit the `ROBOTS_CONFIG` in your `.env` file.

---
*Internal project — Lertvilai V2 Development Team.*
