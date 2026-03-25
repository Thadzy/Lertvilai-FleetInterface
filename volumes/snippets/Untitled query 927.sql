-- คำเตือน: สคริปต์นี้จะลบข้อมูลแผนที่ทั้งหมดในระบบ (เหมาะสำหรับโหมด Development)
TRUNCATE TABLE wh_graphs CASCADE;
TRUNCATE TABLE wh_nodes CASCADE;
TRUNCATE TABLE wh_edges CASCADE;
TRUNCATE TABLE wh_levels CASCADE;

-- รีเซ็ตเลข Sequence (Auto-increment) ให้กลับไปเริ่มที่ 1
ALTER SEQUENCE wh_graphs_id_seq RESTART WITH 1;
ALTER SEQUENCE wh_nodes_id_seq RESTART WITH 1;
ALTER SEQUENCE wh_edges_id_seq RESTART WITH 1;
ALTER SEQUENCE wh_levels_id_seq RESTART WITH 1;