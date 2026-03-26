-- เปลี่ยน 'LOCALBOT' เป็นชื่อหุ่นยนต์ของคุณ
UPDATE wh_requests 
SET status = 'CANCELED' 
WHERE status = 'IN_PROGRESS';

UPDATE wh_assignments 
SET status = 'CANCELED' 
WHERE status = 'OPERATING';