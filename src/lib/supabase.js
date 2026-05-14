import { createClient } from '@supabase/supabase-js';

// Anon key is safe to ship publicly — RLS on Supabase controls access.
// Service key is NOT here. It lives only on the VPS backend.
export const SUPABASE_URL      = 'https://mfddppnjxknjipxfiwzh.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1mZGRwcG5qeGtuamlweGZpd3poIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyODUwMzUsImV4cCI6MjA5Mjg2MTAzNX0.3SUe4duhXVk8DefpZ1qsjo1P3awwd1Cv5rbjiuwZEvs';

// During development point to local server; change to your VPS URL before distributing
export const API_URL = 'https://ba4e-35-229-179-16.ngrok-free.app';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
