const config = {
  url: import.meta.env.VITE_SURREAL_URL
    ?? (import.meta.env.DEV ? 'ws://localhost:8000' : 'wss://surreal.fu.io'),
  namespace: 'avalon',
  database: 'avalon',
  access: 'anon',
};

export default config;
