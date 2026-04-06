# 🤖 Fleet Interface & Warehouse Graph System

This system provides a robust interface for managing robot fleets and warehouse navigation graphs using PostgreSQL and pgRouting. It is designed to be portable and easy to deploy on any machine or robot within a local network.

---

## 🚀 Quick Start (Installation)

Follow these simple steps to get the system running on your robot or server.

### 1. Prerequisites
Ensure you have the following installed on your machine:
*   **Docker** (Latest version)
*   **Docker Compose**

### 2. Deploy the System
1.  Copy this folder to your target machine (e.g., the robot).
2.  Open a terminal in this directory.
3.  Run the following command:
    ```bash
    docker compose up -d
    ```
4.  **That's it!** The database, pgRouting, and the warehouse schema are now initialized and running.

---

## 🌐 Network Access

Once the system is running, it is accessible to any device on the same local network (LAN).

### 📍 Accessing the System
*   **Robot IP Address:** `10.61.6.87`
*   **Web Interface:** `http://10.61.6.87:3000`
*   **Database Connection:** `10.61.6.87:5432`

### 🔧 Connecting from another PC
1.  Connect your PC to the same Wi-Fi/LAN as the robot.
2.  Open your browser and go to: `http://10.61.6.87:3000`
3.  You can now monitor and control the fleet from your browser.

---

## 🛠️ System Features
*   **Automated Routing:** Built-in A* and Dijkstra pathfinding via pgRouting.
*   **Robust Database:** Pre-configured PostgreSQL 15 environment.
*   **Auto-Initialization:** All database tables, functions, and triggers are loaded automatically.
*   **Portable Design:** Ready-to-use Docker containers—no manual setup required.

---

## 📄 Database Credentials (Default)
*   **Host:** `10.61.6.87`
*   **Port:** `5432`
*   **User:** `postgres`
*   **Password:** `password`
*   **Database:** `warehouse_db`

---

## 🆘 Troubleshooting
*   **Connection Failed?** Check if the robot and your device are on the same subnet.
*   **Docker Issues?** Ensure the Docker daemon is running.
*   **Manual Restart:** Use `docker compose restart` to refresh services.
