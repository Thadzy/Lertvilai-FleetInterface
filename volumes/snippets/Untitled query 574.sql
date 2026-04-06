-- อนุญาตให้อ่านไฟล์ได้ทุกคน
CREATE POLICY "Public Access to maps"
ON storage.objects FOR SELECT TO public
USING (bucket_id = 'maps');

-- อนุญาตให้อัปโหลดไฟล์ได้ทุกคน
CREATE POLICY "Allow Uploads to maps"
ON storage.objects FOR INSERT TO public
WITH CHECK (bucket_id = 'maps');

-- อนุญาตให้อัปเดต/ลบไฟล์ (ถ้าจำเป็น)
CREATE POLICY "Allow Updates to maps"
ON storage.objects FOR UPDATE TO public
USING (bucket_id = 'maps');