import { useState, useEffect } from 'react';
import { supabase } from './lib/supabase.js';
import Auth from './components/Auth.jsx';
import Dashboard from './components/Dashboard.jsx';
import TitleBar from './components/TitleBar.jsx';

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  return (
    <div className="app-root">
      <TitleBar />
      {loading ? (
        <div className="splash">
          <div className="spinner" />
        </div>
      ) : session ? (
        <Dashboard session={session} />
      ) : (
        <Auth />
      )}
    </div>
  );
}
