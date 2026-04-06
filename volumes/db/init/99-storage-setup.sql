-- 1. Ensure Storage Bucket "maps" exists
INSERT INTO storage.buckets (id, name, public)
VALUES ('maps', 'maps', true)
ON CONFLICT (id) DO NOTHING;

-- 2. Storage Policies for "maps" bucket
-- Allow public access to read files
CREATE POLICY "Public Read Access"
ON storage.objects FOR SELECT
USING (bucket_id = 'maps');

-- Allow anon role to upload files
CREATE POLICY "Anon Upload Access"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'maps');

-- Allow anon role to update/delete files (useful for replacing maps)
CREATE POLICY "Anon Update Access"
ON storage.objects FOR UPDATE
USING (bucket_id = 'maps');

CREATE POLICY "Anon Delete Access"
ON storage.objects FOR DELETE
USING (bucket_id = 'maps');

-- 3. Database RLS Policies (Ensure Frontend can CRUD graph data)
-- Enable RLS on all graph-related tables
ALTER TABLE wh_graphs ENABLE ROW LEVEL SECURITY;
ALTER TABLE wh_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE wh_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE wh_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE wh_cells ENABLE ROW LEVEL SECURITY;

-- Allow anon to do everything (standard for this internal WCS setup)
-- In a real production with users, you'd be more restrictive.
CREATE POLICY "Allow Anon Everything on wh_graphs" ON wh_graphs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow Anon Everything on wh_nodes" ON wh_nodes FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow Anon Everything on wh_edges" ON wh_edges FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow Anon Everything on wh_levels" ON wh_levels FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow Anon Everything on wh_cells" ON wh_cells FOR ALL USING (true) WITH CHECK (true);

-- Ensure permissions are granted to anon/authenticated roles
GRANT ALL ON TABLE wh_graphs TO anon, authenticated, service_role;
GRANT ALL ON TABLE wh_nodes TO anon, authenticated, service_role;
GRANT ALL ON TABLE wh_edges TO anon, authenticated, service_role;
GRANT ALL ON TABLE wh_levels TO anon, authenticated, service_role;
GRANT ALL ON TABLE wh_cells TO anon, authenticated, service_role;
GRANT ALL ON SEQUENCE wh_graphs_id_seq TO anon, authenticated, service_role;
GRANT ALL ON SEQUENCE wh_nodes_id_seq TO anon, authenticated, service_role;
GRANT ALL ON SEQUENCE wh_edges_id_seq TO anon, authenticated, service_role;
GRANT ALL ON SEQUENCE wh_levels_id_seq TO anon, authenticated, service_role;
GRANT ALL ON SEQUENCE wh_cells_id_seq TO anon, authenticated, service_role;
